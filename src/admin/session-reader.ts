// ── Last Light on Flue · admin session/transcript seam (Phase 7 · slice 1) ────
//
// The SESSION/TRANSCRIPT data layer backing `/admin/api/sessions` (was a 501
// stub). It re-backs the old jsonl-`SessionReader`/`ChatSessionReader` surface
// onto Flue's DURABLE stores:
//   • the session LIST   → `RunStore.listRuns(...)` (blob-free pointers — the
//     "list excludes blobs" invariant is native; we never read a transcript in
//     the list path) mapped to the dashboard's `SessionMeta` shape.
//   • the session TRANSCRIPT → `EventStreamStore.readEvents(path, {offset,limit})`
//     where `path` is `runStreamPath(runId)` for a workflow run or
//     `agentStreamPath('chat', instanceId)` for a chat-agent thread. The stream's
//     decorated `FlueEvent`s are mapped → the dashboard's `JsonlMessage`
//     transcript shape (role / content / tool_calls / timestamp).
//
// VERIFIED against the INSTALLED `@flue/runtime@1.0.0-beta.2` (NOT the @main
// design narrative — that drifted; corrections folded into flue-reference §0/§7):
//   - `EventStreamStore` (`dist/event-stream-store-*.d.mts`) read method is
//     **`readEvents(path, { offset?, limit? })`** (NOT `read(...)`), returning
//     `{ events: Array<{ data: unknown; offset: string }>, nextOffset: string,
//        upToDate: boolean, closed: boolean }`. `offset:"-1"` = from start.
//   - `runStreamPath`/`agentStreamPath` are NOT public exports; they are trivial
//     string templates (`handle-agent-*.mjs`): `runs/${runId}` and
//     `agents/${name}/${instanceId}`. Re-declared here as `streamPathForRun` /
//     `streamPathForAgent` to avoid reaching into an internal subpath.
//   - The persisted stream carries the `FlueEvent` union MINUS `turn_request`
//     (excluded — `docs/api/events-reference.md`). Every event is decorated with
//     `{ ...event, runId|instanceId, dispatchId?, submissionId?, v:1, eventIndex,
//        timestamp }`. The transcript-relevant types are `message_start`/
//     `message_end` (authoritative user/assistant messages), `tool_start`/`tool`
//     (tool calls + results), and `run_*`/`agent_*`/`log` (lifecycle). The
//     DETAILED message payloads (`message` on `message_end`, etc.) mirror
//     pi-agent-core's `AgentMessage` and are **explicitly NOT stable pre-1.0**,
//     so the adapter branches DEFENSIVELY on common content shapes rather than a
//     pinned type (Q7.1) — unknown shapes fall back to a stringified content,
//     never fabricated.
//
// The Flue `EventStreamStore`/`RunStore` are only obtainable from the configured
// persistence adapter's `connect()` (verified: `PersistenceStores`), which throws
// outside a configured runtime — so, exactly like `RunsReader` (Phase 2), the
// Flue read is behind an INJECTABLE `SessionReader` seam. The default export
// (`createDefaultSessionReader`) lazily `connect()`s our `src/db.ts` adapter; the
// routes + tests inject a fake and run fully offline.

import type { ListRunsResponse, RunPointer } from '@flue/runtime';
import type { MessagingThread } from '../threads-store.ts';

// ── Stream path helpers (re-declared — see header: NOT public exports) ────────
//
// VERIFIED string templates (handle-agent-*.mjs). Kept here so the read endpoint
// never imports a hashed internal chunk path. `agents/<name>/<instanceId>` and
// `runs/<runId>`.

/** Workflow-run event-stream path. */
export function streamPathForRun(runId: string): string {
  return `runs/${runId}`;
}
/** Chat/agent-thread event-stream path. `instanceId` = the dispatch `id`
 *  (= our chat `conversationKey`). */
export function streamPathForAgent(agentName: string, instanceId: string): string {
  return `agents/${agentName}/${instanceId}`;
}

