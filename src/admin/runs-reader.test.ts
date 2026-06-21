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
} from './runs-reader.ts';

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
