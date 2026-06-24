import { describe, it, expect } from 'vitest';
import type { RunPointer } from '@flue/runtime';
import {
  toSessionMeta,
  toChatSessionMeta,
  toTranscriptMessages,
  streamPathForRun,
  streamPathForAgent,
  createDefaultSessionReader,
  readFullTranscript,
  filterEventsByOperation,
  derivePhases,
  type RawStreamEvent,
  type ThreadLister,
} from './session-reader.ts';
import type { MessagingThread } from '../threads-store.ts';

// Phase 7 · slice 1 — PURE unit tests for the Flue-event-stream → dashboard
// transcript adapter and the blob-free RunPointer → SessionMeta list adapter.
// Sample Flue events in, dashboard shapes out. No runtime, no HTTP. These pin
// the verified event-stream envelope mapping (message_end / tool / run_end) and
// the blob-free list projection.

describe('stream path helpers (verified templates)', () => {
  it('runStreamPath / agentStreamPath match the installed conventions', () => {
    expect(streamPathForRun('run_01H')).toBe('runs/run_01H');
    expect(streamPathForAgent('chat', 'thread-7')).toBe('agents/chat/thread-7');
  });
});

describe('toSessionMeta (RunPointer → SessionMeta, blob-free)', () => {
  const pointer: RunPointer = {
    runId: 'run_a',
    workflowName: 'build',
    status: 'completed',
    startedAt: '2026-06-23T10:00:00.000Z',
    endedAt: '2026-06-23T10:05:00.000Z',
  };

  it('projects id/sessionType/timing without reading a transcript', () => {
    const m = toSessionMeta(pointer);
    expect(m.id).toBe('run_a');
    expect(m.sessionType).toBe('build'); // workflow name = the dashboard chip
    expect(m.source).toBe('run');
    expect(m.started_at).toBe(Date.parse('2026-06-23T10:00:00.000Z') / 1000);
    expect(m.last_message_at).toBe(Date.parse('2026-06-23T10:05:00.000Z') / 1000);
  });

  it('leaves blob-derived counts at 0 and model null (filled on transcript read)', () => {
    const m = toSessionMeta(pointer);
    expect(m.message_count).toBe(0);
    expect(m.tool_call_count).toBe(0);
    expect(m.conversation_message_count).toBe(0);
    expect(m.model).toBeNull();
    expect(m.last_assistant_content).toBeNull();
  });

  it('handles a running run with no endedAt (null last_message_at)', () => {
    const m = toSessionMeta({ ...pointer, status: 'active', endedAt: undefined });
    expect(m.last_message_at).toBeNull();
  });
});

describe('toChatSessionMeta (MessagingThread → SessionMeta, kind:chat)', () => {
  const thread: MessagingThread = {
    instanceId: 'slack:v1:T1:C2:100.1',
    channel: 'slack',
    repo: null,
    meta: { teamId: 'T1', channelId: 'C2', threadTs: '100.1' },
    title: null,
    createdAt: '2026-06-23T09:00:00.000Z',
    lastActivityAt: '2026-06-23T09:30:00.000Z',
    messageCount: 4,
  };

  it('projects a chat thread to a kind:chat session row (fills agentIds stub)', () => {
    const m = toChatSessionMeta(thread);
    expect(m.id).toBe('slack:v1:T1:C2:100.1');
    expect(m.kind).toBe('chat');
    expect(m.source).toBe('chat');
    expect(m.sessionType).toBe('chat');
    expect(m.platform).toBe('slack');
    expect(m.message_count).toBe(4);
    // The agentIds stub is FILLED with the chat-agent instanceId (= conversationKey).
    expect(m.agentIds).toEqual(['slack:v1:T1:C2:100.1']);
    expect(m.started_at).toBe(Date.parse('2026-06-23T09:00:00.000Z') / 1000);
    expect(m.last_message_at).toBe(Date.parse('2026-06-23T09:30:00.000Z') / 1000);
  });
});

