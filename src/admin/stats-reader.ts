import { StatsStore, type RollupRow, type StatsTotals } from '../stats-store.ts';

// ── Last Light on Flue · admin stats seam (Phase 7 · slice 2) ─────────────────
//
// The data layer backing `GET /admin/api/stats` (was a 501 stub). It rolls up
// the app-owned `executions` table (src/stats-store.ts) into the dashboard +
// `lastlight stats` CLI shape: per-phase / per-workflow cost+token rollups,
// totals, and the CLI's `{ total_executions, today_count, running, by_skill }`
// surface (src/cli.ts cmdStats reads those four). Behind an INJECTABLE seam
// (`StatsReader`, like `RunsReader`/`SessionReader`): the default opens the
// on-disk stats-store; tests inject a fake and run fully offline.

/** The injectable seam `createApp()` mounts the stats route over. */
export interface StatsReader {
  byPhase(): RollupRow[];
  byWorkflow(): RollupRow[];
  byRun(): RollupRow[];
  totals(): StatsTotals;
  /** Count of executions recorded today (since UTC midnight). */
  todayCount(): number;
}

/** The `/admin/api/stats` response (dashboard + CLI shape). */
export interface StatsResponse {
  /** CLI `cmdStats` reads these three directly (src/cli.ts). */
  total_executions: number;
  today_count: number;
  /** No live run-tracking in this slice (a sandbox/liveness concern) → always 0. */
  running: number;
  /**
   * Per-workflow rollup keyed by workflow name, in the CLI's `by_skill` shape
   * (`{ count, success, fail }`). Per-`session.prompt` rows carry no success/fail
   * outcome (that's a run-level concept) → success/fail are 0; `count` is real.
   */
  by_skill: Record<string, { count: number; success: number; fail: number }>;
  /** Richer rollups the dashboard surfaces: per-phase / per-workflow cost+tokens. */
  byPhase: RollupRow[];
  byWorkflow: RollupRow[];
  byRun: RollupRow[];
  totals: StatsTotals;
}

/** UTC midnight ISO for "today" filtering. */
function todayMidnightIso(now: Date = new Date()): string {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  ).toISOString();
}

/** Aggregate a `StatsReader`'s rollups into the route response (pure). */
export function buildStatsResponse(reader: StatsReader): StatsResponse {
  const byWorkflow = reader.byWorkflow();
  const totals = reader.totals();
  const by_skill: StatsResponse['by_skill'] = {};
  for (const w of byWorkflow) {
    // success/fail are run-level outcomes not carried per-prompt → 0; count real.
    by_skill[w.key] = { count: w.count, success: 0, fail: 0 };
  }
  return {
    total_executions: totals.count,
    today_count: reader.todayCount(),
    running: 0,
    by_skill,
    byPhase: reader.byPhase(),
    byWorkflow,
    byRun: reader.byRun(),
    totals,
  };
}

const defaultStorePath = () =>
  process.env.LASTLIGHT_STATS_STORE ?? './data/stats-store.db';

/**
 * The production stats reader: opens the on-disk stats-store per call (cheap
 * sqlite; the dashboard polls ~5s — blob-free rollups only) and closes it. An
 * EMPTY/missing store returns honest zeros (CREATE IF NOT EXISTS), never
 * fabricated numbers.
 */
export function createDefaultStatsReader(
  opts: { storePath?: string } = {},
): StatsReader {
  const storePath = opts.storePath ?? defaultStorePath();
  const withStore = <T>(fn: (s: StatsStore) => T): T => {
    const store = new StatsStore(storePath);
    try {
      return fn(store);
    } finally {
      store.close();
    }
  };
  return {
    byPhase: () => withStore((s) => s.statsByPhase()),
    byWorkflow: () => withStore((s) => s.statsByWorkflow()),
    byRun: () => withStore((s) => s.statsByRun()),
    totals: () => withStore((s) => s.totals()),
    todayCount: () => withStore((s) => s.countSince(todayMidnightIso())),
  };
}
