/**
 * `build` workflow — Phase 4: the durable build cycle + the application-owned
 * approval gate, as explicit `run()` control flow.
 *
 * Discoverable as `src/workflows/build.ts` (filename = workflow name), invoked via
 * `flue run build --payload '{"runId":..,"owner":..,"repo":..,"issue":..}'` and
 * RE-invoked (idempotently, same app runId) by `resume(runId, decision)`.
 *
 * Phase sequence (ported from ~/work/lastlight/workflows/build.yaml):
 *   guardrails → architect → [post_architect GATE] → executor →
 *   reviewer-loop( reviewer:N → [post_reviewer GATE] → fix:N → recheck:N ;
 *                  max_cycles=2, break on APPROVED ) → PR (finalize)
 *
 * THE DURABILITY MODEL (spec/06, design/phase-4): Flue does NOT checkpoint workflow
 * run() and gives NO workflow crash recovery on Node. So:
 *   - the GATE is 100% application-owned: run() writes `pending` to the app run
 *     record and RETURNS (the function ends — Flue won't suspend/resume it);
 *   - `resume(runId, decision)` (src/resume.ts) clears the gate and RE-INVOKES the
 *     same mechanism the Spike-3 gated workflow proved (a fresh `flue run` /
 *     invokeWorkflowAttached with the same app runId) — execution lands just past
 *     the gate because every completed phase is in `phasesDone` and is SKIPPED;
 *   - a per-run restart-count breaker (≤3) terminalizes a crash/resume loop.
 *
 * THIS FOUNDATIONAL SLICE proves the durable CONTROL FLOW only. The phase BODIES
 * (guardrails/architect/executor/reviewer/fix/recheck) + the gate ask + the
 * deterministic open-PR are the `BuildDeps` seam (src/agent-lib/build-phases.ts),
 * STUBBED by default. Real builder-agent sessions + live PR creation are LATER
 * Phase-4 slices — see TODO(phase-4/…). NO live model / GitHub / repo writes here.
 *
 * Beta.2 form: `export async function run(ctx)` (NO defineWorkflow; flue-reference §0).
 */
import type { FlueContext } from '@flue/runtime';
import { BuildRunStore, MAX_RESTART_RESUMES, type GateName } from '../build-run-store.ts';
import {
  type BuildInput,
  type BuildResult,
  type BuildDeps,
  MAX_CYCLES,
  ARCHITECT_PLAN_SCRATCH_KEY,
  defaultBuildDeps,
} from '../agent-lib/build-phases.ts';
import { architectPlanPath } from '../agent-lib/architect-prompt.ts';

export type { BuildInput, BuildResult } from '../agent-lib/build-phases.ts';

/** Read the run-store path lazily so each process (+ test) can point at its own db. */
const storePath = () => process.env.LASTLIGHT_BUILD_RUNSTORE ?? './data/build-run-store.db';

/** Default branch/taskId derivation when the caller doesn't supply them. */
function seedFrom(input: BuildInput) {
  return {
    owner: input.owner,
    repo: input.repo,
    issue: input.issue,
    branch: input.branch ?? `lastlight/${input.issue}`,
    taskId: input.taskId ?? `${input.repo}-${input.issue}-build`,
  };
}

/**
 * The testable core. Drives the full durable control flow over an injected
 * `BuildRunStore` + `BuildDeps`. Production wraps this in `run()` with the default
 * store + stubbed deps; tests pass a temp-sqlite store + fake phase bodies.
 */