describe('createDefaultSessionReader.listSessions — merges runs + chat threads', () => {
  const runPointer: RunPointer = {
    runId: 'run_a',
    workflowName: 'build',
    status: 'completed',
    startedAt: '2026-06-23T08:00:00.000Z',
    endedAt: '2026-06-23T08:30:00.000Z', // last activity 08:30
  };
  const chatThread: MessagingThread = {
    instanceId: 'slack:v1:T1:C2:100.1',
    channel: 'slack',
    repo: null,
    meta: {},
    title: null,
    createdAt: '2026-06-23T09:00:00.000Z',
    lastActivityAt: '2026-06-23T09:30:00.000Z', // newer activity → sorts first
    messageCount: 4,
  };

  const fakeStores = {
    runStore: {
      async listRuns() {
        return { runs: [runPointer], nextCursor: undefined };
      },
    },
    eventStreamStore: {
      async readEvents() {
        return { events: [], nextOffset: '-1', upToDate: true };
      },
      async getStreamMeta() {
        return null;
      },
    },
  };

  const fakeThreadLister = (threads: MessagingThread[]): ThreadLister => ({
    listThreads: () => ({ threads, nextCursor: null }),
  });

  it('merges chat threads (kind:chat) with workflow runs (kind:run), newest activity first', async () => {
    const reader = createDefaultSessionReader({
      connect: async () => fakeStores as never,
      threadLister: fakeThreadLister([chatThread]),
    });
    const { sessions } = await reader.listSessions();
    expect(sessions).toHaveLength(2);
    // Chat thread (09:30) sorts ahead of the run (08:30).
    expect(sessions.map((s) => s.kind)).toEqual(['chat', 'run']);
    expect(sessions[0]!.id).toBe('slack:v1:T1:C2:100.1');
    expect(sessions[1]!.id).toBe('run_a');
  });

  it('lists workflow runs only when no threadLister is wired (degrades cleanly)', async () => {
    const reader = createDefaultSessionReader({
      connect: async () => fakeStores as never,
    });
    const { sessions } = await reader.listSessions();
    expect(sessions.map((s) => s.kind)).toEqual(['run']);
  });

  it('is NON-FATAL: a throwing threadLister degrades to runs only, no error', async () => {
    const reader = createDefaultSessionReader({
      connect: async () => fakeStores as never,
      threadLister: () => {
        throw new Error('threads-store unavailable');
      },
    });
    const { sessions } = await reader.listSessions();
    expect(sessions.map((s) => s.kind)).toEqual(['run']);
  });
});

// Sample decorated FlueEvents as they land on the durable stream (verified
// envelope: { ...event, runId|instanceId, v:1, eventIndex, timestamp }).
const ev = (data: Record<string, unknown>, offset: string): RawStreamEvent => ({
  data: { v: 1, eventIndex: 0, timestamp: '2026-06-23T10:00:00.000Z', ...data },
  offset,
});

