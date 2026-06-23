import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// ── Last Light on Flue · per-phase STATS rollups (Phase 7 · slice 2) ──────────
//
// The application-owned `executions` table (spec/10 / design/phase-7) — the
// per-phase cost/token ledger the dashboard + `lastlight stats` CLI roll up.
// Flue's `RunRecord` carries NO per-phase cost/token breakdown (only the
// per-`session.prompt` `PromptResponse.usage`/`.model`, the native metrics
// source — flue-reference §0), so this stays APP-OWNED (raw sqlite, mirroring
// build-run-store.ts): one row per `session.prompt` call, written right after a
// workflow phase prompts its agent (see `recordExecution` + the build-phase
// instrumentation in agent-lib).
//
// Per spec/10 it is the small, indexed LIST/STATS source: blob-free (no
// transcript text — that lives in Flue's `EventStreamStore`), additive-only
// schema (CREATE IF NOT EXISTS + idempotent ALTER, migration-safe on a fresh OR
// an older db), append-only (one INSERT per call, never narrowed).

/** A single recorded execution (one `session.prompt` call) — the writer input. */
export interface ExecutionRow {
  /** App runId (the build/explore run id) or chat thread key. Empty if unknown. */
  runId: string;
  /** Workflow name (`build`, `pr-review`, `issue-triage`, `chat`, …). */
  workflow: string;
  /** Phase / session name within the workflow (`architect`, `executor`, `review`). */
  phase: string;
  /** Model specifier, e.g. `openai/gpt-…`. Empty when the response omits it. */
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Total USD cost for the call (0 under subscription/OAuth auth). */
  costTotal: number;
  /** ISO-8601 timestamp; defaults to now() when omitted. */
  createdAt?: string;
}

/** A `{ count, totalCost, inputTokens, outputTokens, totalTokens }` rollup row. */
export interface RollupRow {
  /** The grouping key (phase name or workflow name). */
  key: string;
  count: number;
  totalCost: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/** Aggregate totals across every recorded execution. */
export interface StatsTotals {
  count: number;
  totalCost: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/**
 * One time-bucket of execution stats (per-day or per-hour), in the dashboard's
 * `DailyStat` shape (dashboard/src/api.ts). `date` is the bucket key:
 * `YYYY-MM-DD` for daily, `YYYY-MM-DDTHH` for hourly (UTC).
 *
 * The flue `executions` table is blob-free and carries NO success/failure
 * outcome and NO cache-read token column, so `successes`/`failures` and
 * `cacheReadTokens` are honest ZEROS here, never fabricated.
 */
export interface StatBucket {
  date: string;
  executions: number;
  successes: number;
  failures: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
}

/** One raw execution row in the dashboard's `Execution` list shape. */
export interface ExecutionListRow {
  id: string;
  trigger_type: string;
  trigger_id: string;
  skill: string;
  repo: string | null;
  issue_number: number | null;
  started_at: string;
  finished_at: string | null;
  success: number | null;
  error: string | null;
  turns: number | null;
  duration_ms: number | null;
}

interface BucketSqlRow {
  date: string;
  executions: number;
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

interface ExecutionSqlRow {
  id: number;
  run_id: string;
  workflow: string;
  phase: string;
  created_at: string;
}

interface RollupSqlRow {
  key: string;
  count: number;
  total_cost: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

export class StatsStore {
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    // WAL keeps a reader (the dashboard 5s poll) from blocking the writer.
    this.db.exec('PRAGMA journal_mode = WAL;');
    // Additive-only schema (spec/10): never drop/narrow a column. Blob-free —
    // no transcript text lands here (the split rule; transcripts = EventStreamStore).
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS executions (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id        TEXT NOT NULL DEFAULT '',
        workflow      TEXT NOT NULL DEFAULT '',
        phase         TEXT NOT NULL DEFAULT '',
        model         TEXT NOT NULL DEFAULT '',
        input_tokens  INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens  INTEGER NOT NULL DEFAULT 0,
        cost_total    REAL NOT NULL DEFAULT 0,
        created_at    TEXT NOT NULL DEFAULT ''
      );
    `);
    // Indexed by the common rollup/list axes (workflow / phase / time).
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_executions_workflow ON executions(workflow);');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_executions_run ON executions(run_id);');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_executions_created ON executions(created_at);');
  }

  /** Append one execution row. Append-only — never updates a prior row. */
  record(row: ExecutionRow): void {
    this.db
      .prepare(
        `INSERT INTO executions
           (run_id, workflow, phase, model, input_tokens, output_tokens, total_tokens, cost_total, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.runId,
        row.workflow,
        row.phase,
        row.model,
        row.inputTokens | 0,
        row.outputTokens | 0,
        row.totalTokens | 0,
        row.costTotal,
        row.createdAt ?? new Date().toISOString(),
      );
  }

