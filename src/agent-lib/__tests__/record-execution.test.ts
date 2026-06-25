import { describe, it, expect, afterEach } from 'vitest';
import {
  recordExecution,
  runPhasePrompt,
  setExecutionRecorder,
  setPhaseRetryConfig,
  isTransientModelError,
  toExecutionRow,
  type PromptUsageResponse,
} from '../record-execution.ts';
import type { ExecutionRow } from '../../stats-store.ts';

// Phase 7 slice 2 — the shared recording helper: given a fake prompt-usage response,
// records the right `executions` row (runId/workflow/phase/model/tokens/cost). It is
// TEST-INERT (no recorder wired → no write) and NON-FATAL (a write error never throws).

const usage = (): PromptUsageResponse => ({
  text: 'hello',
  usage: {
    input: 100,
    output: 25,
    totalTokens: 125,
    cost: { total: 0.42 },
  },
  model: { provider: 'openai', id: 'gpt-x' },
});

afterEach(() => {
  setExecutionRecorder(null); // reset the seam to inert between tests
});

describe('toExecutionRow', () => {
  it('maps usage + model into a row', () => {
    const r = toExecutionRow({ runId: 'run-9', workflow: 'build', phase: 'architect' }, usage());
    expect(r).toEqual<ExecutionRow>({
      runId: 'run-9',
      workflow: 'build',
      phase: 'architect',
      model: 'openai/gpt-x',
      inputTokens: 100,
      outputTokens: 25,
      totalTokens: 125,
      costTotal: 0.42,
    });
  });

  it('defaults missing usage/model to zeros/empty (never fabricated)', () => {
    const r = toExecutionRow({ runId: '', workflow: 'pr-review', phase: 'review' }, { text: 'x' });
    expect(r.model).toBe('');
    expect(r.inputTokens).toBe(0);
    expect(r.outputTokens).toBe(0);
    expect(r.totalTokens).toBe(0);
    expect(r.costTotal).toBe(0);
  });

  it('derives totalTokens from input+output when absent', () => {
    const r = toExecutionRow(
      { runId: 'r', workflow: 'w', phase: 'p' },
      { text: 'x', usage: { input: 3, output: 4 } },
    );
    expect(r.totalTokens).toBe(7);
  });
});

describe('recordExecution', () => {
  it('records via an injected recorder', () => {
    const rows: ExecutionRow[] = [];
    setExecutionRecorder({ record: (row) => rows.push(row) });
    recordExecution({ runId: 'run-1', workflow: 'build', phase: 'executor' }, usage());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ runId: 'run-1', workflow: 'build', phase: 'executor', costTotal: 0.42 });
  });

  it('is inert when no recorder is wired (no throw, no write)', () => {
    setExecutionRecorder(null);
    expect(() => recordExecution({ runId: 'r', workflow: 'w', phase: 'p' }, usage())).not.toThrow();
  });

  it('is NON-FATAL when the recorder throws', () => {
    setExecutionRecorder({
      record: () => {
        throw new Error('disk full');
      },
    });
    expect(() => recordExecution({ runId: 'r', workflow: 'w', phase: 'p' }, usage())).not.toThrow();
  });
});

describe('runPhasePrompt', () => {
  it('prompts the session, records usage, and returns the response', async () => {
    const rows: ExecutionRow[] = [];
    setExecutionRecorder({ record: (row) => rows.push(row) });
    const session = { prompt: async () => usage() };
    const res = await runPhasePrompt(session, 'do it', { runId: 'run-7', workflow: 'build', phase: 'guardrails' });
    expect(res.text).toBe('hello');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ runId: 'run-7', phase: 'guardrails', inputTokens: 100 });
  });

  it('returns the response even when recording is inert', async () => {
    setExecutionRecorder(null);
    const session = { prompt: async () => usage() };
    const res = await runPhasePrompt(session, 'do it', { runId: 'r', workflow: 'w', phase: 'p' });
    expect(res.text).toBe('hello');
  });
});

describe('isTransientModelError', () => {
  it('flags the OpenAI 500 body, 429s, 5xx status, and dropped sockets', () => {
    expect(isTransientModelError(new Error('prompt failed: An error occurred while processing your request'))).toBe(true);
    expect(isTransientModelError(new Error('429 Too Many Requests'))).toBe(true);
    expect(isTransientModelError({ status: 503 })).toBe(true);
    expect(isTransientModelError(new Error('socket hang up'))).toBe(true);
    expect(isTransientModelError({ status: 500, message: 'x' })).toBe(true);
  });

  it('does NOT flag deterministic / client errors', () => {
    expect(isTransientModelError(new Error('action_input_validation: bad field'))).toBe(false);
    expect(isTransientModelError({ status: 400 })).toBe(false);
    expect(isTransientModelError(new Error('unknown workflow "nope"'))).toBe(false);
  });
});

describe('runPhasePrompt — transient retry', () => {
  afterEach(() => setPhaseRetryConfig({ maxAttempts: 3, baseDelayMs: 2000, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) }));

  it('retries a transient model error and succeeds on a later attempt', async () => {
    const slept: number[] = [];
    setPhaseRetryConfig({ maxAttempts: 3, baseDelayMs: 10, sleep: async (ms) => { slept.push(ms); } });
    setExecutionRecorder(null);

    let calls = 0;
    const session = {
      prompt: async () => {
        calls++;
        if (calls < 3) throw new Error('An error occurred while processing your request. request ID req_x');
        return usage();
      },
    };
    const res = await runPhasePrompt(session, 'synthesize', { runId: 'r', workflow: 'explore', phase: 'synthesize' });
    expect(res.text).toBe('hello');
    expect(calls).toBe(3);
    expect(slept).toEqual([10, 20]); // exponential backoff
  });

  it('gives up after maxAttempts and rethrows the transient error', async () => {
    setPhaseRetryConfig({ maxAttempts: 2, baseDelayMs: 1, sleep: async () => {} });
    setExecutionRecorder(null);
    let calls = 0;
    const session = { prompt: async () => { calls++; throw new Error('503 service unavailable'); } };
    await expect(
      runPhasePrompt(session, 'x', { runId: 'r', workflow: 'explore', phase: 'synthesize' }),
    ).rejects.toThrow(/service unavailable/);
    expect(calls).toBe(2);
  });

  it('does NOT retry a non-transient error (fails fast)', async () => {
    setPhaseRetryConfig({ maxAttempts: 3, baseDelayMs: 1, sleep: async () => {} });
    setExecutionRecorder(null);
    let calls = 0;
    const session = { prompt: async () => { calls++; throw new Error('action_input_validation'); } };
    await expect(
      runPhasePrompt(session, 'x', { runId: 'r', workflow: 'build', phase: 'architect' }),
    ).rejects.toThrow(/action_input_validation/);
    expect(calls).toBe(1);
  });
});
