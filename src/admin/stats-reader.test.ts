import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StatsStore, type ExecutionRow, type StatBucket } from '../stats-store.ts';
import {
  buildStatsResponse,
  buildDailyStatsResponse,
  buildHourlyStatsResponse,
  buildExecutionsResponse,
  clampDays,
  clampHours,
  createDefaultStatsReader,
  type StatsReader,
} from './stats-reader.ts';

// Phase 7 — the stats seam backing /admin/api/stats{,/daily,/hourly} and
// /admin/api/executions. Pure response-builders over an injected StatsReader
// (fake here, runs fully offline) PLUS integration over the real on-disk store.

// ── A fully in-memory fake StatsReader (no sqlite, no disk) ──────────────────
function fakeReader(over: Partial<StatsReader> = {}): StatsReader {
  return {
    byPhase: () => [],
    byWorkflow: () => [],
    byRun: () => [],
    totals: () => ({ count: 0, totalCost: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
    todayCount: () => 0,
    dailyStats: () => [],
    hourlyStats: () => [],
    listExecutions: () => [],
    ...over,
  };
}

describe('clamp helpers (mirror reference route param handling)', () => {
  it('clampDays defaults to 30, clamps to [1, 90]', () => {
    expect(clampDays(undefined)).toBe(30);
    expect(clampDays('garbage')).toBe(30);
    // parseInt('0')||30 → 30 (falsy 0 falls back to default), then clamp — matches reference.
    expect(clampDays('0')).toBe(30);
    expect(clampDays('-5')).toBe(1);
    expect(clampDays('7')).toBe(7);
    expect(clampDays('1000')).toBe(90);
  });

  it('clampHours defaults to 24, clamps to [1, 168]', () => {
    expect(clampHours(undefined)).toBe(24);
    expect(clampHours('garbage')).toBe(24);
    // parseInt('0')||24 → 24 (falsy 0 falls back to default), then clamp — matches reference.
    expect(clampHours('0')).toBe(24);
    expect(clampHours('48')).toBe(48);
    expect(clampHours('99999')).toBe(168);
  });
});

describe('pure response builders (fake reader)', () => {
  it('buildDailyStatsResponse wraps reader.dailyStats in { daily }', () => {
    const bucket: StatBucket = {
      date: '2026-06-23',
      executions: 3,
      successes: 0,
      failures: 0,
      totalTokens: 360,
      inputTokens: 300,
      outputTokens: 60,
      cacheReadTokens: 0,
      costUsd: 2,
    };
    const reader = fakeReader({
      dailyStats: (days) => {
        expect(days).toBe(7);
        return [bucket];
      },
    });
    expect(buildDailyStatsResponse(reader, 7)).toEqual({ daily: [bucket] });
  });

  it('buildHourlyStatsResponse wraps reader.hourlyStats in { hourly }', () => {
    const bucket: StatBucket = {
      date: '2026-06-23T12',
      executions: 1,
      successes: 0,
      failures: 0,
      totalTokens: 120,
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 0,
      costUsd: 0.5,
    };
    const reader = fakeReader({
      hourlyStats: (hours) => {
        expect(hours).toBe(12);
        return [bucket];
      },
    });
    expect(buildHourlyStatsResponse(reader, 12)).toEqual({ hourly: [bucket] });
  });

  it('buildExecutionsResponse defaults limit=100 offset=0 and wraps in { executions }', () => {
    let seen: { limit: number; offset: number } | undefined;
    const reader = fakeReader({
      listExecutions: (opts) => {
        seen = opts;
        return [];
      },
    });
    expect(buildExecutionsResponse(reader)).toEqual({ executions: [] });
    expect(seen).toEqual({ limit: 100, offset: 0 });
  });

  it('buildExecutionsResponse parses limit/offset query strings', () => {
    let seen: { limit: number; offset: number } | undefined;
    const reader = fakeReader({
      listExecutions: (opts) => {
        seen = opts;
        return [];
      },
    });
    buildExecutionsResponse(reader, { limit: '25', offset: '50' });
    expect(seen).toEqual({ limit: 25, offset: 50 });
  });

  it('buildStatsResponse still works (existing /stats contract unchanged)', () => {
    const reader = fakeReader();
    const res = buildStatsResponse(reader);
    expect(res.total_executions).toBe(0);
    expect(res.running).toBe(0);
    expect(res.by_skill).toEqual({});
  });
});

// ── Integration over the real on-disk StatsStore (createDefaultStatsReader) ──
describe('createDefaultStatsReader over a real store', () => {
  let dir: string;
  let storePath: string;

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

  function seed(rows: ExecutionRow[]) {
    const s = new StatsStore(storePath);
    try {
      for (const r of rows) s.record(r);
    } finally {
      s.close();
    }
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'stats-reader-'));
    storePath = join(dir, 's.db');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('empty store → honest ZERO buckets, never fabricated', () => {
    const reader = createDefaultStatsReader({ storePath });

    const daily = reader.dailyStats(7);
    expect(daily).toHaveLength(7);
    for (const b of daily) {
      expect(b.executions).toBe(0);
      expect(b.totalTokens).toBe(0);
      expect(b.costUsd).toBe(0);
      expect(b.successes).toBe(0);
      expect(b.failures).toBe(0);
      expect(b.cacheReadTokens).toBe(0);
    }

    const hourly = reader.hourlyStats(24);
    expect(hourly).toHaveLength(24);
    expect(hourly.every((b) => b.executions === 0)).toBe(true);

    expect(reader.listExecutions({ limit: 100, offset: 0 })).toEqual([]);
  });

  it('dailyStats buckets rows by UTC day, filling empty days with zeros', () => {
    const todayIso = new Date().toISOString();
    seed([
      row({ inputTokens: 100, outputTokens: 20, totalTokens: 120, costTotal: 0.5, createdAt: todayIso }),
      row({ inputTokens: 200, outputTokens: 40, totalTokens: 240, costTotal: 1.5, createdAt: todayIso }),
    ]);
    const reader = createDefaultStatsReader({ storePath });

    const daily = reader.dailyStats(7);
    expect(daily).toHaveLength(7);
    const todayKey = todayIso.slice(0, 10);
    const todayBucket = daily.find((b) => b.date === todayKey)!;
    expect(todayBucket.executions).toBe(2);
    expect(todayBucket.totalTokens).toBe(360);
    expect(todayBucket.inputTokens).toBe(300);
    expect(todayBucket.outputTokens).toBe(60);
    expect(todayBucket.costUsd).toBeCloseTo(2.0);
    // No success/cache columns in the flue table → honest zeros.
    expect(todayBucket.successes).toBe(0);
    expect(todayBucket.failures).toBe(0);
    expect(todayBucket.cacheReadTokens).toBe(0);

    // Days are last-N, contiguous, ascending, and the window endpoint is today.
    expect(daily[daily.length - 1]!.date).toBe(todayKey);
    const empties = daily.filter((b) => b.date !== todayKey);
    expect(empties.every((b) => b.executions === 0)).toBe(true);
  });

  it('hourlyStats buckets rows by UTC hour key (YYYY-MM-DDTHH)', () => {
    const nowIso = new Date().toISOString();
    seed([row({ createdAt: nowIso }), row({ createdAt: nowIso })]);
    const reader = createDefaultStatsReader({ storePath });

    const hourly = reader.hourlyStats(6);
    expect(hourly).toHaveLength(6);
    const hourKey = nowIso.slice(0, 13);
    const bucket = hourly.find((b) => b.date === hourKey)!;
    expect(bucket.executions).toBe(2);
    expect(hourly[hourly.length - 1]!.date).toBe(hourKey);
  });

  it('listExecutions returns most-recent-first rows mapped to the Execution shape', () => {
    seed([
      row({ runId: 'r-old', workflow: 'build', phase: 'architect', createdAt: '2024-01-01T00:00:00.000Z' }),
      row({ runId: 'r-new', workflow: 'pr-review', phase: 'review', createdAt: '2025-01-01T00:00:00.000Z' }),
    ]);
    const reader = createDefaultStatsReader({ storePath });

    const list = reader.listExecutions({ limit: 100, offset: 0 });
    expect(list).toHaveLength(2);
    // Most-recent first.
    expect(list[0]!.trigger_id).toBe('r-new');
    expect(list[0]!.skill).toBe('pr-review:review');
    expect(list[1]!.trigger_id).toBe('r-old');
    expect(list[1]!.skill).toBe('build:architect');

    // Honest nulls where the flue table has no source column.
    const e = list[0]!;
    expect(typeof e.id).toBe('string');
    expect(e.started_at).toBe('2025-01-01T00:00:00.000Z');
    expect(e.finished_at).toBeNull();
    expect(e.success).toBeNull();
    expect(e.error).toBeNull();
    expect(e.turns).toBeNull();
    expect(e.duration_ms).toBeNull();
    expect(e.repo).toBeNull();
    expect(e.issue_number).toBeNull();
    expect(e.trigger_type).toBe('');
  });

  it('listExecutions honors limit and offset (paging)', () => {
    seed([
      row({ runId: 'r1', createdAt: '2025-01-03T00:00:00.000Z' }),
      row({ runId: 'r2', createdAt: '2025-01-02T00:00:00.000Z' }),
      row({ runId: 'r3', createdAt: '2025-01-01T00:00:00.000Z' }),
    ]);
    const reader = createDefaultStatsReader({ storePath });

    const page1 = reader.listExecutions({ limit: 2, offset: 0 });
    expect(page1.map((e) => e.trigger_id)).toEqual(['r1', 'r2']);
    const page2 = reader.listExecutions({ limit: 2, offset: 2 });
    expect(page2.map((e) => e.trigger_id)).toEqual(['r3']);
  });
});