  private rollupBy(column: 'phase' | 'workflow'): RollupRow[] {
    const rows = this.db
      .prepare(
        `SELECT ${column} AS key,
                COUNT(*) AS count,
                COALESCE(SUM(cost_total), 0) AS total_cost,
                COALESCE(SUM(input_tokens), 0) AS input_tokens,
                COALESCE(SUM(output_tokens), 0) AS output_tokens,
                COALESCE(SUM(total_tokens), 0) AS total_tokens
         FROM executions
         GROUP BY ${column}
         ORDER BY count DESC`,
      )
      .all() as unknown as RollupSqlRow[];
    return rows.map(this.hydrateRollup);
  }

  private hydrateRollup(r: RollupSqlRow): RollupRow {
    return {
      key: r.key,
      count: r.count,
      totalCost: r.total_cost,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      totalTokens: r.total_tokens,
    };
  }

  /** Per-phase rollup (cost/tokens grouped by phase name), busiest first. */
  statsByPhase(): RollupRow[] {
    return this.rollupBy('phase');
  }

  /** Per-workflow rollup (cost/tokens grouped by workflow name), busiest first. */
  statsByWorkflow(): RollupRow[] {
    return this.rollupBy('workflow');
  }

  /** Per-run rollup (cost/tokens grouped by app runId), most rows first. */
  statsByRun(): RollupRow[] {
    const rows = this.db
      .prepare(
        `SELECT run_id AS key,
                COUNT(*) AS count,
                COALESCE(SUM(cost_total), 0) AS total_cost,
                COALESCE(SUM(input_tokens), 0) AS input_tokens,
                COALESCE(SUM(output_tokens), 0) AS output_tokens,
                COALESCE(SUM(total_tokens), 0) AS total_tokens
         FROM executions
         WHERE run_id <> ''
         GROUP BY run_id
         ORDER BY count DESC`,
      )
      .all() as unknown as RollupSqlRow[];
    return rows.map(this.hydrateRollup);
  }

