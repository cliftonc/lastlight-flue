// ── Last Light on Flue · admin read seam (Phase 2 · slice 2) ─────────────────
//
// Thin pass-through over Flue's inspection primitives (`listRuns`/`getRun`/
// `listAgents`, `@flue/runtime`) backing the application-owned `/admin/api/*`
// READ routes. Phase 2 is the THIN version; the FULL re-back (joining the app
// run-store for phasesDone/pendingGate/stats/thread-grouping + EventStreamStore
// transcripts) is Phase 7 (see design/phase-7-persistence-admin.md).
//
// Two concerns live here, deliberately separated so the mapping is unit-testable
// WITHOUT a running Flue runtime:
//   1. `RunsReader` — the injectable seam. The real Flue free functions THROW
//      "called before runtime was configured" when called outside a Flue-built
//      server entry (verified 2026-06-21), exactly like `flue()`. So the routes
//      take a `RunsReader` provider; the default export wires the real Flue
//      functions (lazily, so the throw only surfaces at request time), and tests
//      inject a fake returning sample data — no live runtime, no build.
//   2. Pure adapter functions (`toRunSummary` / `toRunDetail` / `toAgentSummary`)
//      mapping Flue's shapes → the shapes the existing dashboard + `src/cli.ts`
//      expect. Pure → directly unit-testable with sample inputs.

import type {
  ListRunsOpts,
  ListRunsResponse,
  RunPointer,
  RunRecord,
  RunStatus,
  AgentManifestEntry,
} from '@flue/runtime';

/**
 * The Flue-data seam. The three methods mirror `@flue/runtime`'s `listRuns` /
 * `getRun` / `listAgents` exactly (same params, same return shapes), so the
 * default export can pass the real functions through unchanged, and tests can
 * inject a fake. Gating any "is the runtime up?" check happens at the route, not
 * here — this interface is pure data access.
 */
export interface RunsReader {
  listRuns(opts?: ListRunsOpts): Promise<ListRunsResponse>;
  getRun(runId: string): Promise<RunRecord | null>;
  listAgents(): Promise<AgentManifestEntry[]>;
}

// ── Status mapping ───────────────────────────────────────────────────────────
//
// Flue's RunStatus is the 3-value `active | completed | errored`. The legacy
// dashboard/CLI status vocabulary is `running | paused | succeeded | failed |
// cancelled`. We map the three Flue states to their dashboard equivalents;
// `paused` and `cancelled` are NOT distinguishable from Flue's record alone —
// they are app-run-store concepts (pendingGate / explicit cancel) joined in
// Phase 7. A `paused` run still reads as `running` here (TODO(phase-7)).

/** Dashboard/CLI run status vocabulary (superset of Flue's). */
export type DashboardRunStatus =
  | 'running'
  | 'paused'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export function mapRunStatus(status: RunStatus): DashboardRunStatus {
  switch (status) {
    case 'active':
      return 'running'; // TODO(phase-7): app run-store may refine to 'paused'
    case 'completed':
      return 'succeeded';
    case 'errored':
      return 'failed';
  }
}

// ── Run summary (list row) ───────────────────────────────────────────────────
//
// Source: a Flue `RunPointer` (blob-free — listRuns natively excludes
// payload/result/error, preserving the "list excludes blobs" invariant). The
// dashboard's `workflowRuns[]` rows + `src/cli.ts` read `id`, `workflowName`,
// `status`, `currentPhase`, `repo`, `startedAt`. Fields Flue does NOT carry on a
// pointer (currentPhase, repo, issueNumber, phaseHistory, restartCount) come
// from the app run-store in Phase 7; here they are explicit nulls, NOT fabricated.

export interface RunSummary {
  /** Dashboard/CLI key is `id`; Flue's is `runId`. */
  id: string;
  workflowName: string;
  status: DashboardRunStatus;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  isError: boolean;
  // TODO(phase-7): the following are app-run-store fields (not on a Flue
  // RunPointer) — null until the run-store join lands. Not fabricated.
  currentPhase: null;
  repo: null;
  issueNumber: null;
  restartCount: null;
}

