import type { FlueContext } from '@flue/runtime';
import type { SandboxFactory } from '@flue/runtime';
import { Octokit } from 'octokit';
import type { BuildRun } from '../build-run-store.ts';
import { parseReviewerVerdict, type ReviewerVerdict } from '../engine/verdict.ts';
import {
  GITHUB_PERMISSION_PROFILES,
  type GitAccessProfile,
} from '../engine/profiles.ts';
import { configureGitAuth } from '../engine/git-auth.ts';
import { loadConfig } from '../config.ts';
import { createArchitectAgent } from './architect.ts';
import {
  renderArchitectPrompt,
  architectPlanPath,
  type ArchitectIssueContext,
} from './architect-prompt.ts';
import {
  withBuildSandbox,
  defaultBuildSandboxOps,
  type BuildSandboxOps,
} from './build-sandbox.ts';
import type { RepoRef } from '../tools/github-read.ts';

// Phase 4 — the BuildDeps DI seam (mirrors pr-review's `deps` pattern).
//
// The build CONTROL FLOW lives in src/workflows/build.ts; the actual phase BODIES
// (guardrails / architect / executor / reviewer / fix / recheck) and the side
// effects (gate ask, open-PR) are injected so the durable control flow — pause /
// resume / idempotency / breaker / phase-skip — is tested OFFLINE with NO live
// model and NO GitHub.
//
// SLICE STATUS (this slice): the ARCHITECT phase body is now WIRED for real (a
// top-level harness session over the architect agent, in a Docker sandbox with the
// repo pre-cloned at the working branch — design: NOT a subagent). Still STUBBED:
// guardrails / executor / reviewer / fix / recheck + the gate ask + the open-PR.
// See TODO(phase-4/…). The architect's own seams (token mint, octokit, sandbox
// ops, session runner) are injectable so the default impl is tested OFFLINE too.