  /** Aggregate totals across every recorded execution. */
  totals(): StatsTotals {
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS count,
                COALESCE(SUM(cost_total), 0) AS total_cost,
                COALESCE(SUM(input_tokens), 0) AS input_tokens,
                COALESCE(SUM(output_tokens), 0) AS output_tokens,
                COALESCE(SUM(total_tokens), 0) AS total_tokens
         FROM executions`,
      )
      .get() as unknown as RollupSqlRow;
    return {
      count: r.count,
      totalCost: r.total_cost,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      totalTokens: r.total_tokens,
    };
  }

  /**
   * The raw execution rows for a single app run, oldest-first — the per-phase
   * ledger the dashboard's `GET /admin/api/workflow-runs/:id/executions` maps to
   * `WorkflowRunExecution[]`. Blob-free (no transcript). Columns the flue table
   * does NOT carry (sessionId / success / error / turns / cache tokens /
   * apiDurationMs / stopReason) are absent here — the route maps them to honest
   * undefined, never fabricated. Empty (unknown / never-run id) → `[]`.
   */
  executionsForRun(runId: string): ExecutionRow[] {
    const rows = this.db
      .prepare(
        `SELECT run_id, workflow, phase, model,
                input_tokens, output_tokens, total_tokens, cost_total, created_at
         FROM executions
         WHERE run_id = ?
         ORDER BY id ASC`,
      )
      .all(runId) as unknown as Array<{
        run_id: string;
        workflow: string;
        phase: string;
        model: string;
        input_tokens: number;
        output_tokens: number;
        total_tokens: number;
        cost_total: number;
        created_at: string;
      }>;
    return rows.map((r) => ({
      runId: r.run_id,
      workflow: r.workflow,
      phase: r.phase,
      model: r.model,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      totalTokens: r.total_tokens,
      costTotal: r.cost_total,
      createdAt: r.created_at,
    }));
  }

  /** Count of executions created on/after the given ISO timestamp (e.g. midnight). */
  countSince(sinceIso: string): number {
    const r = this.db
      .prepare('SELECT COUNT(*) AS c FROM executions WHERE created_at >= ?')
      .get(sinceIso) as { c: number };
    return r.c;
  }

  /** An empty (all-zeros) bucket for a key with no recorded executions. */
  private static emptyBucket(date: string): StatBucket {
    return {
      date,
      executions: 0,
      successes: 0,
      failures: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      costUsd: 0,
    };
  }

  /** Hydrate a SQL bucket row into the dashboard `StatBucket` shape. */
  private static hydrateBucket(r: BucketSqlRow): StatBucket {
    return {
      date: r.date,
      executions: r.executions,
      // The flue table has no per-row success/failure outcome → honest zeros.
      successes: 0,
      failures: 0,
      totalTokens: r.total_tokens,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      // No cache-read token column in the flue table → honest zero.
      cacheReadTokens: 0,
      costUsd: r.cost_usd,
    };
  }

  /**
   * Daily aggregated stats for the inclusive UTC window `[today-(days-1), today]`.
   * Buckets `executions` by `date(created_at)` (UTC YYYY-MM-DD). Every day in the
   * window is present; days with no rows are honest all-zero buckets.
   */
  dailyStats(days: number): StatBucket[] {
    const today = new Date();
    const startUtc = new Date(
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - (days - 1)),
    );

    const dateKeys: string[] = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(startUtc);
      d.setUTCDate(startUtc.getUTCDate() + i);
      dateKeys.push(d.toISOString().slice(0, 10));
    }

    const rows = this.db
      .prepare(
        `SELECT
           date(created_at) AS date,
           COUNT(*) AS executions,
           COALESCE(SUM(total_tokens), 0) AS total_tokens,
           COALESCE(SUM(input_tokens), 0) AS input_tokens,
           COALESCE(SUM(output_tokens), 0) AS output_tokens,
           COALESCE(SUM(cost_total), 0) AS cost_usd
         FROM executions
         WHERE date(created_at) >= ?
         GROUP BY date(created_at)`,
      )
      .all(dateKeys[0]!) as unknown as BucketSqlRow[];

    const byDate = new Map(rows.map((r) => [r.date, StatsStore.hydrateBucket(r)]));
    return dateKeys.map((date) => byDate.get(date) ?? StatsStore.emptyBucket(date));
  }

  /**
   * Hourly aggregated stats for the rolling last N hours (UTC). Bucket key is
   * `YYYY-MM-DDTHH` (matches `strftime('%Y-%m-%dT%H', …)`). Every hour in the
   * window is present; empty hours are honest all-zero buckets.
   */
  hourlyStats(hours: number): StatBucket[] {
    const now = new Date();
    const startUtc = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
        now.getUTCHours() - (hours - 1),
      ),
    );

    const hourKeys: string[] = [];
    for (let i = 0; i < hours; i++) {
      const d = new Date(startUtc);
      d.setUTCHours(startUtc.getUTCHours() + i);
      hourKeys.push(d.toISOString().slice(0, 13));
    }

    const rows = this.db
      .prepare(
        `SELECT
           strftime('%Y-%m-%dT%H', created_at) AS date,
           COUNT(*) AS executions,
           COALESCE(SUM(total_tokens), 0) AS total_tokens,
           COALESCE(SUM(input_tokens), 0) AS input_tokens,
           COALESCE(SUM(output_tokens), 0) AS output_tokens,
           COALESCE(SUM(cost_total), 0) AS cost_usd
         FROM executions
         WHERE strftime('%Y-%m-%dT%H', created_at) >= ?
         GROUP BY strftime('%Y-%m-%dT%H', created_at)`,
      )
      .all(hourKeys[0]!) as unknown as BucketSqlRow[];

    const byHour = new Map(rows.map((r) => [r.date, StatsStore.hydrateBucket(r)]));
    return hourKeys.map((date) => byHour.get(date) ?? StatsStore.emptyBucket(date));
  }

  /**
   * A page of raw execution rows (most-recent first), mapped to the dashboard's
   * `Execution` list shape. The flue table carries no trigger/skill/outcome
   * columns the reference ledger had, so those map honestly: `skill` derives
   * from `workflow:phase`, `trigger_id` from `run_id`, and the
   * outcome/duration/turns/repo/issue fields are null (no source column).
   */
  listExecutions(limit = 100, offset = 0): ExecutionListRow[] {
    const rows = this.db
      .prepare(
        `SELECT id, run_id, workflow, phase, created_at
         FROM executions
         ORDER BY created_at DESC, id DESC
         LIMIT ? OFFSET ?`,
      )
      .all(limit, offset) as unknown as ExecutionSqlRow[];
    return rows.map((r) => ({
      id: String(r.id),
      trigger_type: '',
      trigger_id: r.run_id,
      // `workflow:phase` mirrors the reference ledger's composite phase skill key.
      skill: r.workflow && r.phase ? `${r.workflow}:${r.phase}` : r.workflow || r.phase,
      repo: null,
      issue_number: null,
      started_at: r.created_at,
      finished_at: null,
      success: null,
      error: null,
      turns: null,
      duration_ms: null,
    }));
  }

  close(): void {
    if (this.closed) return; // idempotent — double-close is a no-op
    this.closed = true;
    this.db.close();
  }
}
