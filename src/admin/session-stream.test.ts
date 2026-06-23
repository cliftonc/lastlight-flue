import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import {
  mountSessionStreamRoutes,
  mountChatSessionJsonRoutes,
  sessionsSignature,
  transcriptToMessages,
  type SessionStreamSource,
} from './session-stream.ts';
import type { SessionMeta } from './session-reader.ts';

// Phase 7 · SSE slice — tests for the live session-list + message SSE streams
// and the chat catch-up JSON routes. Runs fully OFFLINE against a fake reader:
// no Flue runtime, no timers we can't drain (a one-snapshot fake makes the first
// push the only content we assert; the poll loop is abandoned when we abort the
// stream by reading only the first chunk).

const meta = (over: Partial<SessionMeta> = {}): SessionMeta => ({
  id: 'run_a',
  source: 'run',
  sessionType: 'build',
  kind: 'run',
  model: null,
  started_at: 1000,
  last_message_at: 2000,
  message_count: 3,
  tool_call_count: 0,
  conversation_message_count: 3,
  last_assistant_content: null,
  agentIds: [],
  platform: null,
  ...over,
});

const ev = (data: Record<string, unknown>, offset: string) => ({
  data: { v: 1, timestamp: '2026-06-23T10:00:00.000Z', ...data },
  offset,
});

/** Read an SSE Response body, parsing only as many `event:`/`data:` frames as
 *  `n` (so we don't hang on the never-ending poll loop). */
async function readFrames(
  res: Response,
  n: number,
): Promise<Array<{ event?: string; data: string }>> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const frames: Array<{ event?: string; data: string }> = [];
  while (frames.length < n) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    // SSE frames are separated by a blank line.
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event: string | undefined;
      const dataLines: string[] = [];
      for (const line of raw.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
      }
      frames.push({ event, data: dataLines.join('\n') });
      if (frames.length >= n) break;
    }
  }
  await reader.cancel().catch(() => {});
  return frames;
}

describe('sessionsSignature', () => {
  it('changes when a row activity / count changes, stable otherwise', () => {
    const a = [meta()];
    expect(sessionsSignature(a)).toBe(sessionsSignature([meta()]));
    expect(sessionsSignature(a)).not.toBe(
      sessionsSignature([meta({ message_count: 4 })]),
    );
    expect(sessionsSignature(a)).not.toBe(
      sessionsSignature([meta({ last_message_at: 9999 })]),
    );
  });
});

describe('transcriptToMessages — monotonic numeric ids', () => {
  it('assigns sequential ids by transcript index', () => {
    const events = [
      ev({ type: 'message_end', message: { role: 'user', content: 'hi' } }, '0_1'),
      ev({ type: 'message_end', message: { role: 'assistant', content: 'yo' } }, '0_2'),
    ];
    const msgs = transcriptToMessages(events);
    expect(msgs.map((m) => m.id)).toEqual([0, 1]);
    expect(msgs[0]).toMatchObject({ id: 0, role: 'user', content: 'hi' });
  });
});

function fakeSource(over: Partial<SessionStreamSource> = {}): SessionStreamSource {
  return {
    async listSessions() {
      return { sessions: [meta()], nextCursor: null };
    },
    async exists() {
      return true;
    },
    async readTranscript() {
      return {
        events: [
          ev({ type: 'message_end', message: { role: 'user', content: 'hi' } }, '0_1'),
          ev({ type: 'message_end', message: { role: 'assistant', content: 'yo' } }, '0_2'),
        ],
        nextOffset: '0_2',
        upToDate: true,
      };
    },
    ...over,
  };
}

describe('session-list SSE stream', () => {
  it('emits an initial `sessions` snapshot with {sessions} data', async () => {
    const app = new Hono();
    mountSessionStreamRoutes(app, fakeSource(), '/sessions', 'run');
    const res = await app.request('/sessions/stream?limit=10');
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const [frame] = await readFrames(res, 1);
    expect(frame!.event).toBe('sessions');
    expect(JSON.parse(frame!.data)).toEqual({ sessions: [meta()] });
  });

  it('list-stream `/stream` is NOT shadowed by a pre-registered `/:id` (ordering)', async () => {
    // Integration hazard: Hono matches in registration order, so the literal
    // `/sessions/stream` MUST be registered BEFORE the existing `/sessions/:id`
    // route or it resolves to the :id handler. mountSessionStreamRoutes itself
    // registers the list-stream first; the integrator must mount it ahead of the
    // existing `/sessions/:id` GET. This asserts the in-module ordering is right.
    const app = new Hono();
    mountSessionStreamRoutes(app, fakeSource(), '/sessions', 'run');
    app.get('/sessions/:id', (c) => c.json({ shadowed: c.req.param('id') }));
    const res = await app.request('/sessions/stream?limit=10');
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const [frame] = await readFrames(res, 1);
    expect(frame!.event).toBe('sessions');
  });

  it('emits a named `error` event when listSessions throws', async () => {
    const app = new Hono();
    mountSessionStreamRoutes(
      app,
      fakeSource({
        async listSessions() {
          throw new Error('boom');
        },
      }),
      '/sessions',
      'run',
    );
    const res = await app.request('/sessions/stream');
    const [frame] = await readFrames(res, 1);
    expect(frame!.event).toBe('error');
    expect(JSON.parse(frame!.data)).toEqual({ message: 'boom' });
  });
});