// ── Dashboard transcript shapes (ported from the reference) ───────────────────
//
// Mirrors `lastlight/src/admin/sessions.ts` (`SessionMeta`) + `session-log.ts`
// (`JsonlMessage`) — the shapes the existing dashboard SPA + `src/cli.ts` render
// WITHOUT change. App-only fields Flue's stream lacks (tool_call_count derived,
// model from a turn event) are filled where derivable and null otherwise — never
// faked.

/** A single transcript message row (the dashboard's `JsonlMessage`). */
export interface TranscriptMessage {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content?: unknown;
  tool_calls?: Array<{ id?: string; name?: string; arguments?: unknown }>;
  tool_call_id?: string;
  timestamp?: string;
  model?: string;
}

/** Session list-row metadata (the dashboard's `SessionMeta`). Blob-free. */
export interface SessionMeta {
  id: string;
  source: string;
  /** Coarse session kind for the dashboard chip (workflow name / "chat"). */
  sessionType: string;
  /** Discriminator the dashboard uses to pick the transcript stream path:
   *  a workflow `run` (`runStreamPath`) or a `chat` thread (`agentStreamPath`). */
  kind: 'run' | 'chat';
  model: string | null;
  started_at: number;
  last_message_at: number | null;
  message_count: number;
  tool_call_count: number;
  conversation_message_count: number;
  last_assistant_content: string | null;
  agentIds: string[];
  platform?: string | null;
  // Honest Phase-7-later fields the run pointer cannot carry blob-free; the
  // transcript read fills the real counts. Not fabricated here.
}

// ── The injectable seam ───────────────────────────────────────────────────────
//
// Two methods mirror the two read paths. `listSessions` is BLOB-FREE (it must
// not load any transcript). `readTranscript` returns the raw decorated
// `FlueEvent`s for one session — the PURE adapter (`toTranscriptMessages`) maps
// them to `TranscriptMessage[]`, so the routes stay thin and the mapping is
// unit-testable with sample events.

/** One raw stream event as returned by `EventStreamStore.readEvents`. */
export interface RawStreamEvent {
  data: unknown;
  offset: string;
}

/** The result of reading a session's transcript stream (catch-up read). */
export interface TranscriptReadResult {
  events: RawStreamEvent[];
  /** Resume cursor for the next read (the stream's `nextOffset`). */
  nextOffset: string;
  /** True when the read reached the end of the currently-available events. */
  upToDate: boolean;
}

/**
 * The session/transcript data seam `createApp()` mounts the routes over.
 * Injected so the routes test OFFLINE with a fake; the default export wires the
 * real Flue `RunStore`/`EventStreamStore` (which throw outside a configured
 * runtime).
 */
export interface SessionReader {
  /** Blob-free session list (workflow runs, newest-first). NO transcripts. */
  listSessions(opts?: { limit?: number; cursor?: string }): Promise<{
    sessions: SessionMeta[];
    nextCursor: string | null;
  }>;
  /** True when a session id resolves to a known run/agent stream. */
  exists(id: string): Promise<boolean>;
  /**
   * Catch-up transcript read for one session. `kind` selects the stream path:
   * a workflow run (`runStreamPath`) or a chat-agent thread (`agentStreamPath`).
   * Defaults to `run`.
   */
  readTranscript(
    id: string,
    opts?: { offset?: string; limit?: number; kind?: 'run' | 'agent'; agentName?: string },
  ): Promise<TranscriptReadResult>;
}

// ── List adapter: RunPointer → SessionMeta (blob-free) ────────────────────────
//
// A workflow run IS a session. The pointer carries no transcript (the invariant),
// so message/tool counts are 0 in the list and the real counts come from the
// transcript read — honest, not fabricated. `started_at`/`last_message_at` are
// epoch SECONDS (the reference dashboard's unit). `sessionType` = the workflow
// name (the dashboard's chip).

