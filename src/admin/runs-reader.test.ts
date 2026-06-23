import { describe, it, expect } from 'vitest';
import type {
  RunPointer,
  RunRecord,
  AgentManifestEntry,
} from '@flue/runtime';
import {
  mapRunStatus,
  toRunSummary,
  toRunDetail,
  toAgentSummary,
  toRunExecution,
  type RunActionsReader,
} from './runs-reader.ts';
import type { ExecutionRow } from '../stats-store.ts';

// Phase 2 · slice 2 — pure unit tests for the Flue-shape → dashboard-shape
// adapter. No runtime, no HTTP: just sample Flue records in, dashboard shapes
// out. These pin the status mapping, the blob-free summary projection, the
// detail projection, and the explicit-null (NOT fabricated) Phase-7 fields.

describe('mapRunStatus (Flue → dashboard vocabulary)', () => {
  it('maps the three Flue states to dashboard equivalents', () => {
    expect(mapRunStatus('active')).toBe('running');
    expect(mapRunStatus('completed')).toBe('succeeded');
    expect(mapRunStatus('errored')).toBe('failed');
  });
});

describe('toRunSummary (RunPointer → list row)', () => {
  const pointer: RunPointer = {
    runId: 'run_01H',
    workflowName: 'build',
    status: 'active',
    startedAt: '2026-06-21T10:00:00.000Z',
    endedAt: undefined,
    durationMs: undefined,
    isError: undefined,
  };

  it('renames runId→id and maps status', () => {
    const s = toRunSummary(pointer);
    expect(s.id).toBe('run_01H');
    expect(s.workflowName).toBe('build');
    expect(s.status).toBe('running');
    expect(s.startedAt).toBe('2026-06-21T10:00:00.000Z');
  });

  it('coerces absent optionals to null/false (never undefined)', () => {
    const s = toRunSummary(pointer);
    expect(s.endedAt).toBeNull();
    expect(s.durationMs).toBeNull();
    expect(s.isError).toBe(false);
  });

  it('app-run-store fields are explicit null, NOT fabricated (TODO phase-7)', () => {
    const s = toRunSummary(pointer);
    expect(s.currentPhase).toBeNull();
    expect(s.repo).toBeNull();
    expect(s.issueNumber).toBeNull();
    expect(s.restartCount).toBeNull();
  });

  it('passes through a completed run with timing', () => {
    const s = toRunSummary({
      runId: 'run_done',
      workflowName: 'pr-review',
      status: 'completed',
      startedAt: '2026-06-21T09:00:00.000Z',
      endedAt: '2026-06-21T09:05:00.000Z',
      durationMs: 300000,
      isError: false,
    });
    expect(s.status).toBe('succeeded');
    expect(s.endedAt).toBe('2026-06-21T09:05:00.000Z');
    expect(s.durationMs).toBe(300000);
  });

  it('does NOT carry blob fields (no payload/result/error on a summary)', () => {
    const s = toRunSummary(pointer) as unknown as Record<string, unknown>;
    expect('payload' in s).toBe(false);
    expect('result' in s).toBe(false);
    expect('error' in s).toBe(false);
  });
});

describe('toRunDetail (RunRecord → detail)', () => {
  const record: RunRecord = {
    runId: 'run_01H',
    workflowName: 'build',
    status: 'errored',
    startedAt: '2026-06-21T10:00:00.000Z',
    endedAt: '2026-06-21T10:02:00.000Z',
    durationMs: 120000,
    isError: true,
    payload: { repo: 'owner/repo', issue: 7 },
    result: undefined,
    error: { message: 'boom' },
  };

  it('includes the summary fields plus payload/result/error blobs', () => {
    const d = toRunDetail(record);
    expect(d.id).toBe('run_01H');
    expect(d.status).toBe('failed');
    expect(d.isError).toBe(true);
    expect(d.payload).toEqual({ repo: 'owner/repo', issue: 7 });
    expect(d.result).toBeNull();
    expect(d.error).toEqual({ message: 'boom' });
  });
});

describe('toAgentSummary (AgentManifestEntry)', () => {
  it('flattens transports.http and coerces missing description to null', () => {
    const entry: AgentManifestEntry = {
      name: 'hello',
      transports: { http: true },
      created: true,
    };
    expect(toAgentSummary(entry)).toEqual({
      name: 'hello',
      description: null,
      http: true,
      created: true,
    });
  });

  it('reports http:false when no http transport', () => {
    const entry: AgentManifestEntry = {
      name: 'internal',
      description: 'dispatch-only agent',
      transports: {},
      created: true,
    };
    expect(toAgentSummary(entry)).toEqual({
      name: 'internal',
      description: 'dispatch-only agent',
      http: false,
      created: true,
    });
  });
});

describe('toRunExecution (ExecutionRow → WorkflowRunExecution row)', () => {
  const row: ExecutionRow = {
    runId: 'run_01H',
    workflow: 'build',
    phase: 'architect',
    model: 'openai/gpt-5.1',
    inputTokens: 1200,
    outputTokens: 340,
    totalTokens: 1540,
    costTotal: 0.042,
    createdAt: '2026-06-21T10:00:00.000Z',
  };

  it('maps skill to <workflow>:<phase> and exposes the bare phase', () => {
    const e = toRunExecution(row, 0);
    expect(e.skill).toBe('build:architect');
    expect(e.phase).toBe('architect');
  });

  it('synthesises a stable id from runId + phase + index', () => {
    expect(toRunExecution(row, 0).id).toBe('run_01H:architect:0');
    expect(toRunExecution(row, 2).id).toBe('run_01H:architect:2');
  });

  it('carries the real cost/token metrics and startedAt', () => {
    const e = toRunExecution(row, 0);
    expect(e.costUsd).toBe(0.042);
    expect(e.inputTokens).toBe(1200);
    expect(e.outputTokens).toBe(340);
    expect(e.startedAt).toBe('2026-06-21T10:00:00.000Z');
  });

  it('does NOT fabricate fields the flue table lacks (no success/error/sessionId)', () => {
    const e = toRunExecution(row, 0) as unknown as Record<string, unknown>;
    expect('success' in e).toBe(false);
    expect('error' in e).toBe(false);
    expect('sessionId' in e).toBe(false);
    expect('durationMs' in e).toBe(false);
  });

  it('falls back to the bare phase as skill when workflow is empty', () => {
    const e = toRunExecution({ ...row, workflow: '' }, 0);
    expect(e.skill).toBe('architect');
  });
});

describe('RunActionsReader (seam contract — fake)', () => {
  it('lists executions and cancels via the injected fake', () => {
    const cancelled: string[] = [];
    const fake: RunActionsReader = {
      listRunExecutions: (id) =>
        id === 'run_01H'
          ? [
              toRunExecution(
                {
                  runId: 'run_01H',
                  workflow: 'build',
                  phase: 'architect',
                  model: '',
                  inputTokens: 0,
                  outputTokens: 0,
                  totalTokens: 0,
                  costTotal: 0,
                  createdAt: '2026-06-21T10:00:00.000Z',
                },
                0,
              ),
            ]
          : [],
      cancelRun: (id) => {
        if (id !== 'run_01H') return false;
        cancelled.push(id);
        return true;
      },
    };

    expect(fake.listRunExecutions('run_01H')).toHaveLength(1);
    expect(fake.listRunExecutions('missing')).toEqual([]);
    expect(fake.cancelRun('run_01H')).toBe(true);
    expect(fake.cancelRun('missing')).toBe(false);
    expect(cancelled).toEqual(['run_01H']);
  });
});