describe('per-session message SSE stream', () => {
  it('backfills `message` events (id>since) then a `ready` event', async () => {
    const app = new Hono();
    mountSessionStreamRoutes(app, fakeSource(), '/sessions', 'run');
    const res = await app.request('/sessions/run_a/stream?since=-1');
    const frames = await readFrames(res, 3);
    expect(frames[0]!.event).toBe('message');
    expect(JSON.parse(frames[0]!.data)).toMatchObject({ id: 0, role: 'user', content: 'hi' });
    expect(frames[1]!.event).toBe('message');
    expect(JSON.parse(frames[1]!.data)).toMatchObject({ id: 1, role: 'assistant' });
    expect(frames[2]!.event).toBe('ready');
    expect(frames[2]!.data).toBe('');
  });

  it('only backfills messages with id > since', async () => {
    const app = new Hono();
    mountSessionStreamRoutes(app, fakeSource(), '/sessions', 'run');
    const res = await app.request('/sessions/run_a/stream?since=0');
    const frames = await readFrames(res, 2);
    // id 0 is skipped (since=0); id 1 emitted, then ready.
    expect(frames[0]!.event).toBe('message');
    expect(JSON.parse(frames[0]!.data)).toMatchObject({ id: 1 });
    expect(frames[1]!.event).toBe('ready');
  });

  it('emits `ready` even when the session has no messages yet', async () => {
    const app = new Hono();
    mountSessionStreamRoutes(
      app,
      fakeSource({
        async readTranscript() {
          return { events: [], nextOffset: '-1', upToDate: true };
        },
      }),
      '/sessions',
      'run',
    );
    const res = await app.request('/sessions/run_a/stream?since=-1');
    const [frame] = await readFrames(res, 1);
    expect(frame!.event).toBe('ready');
  });

  it('404s when the session does not exist', async () => {
    const app = new Hono();
    mountSessionStreamRoutes(
      app,
      fakeSource({
        async exists() {
          return false;
        },
      }),
      '/sessions',
      'run',
    );
    const res = await app.request('/sessions/nope/stream');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'session not found' });
  });
});

describe('chat-session catch-up JSON routes', () => {
  it('GET /chat-sessions → { sessions, liveCount, nextCursor }', async () => {
    const app = new Hono();
    mountChatSessionJsonRoutes(app, fakeSource(), '/chat-sessions', 'agent');
    const res = await app.request('/chat-sessions?limit=5');
    expect(await res.json()).toEqual({
      sessions: [meta()],
      liveCount: 0,
      nextCursor: null,
    });
  });

  it('GET /chat-sessions/:id/messages → { source, messages, last_id } catch-up', async () => {
    const app = new Hono();
    mountChatSessionJsonRoutes(app, fakeSource(), '/chat-sessions', 'agent');
    const res = await app.request('/chat-sessions/abc/messages?since=-1');
    const body = (await res.json()) as { source: string; messages: unknown[]; last_id: number };
    expect(body.source).toBe('flue');
    expect(body.messages).toHaveLength(2);
    expect(body.last_id).toBe(1);
  });

  it('GET /chat-sessions/:id/messages respects since', async () => {
    const app = new Hono();
    mountChatSessionJsonRoutes(app, fakeSource(), '/chat-sessions', 'agent');
    const res = await app.request('/chat-sessions/abc/messages?since=0');
    const body = (await res.json()) as { messages: Array<{ id: number }> };
    expect(body.messages.map((m) => m.id)).toEqual([1]);
  });

  it('GET /chat-sessions/:id/messages → none when session absent', async () => {
    const app = new Hono();
    mountChatSessionJsonRoutes(
      app,
      fakeSource({
        async exists() {
          return false;
        },
      }),
      '/chat-sessions',
      'agent',
    );
    const res = await app.request('/chat-sessions/x/messages?since=5');
    expect(await res.json()).toEqual({ source: 'none', messages: [], last_id: 5 });
  });
});