const toEpochSeconds = (iso: string | undefined): number | null => {
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? null : ms / 1000;
};

export function toSessionMeta(p: RunPointer): SessionMeta {
  const started = toEpochSeconds(p.startedAt) ?? Date.now() / 1000;
  return {
    id: p.runId,
    source: 'run',
    sessionType: p.workflowName,
    kind: 'run',
    model: null, // not on a blob-free pointer; transcript read surfaces it
    started_at: started,
    last_message_at: toEpochSeconds(p.endedAt) ?? null,
    message_count: 0, // blob-free list — real count on transcript read
    tool_call_count: 0,
    conversation_message_count: 0,
    last_assistant_content: null,
    agentIds: [],
    platform: null,
  };
}

// ── List adapter: MessagingThread → SessionMeta (blob-free, kind:'chat') ──────
//
// A chat thread IS a session too — but its transcript lives in the chat-agent
// event stream (`agentStreamPath('chat', instanceId)`), NOT a workflow-run stream.
// The thread row (app-owned `messaging_threads`) carries the GROUPING metadata
// blob-free: channel/repo, last-activity, message-count. `agentIds:[instanceId]`
// fills the old `agentIds:[]` stub — the chat thread's transcript is read from
// `agentStreamPath('chat', instanceId)` (already wired). Timestamps → epoch
// seconds (the dashboard's unit).

const isoToEpochSeconds = (iso: string): number | null => {
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? null : ms / 1000;
};

export function toChatSessionMeta(t: MessagingThread): SessionMeta {
  const started = isoToEpochSeconds(t.createdAt) ?? Date.now() / 1000;
  return {
    id: t.instanceId,
    source: 'chat',
    sessionType: 'chat',
    kind: 'chat',
    model: null, // surfaced on the transcript read, not the grouping row
    started_at: started,
    last_message_at: isoToEpochSeconds(t.lastActivityAt),
    message_count: t.messageCount,
    tool_call_count: 0, // blob-free — real count on the transcript read
    conversation_message_count: t.messageCount,
    last_assistant_content: null,
    // The chat-agent instanceId IS the conversationKey — fills the agentIds stub.
    agentIds: [t.instanceId],
    platform: t.channel,
  };
}

// ── Transcript adapter: FlueEvent[] → TranscriptMessage[] (PURE) ──────────────
//
// The load-bearing, unit-tested mapping. Branches on the decorated event's
// `type`. Stable contract types are mapped directly; the (unstable) detailed
// `message` payloads are read defensively. Lifecycle/log/streaming-delta events
// are dropped from the transcript (they are not conversation messages) — except
// errors, surfaced as a `system` message so a failed run is visible.

/** A decorated stream event (loose — only `type` + the fields we read). */
type FlueStreamEvent = Record<string, unknown> & { type?: string };

/** Extract a plain-text rendering from a message's `content` (string | blocks). */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (b): b is { type?: string; text?: string } =>
          typeof b === 'object' && b !== null && (b as { type?: string }).type === 'text',
      )
      .map((b) => b.text ?? '')
      .join('');
  }
  return '';
}

/** Pull tool_use blocks out of an assistant message's content array. */
function toolCallsOf(content: unknown): TranscriptMessage['tool_calls'] | undefined {
  if (!Array.isArray(content)) return undefined;
  const calls = content
    .filter(
      (b): b is { type?: string; id?: string; name?: string; input?: unknown } =>
        typeof b === 'object' && b !== null && (b as { type?: string }).type === 'tool_use',
    )
    .map((b) => ({ id: b.id, name: b.name, arguments: b.input }));
  return calls.length ? calls : undefined;
}

/**
 * Map one session's raw stream events to the dashboard transcript. PURE: sample
 * events in, `TranscriptMessage[]` out. Mirrors the reference's jsonl
 * normalization, but over Flue's `FlueEvent` envelope.
 */
