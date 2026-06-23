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
import { createExecutorAgent } from './executor.ts';
import { createGuardrailsAgent } from './guardrails.ts';
import { createBuildReviewerAgent, createFixAgent } from './build-reviewer.ts';
import {
  renderArchitectPrompt,
  architectPlanPath,
  issueDirFor,
  type ArchitectIssueContext,
} from './architect-prompt.ts';
import {
  renderGuardrailsPrompt,
  guardrailsReportPath,
} from './guardrails-prompt.ts';
import {
  renderGateComment,
  postGateCommentDeterministically,
  renderPrBody,
  renderPrTitle,
  defaultBranchOf,
  openPullRequestDeterministically,
} from '../build-github-post.ts';
import {
  renderExecutorPrompt,
  executorSummaryPath,
} from './executor-prompt.ts';
import {
  renderReviewerPrompt,
  renderReReviewerPrompt,
  renderFixPrompt,
  reviewerVerdictPath,
} from './reviewer-prompt.ts';
import {
  withBuildSandbox,
  defaultBuildSandboxOps,
  type BuildSandboxOps,
  type BuildContainer,
} from './build-sandbox.ts';
import type { RepoRef } from '../tools/github-read.ts';
import { runPhasePrompt } from './record-execution.ts';

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
   * The CHANNEL conversation key (issue/PR thread) this run was triggered from — the
   * SAME `conversationKey` the channel computes from an event. Recorded on the run
   * record at a gate pause (Phase 6 gate correlation) so a channel approve/reject on
   * that conversation resolves THIS run. Absent on a CLI run.
   */
  conversationKey?: string;
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
  /**
   * Optional run-record scratch POINTERS this phase produced (file paths / shas —
   * never blobs; spec/10 split rule). The workflow merges them when it marks the
   * phase done. The executor records its summary-file pointer + commit sha here.
   */
  scratch?: Record<string, string>;
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
  /**
   * Post the approval ask (a deterministic GitHub issue comment). Guarded by the
   * workflow so it posts at most once per gate hit. Returns the created comment id
   * (recorded in the run record for audit); a fake may return void.
   */
  postGateComment(
    ctx: FlueContext<BuildInput>,
    run: BuildRun,
    gate: string,
  ): Promise<{ commentId: number } | void>;
  /**
   * Deterministically open the PR over the scoped repo-write token (workflow code,
   * NOT a model tool). Idempotent: reuses an already-open PR for the branch.
   */
  openPullRequest(
    ctx: FlueContext<BuildInput>,
    run: BuildRun,
  ): Promise<{ html_url: string; number?: number }>;
  /** Whether a gate fires (positive-enable config). Disabled → no pause. */
  gateEnabled(gate: 'post_architect' | 'post_reviewer'): boolean;
  /** Parse the reviewer verdict marker (the prompt↔code contract). */
  parseVerdict(text: string): { verdict: ReviewerVerdict; viaFallback: boolean };
}

/** Reviewer fix/recheck cap (build.yaml `loop.max_cycles: 2`). */
export const MAX_CYCLES = 2;

/** The `repo-write` profile build phases run under (spec/09 / design — PEM wall). */
export const BUILD_PROFILE: GitAccessProfile = 'repo-write';

/** The run-record scratch pointer key for the guardrails report artifact. */
export const GUARDRAILS_REPORT_SCRATCH_KEY = 'guardrailsReport';

/** The run-record scratch pointer key for the architect plan artifact. */
export const ARCHITECT_PLAN_SCRATCH_KEY = 'architectPlan';

/** The run-record scratch key recording the opened PR number (the open-PR anchor). */
export const PR_NUMBER_SCRATCH_KEY = 'prNumber';

/** The run-record scratch key prefix for a posted gate-comment id (`gateComment:<gate>`). */
export function gateCommentScratchKey(gate: string): string {
  return `gateComment:${gate}`;
}

/** The run-record scratch pointer key for the executor summary artifact. */
export const EXECUTOR_SUMMARY_SCRATCH_KEY = 'executorSummary';

/** The run-record scratch key recording the executor's HEAD commit sha. */
export const EXECUTOR_SHA_SCRATCH_KEY = 'executorSha';

/** The run-record scratch pointer key for the reviewer-verdict artifact. */
export const REVIEWER_VERDICT_SCRATCH_KEY = 'reviewerVerdict';

/** The run-record scratch key recording a fix cycle's HEAD commit sha (`fixSha:N`). */
export function fixShaScratchKey(cycle: number): string {
  return `fixSha:${cycle}`;
}