describe('toTranscriptMessages (FlueEvent[] → transcript)', () => {
  it('maps message_end user + assistant messages to role/content rows', () => {
    const events = [
      ev({ type: 'run_start', workflowName: 'chat' }, '0_1'),
      ev({ type: 'message_start' }, '0_2'),
      ev({ type: 'message_end', message: { role: 'user', content: 'hello there' } }, '0_3'),
      ev(
        {
          type: 'message_end',
          message: { role: 'assistant', content: 'hi back', model: 'openai/gpt-x' },
        },
        '0_4',
      ),
    ];
    const msgs = toTranscriptMessages(events);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toMatchObject({ role: 'user', content: 'hello there' });
    expect(msgs[1]).toMatchObject({ role: 'assistant', content: 'hi back', model: 'openai/gpt-x' });
  });

  it('extracts text + tool_use blocks from an assistant content array', () => {
    const events = [
      ev(
        {
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'let me check' },
              { type: 'tool_use', id: 'tu_1', name: 'github_read', input: { repo: 'x' } },
            ],
          },
        },
        '0_1',
      ),
    ];
    const msg = toTranscriptMessages(events)[0]!;
    expect(msg.content).toBe('let me check');
    expect(msg.tool_calls).toEqual([
      { id: 'tu_1', name: 'github_read', arguments: { repo: 'x' } },
    ]);
  });

  it('maps a tool event to a tool row with its tool_call_id', () => {
    const events = [
      ev({ type: 'tool', toolName: 'github_read', toolCallId: 'tu_1', result: { ok: true } }, '0_1'),
    ];
    const msg = toTranscriptMessages(events)[0]!;
    expect(msg.role).toBe('tool');
    expect(msg.tool_call_id).toBe('tu_1');
    expect(msg.content).toEqual({ ok: true });
  });

  it('surfaces a terminal run error as a system message', () => {
    const events = [
      ev({ type: 'run_end', isError: true, error: { message: 'boom' } }, '0_1'),
    ];
    const msg = toTranscriptMessages(events)[0]!;
    expect(msg.role).toBe('system');
    expect(msg.content).toBe('boom');
  });

  it('drops lifecycle / streaming-delta / log events (not transcript messages)', () => {
    const events = [
      ev({ type: 'run_start' }, '0_1'),
      ev({ type: 'agent_start' }, '0_2'),
      ev({ type: 'text_delta', text: 'par' }, '0_3'),
      ev({ type: 'turn', usage: { totalTokens: 5 } }, '0_4'),
      ev({ type: 'log', level: 'info', message: 'x' }, '0_5'),
      ev({ type: 'run_end', isError: false, result: 'done' }, '0_6'),
    ];
    expect(toTranscriptMessages(events)).toHaveLength(0);
  });

  it('falls back gracefully on an unknown message content shape (never throws)', () => {
    const events = [
      ev({ type: 'message_end', message: { role: 'assistant', content: { weird: true } } }, '0_1'),
    ];
    // Non-string/array content → empty text, no tool calls → row skipped (nothing
    // to render), but no throw.
    expect(() => toTranscriptMessages(events)).not.toThrow();
    expect(toTranscriptMessages(events)).toHaveLength(0);
  });

  it("maps Flue's `toolCall` blocks (args under `arguments`) to assistant tool_calls", () => {
    const events = [
      ev(
        {
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'hmm' },
              { type: 'toolCall', id: 'call_1', name: 'github_get_issue', arguments: { number: 277 } },
            ],
          },
        },
        '0_1',
      ),
    ];
    const rows = toTranscriptMessages(events);
    // A thinking+toolCall turn (no text) is KEPT because it carries a tool call.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.role).toBe('assistant');
    expect(rows[0]!.tool_calls).toEqual([
      { id: 'call_1', name: 'github_get_issue', arguments: { number: 277 } },
    ]);
  });

  it('skips `toolResult` role message_end (deduped by the canonical `tool` event)', () => {
    // Flue emits a tool result as BOTH a `tool` event and a `toolResult`
    // message_end. Only the `tool` event should produce a row — the toolResult
    // must NOT become a bogus `user` message of raw tool-output JSON.
    const events = [
      ev({ type: 'tool', toolName: 'github_get_issue', toolCallId: 'call_1', result: '{"number":277}' }, '0_1'),
      ev(
        {
          type: 'message_end',
          message: { role: 'toolResult', content: [{ type: 'text', text: '{"number":277}' }] },
        },
        '0_2',
      ),
    ];
    const rows = toTranscriptMessages(events);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.role).toBe('tool');
    expect(rows.some((r) => r.role === 'user')).toBe(false);
  });
});

describe('readFullTranscript (drains every page)', () => {
  it('concatenates pages until upToDate (no first-page truncation)', async () => {
    // A fake whose readEvents returns 2 events per page across 3 pages — exactly
    // the truncation bug's shape (a single read would stop at page 1).
    const pages = [
      { events: [ev({ type: 'a' }, '0_1'), ev({ type: 'b' }, '0_2')], nextOffset: '0_2', upToDate: false },
      { events: [ev({ type: 'c' }, '0_3'), ev({ type: 'd' }, '0_4')], nextOffset: '0_4', upToDate: false },
      { events: [ev({ type: 'e' }, '0_5')], nextOffset: '0_5', upToDate: true },
    ];
    let call = 0;
    const reader = {
      async readTranscript() {
        return pages[call++]!;
      },
    };
    const res = await readFullTranscript(reader, 'run_x');
    expect(res.events).toHaveLength(5);
    expect(res.nextOffset).toBe('0_5');
    expect(call).toBe(3);
  });

  it('stops on an empty page (no infinite loop)', async () => {
    const reader = {
      async readTranscript() {
        return { events: [] as RawStreamEvent[], nextOffset: '-1', upToDate: false };
      },
    };
    const res = await readFullTranscript(reader, 'run_x');
    expect(res.events).toHaveLength(0);
  });
});

