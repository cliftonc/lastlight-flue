import { BuildRunStore, type BuildRun } from '../build-run-store.ts';
import { resume, type ResumeDecision, type Reinvoker } from '../resume.ts';
import type { BuildResult } from '../agent-lib/build-phases.ts';

// ── Last Light on Flue · approvals backend (Phase 4 · resume wiring) ──────────
//
// The THIN approvals data layer the CLI + dashboard drive through `/admin/api/*`.
// It reads PAUSED build runs (the pending-gate queue) straight off the build
// run-store and maps a respond(approve|reject) to `resume(runId, decision)` —
// the durable, idempotent re-invoke proven in slice 1. Deliberately kept thin:
// the fuller admin-data re-back (joins, stats, true totals) is Phase 7; this only
// exposes what the approvals list + approve/reject actions need NOW.
//
// SEAM: `ApprovalsBackend` is injected into `createApp()` so the routes are
// testable OFFLINE with a fake store + a fake `resume`/`reinvoke` — no live model,
// no GitHub, no `flue run` spawn. The default backend opens the real build
// run-store and uses the production `resume` (whose default reinvoke spawns
// `flue run build`, the Spike-3 cross-process path).

/** The CLI/dashboard-facing approval row (matches `src/cli.ts` cmdApprovals). */
export interface ApprovalSummary {
  /** The action id the CLI POSTs back — the APP build runId (the resume key). */
  id: string;
  /** The gate the run is parked at (post_architect / post_reviewer:<cycle>). */
  gate: string;
  /** Coarse kind for the CLI's KIND column — the gate family. */
  kind: 'architect' | 'reviewer' | 'gate';
  /** The workflow run id (= the same build runId — surfaced for the CLI column). */
  workflowRunId: string;
  /** Human-facing one-liner: repo#issue + plan/verdict pointer if recorded. */
  summary: string;
  /** Resume re-invoke count (the breaker counter) — surfaced for operators. */
  restartCount: number;
  /** When the gate was raised. Not tracked by the run-store yet (Phase 7) → null. */
  createdAt: string | null;
}

/** The outcome of a respond() call, surfaced to the CLI/dashboard. */
export interface ApprovalRespondResult {
  ok: boolean;
  /** The terminal/parked status the run landed in after the decision. */
  status: BuildResult['status'];
  decision: ResumeDecision;
  reason?: string;
}

/** The seam `createApp()` mounts the approvals routes over. */
export interface ApprovalsBackend {
  /** List PAUSED build runs (pending gates) as approval rows. */
  list(): Promise<ApprovalSummary[]>;
  /** Approve or reject a parked run by id (= app runId) → idempotent resume. */
  respond(id: string, decision: ResumeDecision): Promise<ApprovalRespondResult | null>;
}

/** Map a gate name to the CLI's coarse KIND column. */
function kindOf(gate: string): ApprovalSummary['kind'] {
  if (gate.startsWith('post_architect')) return 'architect';
  if (gate.startsWith('post_reviewer')) return 'reviewer';
  return 'gate';
}

/** Build the human summary from a paused run's identity + recorded pointers. */
function summaryOf(run: BuildRun): string {
  const ref = `${run.owner}/${run.repo}#${run.issue}`;
  const gate = run.pendingGate ?? '';
  const pointer = gate.startsWith('post_reviewer')
    ? run.scratch[`verdict:${run.reviewerCycle}`] ?? run.scratch.reviewerVerdict
    : run.scratch.architectPlan ?? run.scratch.plan;
  return pointer ? `${ref} — ${pointer}` : ref;
}

/** Map a paused run record to the CLI/dashboard approval shape. */
export function toApprovalSummary(run: BuildRun): ApprovalSummary {
  const gate = run.pendingGate ?? '';
  return {
    id: run.id,
    gate,
    kind: kindOf(gate),
    workflowRunId: run.id,
    summary: summaryOf(run),
    restartCount: run.restartCount,
    createdAt: null,
  };
}

/** Options for the default (production) approvals backend. */
export interface DefaultApprovalsBackendOptions {
  storePath?: string;
  /** Resume seam override (tests inject a fake; default = the real `resume`). */
  resume?: typeof resume;
  /** Reinvoke seam threaded through to `resume` (default spawns `flue run build`). */
  reinvoke?: Reinvoker;
}

const defaultStorePath = () =>
  process.env.LASTLIGHT_BUILD_RUNSTORE ?? './data/build-run-store.db';

/**
 * The production approvals backend: lists paused runs off the on-disk build
 * run-store and maps respond() to `resume(runId, decision)`. Each call opens +
 * closes its own store handle (cheap sqlite; the routes are low-traffic). Respond
 * is IDEMPOTENT because `resume` itself no-ops on an already-resolved run.
 */
export function createDefaultApprovalsBackend(
  opts: DefaultApprovalsBackendOptions = {},
): ApprovalsBackend {
  const storePath = opts.storePath ?? defaultStorePath();
  const doResume = opts.resume ?? resume;
  return {
    async list() {
      const store = new BuildRunStore(storePath);
      try {
        return store.listPaused().map(toApprovalSummary);
      } finally {
        store.close();
      }
    },
    async respond(id, decision) {
      // Guard against responding to an id that isn't a paused/known run so the
      // route can 404 cleanly (rather than a silent no-op that looks like 200).
      const store = new BuildRunStore(storePath);
      let exists: boolean;
      try {
        exists = store.get(id) !== undefined;
      } finally {
        store.close();
      }
      if (!exists) return null;
      const result = await doResume(id, decision, { storePath, reinvoke: opts.reinvoke });
      return {
        ok: result.status !== 'failed' || decision === 'reject',
        status: result.status,
        decision,
        reason: result.reason,
      };
    },
  };
}
