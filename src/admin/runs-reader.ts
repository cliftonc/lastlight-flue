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
