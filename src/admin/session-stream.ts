// ── Last Light on Flue · admin SSE session/message streams (Phase 7 · SSE) ────
//
// The SSE surface backing the dashboard's live session-list + transcript hooks
// (dashboard/src/hooks/useSessionStream.ts, useMessageStream.ts). It ports the
// reference `mountSessionRoutes` stream handlers (lastlight/src/admin/routes.ts)
// onto Flue's durable stores via the injected reader seams — WITHOUT changing
// the existing catch-up `/sessions*` JSON routes.
//
// The EXACT frontend contract (verified against the hooks):
//   • session-list stream → named event `sessions`, data `{"sessions": Session[]}`;
//     emit an initial snapshot immediately, then RE-EMIT only when the list
//     changes (a content signature diff), polling on an interval. On error →
//     named event `error`, data `{"message": "..."}`.
//   • message stream → BACKFILL each transcript Message with `id > since` as a
//     named event `message` (data = the Message), then a named event `ready`
//     (signals backfill complete), then poll + emit new `message` events as they
//     arrive. `Message.id` is a monotonic NUMBER (the transcript index).
//
// Auth: the `?token=` query param carries the bearer (EventSource can't set
// headers); the `/admin/api/*` operator-auth middleware already accepts it.
//
// SSE leak-safety: every connection registers `stream.onAbort` to stop its poll
// loop, and the loop is bounded by a `stopped` flag re-checked after every sleep
// — so a client disconnect tears down the interval (no leaked timer, no write to
// a dead socket).

import { streamSSE } from 'hono/streaming';
import type { Context, Hono } from 'hono';
import type { SessionMeta, TranscriptMessage } from './session-reader.ts';
import {
  toTranscriptMessages,
  readFullTranscript,
  filterEventsByOperation,
  type RawStreamEvent,
} from './session-reader.ts';

/** Default poll interval for both stream kinds (ms). The reference used 2–3s. */
const POLL_MS = 2000;

/**
 * The structural reader surface the stream routes need — satisfied by BOTH
 * `SessionReader` (runs+chat merged) and `ChatSessionReader` (chat only). The
 * routes are reader-agnostic: the caller picks which reader + which default
 * transcript `kind` to bind per surface (`/sessions` vs `/chat-sessions`).
 */
export interface SessionStreamSource {
  listSessions(opts?: { limit?: number; cursor?: string }): Promise<{
    sessions: SessionMeta[];
    nextCursor: string | null;
  }>;
  exists(id: string): Promise<boolean>;
  readTranscript(
    id: string,
    opts?: { offset?: string; limit?: number; kind?: 'run' | 'agent'; agentName?: string },
  ): Promise<{ events: Array<{ data: unknown; offset: string }>; nextOffset: string; upToDate: boolean }>;
}

/**
 * A content signature for a session list — changes iff a row the dashboard
 * renders changed (id / activity / count). Used to gate re-emits so an unchanged
 * list doesn't spam the SSE channel. Mirrors the reference's `sig` string.
 */
export function sessionsSignature(sessions: SessionMeta[]): string {
  return sessions
    .map(
      (s) =>
        `${s.id}:${s.last_message_at ?? s.started_at}:${s.message_count}`,
    )
    .join('|');
}

/**
 * Map a reader transcript read to the dashboard `Message[]` with MONOTONIC
 * numeric ids (the transcript index). PURE — the same events always yield the
 * same ids, so a re-read on poll re-derives identical ids and new tail messages
 * get the next ids in sequence. Mirrors the reference's `id: index` assignment.
 */
export function transcriptToMessages(
  events: Array<{ data: unknown; offset: string }>,
): Array<TranscriptMessage & { id: number }> {
  return toTranscriptMessages(events).map((m, i) => ({ id: i, ...m }));
}

/** Parse a `limit` query param (clamped 1..1000) or undefined. */
function parseLimit(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  return Math.min(Math.max(parseInt(raw, 10) || 200, 1), 1000);
}

/** Parse a numeric `since` (the last message id the client already has). -1 = all. */
function parseSince(raw: string | undefined): number {
  if (raw == null || raw === '') return -1;
  const n = parseInt(raw, 10);
  return Number.isNaN(n) ? -1 : n;
}

/**
 * Mount the SSE session-list stream at `${prefix}/stream`. Emits the initial
 * `sessions` snapshot immediately, then re-emits on change every `POLL_MS`.
 * `error` is emitted (named event) on a read failure, and the loop continues so
 * a transient failure doesn't kill the stream.
 */
function mountSessionListStream(
  app: Hono,
  source: SessionStreamSource,
  prefix: string,
): void {
  app.get(`${prefix}/stream`, (c: Context) => {
    const limit = parseLimit(c.req.query('limit'));
    return streamSSE(c, async (stream) => {
      let stopped = false;
      let prevSig: string | null = null; // null = nothing sent yet (covers empty-list initial push)
      stream.onAbort(() => {
        stopped = true;
      });

      const push = async (): Promise<void> => {
        const res = await source.listSessions({ limit });
        const sig = sessionsSignature(res.sessions);
        if (sig !== prevSig) {
          prevSig = sig;
          await stream.writeSSE({
            event: 'sessions',
            data: JSON.stringify({ sessions: res.sessions }),
          });
        }
      };

      try {
        await push();
      } catch (err) {
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({ message: errMessage(err) }),
        });
      }

      while (!stopped) {
        await stream.sleep(POLL_MS);
        if (stopped) break;
        try {
          await push();
        } catch (err) {
          await stream.writeSSE({
            event: 'error',
            data: JSON.stringify({ message: errMessage(err) }),
          });
        }
      }
    });
  });
}