export async function runBuild(
  ctx: FlueContext<BuildInput>,
  store: BuildRunStore,
  deps: BuildDeps = defaultBuildDeps(),
): Promise<BuildResult> {
  const input = ctx.payload;
  const id = input.runId;
  let run = store.getOrCreate(id, seedFrom(input));

  // Already-terminal: a duplicate signal against a finished run is a no-op.
  if (run.status === 'complete') return { status: 'complete' };
  if (run.status === 'failed') return { status: 'failed', reason: run.failReason ?? undefined };

  // ── BREAKER: every (re-)invoke bumps restart_count; > cap → terminalize. ──────
  // (Bump only on a resumed re-entry, not the very first fresh invoke, so a normal
  // single-pass build doesn't consume the budget. resumedGate marks a re-invoke.)
  if (input.resumedGate) {
    const attempts = store.bumpRestart(id);
    if (attempts > MAX_RESTART_RESUMES) {
      store.fail(id, `restart-breaker: resumed ${attempts}x (cap ${MAX_RESTART_RESUMES})`);
      return { status: 'failed', reason: 'restart-breaker' };
    }
    store.clearPending(id);
  }
  run = store.get(id)!;

  // ── guardrails (skipped if done) ─────────────────────────────────────────────
  if (store.shouldRunPhase(run, 'guardrails')) {
    const g = await deps.runPhase(ctx, run, 'guardrails');
    // BLOCKED bypass parity (build.yaml) is a LATER slice; the marker contract is
    // wired so the structure is honest. TODO(phase-4/guardrails): bootstrap bypass.
    if (/^\s*BLOCKED/im.test(g.text)) {
      store.fail(id, 'guardrails-blocked');
      return { status: 'failed', reason: 'guardrails-blocked' };
    }
    store.markPhaseDone(id, 'guardrails');
    run = store.get(id)!;
  }

  // ── architect (writes+commits architect-plan.md in prod) ─────────────────────
  // The plan is the durable cross-phase HANDOFF (spec/07): the agent writes +
  // commits it to the branch; the run-record stores only the POINTER (spec/10
  // split rule — never the plan blob), so the executor reads it from the checkout
  // and the post_architect gate can surface it to the human.
  if (store.shouldRunPhase(run, 'architect')) {
    await deps.runPhase(ctx, run, 'architect');
    store.markPhaseDone(id, 'architect', {
      [ARCHITECT_PLAN_SCRATCH_KEY]: architectPlanPath(run.issue),
    });
    run = store.get(id)!;
  }

  // ── GATE: post_architect (positive-enable) ───────────────────────────────────
  // Fires unless this invoke was approved past exactly this gate. Idempotent: the
  // ask posts once (guarded on pendingGate not already set), and a re-pause writes
  // the same pending marker.
  if (deps.gateEnabled('post_architect') && input.resumedGate !== 'post_architect') {
    if (run.pendingGate !== 'post_architect') {
      store.setPending(id, 'post_architect');
      await deps.postGateComment(ctx, run, 'post_architect');
    }
    return { status: 'paused', gate: 'post_architect' };
  }

  // ── executor (skipped if done) ───────────────────────────────────────────────
  // The executor reads the architect plan from the checkout, implements + COMMITS
  // it in-sandbox, and the workflow PUSHES the branch (mocked in tests). Its phase
  // result carries scratch POINTERS (the executor-summary file path + the commit
  // sha — never the diff blob; spec/10) that anchor the reviewer/PR phases.
  if (store.shouldRunPhase(run, 'executor')) {
    const ex = await deps.runPhase(ctx, run, 'executor');
    store.markPhaseDone(id, 'executor', ex.scratch);
    run = store.get(id)!;
  }

  // ── reviewer loop: fix↔recheck up to MAX_CYCLES, optional post_reviewer gate ──
  // The cursor `reviewerCycle` makes the loop resumable mid-flight: a resume re-
  // enters the same cycle. Each cycle's reviewer/fix/recheck phases are themselves
  // idempotency-keyed so a duplicate re-invoke doesn't re-run a completed sub-phase.
  for (let cycle = run.reviewerCycle; cycle < MAX_CYCLES; cycle++) {
    const reviewerPhase = `reviewer:${cycle}`;
    let verdictText: string;
    if (store.shouldRunPhase(run, reviewerPhase)) {
      const rv = await deps.runPhase(ctx, run, reviewerPhase);
      verdictText = rv.text;
      // Record the verdict text (→ the gate + recovered on a re-invoke) alongside
      // any scratch POINTER the phase produced (the reviewer-verdict.md path; spec/10).
      store.markPhaseDone(id, reviewerPhase, {
        ...rv.scratch,
        [`verdict:${cycle}`]: verdictText,
      });
      run = store.get(id)!;
    } else {
      // Re-invoke after this cycle's reviewer already ran: recover its verdict.
      verdictText = run.scratch[`verdict:${cycle}`] ?? '';
    }

    const { verdict } = deps.parseVerdict(verdictText);
    if (verdict === 'APPROVED') break;

    // GATE: post_reviewer (positive-enable), carries the cycle in the re-entry token.
    const reviewerGate: GateName = `post_reviewer:${cycle}`;
    if (deps.gateEnabled('post_reviewer') && input.resumedGate !== reviewerGate) {
      if (run.pendingGate !== reviewerGate) {
        store.setCycle(id, cycle);
        store.setPending(id, reviewerGate);
        await deps.postGateComment(ctx, run, reviewerGate);
      }
      return { status: 'paused', gate: reviewerGate };
    }

    // fix → recheck (each idempotency-keyed). The fix records its commit-sha
    // pointer; the recheck (re-review of the fix) records its verdict pointer.
    // The NEXT cycle's reviewer:<cycle+1> phase is the loop's authoritative re-read
    // of the verdict (the existing golden contract), so the recheck text is captured
    // as scratch context only — it does NOT pre-seed the next cycle's verdict.
    const fixPhase = `fix:${cycle}`;
    if (store.shouldRunPhase(run, fixPhase)) {
      const fx = await deps.runPhase(ctx, run, fixPhase);
      store.markPhaseDone(id, fixPhase, fx.scratch);
      run = store.get(id)!;
    }
    const recheckPhase = `recheck:${cycle}`;
    if (store.shouldRunPhase(run, recheckPhase)) {
      const rc = await deps.runPhase(ctx, run, recheckPhase);
      store.markPhaseDone(id, recheckPhase, {
        ...rc.scratch,
        [`recheckVerdict:${cycle}`]: rc.text,
      });
      run = store.get(id)!;
    }
    store.setCycle(id, cycle + 1);
    run = store.get(id)!;
  }

  // ── finalize: deterministic PR open (workflow code, NOT a model tool — P3 rule) ─
  if (store.shouldRunPhase(run, 'pr')) {
    const pr = await deps.openPullRequest(ctx, run);
    store.markPhaseDone(id, 'pr', { prUrl: pr.html_url });
    store.complete(id);
    return { status: 'complete', prUrl: pr.html_url };
  }

  store.complete(id);
  return { status: 'complete', prUrl: run.scratch.prUrl };
}

/** Flue workflow entry — discovered as the `build` workflow. */
export async function run(ctx: FlueContext<BuildInput>): Promise<BuildResult> {
  const store = new BuildRunStore(storePath());
  try {
    return await runBuild(ctx, store);
  } finally {
    store.close();
  }
}