export type BuildInput = {
  /** APP run id — stable caller-owned key (issue/thread), distinct from Flue's runId. */
  runId: string;
  owner: string;
  repo: string;
  issue: number;
  branch?: string;
  taskId?: string;
  /** User-provided issue text (UNTRUSTED) for the architect contextSnapshot. */
  issueContext?: ArchitectIssueContext;
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

/** The `repo-write` profile build phases run under (spec/09 / design — PEM wall). */
export const BUILD_PROFILE: GitAccessProfile = 'repo-write';

/** The run-record scratch pointer key for the architect plan artifact. */
export const ARCHITECT_PLAN_SCRATCH_KEY = 'architectPlan';

// ───────────────────────────────────────────────────────────────────────────
// ARCHITECT phase — the first real build phase body.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Injectable seams for the architect phase, so the default `runPhase('architect')`
 * is testable OFFLINE (no live model / GitHub / Docker). Production wires the real
 * token mint + Octokit + Docker sandbox ops + the agent-session runner.
 */
export interface ArchitectPhaseDeps {
  /** Mint a `repo-write` scoped installation token for this repo (PEM wall). */
  mintToken(run: BuildRun): Promise<string>;
  /** Build an Octokit authenticated with the scoped token. */
  makeOctokit(token: string): Octokit;
  /** Container lifecycle ops for the build sandbox (real Docker by default). */
  sandboxOps: BuildSandboxOps;
  /**
   * Run the architect agent session against the pre-cloned repo + rendered prompt,
   * returning its raw text output. Wraps agent-init + session.prompt so tests can
   * return a canned plan summary with no live model.
   */
  runArchitectSession(
    ctx: FlueContext<BuildInput>,
    ref: RepoRef,
    octokit: Octokit,
    sandbox: SandboxFactory,
    prompt: string,
  ): Promise<string>;
}

/** Mint a repo-write token downscoped to the target repo via the ported git-auth. */
async function mintRepoWriteToken(run: BuildRun): Promise<string> {
  const cfg = loadConfig();
  if (!cfg.githubApp) {
    throw new Error(
      'build/architect: GitHub App not configured ' +
        '(GITHUB_APP_ID / _PRIVATE_KEY_PATH / _INSTALLATION_ID). Cannot mint a repo-write token.',
    );
  }
  const { token } = await configureGitAuth({
    appId: cfg.githubApp.appId,
    privateKeyPath: cfg.githubApp.privateKeyPath,
    installationId: cfg.githubApp.installationId,
    botName: cfg.botLogin.replace(/\[bot\]$/, ''),
    repositories: [run.repo],
    permissions: GITHUB_PERMISSION_PROFILES[BUILD_PROFILE],
  });
  return token;
}

/** The real architect run: init the agent, open the named session, prompt it. */
async function runArchitectSession(
  ctx: FlueContext<BuildInput>,
  ref: RepoRef,
  octokit: Octokit,
  sandbox: SandboxFactory,
  prompt: string,
): Promise<string> {
  const agent = createArchitectAgent(ref, octokit, sandbox);
  const harness = await ctx.init(agent);
  // Top-level NAMED session (design: NOT a subagent) so a post-gate resume can
  // re-open exactly the architect conversation.
  const session = await harness.session('architect');
  const res = await session.prompt(prompt);
  return res.text;
}

/** Default architect-phase deps: real token mint + Octokit + Docker + session. */
export function defaultArchitectPhaseDeps(): ArchitectPhaseDeps {
  return {
    mintToken: mintRepoWriteToken,
    makeOctokit: (token) => new Octokit({ auth: token }),
    sandboxOps: defaultBuildSandboxOps(),
    runArchitectSession,
  };
}

/**
 * Run the ARCHITECT phase: mint a repo-write token, build an Octokit, create a
 * Docker sandbox with the repo pre-cloned at the working branch (CALLER owns the
 * container lifetime — created here, torn down in `withBuildSandbox`'s finally),
 * build the architect agent on that sandbox (cwd /workspace), render the prompt
 * (issue text wrapped UNTRUSTED), run the session, and return its text. The agent
 * writes + commits `.lastlight/issue-<N>/architect-plan.md` in the workspace (the
 * durable handoff). The plan path is the run-record scratch pointer the workflow
 * persists (it is NOT inlined — spec/10 split rule).
 */
export async function runArchitectPhase(
  ctx: FlueContext<BuildInput>,
  run: BuildRun,
  deps: ArchitectPhaseDeps = defaultArchitectPhaseDeps(),
): Promise<PhaseResult> {
  const ref: RepoRef = { owner: run.owner, repo: run.repo };
  const token = await deps.mintToken(run);
  const octokit = deps.makeOctokit(token);

  const prompt = renderArchitectPrompt({
    owner: run.owner,
    repo: run.repo,
    issue: run.issue,
    branch: run.branch,
    issue_context: ctx.payload.issueContext,
  });

  const text = await withBuildSandbox(
    { owner: run.owner, repo: run.repo, branch: run.branch },
    token,
    (sandbox) => deps.runArchitectSession(ctx, ref, octokit, sandbox, prompt),
    { ops: deps.sandboxOps, log: ctx.log },
  );

  return { text };
}

/**
 * Default production deps. The ARCHITECT phase body is WIRED; the rest stay
 * STUBBED (later Phase-4 slices). A stubbed phase throws if a live invoke reaches
 * it, so a misconfigured run fails loudly instead of silently no-op'ing.
 */
export function defaultBuildDeps(
  architectDeps: ArchitectPhaseDeps = defaultArchitectPhaseDeps(),
): BuildDeps {
  return {
    async runPhase(ctx, run, name): Promise<PhaseResult> {
      if (name === 'architect') {
        return runArchitectPhase(ctx, run, architectDeps);
      }
      throw new Error(
        `build: phase "${name}" body not wired yet (TODO(phase-4/agents)). ` +
          `The architect phase is wired this slice; guardrails/executor/reviewer/` +
          `fix/recheck land next. Pass BuildDeps to runBuild() to drive them offline.`,
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