export function toRunSummary(p: RunPointer): RunSummary {
  return {
    id: p.runId,
    workflowName: p.workflowName,
    status: mapRunStatus(p.status),
    startedAt: p.startedAt,
    endedAt: p.endedAt ?? null,
    durationMs: p.durationMs ?? null,
    isError: p.isError ?? false,
    currentPhase: null,
    repo: null,
    issueNumber: null,
    restartCount: null,
  };
}

// ── Run detail ───────────────────────────────────────────────────────────────
//
// Source: a full Flue `RunRecord` (carries `payload`/`result`/`error` blobs).
// The dashboard run-detail view + `src/cli.ts workflow log` read the summary
// fields plus the trigger input and outcome. Note Flue's RunRecord field is
// `payload` (the prose docs say "input" but the installed type is `payload`).

export interface RunDetail extends RunSummary {
  /** Trigger input (Flue's `payload` blob). */
  payload: unknown;
  result: unknown;
  error: unknown;
}

export function toRunDetail(r: RunRecord): RunDetail {
  return {
    ...toRunSummary(r),
    payload: r.payload ?? null,
    result: r.result ?? null,
    error: r.error ?? null,
  };
}

// ── Agent summary ────────────────────────────────────────────────────────────
//
// Source: Flue `AgentManifestEntry` = `{ name, description?, transports:{http?},
// created }`. Passed through close to verbatim (the dashboard's agents view is
// new surface; Flue's manifest IS the source of truth for it).

export interface AgentSummary {
  name: string;
  description: string | null;
  /** True when the agent module exports a `route` (public HTTP transport). */
  http: boolean;
  /** True when the module default-exports a created agent. */
  created: boolean;
}

export function toAgentSummary(a: AgentManifestEntry): AgentSummary {
  return {
    name: a.name,
    description: a.description ?? null,
    http: a.transports.http === true,
    created: a.created,
  };
}

// ── Run executions + cancel seam (per-phase ledger + app-record cancel) ───────
//
// Two MORE app-owned admin concerns hang off a workflow run, kept on a SEPARATE
// injectable seam (`RunActionsReader`) so the existing `RunsReader` pass-through
// (the inline `{ listRuns, getRun, listAgents }` in app.ts) stays a clean mirror
// of the three Flue free functions and doesn't gain required methods:
//
//   1. `listRunExecutions(runId)` → the per-phase cost/token ledger for a run,
//      backed by the app-owned `executions` table (src/stats-store.ts; Flue's
//      RunRecord carries NO per-phase breakdown). Mapped to the dashboard's
//      `WorkflowRunExecution[]` (dashboard/src/api.ts) for the pipeline-detail
//      view. Empty / unknown run → `[]`.
//   2. `cancelRun(runId)` → mark the APP build-run record cancelled. Flue does
//      NOT expose a force-cancel of an in-flight Node workflow (flue-reference §0),
//      and there is NO sandbox/container layer on the flue node target to kill,
//      so this is an HONEST app-record cancel: it flips the build-run-store row to
//      a terminal state so the resume/boot-recovery path won't re-invoke it. An
//      in-flight phase already prompting an agent runs to its natural end — see
//      the NOTES in the wiring delta. Returns whether a record was flipped.
//
// Both are PURE-mappable and behind a seam → unit-testable offline with fakes
// (no stats-store on disk, no build-run-store, no live runtime).

import { StatsStore, type ExecutionRow } from '../stats-store.ts';
import { BuildRunStore } from '../build-run-store.ts';

