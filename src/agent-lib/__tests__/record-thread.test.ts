import { describe, it, expect, afterEach } from 'vitest';
import {
  recordThreadActivity,
  setThreadRecorder,
  type ThreadActivity,
} from '../record-thread.ts';

// Phase 7 final slice — the shared chat-thread recorder seam: given a
// conversationKey, records a thread activity (the channel chat-dispatch path).
// TEST-INERT (no recorder wired → no write) + NON-FATAL (a write error never
// throws).

afterEach(() => {
  setThreadRecorder(null); // reset the seam to inert between tests
});

describe('recordThreadActivity', () => {
  it('records via an injected recorder (passes the conversationKey through)', () => {
    const seen: ThreadActivity[] = [];
    setThreadRecorder({ record: (a) => seen.push(a) });
    recordThreadActivity('slack:v1:T1:C2:100.1');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.instanceId).toBe('slack:v1:T1:C2:100.1');
  });

  it('forwards an explicit channel/meta/title when supplied', () => {
    const seen: ThreadActivity[] = [];
    setThreadRecorder({ record: (a) => seen.push(a) });
    recordThreadActivity('k', { channel: 'github', meta: { repo: 'o/r' }, title: 'T' });
    expect(seen[0]).toMatchObject({
      instanceId: 'k',
      channel: 'github',
      meta: { repo: 'o/r' },
      title: 'T',
    });
  });

  it('is inert when no recorder is wired (no throw, no write)', () => {
    setThreadRecorder(null);
    expect(() => recordThreadActivity('slack:v1:T:C:1')).not.toThrow();
  });

  it('is NON-FATAL when the recorder throws', () => {
    setThreadRecorder({
      record: () => {
        throw new Error('disk full');
      },
    });
    expect(() => recordThreadActivity('slack:v1:T:C:1')).not.toThrow();
  });
});
