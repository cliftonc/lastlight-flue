import type { FlueContext } from '@flue/runtime';
import type { BuildRun } from '../build-run-store.ts';
import { parseReviewerVerdict, type ReviewerVerdict } from '../engine/verdict.ts';

// Phase 4 — the BuildDeps DI seam (mirrors pr-review's `deps` pattern).
//
// The build CONTROL FLOW lives in src/workflows/build.ts; the actual phase BODIES
// (guardrails / architect / executor / reviewer / fix / recheck) and the side
// effects (gate ask, open-PR) are injected so the durable control flow — pause /
// resume / idempotency / breaker / phase-skip — is tested OFFLINE with NO live
// model and NO GitHub.
//
// TODO(phase-4/agents): the default deps here are STUBS. Later slices wire the real
// builder agent (architect/executor/reviewer top-level harness sessions, per the
// design: NOT subagents) and the deterministic open-PR over the scoped repo-write
// token (PEM wall). Nothing here touches a real repo, model, or GitHub.

export type BuildInput = {
  /** APP run id — stable caller-owned key (issue/thread), distinct from Flue's runId. */
  runId: string;
  owner: string;
  repo: string;
  issue: number;
  branch?: string;
  taskId?: string;
  /**
   * Per-gate re-entry token set by resume(): the gate this re-invoke is approved
   * past (`post_architect` or `post_reviewer:<cycle>`). Absent on a fresh invoke.
   */
  resumedGate?: string;
  /** Trigger provenance ("cli" | "webhook" | "cron" | "boot"). */
  triggerType?: string;
};

/** The structured result of a build invocation. */
export type BuildResult = {
  status: 'paused' | 'complete' | 'failed';
  gate?: string;
  prUrl?: string;
  reason?: string;
};

/**
 * The result of running one agent phase. `text` carries the marker output the
 * control flow parses (e.g. the reviewer VERDICT, the guardrails BLOCKED/READY).
 */
export interface PhaseResult {
  text: string;
}

/**
 * Injectable phase bodies + side effects. Production wires real agent sessions +
 * the deterministic PR open; tests pass fakes that record calls.
 */
export interface BuildDeps {
  /**
   * Run a named build phase (opens its own top-level harness session in prod).
   * `name` is the session/phase name (`guardrails`, `architect`, `executor`,
   * `reviewer:0`, `fix:0`, `recheck:0`, …). Returns the agent's marker text.
   */
  runPhase(
    ctx: FlueContext<BuildInput>,
    run: BuildRun,
    name: string,
  ): Promise<PhaseResult>;
  /** Post the approval ask (GitHub comment / Slack). Guarded so it posts once. */
  postGateComment(
    ctx: FlueContext<BuildInput>,
    run: BuildRun,
    gate: string,
  ): Promise<void>;
  /** Deterministically open the PR over the scoped repo-write token (workflow code). */
  openPullRequest(
    ctx: FlueContext<BuildInput>,
    run: BuildRun,
  ): Promise<{ html_url: string }>;
  /** Whether a gate fires (positive-enable config). Disabled → no pause. */
  gateEnabled(gate: 'post_architect' | 'post_reviewer'): boolean;
  /** Parse the reviewer verdict marker (the prompt↔code contract). */
  parseVerdict(text: string): { verdict: ReviewerVerdict; viaFallback: boolean };
}

/** Reviewer fix/recheck cap (build.yaml `loop.max_cycles: 2`). */
export const MAX_CYCLES = 2;

/**
 * Default production deps — STUBBED for this foundational slice. They throw if a
 * real agent/PR would run, so a misconfigured live invoke fails loudly instead of
 * silently no-op'ing. Real bodies land in later Phase-4 slices.
 */
export function defaultBuildDeps(): BuildDeps {
  return {
    async runPhase(_ctx, _run, name): Promise<PhaseResult> {
      throw new Error(
        `build: phase "${name}" body not wired yet (TODO(phase-4/agents)). ` +
          `This foundational slice proves the durable control flow only; ` +
          `pass BuildDeps to runBuild() to drive it offline.`,
      );
    },
    async postGateComment(_ctx, _run, _gate): Promise<void> {
      throw new Error('build: postGateComment not wired (TODO(phase-4/channels)).');
    },
    async openPullRequest(_ctx, _run): Promise<{ html_url: string }> {
      throw new Error('build: openPullRequest not wired (TODO(phase-4/github-post)).');
    },
    // Both gates enabled by default (post_architect is the headline acceptance).
    gateEnabled: () => true,
    parseVerdict: (text) => parseReviewerVerdict(text),
  };
}