/**
 * Parse the loop cycle out of a per-cycle phase name (`reviewer:0` / `fix:1` /
 * `recheck:0`). The build.ts loop keys every reviewer-loop phase this way so each
 * cycle is independently idempotency-tracked + names the right prompt context.
 */
export function cycleFromPhaseName(name: string): number {
  const m = name.match(/:(\d+)$/);
  if (!m) {
    throw new Error(`build: reviewer-loop phase "${name}" is missing its :<cycle> suffix.`);
  }
  return Number(m[1]);
}

// ───────────────────────────────────────────────────────────────────────────
// GUARDRAILS phase — the pre-flight screen (runs FIRST, before the architect).
//
// Emits READY / BLOCKED (the prompt↔code marker). The workflow parses
// `^\s*BLOCKED` and fails the build — UNLESS the issue is a BOOTSTRAP task
// (`lastlight:bootstrap` label / a `guardrails:` title prefix), in which case the
// BLOCK is bypassed so the executor can establish the missing tooling (parity with
// build.yaml `contains_BLOCKED.unless_label` / `unless_title_matches`).
// ───────────────────────────────────────────────────────────────────────────

/** The bootstrap label name (build.yaml `unless_label`). Mirrors config.bootstrapLabel. */
export const BOOTSTRAP_LABEL = 'lastlight:bootstrap';

/** The `unless_title_matches` regex (build.yaml): a `guardrails:`/`[guardrails]` prefix. */
const GUARDRAILS_TITLE_RE = /^\s*(guardrails:|\[guardrails\])/i;

/**
 * BLOCKED-bypass parity (design Q4.5 / build.yaml `contains_BLOCKED.unless_*`): a
 * guardrails BLOCKED is bypassed (the build proceeds so the executor can ADD the
 * missing tooling) when the issue is itself a bootstrap task — detected by the
 * `lastlight:bootstrap` label OR a `guardrails:` / `[guardrails]` title prefix. The
 * issue metadata comes from the run input's `issueContext` (trigger metadata, NOT
 * model output). With no issue context, there is no bypass (a normal feature build
 * BLOCKED stops, as in the reference).
 */
export function bootstrapBypass(ic?: ArchitectIssueContext): boolean {
  if (!ic) return false;
  const label = (ic.labels ?? []).some((l) => l === BOOTSTRAP_LABEL);
  const title = !!ic.title && GUARDRAILS_TITLE_RE.test(ic.title);
  return label || title;
}

/**
 * Injectable seams for the guardrails phase, mirroring the architect's seams so the
 * default `runPhase('guardrails')` is testable OFFLINE (no live model / GitHub /
 * Docker). The screen runs WITH the sandbox (it inspects the pre-cloned repo).
 */
export interface GuardrailsPhaseDeps {
  mintToken(run: BuildRun): Promise<string>;
  makeOctokit(token: string): Octokit;
  sandboxOps: BuildSandboxOps;
  /**
   * Run the guardrails agent session against the pre-cloned repo + rendered prompt,
   * returning its raw text (ending in the READY / BLOCKED marker). The agent
   * commits a guardrails-report.md in-sandbox but does NOT push.
   */
  runGuardrailsSession(
    ctx: FlueContext<BuildInput>,
    ref: RepoRef,
    octokit: Octokit,
    sandbox: SandboxFactory,
    prompt: string,
  ): Promise<string>;
}

/** The real guardrails run: init the agent, open the named session, prompt it. */
async function runGuardrailsSession(
  ctx: FlueContext<BuildInput>,
  ref: RepoRef,
  octokit: Octokit,
  sandbox: SandboxFactory,
  prompt: string,
): Promise<string> {
  const agent = createGuardrailsAgent(ref, octokit, sandbox);
  const harness = await ctx.init(agent);
  const session = await harness.session('guardrails');
  // Shared phase-prompt seam: records per-phase usage (cost/tokens) into the
  // app-owned `executions` stats table — NON-FATAL + TEST-INERT (record-execution.ts).
  const res = await runPhasePrompt(session, prompt, {
    runId: ctx.payload.runId,
    workflow: 'build',
    phase: 'guardrails',
  });
  return res.text;
}

/** Default guardrails-phase deps: real token mint + Octokit + Docker + session. */
export function defaultGuardrailsPhaseDeps(): GuardrailsPhaseDeps {
  return {
    mintToken: mintRepoWriteToken,
    makeOctokit: (token) => new Octokit({ auth: token }),
    sandboxOps: defaultBuildSandboxOps(),
    runGuardrailsSession,
  };
}

