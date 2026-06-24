import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BuildRunStore } from './build-run-store.ts';
import type { BuildInput, BuildResult } from './agent-lib/build-phases.ts';

// Phase 4 — resume(runId, decision): clear the gate + re-invoke idempotently.
//
// THE RE-INVOKE MECHANISM. There is NO top-level `invoke` in @flue/runtime
// 1.0.0-beta.2 (flue-reference §0): a workflow is re-entered by re-RUNNING it. The
// Spike-3 gated workflow ALREADY PROVED this works across 3 separate `flue run`
// processes — a fresh process re-runs run() from the top, and the on-disk app run
// record's phasesDone makes it land just past the gate (idempotent). resume() is
// that same mechanism, applied to the `build` workflow.
//
// The re-invoker is an INJECTED seam (`reinvoke`) so this is testable offline:
//   - tests pass an in-process fake that calls runBuild() directly;
//   - production defaults to spawning `flue run build --payload {...resumedGate}`,
//     exactly the cross-process path Spike-3 proved (or, when invoked from inside
//     the running server, the channel layer can call `invokeWorkflowAttached` —
//     TODO(phase-4/channels): wire that entry once channels land).
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

const exec = promisify(execFile);

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
 * Default production re-invoker: spawn a fresh `flue run build` process with the
 * resumedGate token — the cross-process re-entry Spike-3 proved. (Stdout carries
 * the workflow's JSON result; we don't parse it here — the run record is the truth.)
 */
function defaultReinvoke(input: BuildInput): Reinvoker {
  return async () => {
    await exec('pnpm', ['exec', 'flue', 'run', 'build', '--input', JSON.stringify(input)], {
      timeout: 600_000,
    });
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