export function toTranscriptMessages(events: RawStreamEvent[]): TranscriptMessage[] {
  const out: TranscriptMessage[] = [];
  for (const { data } of events) {
    const ev = (data ?? {}) as FlueStreamEvent;
    const ts = typeof ev.timestamp === 'string' ? ev.timestamp : undefined;
    switch (ev.type) {
      // Authoritative completed user/assistant messages (stream of record).
      case 'message_end': {
        const msg = (ev.message ?? {}) as { role?: string; content?: unknown; model?: string };
        const role = msg.role === 'assistant' ? 'assistant' : 'user';
        const text = textOf(msg.content);
        const calls = role === 'assistant' ? toolCallsOf(msg.content) : undefined;
        // Skip an empty assistant turn that is pure tool_use with no text only
        // if there is also no tool call (nothing to show).
        if (!text && !calls) break;
        const row: TranscriptMessage = { role, content: text, timestamp: ts };
        if (calls) row.tool_calls = calls;
        if (role === 'assistant' && typeof msg.model === 'string') row.model = msg.model;
        out.push(row);
        break;
      }
      // Tool execution result → a `tool` row (mirrors the reference's tool role;
      // `tool_call_id` correlates back to the assistant's `tool_calls[].id`).
      case 'tool': {
        const result = ev.result ?? ev.error ?? null;
        out.push({
          role: 'tool',
          content: result,
          tool_call_id: typeof ev.toolCallId === 'string' ? ev.toolCallId : undefined,
          timestamp: ts,
        });
        break;
      }
      // Surface a terminal error so a failed run isn't a silent empty transcript.
      case 'run_end': {
        if (ev.isError) {
          out.push({
            role: 'system',
            content: serializeError(ev.error),
            timestamp: ts,
          });
        }
        break;
      }
      // Everything else (run_start/resume, agent_start/end, idle, turn*,
      // text_delta/thinking_*, log, operation*, compaction*) is lifecycle /
      // streaming progress — NOT a transcript message. Dropped.
      default:
        break;
    }
  }
  return out;
}

function serializeError(error: unknown): string {
  if (error == null) return 'run errored';
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && 'message' in (error as object)) {
    return String((error as { message?: unknown }).message ?? 'run errored');
  }
  return JSON.stringify(error);
}

// ── Default (production) SessionReader — wires the real Flue stores ───────────
//
// Lazily `connect()`s the persistence adapter to obtain `{ runStore,
// eventStreamStore }`. `connect()` throws outside a configured runtime (in tests
// the seam is faked, so this never runs offline). The handle is cached after the
// first connect.

/** The minimal Flue store surface this reader needs (for typing the adapter). */
interface FlueStoresLike {
  runStore: { listRuns(opts?: { limit?: number; cursor?: string }): Promise<ListRunsResponse> };
  eventStreamStore: {
    readEvents(
      path: string,
      opts?: { offset?: string; limit?: number },
    ): Promise<{
      events: Array<{ data: unknown; offset: string }>;
      nextOffset: string;
      upToDate: boolean;
    }>;
    getStreamMeta(path: string): Promise<{ nextOffset: string } | null>;
  };
}

/** Lists app-owned chat threads (the `messaging_threads` table) blob-free. */
export interface ThreadLister {
  listThreads(opts?: { limit?: number; cursor?: string }): {
    threads: MessagingThread[];
    nextCursor: string | null;
  };
}

export interface DefaultSessionReaderOptions {
  /** Override the store-connector (tests). Default: connect `src/db.ts`. */
  connect?: () => Promise<FlueStoresLike>;
  /** Default agent name for agent-stream transcripts (chat threads). */
  defaultAgentName?: string;
  /**
   * The app-owned chat-thread grouping source (`messaging_threads`). When wired,
   * `listSessions` MERGES chat threads (kind:'chat') into the run list, newest
   * activity first. Injected so tests run offline; the default lazily opens the
   * on-disk threads-store. Omit to list workflow runs only.
   */
  threadLister?: ThreadLister | (() => ThreadLister);
}

