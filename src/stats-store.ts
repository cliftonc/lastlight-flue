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

  /** Count of executions created on/after the given ISO timestamp (e.g. midnight). */
  countSince(sinceIso: string): number {
    const r = this.db
      .prepare('SELECT COUNT(*) AS c FROM executions WHERE created_at >= ?')
      .get(sinceIso) as { c: number };
    return r.c;
  }

  close(): void {
    if (this.closed) return; // idempotent — double-close is a no-op
    this.closed = true;
    this.db.close();
  }
}