/**
 * Mount the SSE per-session message stream at `${prefix}/:id/stream`. Backfills
 * every transcript message with `id > since` as a `message` event, emits `ready`
 * (backfill complete), then polls and emits NEW messages as they appear.
 * `defaultKind` selects the transcript stream path (run vs. chat-agent).
 */
function mountMessageStream(
  app: Hono,
  source: SessionStreamSource,
  prefix: string,
  defaultKind: 'run' | 'agent',
): void {
  app.get(`${prefix}/:id/stream`, async (c: Context) => {
    const id = c.req.param('id') ?? '';
    const since = parseSince(c.req.query('since'));
    const kind = c.req.query('kind') === 'agent' ? 'agent' : c.req.query('kind') === 'run' ? 'run' : defaultKind;
    // Optional: scope the transcript to a single derived phase (one operationId).
    // The run-detail per-phase log view passes this so it can reuse the same run
    // stream rather than a per-phase session (which Flue does not have).
    const operation = c.req.query('operation') || undefined;

    if (!(await source.exists(id))) {
      return c.json({ error: 'session not found' }, 404);
    }

    return streamSSE(c, async (stream) => {
      let stopped = false;
      // Highest message id already emitted to this client (backfill watermark).
      let lastEmitted = since;
      stream.onAbort(() => {
        stopped = true;
      });

      // Re-read the FULL transcript (drained to the end — a single readEvents
      // page caps at 100 events) and emit every message with id > lastEmitted.
      const emitNew = async (): Promise<void> => {
        const t = await readFullTranscript(source, id, { kind });
        const events: RawStreamEvent[] = operation
          ? filterEventsByOperation(t.events, operation)
          : t.events;
        const messages = transcriptToMessages(events);
        for (const m of messages) {
          if (m.id > lastEmitted) {
            await stream.writeSSE({ event: 'message', data: JSON.stringify(m) });
            lastEmitted = m.id;
          }
        }
      };

      // Backfill, then signal ready. A read failure surfaces as a named `error`
      // event but we STILL send `ready` so the client leaves the connecting
      // state (matching the reference, which always emits ready post-backfill).
      try {
        await emitNew();
      } catch (err) {
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({ message: errMessage(err) }),
        });
      }
      await stream.writeSSE({ event: 'ready', data: '' });

      while (!stopped) {
        await stream.sleep(POLL_MS);
        if (stopped) break;
        try {
          await emitNew();
        } catch (err) {
          await stream.writeSSE({
            event: 'error',
            data: JSON.stringify({ message: errMessage(err) }),
          });
        }
      }
    });
  });
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Mount the SSE stream routes for a session surface under `prefix`:
 *   • `${prefix}/stream`        — session-list stream (`sessions` events)
 *   • `${prefix}/:id/stream`    — per-session message stream (`message`/`ready`)
 * `defaultKind` is the transcript path kind for this surface (`run` for
 * `/sessions`, `agent` for `/chat-sessions`). Idempotent registration order
 * matters: the list-stream literal `/stream` is registered before the
 * parametric `/:id/stream` so it is not shadowed.
 */
export function mountSessionStreamRoutes(
  app: Hono,
  source: SessionStreamSource,
  prefix: string,
  defaultKind: 'run' | 'agent',
): void {
  mountSessionListStream(app, source, prefix);
  mountMessageStream(app, source, prefix, defaultKind);
}

/**
 * Mount the chat-sessions CATCH-UP JSON routes (non-SSE) that mirror the
 * existing `/sessions` ones, for the `/chat-sessions` surface:
 *   • GET `${prefix}`                  → `{ sessions }`
 *   • GET `${prefix}/:id/messages`     → `{ source, messages, last_id }`
 * These complete the chat surface alongside the SSE streams. The run surface's
 * equivalents already live in createApp (unchanged).
 */
export function mountChatSessionJsonRoutes(
  app: Hono,
  source: SessionStreamSource,
  prefix: string,
  defaultKind: 'run' | 'agent',
): void {
  app.get(`${prefix}`, async (c: Context) => {
    const limit = parseLimit(c.req.query('limit'));
    const cursor = c.req.query('cursor') || undefined;
    const res = await source.listSessions({ limit, cursor });
    return c.json({ sessions: res.sessions, liveCount: 0, nextCursor: res.nextCursor });
  });

  app.get(`${prefix}/:id/messages`, async (c: Context) => {
    const id = c.req.param('id') ?? '';
    const since = parseSince(c.req.query('since'));
    if (!(await source.exists(id))) {
      return c.json({ source: 'none', messages: [], last_id: since });
    }
    const kind = c.req.query('kind') === 'agent' ? 'agent' : c.req.query('kind') === 'run' ? 'run' : defaultKind;
    const operation = c.req.query('operation') || undefined;
    const t = await readFullTranscript(source, id, { kind });
    const events = operation ? filterEventsByOperation(t.events, operation) : t.events;
    const all = transcriptToMessages(events);
    const next = all.filter((m) => m.id > since);
    const lastId = all.length ? all[all.length - 1]!.id : since;
    return c.json({ source: 'flue', messages: next, last_id: lastId });
  });
}
