import { invokeFlueRun } from './agent-lib/invoke-flue-run.ts';
import { BuildRunStore } from './build-run-store.ts';
import type { BuildInput, BuildResult } from './agent-lib/build-phases.ts';

// Phase 4 — resume(runId, decision): clear the gate + re-invoke idempotently.
//
// THE RE-INVOKE MECHANISM. A workflow is re-entered by re-RUNNING it: the on-disk app
// run record's phasesDone makes a fresh run() land just past the gate (idempotent). The
// Spike-3 gated workflow proved this across separate processes; it holds identically
// in-process because durability is app-owned, not process-bound. resume() applies that
// same mechanism to the `build` workflow.
//
// Beta.3 exports a top-level `invoke(workflow, { input })`, so the default re-entry is
// now IN-PROCESS (`src/agent-lib/invoke-flue-run.ts`) rather than spawning `flue run`
// (beta.2 had no `invoke` — flue-reference §0). The re-invoker is an INJECTED seam
// (`reinvoke`) so this is testable offline:
//   - tests pass an in-process fake that calls runBuild() directly;
//   - production defaults to `invokeFlueRun('build', { …resumedGate })`.
//
// FIRE-AND-FORGET: `invoke()` returns after admission, before the run completes, so the
// `store.get(runId)` read below reflects the run as it stands NOW (still active/paused),
// not its final state. That's fine — callers rely on the workflow's own async post-back,
// and the run record remains the source of truth.
//
// Decision flow (design/phase-4 §"Approval gate"):
//   reject  → runStore.fail(runId, 'rejected') — terminal, NO re-invoke.
//   approve → set resumedGate to the parked gate, re-invoke build with the SAME app
//             runId. phasesDone skips every completed phase; execution resumes just
//             past the gate. A DUPLICATE approve is a no-op (gate already cleared,
//             phases already done).
//
// NO LIVE SIDE EFFECTS here this slice: the default `reinvoke` spawns `flue run`
// which runs the STUBBED build deps — it does not touch a real repo/model/GitHub
// unless the (later-slice) real deps are wired in.

export type ResumeDecision = 'approve' | 'reject';

/** Re-invoke the build workflow for an app runId, carrying the parked gate token. */
export type Reinvoker = (input: BuildInput) => Promise<BuildResult | void>;

export interface ResumeOptions {
  storePath?: string;
  /** The re-invoke seam (default = spawn `flue run build`). Tests inject a fake. */
  reinvoke?: Reinvoker;
}

/** Read the build run-store path lazily (matches build.ts). */
const defaultStorePath = () =>
  process.env.LASTLIGHT_BUILD_RUNSTORE ?? './.data/build-run-store.db';

/**
 * Default production re-invoker: in-process `invoke('build', { …resumedGate })`. Returns
 * after admission (fire-and-forget); the run record is the truth, so we don't read the
 * receipt here.
 */
function defaultReinvoke(input: BuildInput): Reinvoker {
  return async () => {
    await invokeFlueRun('build', input);
  };
}

/**
 * Resume a build parked at an approval gate.
 *
 * @param runId    the APP run id (the resume contract — stable across re-invokes).
 * @param decision 'approve' (re-invoke past the gate) | 'reject' (terminalize).
 */
export async function resume(
  runId: string,
  decision: ResumeDecision,
  opts: ResumeOptions = {},
): Promise<BuildResult> {
  const store = new BuildRunStore(opts.storePath ?? defaultStorePath());
  try {
    const run = store.get(runId);
    if (!run) {
      return { status: 'failed', reason: `resume: unknown runId ${runId}` };
    }

    // Idempotent guards: a decision against a non-paused / terminal run is a no-op.
    if (run.status === 'complete') return { status: 'complete', prUrl: run.scratch.prUrl };
    if (run.status === 'failed') {
      return { status: 'failed', reason: run.failReason ?? undefined };
    }
    if (run.pendingGate === null) {
      // Already resumed (e.g. a duplicate approve raced past). No-op, report state.
      return { status: run.status === 'paused' ? 'paused' : 'complete' };
    }

    if (decision === 'reject') {
      store.fail(runId, 'rejected');
      return { status: 'failed', reason: 'rejected' };
    }

    // approve → re-invoke with the parked gate as the per-gate re-entry token.
    const gate = run.pendingGate;
    const input: BuildInput = {
      runId: run.id,
      owner: run.owner,
      repo: run.repo,
      issue: run.issue,
      branch: run.branch,
      taskId: run.taskId,
      resumedGate: gate,
      triggerType: 'resume',
    };
    const reinvoke = opts.reinvoke ?? defaultReinvoke(input);
    const result = await reinvoke(input);
    // The run record is the source of truth; reflect it back to the caller.
    const after = store.get(runId)!;
    return (
      (result as BuildResult | undefined) ?? {
        status: after.status === 'failed' ? 'failed' : after.status === 'complete' ? 'complete' : 'paused',
        prUrl: after.scratch.prUrl,
        reason: after.failReason ?? undefined,
      }
    );
  } finally {
    store.close();
  }
}

/**
 * Boot-time orphan recovery (design/phase-4 §"Boot resume + breaker"): re-invoke
 * every `status='active'` run (NOT `paused` — those await a human). The breaker in
 * runBuild caps the resume loop. Called from app boot (TODO(phase-4/boot): wire).
 */
export async function recoverOrphanRuns(opts: ResumeOptions = {}): Promise<string[]> {
  const store = new BuildRunStore(opts.storePath ?? defaultStorePath());
  const recovered: string[] = [];
  try {
    for (const run of store.listActive()) {
      const input: BuildInput = {
        runId: run.id,
        owner: run.owner,
        repo: run.repo,
        issue: run.issue,
        branch: run.branch,
        taskId: run.taskId,
        // A boot recovery is a re-invoke → carry resumedGate so the breaker bumps.
        resumedGate: run.pendingGate ?? 'boot',
        triggerType: 'boot',
      };
      const reinvoke = opts.reinvoke ?? defaultReinvoke(input);
      await reinvoke(input);
      recovered.push(run.id);
    }
    return recovered;
  } finally {
    store.close();
  }
}