/**
 * The production session reader. Opens the Flue persistence adapter ONCE
 * (cached), reads the run list via `RunStore.listRuns` and transcripts via
 * `EventStreamStore.readEvents`. Wired by `app.ts`'s default export.
 */
export function createDefaultSessionReader(
  opts: DefaultSessionReaderOptions = {},
): SessionReader {
  const agentName = opts.defaultAgentName ?? 'chat';
  let storesPromise: Promise<FlueStoresLike> | null = null;

  // The chat-thread grouping source. Resolved lazily (a function form opens the
  // on-disk threads-store on first use); a missing/failing source is NON-FATAL —
  // the session list degrades to workflow runs only, never errors.
  const resolveThreadLister = (): ThreadLister | null => {
    const tl = opts.threadLister;
    if (!tl) return null;
    return typeof tl === 'function' ? tl() : tl;
  };
  const listChatSessions = (listOpts?: {
    limit?: number;
    cursor?: string;
  }): SessionMeta[] => {
    try {
      const lister = resolveThreadLister();
      if (!lister) return [];
      const res = lister.listThreads({ limit: listOpts?.limit });
      return res.threads.map(toChatSessionMeta);
    } catch (err) {
      // NON-FATAL: a thread-list failure must not break the sessions list.
      console.error('[sessions] chat-thread list failed (non-fatal):', err);
      return [];
    }
  };

  const connect = async (): Promise<FlueStoresLike> => {
    if (!storesPromise) {
      storesPromise = (
        opts.connect
          ? Promise.resolve(opts.connect())
          : import('../db.ts').then((m) => {
              const adapter = m.default as {
                connect: () => FlueStoresLike | Promise<FlueStoresLike>;
              };
              return adapter.connect();
            })
      ).catch((err) => {
        // Reset so a transient connect failure can be retried on next request.
        storesPromise = null;
        throw err;
      });
    }
    return storesPromise;
  };

  return {
    async listSessions(listOpts) {
      const stores = await connect();
      const res = await stores.runStore.listRuns({
        limit: listOpts?.limit,
        cursor: listOpts?.cursor,
      });
      // MERGE workflow runs (kind:'run') + chat threads (kind:'chat'), newest
      // activity first. Both blob-free. Chat threads fill the old `agentIds:[]`
      // stub; their transcripts come from `agentStreamPath('chat', instanceId)`.
      const runs = res.runs.map(toSessionMeta);
      const chats = listChatSessions(listOpts);
      const merged = [...runs, ...chats].sort(
        (a, b) =>
          (b.last_message_at ?? b.started_at) - (a.last_message_at ?? a.started_at),
      );
      return {
        sessions: merged,
        // The runs cursor still drives run pagination; chat threads are a small
        // bounded set (the first page covers them). Honest: chat threads aren't
        // re-paginated by this cursor.
        nextCursor: res.nextCursor ?? null,
      };
    },
    async exists(id) {
      const stores = await connect();
      const meta = await stores.eventStreamStore.getStreamMeta(streamPathForRun(id));
      if (meta) return true;
      // Fall back to the chat-agent stream path.
      const agentMeta = await stores.eventStreamStore.getStreamMeta(
        streamPathForAgent(agentName, id),
      );
      return agentMeta !== null;
    },
    async readTranscript(id, readOpts) {
      const stores = await connect();
      const path =
        readOpts?.kind === 'agent'
          ? streamPathForAgent(readOpts.agentName ?? agentName, id)
          : streamPathForRun(id);
      const res = await stores.eventStreamStore.readEvents(path, {
        offset: readOpts?.offset ?? '-1',
        limit: readOpts?.limit,
      });
      return {
        events: res.events,
        nextOffset: res.nextOffset,
        upToDate: res.upToDate,
      };
    },
  };
}