/**
 * Run the GUARDRAILS phase (the FIRST build phase): mint a repo-write token, build
 * an Octokit, create a Docker sandbox with the repo pre-cloned at the working
 * branch (CALLER owns the container lifetime, torn down in `withBuildSandbox`'s
 * finally), build the guardrails agent on that sandbox (cwd /workspace), render the
 * prompt (issue text wrapped UNTRUSTED so the bootstrap escape hatch is judged from
 * data, not instructions), run the session, and return its text (ending in the
 * READY / BLOCKED marker the workflow parses). Records the guardrails-report
 * pointer in scratch (NOT the report blob — spec/10).
 */
export async function runGuardrailsPhase(
  ctx: FlueContext<BuildInput>,
  run: BuildRun,
  deps: GuardrailsPhaseDeps = defaultGuardrailsPhaseDeps(),
): Promise<PhaseResult> {
  const ref: RepoRef = { owner: run.owner, repo: run.repo };
  const token = await deps.mintToken(run);
  const octokit = deps.makeOctokit(token);

  const prompt = renderGuardrailsPrompt({
    owner: run.owner,
    repo: run.repo,
    issue: run.issue,
    branch: run.branch,
    bootstrapLabel: BOOTSTRAP_LABEL,
    issue_context: ctx.payload.issueContext,
  });

  const text = await withBuildSandbox(
    { owner: run.owner, repo: run.repo, branch: run.branch },
    token,
    (sandbox) => deps.runGuardrailsSession(ctx, ref, octokit, sandbox, prompt),
    { ops: deps.sandboxOps, log: ctx.log },
  );

  return {
    text,
    scratch: { [GUARDRAILS_REPORT_SCRATCH_KEY]: guardrailsReportPath(run.issue) },
  };
}

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
  const res = await runPhasePrompt(session, prompt, {
    runId: ctx.payload.runId,
    workflow: 'build',
    phase: 'architect',
  });
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

// ───────────────────────────────────────────────────────────────────────────
// EXECUTOR phase — reads the committed plan, implements, commits, then PUSHES.
// ───────────────────────────────────────────────────────────────────────────

/** The result of the executor phase: the agent's text + the post-commit sha. */
export interface ExecutorRunResult {
  /** The agent's raw text output (file list / test results / commit hash). */
  text: string;
  /** The branch HEAD sha after the executor committed (the reviewer/PR anchor). */
  sha: string;
}

/**
 * Injectable seams for the executor phase, so the default `runPhase('executor')`
 * is testable OFFLINE (no live model / GitHub / Docker / push). Production wires
 * the real token mint + Octokit + Docker sandbox ops + the agent-session runner +
 * the deterministic branch push.
 */
export interface ExecutorPhaseDeps {
  /** Mint a `repo-write` scoped installation token for this repo (PEM wall). */
  mintToken(run: BuildRun): Promise<string>;
  /** Build an Octokit authenticated with the scoped token. */
  makeOctokit(token: string): Octokit;
  /** Container lifecycle ops for the build sandbox (real Docker by default). */
  sandboxOps: BuildSandboxOps;
  /**
   * Run the executor agent session against the pre-cloned repo (with the
   * architect plan on the branch) + rendered prompt; returns its raw text output.
   * The agent COMMITS its changes in-sandbox via the git CLI but does NOT push.
   */
  runExecutorSession(
    ctx: FlueContext<BuildInput>,
    ref: RepoRef,
    octokit: Octokit,
    sandbox: SandboxFactory,
    prompt: string,
  ): Promise<string>;
  /**
   * Read the branch HEAD sha after the executor committed (over the same checkout).
   * Recorded in the run-record scratch as the reviewer/PR anchor.
   */
  readHeadSha(container: BuildContainer): Promise<string>;
  /**
   * Push the working branch to origin over the repo-write token (the controlled,
   * workflow-owned side effect — a SEAM so tests assert it WOULD push, with the
   * bound branch ref, WITHOUT a real push). LIVE form runs `git push` in-sandbox.
   */
  pushBranch(container: BuildContainer, branch: string): Promise<void>;
}

