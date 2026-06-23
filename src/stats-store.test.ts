import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { StatsStore, type ExecutionRow } from './stats-store.ts';

// Phase 7 slice 2 — the app-owned `executions` stats table: append-only per-phase
// cost/token rows + each rollup (phase/workflow/run/totals), migration-safe on a
// fresh AND an older db, blob-free.

let dir: string;
let store: StatsStore;

const row = (over: Partial<ExecutionRow> = {}): ExecutionRow => ({
  runId: 'run-1',
  workflow: 'build',
  phase: 'architect',
  model: 'openai/gpt-x',
  inputTokens: 100,
  outputTokens: 20,
  totalTokens: 120,
  costTotal: 0.5,
  ...over,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stats-'));
  store = new StatsStore(join(dir, 's.db'));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('StatsStore', () => {
  it('records rows and totals them', () => {
    store.record(row({ phase: 'architect', costTotal: 0.5, inputTokens: 100, outputTokens: 20, totalTokens: 120 }));
    store.record(row({ phase: 'executor', costTotal: 1.5, inputTokens: 200, outputTokens: 40, totalTokens: 240 }));
    const t = store.totals();
    expect(t.count).toBe(2);
    expect(t.totalCost).toBeCloseTo(2.0);
    expect(t.inputTokens).toBe(300);
    expect(t.outputTokens).toBe(60);
    expect(t.totalTokens).toBe(360);
  });

  it('rolls up by phase (busiest first)', () => {
    store.record(row({ phase: 'architect' }));
    store.record(row({ phase: 'executor', costTotal: 1.5 }));
    store.record(row({ phase: 'executor', costTotal: 2.5 }));
    const byPhase = store.statsByPhase();
    expect(byPhase[0]!.key).toBe('executor');
    expect(byPhase[0]!.count).toBe(2);
    expect(byPhase[0]!.totalCost).toBeCloseTo(4.0);
    const architect = byPhase.find((r) => r.key === 'architect')!;
    expect(architect.count).toBe(1);
  });

  it('rolls up by workflow', () => {
    store.record(row({ workflow: 'build' }));
    store.record(row({ workflow: 'build' }));
    store.record(row({ workflow: 'pr-review', costTotal: 0.25 }));
    const byWorkflow = store.statsByWorkflow();
    const build = byWorkflow.find((r) => r.key === 'build')!;
    const pr = byWorkflow.find((r) => r.key === 'pr-review')!;
    expect(build.count).toBe(2);
    expect(pr.count).toBe(1);
    expect(pr.totalCost).toBeCloseTo(0.25);
  });

  it('rolls up by run, excluding empty runIds', () => {
    store.record(row({ runId: 'run-1' }));
    store.record(row({ runId: 'run-2' }));
    store.record(row({ runId: '' })); // anonymous — excluded from per-run rollup
    const byRun = store.statsByRun();
    expect(byRun.map((r) => r.key).sort()).toEqual(['run-1', 'run-2']);
  });

  it('countSince filters by created_at', () => {
    store.record(row({ createdAt: '2020-01-01T00:00:00.000Z' }));
    store.record(row({ createdAt: '2030-01-01T00:00:00.000Z' }));
    expect(store.countSince('2025-01-01T00:00:00.000Z')).toBe(1);
  });

  it('is migration-safe on a fresh db (empty rollups, zero totals — not fabricated)', () => {
    const t = store.totals();
    expect(t.count).toBe(0);
    expect(t.totalCost).toBe(0);
    expect(store.statsByPhase()).toEqual([]);
    expect(store.statsByWorkflow()).toEqual([]);
    expect(store.countSince('2000-01-01T00:00:00.000Z')).toBe(0);
  });

  it('is migration-safe over an OLDER db with a pre-existing executions table', () => {
    const path = join(dir, 'old.db');
    // Simulate an older db that already had an `executions` table (subset of cols).
    const raw = new DatabaseSync(path);
    raw.exec(
      `CREATE TABLE executions (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         run_id TEXT, workflow TEXT, phase TEXT, model TEXT,
         input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER,
         cost_total REAL, created_at TEXT
       );`,
    );
    raw.prepare(
      `INSERT INTO executions (run_id, workflow, phase, model, input_tokens, output_tokens, total_tokens, cost_total, created_at)
       VALUES ('r0','build','architect','m',10,2,12,0.1,'2024-01-01T00:00:00.000Z')`,
    ).run();
    raw.close();

    // Re-opening with StatsStore (CREATE IF NOT EXISTS / ADD INDEX IF NOT EXISTS)
    // must NOT throw and must read the pre-existing row.
    const reopened = new StatsStore(path);
    try {
      expect(reopened.totals().count).toBe(1);
      reopened.record(row({ runId: 'r1' }));
      expect(reopened.totals().count).toBe(2);
    } finally {
      reopened.close();
    }
  });
});