describe('filterEventsByOperation + derivePhases (run-history pipeline)', () => {
  const stream = [
    ev({ type: 'run_start' }, '0_0'),
    ev({ type: 'agent_start', operationId: 'op1', session: 'guardrails', timestamp: 't1' }, '0_1'),
    ev({ type: 'message_end', operationId: 'op1', message: { role: 'user', content: 'go' }, timestamp: 't2' }, '0_2'),
    ev({ type: 'tool', operationId: 'op1', toolName: 'x', result: 'ok', timestamp: 't3' }, '0_3'),
    ev({ type: 'agent_end', operationId: 'op1', timestamp: 't4' }, '0_4'),
    ev({ type: 'agent_start', operationId: 'op2', session: 'architect', timestamp: 't5' }, '0_5'),
    ev({ type: 'message_end', operationId: 'op2', message: { role: 'assistant', content: 'done' }, timestamp: 't6' }, '0_6'),
    ev({ type: 'agent_end', operationId: 'op2', isError: true, timestamp: 't7' }, '0_7'),
    ev({ type: 'run_end' }, '0_8'),
  ];

  it('filters events to one operation', () => {
    expect(filterEventsByOperation(stream, 'op1')).toHaveLength(4);
    expect(filterEventsByOperation(stream, 'op2')).toHaveLength(3);
    expect(filterEventsByOperation(stream, 'nope')).toHaveLength(0);
  });

  it('derives ordered phases keyed by operation, named by session', () => {
    const phases = derivePhases(stream);
    expect(phases).toHaveLength(2);
    expect(phases[0]).toMatchObject({
      operationId: 'op1',
      name: 'guardrails',
      index: 0,
      messageCount: 1,
      toolCount: 1,
      isError: false,
      startedAt: 't1',
      endedAt: 't4',
    });
    expect(phases[1]).toMatchObject({
      operationId: 'op2',
      name: 'architect',
      index: 1,
      messageCount: 1,
      toolCount: 0,
      isError: true,
    });
  });

  it('falls back to a `default` phase name when no agent_start session is present', () => {
    const single = [
      ev({ type: 'operation_start', operationId: 'opX' }, '0_1'),
      ev({ type: 'message_end', operationId: 'opX', message: { role: 'user', content: 'hi' } }, '0_2'),
    ];
    const phases = derivePhases(single);
    expect(phases).toHaveLength(1);
    expect(phases[0]!.name).toBe('default');
  });

  it('returns no phases for a run with only run-level events', () => {
    expect(derivePhases([ev({ type: 'run_start' }, '0_0'), ev({ type: 'run_end' }, '0_1')])).toHaveLength(0);
  });

  it('labels a subagent task by its parent (phase) session and drops the empty dispatch parent', () => {
    // Mirrors a build phase: a `session.task()` dispatch op on the coordinator (no
    // agent_start, no messages) + the child subagent op running in `task:architect:<id>`
    // with parentSession='architect'.
    const stream = [
      ev({ type: 'operation_start', operationId: 'dispatch', session: 'architect', operationKind: 'task', timestamp: 't0' }, '0_0'),
      ev({ type: 'agent_start', operationId: 'child', session: 'task:architect:abc123', parentSession: 'architect', timestamp: 't1' }, '0_1'),
      ev({ type: 'message_end', operationId: 'child', message: { role: 'assistant', content: 'plan' }, timestamp: 't2' }, '0_2'),
      ev({ type: 'agent_end', operationId: 'child', timestamp: 't3' }, '0_3'),
    ];
    const phases = derivePhases(stream);
    expect(phases).toHaveLength(1);
    expect(phases[0]).toMatchObject({ operationId: 'child', name: 'architect', index: 0, messageCount: 1 });
  });
});