/** The real executor run: init the agent, open the named session, prompt it. */
async function runExecutorSession(
  ctx: FlueContext<BuildInput>,
  ref: RepoRef,
  octokit: Octokit,
  sandbox: SandboxFactory,
  prompt: string,
): Promise<string> {
  const agent = createExecutorAgent(ref, octokit, sandbox);
  const harness = await ctx.init(agent);
  // Top-level NAMED session (design: NOT a subagent) so a post-gate resume can
  // re-open exactly the executor conversation.
  const session = await harness.session('executor');
  const res = await runPhasePrompt(session, prompt, {
    runId: ctx.payload.runId,
    workflow: 'build',
    phase: 'executor',
  });
  return res.text;
}

/** Read the branch HEAD sha over the same checkout (deterministic, not a model tool). */
async function readHeadSha(container: BuildContainer): Promise<string> {
  const r = await container.exec('git rev-parse HEAD', {
    cwd: '/workspace',
    timeoutMs: 30_000,
  });
  return r.stdout.trim();
}

/**
 * Push the working branch to origin (the LIVE side effect). Runs in-sandbox over
 * the baked repo-write token. The branch ref is BOUND (closed over the run), never
 * model-chosen. In tests this whole seam is mocked → NO real push happens.
 */
async function pushBranch(container: BuildContainer, branch: string): Promise<void> {
  const r = await container.exec(
    `git push origin ${shellArgInline(branch)}`,
    { cwd: '/workspace', timeoutMs: 5 * 60_000 },
  );
  if (r.exitCode !== 0) {
    throw new Error(`build/executor: git push failed (${r.exitCode}): ${r.stderr.trim()}`);
  }
}