/**
 * A per-phase execution row in the dashboard's `WorkflowRunExecution` shape
 * (dashboard/src/api.ts). `id`/`skill`/`phase`/`startedAt` plus the cost/token
 * metrics are REAL (from the app `executions` table); the fields the flue table
 * does not carry (`sessionId`/`success`/`error`/`finishedAt`/`durationMs`/
 * `turns`/cache tokens/`apiDurationMs`/`stopReason`/`extensions`/`skills`) are
 * omitted (honest undefined), never fabricated.
 */
export interface RunExecution {
  id: string;
  skill: string;
  phase: string;
  startedAt: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Map one app `ExecutionRow` → the dashboard `WorkflowRunExecution`-compatible
 * row. `skill` mirrors the reference's `<workflowName>:<phaseName>` key; `phase`
 * is the bare phase name. `id` is synthesised from runId + phase + index because
 * the blob-free `ExecutionRow` carries no stable per-row id of its own. Pure.
 */
export function toRunExecution(row: ExecutionRow, index: number): RunExecution {
  const workflow = row.workflow || '';
  const phase = row.phase || '';
  return {
    id: `${row.runId}:${phase || workflow}:${index}`,
    skill: workflow ? `${workflow}:${phase}` : phase,
    phase,
    startedAt: row.createdAt ?? '',
    costUsd: row.costTotal,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
  };
}

/**
 * The injectable seam for the run-scoped executions list + cancel action.
 * Modeled on `StatsReader`: the default opens the on-disk stores per call; tests
 * inject a fake and run fully offline.
 */
export interface RunActionsReader {
  /** Per-phase execution ledger for an app run, oldest-first. Empty → []. */
  listRunExecutions(runId: string): RunExecution[];
  /**
   * Mark the app build-run record cancelled (honest app-record cancel — see the
   * seam doc above). Returns true when a record was flipped, false when no such
   * run exists in the app store.
   */
  cancelRun(runId: string): boolean;
}

const defaultStatsStorePath = () =>
  process.env.LASTLIGHT_STATS_STORE ?? './.data/stats-store.db';
const defaultBuildRunStorePath = () =>
  process.env.LASTLIGHT_BUILD_RUNSTORE ?? './.data/build-run-store.db';

/**
 * The production run-actions reader. `listRunExecutions` opens the on-disk
 * stats-store (cheap sqlite; CREATE IF NOT EXISTS → an empty/missing store yields
 * `[]`, never fabricated rows) and maps its rows to the dashboard shape.
 * `cancelRun` opens the build-run-store and flips the run's record to a terminal
 * 'failed' state with a cancellation reason (the store has no separate
 * 'cancelled' status — see NOTES in the wiring delta); it is a no-op returning
 * false when the id is unknown. Each call opens + closes its own handle.
 */
export function createDefaultRunActionsReader(
  opts: { statsStorePath?: string; buildRunStorePath?: string } = {},
): RunActionsReader {
  const statsPath = opts.statsStorePath ?? defaultStatsStorePath();
  const buildPath = opts.buildRunStorePath ?? defaultBuildRunStorePath();
  return {
    listRunExecutions(runId) {
      // Lazy import keeps the seam module free of a hard sqlite dep at import.
      const { StatsStore } = require('../stats-store.ts') as typeof import('../stats-store.ts');
      const store = new StatsStore(statsPath);
      try {
        return store.executionsForRun(runId).map(toRunExecution);
      } finally {
        store.close();
      }
    },
    cancelRun(runId) {
      const { BuildRunStore } = require('../build-run-store.ts') as typeof import('../build-run-store.ts');
      const store = new BuildRunStore(buildPath);
      try {
        const run = store.get(runId);
        if (!run) return false;
        // No 'cancelled' status in the build-run-store vocabulary; the terminal
        // 'failed' + a cancellation reason is the honest stop that the resume /
        // boot-recovery path will not re-invoke. Idempotent on an already-terminal run.
        store.fail(runId, 'cancelled via admin dashboard');
        return true;
      } finally {
        store.close();
      }
    },
  };
}

