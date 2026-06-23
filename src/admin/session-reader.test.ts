import { describe, it, expect } from 'vitest';
import type { RunPointer } from '@flue/runtime';
import {
  toSessionMeta,
  toTranscriptMessages,
  streamPathForRun,
  streamPathForAgent,
  type RawStreamEvent,
} from './session-reader.ts';

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
});