/** Single-quote for safe `sh -c` interpolation (the branch is workflow-derived). */
function shellArgInline(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Default executor-phase deps: real token mint + Octokit + Docker + session + push. */
export function defaultExecutorPhaseDeps(): ExecutorPhaseDeps {
  return {
    mintToken: mintRepoWriteToken,
    makeOctokit: (token) => new Octokit({ auth: token }),
    sandboxOps: defaultBuildSandboxOps(),
    runExecutorSession,
    readHeadSha,
    pushBranch,
  };
}

/**
 * Run the EXECUTOR phase (runs AFTER the post_architect gate is approved): mint a
 * repo-write token, build an Octokit, create a Docker sandbox with the repo
 * pre-cloned at the working branch (the architect's plan is committed on it — the
 * CALLER owns the container lifetime, torn down in `withBuildSandbox`'s finally),
 * build the executor agent on that sandbox (cwd /workspace), render the prompt (it
 * names the plan path so the agent reads `.lastlight/issue-<N>/architect-plan.md`;
 * any user issue text wrapped UNTRUSTED), run the session (the agent implements +
 * COMMITS in-sandbox via the git CLI), read the committed HEAD sha, then PUSH the
 * branch over the deterministic seam (mocked in tests). Returns the agent text;
 * the workflow persists the executor-summary pointer + the commit sha to the
 * run-record scratch (the reviewer/PR anchors — NOT the diff blob; spec/10 split).
 */
export async function runExecutorPhase(
  ctx: FlueContext<BuildInput>,
  run: BuildRun,
  deps: ExecutorPhaseDeps = defaultExecutorPhaseDeps(),
): Promise<ExecutorRunResult> {
  const ref: RepoRef = { owner: run.owner, repo: run.repo };
  const token = await deps.mintToken(run);
  const octokit = deps.makeOctokit(token);

  const prompt = renderExecutorPrompt({
    owner: run.owner,
    repo: run.repo,
    issue: run.issue,
    branch: run.branch,
    issue_context: ctx.payload.issueContext,
  });

  return withBuildSandbox(
    { owner: run.owner, repo: run.repo, branch: run.branch },
    token,
    async (sandbox, container) => {
      const text = await deps.runExecutorSession(ctx, ref, octokit, sandbox, prompt);
      const sha = await deps.readHeadSha(container);
      // The CONTROLLED repo-write side effect: push the branch the workflow bound
      // (mocked in tests → asserts it WOULD push, no real push). Live push is
      // gated + run later with the user.
      await deps.pushBranch(container, run.branch);
      return { text, sha };
    },
    { ops: deps.sandboxOps, log: ctx.log },
  );
}

// ───────────────────────────────────────────────────────────────────────────
// REVIEWER LOOP — reviewer:N → [post_reviewer gate] → fix:N → recheck:N.
//
// reviewer:N  — review the executor's COMMITTED changes in the checkout, emit a
//               VERDICT marker (parsed → the durable loop); the reviewer commits
//               reviewer-verdict.md in-sandbox, NO GitHub post (internal review).
// fix:N       — address the reviewer notes (read from the committed verdict file),
//               run the gate, COMMIT in-sandbox, then PUSH the branch (mocked seam).
// recheck:N   — the SAME reviewer agent re-prompted with re-reviewer.md re-reviews
//               the fix → new VERDICT → the loop breaks (APPROVED) or runs another
//               cycle (build.ts owns max_cycles + the break-on-APPROVED).
//
// NO live model / GitHub / Docker / push in tests — every seam is injectable.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Injectable seams for the reviewer/recheck phases, so the default
 * `runPhase('reviewer:N'|'recheck:N')` is testable OFFLINE. Production wires the
 * real token mint + Octokit + Docker sandbox ops + the reviewer agent-session
 * runner. A re-review re-prompts the SAME reviewer agent with re-reviewer.md.
 */
export interface ReviewerPhaseDeps {
  /** Mint a `repo-write` scoped installation token for this repo (PEM wall). */
  mintToken(run: BuildRun): Promise<string>;
  /** Build an Octokit authenticated with the scoped token. */
  makeOctokit(token: string): Octokit;
  /** Container lifecycle ops for the build sandbox (real Docker by default). */
  sandboxOps: BuildSandboxOps;
  /**
   * Run the build reviewer agent session against the pre-cloned checkout (carrying
   * the executor's committed changes) + the rendered reviewer / re-reviewer prompt;
   * returns its raw text (ending in the VERDICT marker). The reviewer commits the
   * verdict artifact in-sandbox via the git CLI but does NOT push.
   */
  runReviewerSession(
    ctx: FlueContext<BuildInput>,
    ref: RepoRef,
    octokit: Octokit,
    sandbox: SandboxFactory,
    prompt: string,
    sessionName: string,
  ): Promise<string>;
}

/** The real reviewer run: init the agent, open the named session, prompt it. */
async function runReviewerSession(
  ctx: FlueContext<BuildInput>,
  ref: RepoRef,
  octokit: Octokit,
  sandbox: SandboxFactory,
  prompt: string,
  sessionName: string,
): Promise<string> {
  const agent = createBuildReviewerAgent(ref, octokit, sandbox);
  const harness = await ctx.init(agent);
  // Top-level NAMED per-cycle session (`reviewer:0` / `recheck:0` — NOT a subagent)
  // so a post-gate resume re-opens exactly the right cycle's conversation.
  const session = await harness.session(sessionName);
  const res = await runPhasePrompt(session, prompt, {
    runId: ctx.payload.runId,
    workflow: 'build',
    phase: sessionName,
  });
  return res.text;
}

/** Default reviewer-phase deps: real token mint + Octokit + Docker + session. */
export function defaultReviewerPhaseDeps(): ReviewerPhaseDeps {
  return {
    mintToken: mintRepoWriteToken,
    makeOctokit: (token) => new Octokit({ auth: token }),
    sandboxOps: defaultBuildSandboxOps(),
    runReviewerSession,
  };
}

/**
 * Run a REVIEWER phase (`reviewer:N` is the first review; `recheck:N` re-reviews
 * after fix cycle N): mint a repo-write token, build an Octokit, create a Docker
 * sandbox with the repo pre-cloned at the working branch (carrying the executor's
 * committed changes + any prior verdict/fix commits — CALLER owns the container
 * lifetime, torn down in `withBuildSandbox`'s finally), build the reviewer agent on
 * that sandbox (cwd /workspace), render the prompt (reviewer.md for the first
 * review, re-reviewer.md for a recheck), run the session, and return its text
 * (ending in the VERDICT marker the loop parses). NO GitHub post — this is an
 * internal build review; the verdict drives the loop + the gate surfaces it.
 */
export async function runReviewerPhase(
  ctx: FlueContext<BuildInput>,
  run: BuildRun,
  cycle: number,
  isRecheck: boolean,
  deps: ReviewerPhaseDeps = defaultReviewerPhaseDeps(),
): Promise<PhaseResult> {
  const ref: RepoRef = { owner: run.owner, repo: run.repo };
  const token = await deps.mintToken(run);
  const octokit = deps.makeOctokit(token);

  const promptCtx = {
    owner: run.owner,
    repo: run.repo,
    issue: run.issue,
    branch: run.branch,
  };
  const prompt = isRecheck
    ? renderReReviewerPrompt(promptCtx, cycle)
    : renderReviewerPrompt(promptCtx);
  const sessionName = `${isRecheck ? 'recheck' : 'reviewer'}:${cycle}`;

  const text = await withBuildSandbox(
    { owner: run.owner, repo: run.repo, branch: run.branch },
    token,
    (sandbox) =>
      deps.runReviewerSession(ctx, ref, octokit, sandbox, prompt, sessionName),
    { ops: deps.sandboxOps, log: ctx.log },
  );

  return {
    text,
    scratch: { [REVIEWER_VERDICT_SCRATCH_KEY]: reviewerVerdictPath(run.issue) },
  };
}

// ───────────────────────────────────────────────────────────────────────────
// FIX phase — addresses the reviewer notes, commits, then PUSHES (mocked seam).
// ───────────────────────────────────────────────────────────────────────────

/** The result of a fix phase: the agent's text + the post-commit sha. */
export interface FixRunResult {
  text: string;
  /** The branch HEAD sha after the fix committed (the recheck/PR anchor). */
  sha: string;
}

/**
 * Injectable seams for the fix phase, so the default `runPhase('fix:N')` is
 * testable OFFLINE. Mirrors the executor's seams (mint + octokit + sandbox ops +
 * session + sha read + the MOCKED push) — the fix is just a scoped re-implementation.
 */
export interface FixPhaseDeps {
  mintToken(run: BuildRun): Promise<string>;
  makeOctokit(token: string): Octokit;
  sandboxOps: BuildSandboxOps;
  /**
   * Run the fix agent session against the pre-cloned checkout (carrying the
   * reviewer-verdict.md the agent reads) + the rendered fix prompt; returns its raw
   * text. The agent COMMITS its fixes in-sandbox via the git CLI but does NOT push.
   */
  runFixSession(
    ctx: FlueContext<BuildInput>,
    ref: RepoRef,
    octokit: Octokit,
    sandbox: SandboxFactory,
    prompt: string,
    sessionName: string,
  ): Promise<string>;
  /** Read the branch HEAD sha after the fix committed (the recheck/PR anchor). */
  readHeadSha(container: BuildContainer): Promise<string>;
  /**
   * Push the working branch to origin over the repo-write token (the controlled,
   * workflow-owned side effect — a SEAM so tests assert it WOULD push, with the
   * bound branch ref, WITHOUT a real push). Shares the executor's push contract.
   */
  pushBranch(container: BuildContainer, branch: string): Promise<void>;
}

/** The real fix run: init the agent, open the per-cycle named session, prompt it. */
async function runFixSession(
  ctx: FlueContext<BuildInput>,
  ref: RepoRef,
  octokit: Octokit,
  sandbox: SandboxFactory,
  prompt: string,
  sessionName: string,
): Promise<string> {
  const agent = createFixAgent(ref, octokit, sandbox);
  const harness = await ctx.init(agent);
  const session = await harness.session(sessionName);
  const res = await runPhasePrompt(session, prompt, {
    runId: ctx.payload.runId,
    workflow: 'build',
    phase: sessionName,
  });
  return res.text;
}

/** Default fix-phase deps: real token mint + Octokit + Docker + session + sha + push. */
export function defaultFixPhaseDeps(): FixPhaseDeps {
  return {
    mintToken: mintRepoWriteToken,
    makeOctokit: (token) => new Octokit({ auth: token }),
    sandboxOps: defaultBuildSandboxOps(),
    runFixSession,
    readHeadSha,
    pushBranch,
  };
}

/**
 * Run a FIX phase (`fix:N`): mint a repo-write token, build an Octokit, create a
 * Docker sandbox with the repo pre-cloned at the working branch (carrying the
 * reviewer-verdict.md the agent reads — CALLER owns the container lifetime, torn
 * down in `withBuildSandbox`'s finally), build the fix agent on that sandbox (cwd
 * /workspace), render the fix prompt (it names the reviewer-verdict path so the
 * agent fixes ONLY the reported issues), run the session (the agent addresses the
 * notes + COMMITS in-sandbox via the git CLI), read the committed HEAD sha, then
 * PUSH the branch over the deterministic seam (mocked in tests). Returns the agent
 * text + the new sha (the recheck/PR anchor).
 */
export async function runFixPhase(
  ctx: FlueContext<BuildInput>,
  run: BuildRun,
  cycle: number,
  deps: FixPhaseDeps = defaultFixPhaseDeps(),
): Promise<FixRunResult> {
  const ref: RepoRef = { owner: run.owner, repo: run.repo };
  const token = await deps.mintToken(run);
  const octokit = deps.makeOctokit(token);

  const prompt = renderFixPrompt(
    { owner: run.owner, repo: run.repo, issue: run.issue, branch: run.branch },
    cycle,
  );
  const sessionName = `fix:${cycle}`;

  return withBuildSandbox(
    { owner: run.owner, repo: run.repo, branch: run.branch },
    token,
    async (sandbox, container) => {
      const text = await deps.runFixSession(ctx, ref, octokit, sandbox, prompt, sessionName);
      const sha = await deps.readHeadSha(container);
      // The CONTROLLED repo-write side effect: push the bound branch (mocked in
      // tests). Live push is gated + run later with the user.
      await deps.pushBranch(container, run.branch);
      return { text, sha };
    },
    { ops: deps.sandboxOps, log: ctx.log },
  );
}

// ───────────────────────────────────────────────────────────────────────────
// GATE ASK — the deterministic approval-gate comment (NOT a model tool).
// ───────────────────────────────────────────────────────────────────────────

/** Injectable seams for the gate ask, so the default is testable OFFLINE. */
export interface GatePostDeps {
  mintToken(run: BuildRun): Promise<string>;
  makeOctokit(token: string): Octokit;
}

/** Default gate-post deps: real token mint + Octokit (no sandbox — pure API call). */
export function defaultGatePostDeps(): GatePostDeps {
  return {
    mintToken: mintRepoWriteToken,
    makeOctokit: (token) => new Octokit({ auth: token }),
  };
}

/** The artifact path a gate surfaces: the plan for post_architect, the verdict otherwise. */
function gateArtifactPath(run: BuildRun, gate: string): string {
  if (gate.startsWith('post_reviewer')) return reviewerVerdictPath(run.issue);
  return architectPlanPath(run.issue);
}

/**
 * Deterministically post the approval-gate ask (a GitHub ISSUE COMMENT) over the
 * scoped repo-write token. The owner/repo/issue are CLOSED OVER the bound run, NOT
 * model-chosen (mirrors github-post.ts). The body surfaces the artifact (plan /
 * verdict) + the approve/reject instructions the human resumes with. The workflow
 * guards the call (it posts once per gate hit via the run record's `pendingGate`);
 * the returned comment id is recorded for audit.
 */
export async function runPostGateComment(
  ctx: FlueContext<BuildInput>,
  run: BuildRun,
  gate: string,
  deps: GatePostDeps = defaultGatePostDeps(),
): Promise<{ commentId: number }> {
  const ref: RepoRef = { owner: run.owner, repo: run.repo };
  const token = await deps.mintToken(run);
  const octokit = deps.makeOctokit(token);

  const cycleMatch = gate.match(/:(\d+)$/);
  const body = renderGateComment({
    gate,
    branch: run.branch,
    artifactPath: gateArtifactPath(run, gate),
    cycle: cycleMatch ? Number(cycleMatch[1]) : undefined,
  });
  const posted = await postGateCommentDeterministically(octokit, ref, run.issue, body);
  return { commentId: posted.id };
}

// ───────────────────────────────────────────────────────────────────────────
// OPEN PR — the deterministic finalize (NOT a model tool; idempotent).
// ───────────────────────────────────────────────────────────────────────────

/** Injectable seams for the open-PR step, so the default is testable OFFLINE. */
export interface OpenPrDeps {
  mintToken(run: BuildRun): Promise<string>;
  makeOctokit(token: string): Octokit;
}

/** Default open-PR deps: real token mint + Octokit (deterministic API calls). */
export function defaultOpenPrDeps(): OpenPrDeps {
  return {
    mintToken: mintRepoWriteToken,
    makeOctokit: (token) => new Octokit({ auth: token }),
  };
}

/** The handoff artifacts a completed build produces (the PR body links these). */
const PR_ARTIFACT_FILES = [
  'guardrails-report.md',
  'architect-plan.md',
  'executor-summary.md',
  'reviewer-verdict.md',
  'status.md',
];

/**
 * Deterministically open the PR (the finalize step) over the scoped repo-write
 * token. IDEMPOTENT: reuses an already-open PR for the working branch (a resumed /
 * retried run must NOT double-open). owner/repo/head/base come from the bound run +
 * the repo's default branch, NEVER the model. Renders the PR title/body
 * deterministically (the agent does NOT write the PR — design/phase-4 P3 rule).
 *
 * The reviewer-loop outcome is read from the run record: the loop ended APPROVED
 * iff the last cycle's recorded verdict was APPROVED (otherwise the body notes the
 * unresolved issues + the fix-cycle count).
 */
export async function runOpenPullRequest(
  ctx: FlueContext<BuildInput>,
  run: BuildRun,
  deps: OpenPrDeps = defaultOpenPrDeps(),
): Promise<{ html_url: string; number: number }> {
  const ref: RepoRef = { owner: run.owner, repo: run.repo };
  const token = await deps.mintToken(run);
  const octokit = deps.makeOctokit(token);

  const base = await defaultBranchOf(octokit, ref);
  const lastCycle = Math.max(0, run.reviewerCycle - 1);
  const lastVerdict = run.scratch[`verdict:${lastCycle}`] ?? '';
  const approved = /VERDICT:\s*APPROVED/i.test(lastVerdict);

  const body = renderPrBody({
    issue: run.issue,
    branch: run.branch,
    links: {
      owner: run.owner,
      repo: run.repo,
      branch: run.branch,
      issueDir: issueDirFor(run.issue),
      files: PR_ARTIFACT_FILES,
    },
    approved,
    cycles: run.reviewerCycle,
  });
  const title = renderPrTitle(run.issue, run.branch);

  const pr = await openPullRequestDeterministically(octokit, ref, {
    branch: run.branch,
    base,
    title,
    body,
  });
  return { html_url: pr.html_url, number: pr.number };
}

/**
 * Default production deps. ALL build-workflow phase bodies + side effects are now
 * WIRED: guardrails / architect / executor / reviewer-loop (reviewer / fix /
 * recheck), the deterministic gate ask, and the deterministic open-PR. Each is
 * driven OFFLINE in tests via injected sub-deps; production uses the real token
 * mint + Octokit + Docker sandbox. Gate enablement is positive-enable from config.
 */
export function defaultBuildDeps(
  architectDeps: ArchitectPhaseDeps = defaultArchitectPhaseDeps(),
  executorDeps: ExecutorPhaseDeps = defaultExecutorPhaseDeps(),
  reviewerDeps: ReviewerPhaseDeps = defaultReviewerPhaseDeps(),
  fixDeps: FixPhaseDeps = defaultFixPhaseDeps(),
  guardrailsDeps: GuardrailsPhaseDeps = defaultGuardrailsPhaseDeps(),
  gatePostDeps: GatePostDeps = defaultGatePostDeps(),
  openPrDeps: OpenPrDeps = defaultOpenPrDeps(),
): BuildDeps {
  return {
    async runPhase(ctx, run, name): Promise<PhaseResult> {
      if (name === 'guardrails') {
        return runGuardrailsPhase(ctx, run, guardrailsDeps);
      }
      if (name === 'architect') {
        return runArchitectPhase(ctx, run, architectDeps);
      }
      if (name === 'executor') {
        const res = await runExecutorPhase(ctx, run, executorDeps);
        return {
          text: res.text,
          scratch: {
            [EXECUTOR_SUMMARY_SCRATCH_KEY]: executorSummaryPath(run.issue),
            [EXECUTOR_SHA_SCRATCH_KEY]: res.sha,
          },
        };
      }
      // The reviewer loop is keyed per-cycle (`reviewer:N` / `fix:N` / `recheck:N`).
      if (name.startsWith('reviewer:')) {
        return runReviewerPhase(ctx, run, cycleFromPhaseName(name), false, reviewerDeps);
      }
      if (name.startsWith('recheck:')) {
        return runReviewerPhase(ctx, run, cycleFromPhaseName(name), true, reviewerDeps);
      }
      if (name.startsWith('fix:')) {
        const cycle = cycleFromPhaseName(name);
        const res = await runFixPhase(ctx, run, cycle, fixDeps);
        return { text: res.text, scratch: { [fixShaScratchKey(cycle)]: res.sha } };
      }
      throw new Error(
        `build: unknown phase "${name}" (no body routed). The build phases are ` +
          `guardrails / architect / executor / reviewer-loop (reviewer:N / fix:N / ` +
          `recheck:N). Check the phase-name spelling in build.ts.`,
      );
    },
    async postGateComment(ctx, run, gate): Promise<{ commentId: number }> {
      return runPostGateComment(ctx, run, gate, gatePostDeps);
    },
    async openPullRequest(ctx, run): Promise<{ html_url: string; number: number }> {
      return runOpenPullRequest(ctx, run, openPrDeps);
    },
    // Positive-enable from config: a gate fires only if `approval[gate] === true`
    // (build.yaml parity — a disabled/absent gate falls through with no pause).
    gateEnabled: (gate) => loadConfig().approval?.[gate] === true,
    parseVerdict: (text) => parseReviewerVerdict(text),
  };
}
