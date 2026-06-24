import {
  defineAgent,
  type FlueHarness,
  type ToolDefinition,
} from '@flue/runtime';
import * as v from 'valibot';
import { Octokit } from 'octokit';
import type { BuildRun } from '../build-run-store.ts';
import { parseReviewerVerdict, type ReviewerVerdict } from '../engine/verdict.ts';
import {
  GITHUB_PERMISSION_PROFILES,
  type GitAccessProfile,
} from '../engine/profiles.ts';
import { loadConfig } from '../config.ts';
import { configureGitAuth } from '../engine/git-auth.ts';
import { dockerSandbox } from '../sandboxes/docker.ts';
import { architectProfile, ARCHITECT_PROFILE_NAME } from './architect.ts';
import { executorProfile, EXECUTOR_PROFILE_NAME } from './executor.ts';
import { guardrailsProfile, GUARDRAILS_PROFILE_NAME } from './guardrails.ts';
import {
  buildReviewerProfile,
  buildFixProfile,
  BUILD_REVIEWER_PROFILE_NAME,
  BUILD_FIX_PROFILE_NAME,
} from './build-reviewer.ts';
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
  cloneRepoIntoHarness,
  BUILD_WORKSPACE,
} from './build-sandbox.ts';
import { githubReadTools, type RepoRef } from '../tools/github-read.ts';
import { runPhasePrompt } from './record-execution.ts';
import { ProgressNotifier } from '../notify/notifier.ts';
import { GitHubTransport } from '../notify/transports/github.ts';
import { SlackTransport } from '../notify/transports/slack.ts';
import { NULL_REPORTER, readNotifierState } from '../notify/state.ts';
import { runDashboardUrl } from '../notify/model.ts';
import type {
  NotifierState,
  NotifierTransport,
  ProgressReporter,
} from '../notify/types.ts';
import { buildBuildModel } from './build-notify.ts';
import { slackPosterFromConfig, parseSlackConversationKey } from '../slack-client.ts';

// Phase 4 — the BuildDeps DI seam (mirrors pr-review's `deps` pattern), beta.3.
//
// The build CONTROL FLOW lives in src/workflows/build.ts; the actual phase BODIES
// (guardrails / architect / executor / reviewer / fix / recheck) and the side
// effects (gate ask, open-PR) are injected so the durable control flow — pause /
// resume / idempotency / breaker / phase-skip — is tested OFFLINE with NO live
// model and NO GitHub.
//
// beta.3 SHAPE: there is ONE bound coordinator agent (`buildAgent`) whose harness
// owns a self-terminating Docker sandbox (`dockerSandbox()`). The per-phase agents
// are SUBAGENT PROFILES on that coordinator (architect / executor / guardrails /
// build-reviewer / build-fix). Each phase delegates via
// `session.task(prompt, { agent: '<profile>', tools })` — the per-run READ tools are
// injected per call (the security spine), and the shared `/workspace` checkout (cloned
// ONCE per invocation by `ensureBuildCheckout`) persists across phases.

// ── Coordinator agent + input schema ──────────────────────────────────────────

/** The issue-context shape the architect/guardrails prompts wrap as UNTRUSTED. */
const IssueContextSchema = v.object({
  title: v.optional(v.string()),
  body: v.optional(v.string()),
  comment: v.optional(v.string()),
  sender: v.optional(v.string()),
  labels: v.optional(v.array(v.string())),
});

/** The `build` workflow input — validated at admission (`defineWorkflow({ input })`). */
export const BuildInputSchema = v.object({
  /** APP run id — stable caller-owned key (issue/thread), distinct from Flue's runId. */
  runId: v.string(),
  owner: v.string(),
  repo: v.string(),
  issue: v.number(),
  branch: v.optional(v.string()),
  taskId: v.optional(v.string()),
  /** User-provided issue text (UNTRUSTED) for the architect contextSnapshot. */
  issueContext: v.optional(IssueContextSchema),
  /**
   * The CHANNEL conversation key (issue/PR thread) this run was triggered from — the
   * SAME `conversationKey` the channel computes from an event. Recorded on the run
   * record at a gate pause (Phase 6 gate correlation) so a channel approve/reject on
   * that conversation resolves THIS run. Absent on a CLI run.
   */
  conversationKey: v.optional(v.string()),
  /**
   * Per-gate re-entry token set by resume(): the gate this re-invoke is approved
   * past (`post_architect` or `post_reviewer:<cycle>`). Absent on a fresh invoke.
   */
  resumedGate: v.optional(v.string()),
  /** Trigger provenance ("cli" | "webhook" | "cron" | "boot"). */
  triggerType: v.optional(v.string()),
});
export type BuildInput = v.InferOutput<typeof BuildInputSchema>;

// (Backstop so the inferred type keeps the documented `issueContext` field name.)
const _issueContextTypecheck: ArchitectIssueContext | undefined = undefined as
  | BuildInput['issueContext']
  | undefined;
void _issueContextTypecheck;

/**
 * The `build` COORDINATOR agent (beta.3). It owns a fresh self-terminating Docker
 * sandbox (`dockerSandbox()`) + `cwd: /workspace`; every build phase is a SUBAGENT
 * PROFILE delegated via `session.task({ agent })`. The coordinator declares NO tools
 * (the per-run READ tools are injected per task call) — the security spine.
 */
export const buildAgent = defineAgent(() => ({
  sandbox: dockerSandbox(),
  cwd: BUILD_WORKSPACE,
  subagents: [
    guardrailsProfile,
    architectProfile,
    executorProfile,
    buildReviewerProfile,
    buildFixProfile,
  ],
}));

/**
 * The action-context surface the build phase bodies + the testable core need: the
 * supplied `harness` (initialized from `buildAgent`, sandbox attached), the validated
 * `input`, and `log`. Replaces beta.2 `FlueContext<BuildInput>` (no `ctx.id`/`env`/`req`).
 */
export interface BuildRunCtx {
  harness: FlueHarness;
  input: BuildInput;
  log: { info(msg: string, meta?: unknown): void; warn(msg: string, meta?: unknown): void; error(msg: string, meta?: unknown): void };
}

export type { BuildRun } from '../build-run-store.ts';

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
 * Injectable phase bodies + side effects. Production wires real subagent tasks +
 * the deterministic PR open; tests pass fakes that record calls.
 */
export interface BuildDeps {
  /**
   * Run a named build phase (delegates to a subagent profile on the coordinator
   * harness in prod). `name` is the phase name (`guardrails`, `architect`,
   * `executor`, `reviewer:0`, `fix:0`, `recheck:0`, …). Returns the agent's marker text.
   */
  runPhase(
    ctx: BuildRunCtx,
    run: BuildRun,
    name: string,
  ): Promise<PhaseResult>;
  /**
   * Post the approval ask (a deterministic GitHub issue comment). Guarded by the
   * workflow so it posts at most once per gate hit. Returns the created comment id
   * (recorded in the run record for audit); a fake may return void.
   */
  postGateComment(
    ctx: BuildRunCtx,
    run: BuildRun,
    gate: string,
  ): Promise<{ commentId: number } | void>;
  /**
   * Deterministically open the PR over the scoped repo-write token (workflow code,
   * NOT a model tool). Idempotent: reuses an already-open PR for the branch.
   */
  openPullRequest(
    ctx: BuildRunCtx,
    run: BuildRun,
  ): Promise<{ html_url: string; number?: number }>;
  /** Whether a gate fires (positive-enable config). Disabled → no pause. */
  gateEnabled(gate: 'post_architect' | 'post_reviewer'): boolean;
  /** Parse the reviewer verdict marker (the prompt↔code contract). */
  parseVerdict(text: string): { verdict: ReviewerVerdict; viaFallback: boolean };
  /**
   * Phase 8 egress — build, SEED (start), and return the in-place progress
   * reporter for this run: a {@link ProgressReporter} fanning the per-phase
   * checklist to the originating GitHub issue (+ a Slack thread when the run
   * carries a Slack conversationKey). `save` persists the in-place-update
   * handles into the run record so a RESUMED run re-attaches to the SAME
   * surface. Optional + best-effort: omitted (tests / CLI) → the control flow
   * uses {@link NULL_REPORTER} and the durable spine is unchanged.
   */
  makeReporter?(
    ctx: BuildRunCtx,
    run: BuildRun,
    save: (patch: NotifierState) => void,
  ): Promise<ProgressReporter>;
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

// ── Shared sandbox/session plumbing ────────────────────────────────────────────

/** The coordinator session name build phases delegate their subagent tasks from. */
const BUILD_SESSION = 'build';

/** Harnesses whose /workspace already holds the cloned checkout (clone-once-per-invocation). */
const clonedBuildHarnesses = new WeakSet<FlueHarness>();

/**
 * Clone the repo into the coordinator harness's `/workspace` ONCE per invocation
 * (guarded by harness identity — phases share one harness, so the checkout persists
 * across `session.task` calls). The token-bearing origin is LEFT IN PLACE (no scrub)
 * so the executor/fix push authenticates. On a resumed run a FRESH harness re-clones,
 * continuing the pushed branch tip (`cloneRepoIntoHarness` reuses the remote branch).
 */
export async function ensureBuildCheckout(
  harness: FlueHarness,
  run: BuildRun,
  token: string,
): Promise<void> {
  if (clonedBuildHarnesses.has(harness)) return;
  await cloneRepoIntoHarness(
    harness,
    { owner: run.owner, repo: run.repo, branch: run.branch },
    token,
  );
  clonedBuildHarnesses.add(harness);
}

/** Drop the clone-once registry — test isolation only. */
export function resetBuildCheckoutsForTests(): void {
  // WeakSet has no clear(); a fresh module is loaded per test process. Provided as a
  // no-op marker so tests can document intent; the WeakSet is GC'd with its harnesses.
}

/**
 * Run a build phase as a delegated SUBAGENT TASK on the coordinator session, recording
 * its usage (NON-FATAL + TEST-INERT — see record-execution.ts). The per-run READ tools
 * are injected for THIS call only — owner/repo/token never model-selectable.
 */
async function runPhaseTask(
  ctx: BuildRunCtx,
  profileName: string,
  phase: string,
  prompt: string,
  tools: ToolDefinition[],
): Promise<string> {
  const session = await ctx.harness.session(BUILD_SESSION);
  // Adapt `session.task({ agent })` to the `runPhasePrompt` recorder seam (it calls
  // `.prompt(text, opts)`); the profile selection + injected tools ride on the task opts.
  const taskRunner = {
    prompt: (text: string, opts?: unknown) =>
      session.task(text, { ...((opts as object | undefined) ?? {}), agent: profileName }),
  };
  const res = await runPhaseTaskRecorded(taskRunner, prompt, {
    runId: ctx.input.runId,
    workflow: 'build',
    phase,
  }, { tools });
  return res.text;
}

/** Thin wrapper so the `runPhasePrompt` generic resolves against the task runner. */
function runPhaseTaskRecorded(
  runner: { prompt(text: string, opts?: unknown): Promise<{ text: string }> },
  prompt: string,
  rec: { runId: string; workflow: string; phase: string },
  opts: unknown,
) {
  return runPhasePrompt(runner as never, prompt, rec, opts);
}

/** Read the branch HEAD sha over the shared checkout (deterministic, not a model tool). */
async function readHeadSha(harness: FlueHarness): Promise<string> {
  const r = await harness.shell('git rev-parse HEAD', { cwd: BUILD_WORKSPACE });
  return r.stdout.trim();
}

/**
 * Push the working branch to origin (the LIVE side effect). Runs in-sandbox over the
 * token-bearing origin the clone left in place. The branch ref is BOUND (closed over
 * the run), never model-chosen. In tests this seam is mocked → NO real push happens.
 */
async function pushBranch(harness: FlueHarness, branch: string): Promise<void> {
  const r = await harness.shell(`git push origin ${shellArgInline(branch)}`, {
    cwd: BUILD_WORKSPACE,
  });
  if (r.exitCode !== 0) {
    throw new Error(`build: git push failed (${r.exitCode}): ${r.stderr.trim()}`);
  }
}

/** Single-quote for safe `sh -c` interpolation (the branch is workflow-derived). */
function shellArgInline(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Mint a repo-write token downscoped to the target repo via the ported git-auth. */
async function mintRepoWriteToken(run: BuildRun): Promise<string> {
  const cfg = loadConfig();
  if (!cfg.githubApp) {
    throw new Error(
      'build: GitHub App not configured ' +
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

// ───────────────────────────────────────────────────────────────────────────
// GUARDRAILS phase — the pre-flight screen (runs FIRST, before the architect).
// ───────────────────────────────────────────────────────────────────────────

/** The bootstrap label name (build.yaml `unless_label`). Mirrors config.bootstrapLabel. */
export const BOOTSTRAP_LABEL = 'lastlight:bootstrap';

/** The `unless_title_matches` regex (build.yaml): a `guardrails:`/`[guardrails]` prefix. */
const GUARDRAILS_TITLE_RE = /^\s*(guardrails:|\[guardrails\])/i;

/**
 * BLOCKED-bypass parity (design Q4.5 / build.yaml `contains_BLOCKED.unless_*`): a
 * guardrails BLOCKED is bypassed (the build proceeds so the executor can ADD the
 * missing tooling) when the issue is itself a bootstrap task — detected by the
 * `lastlight:bootstrap` label OR a `guardrails:` / `[guardrails]` title prefix.
 */
export function bootstrapBypass(ic?: ArchitectIssueContext): boolean {
  if (!ic) return false;
  const label = (ic.labels ?? []).some((l) => l === BOOTSTRAP_LABEL);
  const title = !!ic.title && GUARDRAILS_TITLE_RE.test(ic.title);
  return label || title;
}

/**
 * Injectable seams for the guardrails phase, so the default `runPhase('guardrails')`
 * is testable OFFLINE (no live model / GitHub / Docker). The screen runs WITH the
 * shared checkout (it inspects the pre-cloned repo).
 */
export interface GuardrailsPhaseDeps {
  mintToken(run: BuildRun): Promise<string>;
  makeOctokit(token: string): Octokit;
  /** Clone the repo into the coordinator harness's /workspace (once per invocation). */
  ensureCheckout(harness: FlueHarness, run: BuildRun, token: string): Promise<void>;
  /**
   * Delegate the guardrails subagent task against the shared checkout + rendered
   * prompt, returning its raw text (ending in the READY / BLOCKED marker).
   */
  runGuardrailsSession(
    ctx: BuildRunCtx,
    ref: RepoRef,
    octokit: Octokit,
    prompt: string,
  ): Promise<string>;
}

/** The real guardrails run: delegate to the guardrails subagent profile. */
async function runGuardrailsSession(
  ctx: BuildRunCtx,
  ref: RepoRef,
  octokit: Octokit,
  prompt: string,
): Promise<string> {
  return runPhaseTask(
    ctx,
    GUARDRAILS_PROFILE_NAME,
    'guardrails',
    prompt,
    githubReadTools(ref, octokit),
  );
}

/** Default guardrails-phase deps: real token mint + Octokit + clone + subagent task. */
export function defaultGuardrailsPhaseDeps(): GuardrailsPhaseDeps {
  return {
    mintToken: mintRepoWriteToken,
    makeOctokit: (token) => new Octokit({ auth: token }),
    ensureCheckout: ensureBuildCheckout,
    runGuardrailsSession,
  };
}

/**
 * Run the GUARDRAILS phase (the FIRST build phase): mint a repo-write token, build an
 * Octokit, ensure the repo is cloned into the coordinator harness's /workspace, render
 * the prompt (issue text wrapped UNTRUSTED), delegate the guardrails subagent task, and
 * return its text (ending in the READY / BLOCKED marker the workflow parses). Records
 * the guardrails-report pointer in scratch (NOT the report blob — spec/10).
 */
export async function runGuardrailsPhase(
  ctx: BuildRunCtx,
  run: BuildRun,
  deps: GuardrailsPhaseDeps = defaultGuardrailsPhaseDeps(),
): Promise<PhaseResult> {
  const ref: RepoRef = { owner: run.owner, repo: run.repo };
  const token = await deps.mintToken(run);
  const octokit = deps.makeOctokit(token);
  await deps.ensureCheckout(ctx.harness, run, token);

  const prompt = renderGuardrailsPrompt({
    owner: run.owner,
    repo: run.repo,
    issue: run.issue,
    branch: run.branch,
    bootstrapLabel: BOOTSTRAP_LABEL,
    issue_context: ctx.input.issueContext,
  });

  const text = await deps.runGuardrailsSession(ctx, ref, octokit, prompt);

  return {
    text,
    scratch: { [GUARDRAILS_REPORT_SCRATCH_KEY]: guardrailsReportPath(run.issue) },
  };
}

// ───────────────────────────────────────────────────────────────────────────
// ARCHITECT phase — the first plan-writing build phase body.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Injectable seams for the architect phase, so the default `runPhase('architect')`
 * is testable OFFLINE (no live model / GitHub / Docker).
 */
export interface ArchitectPhaseDeps {
  mintToken(run: BuildRun): Promise<string>;
  makeOctokit(token: string): Octokit;
  ensureCheckout(harness: FlueHarness, run: BuildRun, token: string): Promise<void>;
  /**
   * Delegate the architect subagent task against the shared checkout + rendered
   * prompt, returning its raw text. The agent writes + commits the plan in-sandbox.
   */
  runArchitectSession(
    ctx: BuildRunCtx,
    ref: RepoRef,
    octokit: Octokit,
    prompt: string,
  ): Promise<string>;
}

/** The real architect run: delegate to the architect subagent profile. */
async function runArchitectSession(
  ctx: BuildRunCtx,
  ref: RepoRef,
  octokit: Octokit,
  prompt: string,
): Promise<string> {
  return runPhaseTask(
    ctx,
    ARCHITECT_PROFILE_NAME,
    'architect',
    prompt,
    githubReadTools(ref, octokit),
  );
}

/** Default architect-phase deps: real token mint + Octokit + clone + subagent task. */
export function defaultArchitectPhaseDeps(): ArchitectPhaseDeps {
  return {
    mintToken: mintRepoWriteToken,
    makeOctokit: (token) => new Octokit({ auth: token }),
    ensureCheckout: ensureBuildCheckout,
    runArchitectSession,
  };
}

/**
 * Run the ARCHITECT phase: mint a repo-write token, build an Octokit, ensure the repo
 * is cloned into the coordinator harness's /workspace, render the prompt (issue text
 * wrapped UNTRUSTED), delegate the architect subagent task, and return its text. The
 * agent writes + commits `.lastlight/issue-<N>/architect-plan.md` in the workspace (the
 * durable handoff). The plan path is the run-record scratch pointer the workflow
 * persists (NOT the plan blob — spec/10 split rule).
 */
export async function runArchitectPhase(
  ctx: BuildRunCtx,
  run: BuildRun,
  deps: ArchitectPhaseDeps = defaultArchitectPhaseDeps(),
): Promise<PhaseResult> {
  const ref: RepoRef = { owner: run.owner, repo: run.repo };
  const token = await deps.mintToken(run);
  const octokit = deps.makeOctokit(token);
  await deps.ensureCheckout(ctx.harness, run, token);

  const prompt = renderArchitectPrompt({
    owner: run.owner,
    repo: run.repo,
    issue: run.issue,
    branch: run.branch,
    issue_context: ctx.input.issueContext,
  });

  const text = await deps.runArchitectSession(ctx, ref, octokit, prompt);

  return { text };
}

// ───────────────────────────────────────────────────────────────────────────
// EXECUTOR phase — reads the committed plan, implements, commits, then PUSHES.
// ───────────────────────────────────────────────────────────────────────────

/** The result of the executor phase: the agent's text + the post-commit sha. */
export interface ExecutorRunResult {
  text: string;
  /** The branch HEAD sha after the executor committed (the reviewer/PR anchor). */
  sha: string;
}

/**
 * Injectable seams for the executor phase, so the default `runPhase('executor')` is
 * testable OFFLINE (no live model / GitHub / Docker / push).
 */
export interface ExecutorPhaseDeps {
  mintToken(run: BuildRun): Promise<string>;
  makeOctokit(token: string): Octokit;
  ensureCheckout(harness: FlueHarness, run: BuildRun, token: string): Promise<void>;
  /**
   * Delegate the executor subagent task against the shared checkout (architect plan on
   * the branch) + rendered prompt; returns its raw text. The agent COMMITS in-sandbox
   * via the git CLI but does NOT push.
   */
  runExecutorSession(
    ctx: BuildRunCtx,
    ref: RepoRef,
    octokit: Octokit,
    prompt: string,
  ): Promise<string>;
  /** Read the branch HEAD sha after the executor committed (the reviewer/PR anchor). */
  readHeadSha(harness: FlueHarness): Promise<string>;
  /**
   * Push the working branch to origin over the token-bearing origin (the controlled,
   * workflow-owned side effect — a SEAM so tests assert it WOULD push the BOUND branch
   * WITHOUT a real push). LIVE form runs `git push origin <branch>` in-sandbox.
   */
  pushBranch(harness: FlueHarness, branch: string): Promise<void>;
}

/** The real executor run: delegate to the executor subagent profile. */
async function runExecutorSession(
  ctx: BuildRunCtx,
  ref: RepoRef,
  octokit: Octokit,
  prompt: string,
): Promise<string> {
  return runPhaseTask(
    ctx,
    EXECUTOR_PROFILE_NAME,
    'executor',
    prompt,
    githubReadTools(ref, octokit),
  );
}

/** Default executor-phase deps: real token mint + Octokit + clone + task + sha + push. */
export function defaultExecutorPhaseDeps(): ExecutorPhaseDeps {
  return {
    mintToken: mintRepoWriteToken,
    makeOctokit: (token) => new Octokit({ auth: token }),
    ensureCheckout: ensureBuildCheckout,
    runExecutorSession,
    readHeadSha,
    pushBranch,
  };
}

/**
 * Run the EXECUTOR phase (runs AFTER the post_architect gate is approved): mint a
 * repo-write token, build an Octokit, ensure the repo is cloned into the coordinator
 * harness's /workspace (the architect's plan is committed on the branch), render the
 * prompt (any user issue text wrapped UNTRUSTED), delegate the executor subagent task
 * (the agent implements + COMMITS in-sandbox via the git CLI), read the committed HEAD
 * sha, then PUSH the branch over the deterministic seam (mocked in tests). Returns the
 * agent text; the workflow persists the executor-summary pointer + the commit sha
 * (the reviewer/PR anchors — NOT the diff blob; spec/10 split).
 */
export async function runExecutorPhase(
  ctx: BuildRunCtx,
  run: BuildRun,
  deps: ExecutorPhaseDeps = defaultExecutorPhaseDeps(),
): Promise<ExecutorRunResult> {
  const ref: RepoRef = { owner: run.owner, repo: run.repo };
  const token = await deps.mintToken(run);
  const octokit = deps.makeOctokit(token);
  await deps.ensureCheckout(ctx.harness, run, token);

  const prompt = renderExecutorPrompt({
    owner: run.owner,
    repo: run.repo,
    issue: run.issue,
    branch: run.branch,
    issue_context: ctx.input.issueContext,
  });

  const text = await deps.runExecutorSession(ctx, ref, octokit, prompt);
  const sha = await deps.readHeadSha(ctx.harness);
  // The CONTROLLED repo-write side effect: push the branch the workflow bound (mocked
  // in tests → asserts it WOULD push, no real push).
  await deps.pushBranch(ctx.harness, run.branch);
  return { text, sha };
}

// ───────────────────────────────────────────────────────────────────────────
// REVIEWER LOOP — reviewer:N → [post_reviewer gate] → fix:N → recheck:N.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Injectable seams for the reviewer/recheck phases, so the default
 * `runPhase('reviewer:N'|'recheck:N')` is testable OFFLINE. A re-review re-prompts the
 * reviewer profile with re-reviewer.md.
 */
export interface ReviewerPhaseDeps {
  mintToken(run: BuildRun): Promise<string>;
  makeOctokit(token: string): Octokit;
  ensureCheckout(harness: FlueHarness, run: BuildRun, token: string): Promise<void>;
  /**
   * Delegate the build reviewer subagent task against the shared checkout (carrying
   * the executor's committed changes) + the rendered reviewer / re-reviewer prompt;
   * returns its raw text (ending in the VERDICT marker).
   */
  runReviewerSession(
    ctx: BuildRunCtx,
    ref: RepoRef,
    octokit: Octokit,
    prompt: string,
    phase: string,
  ): Promise<string>;
}

/** The real reviewer run: delegate to the build-reviewer subagent profile. */
async function runReviewerSession(
  ctx: BuildRunCtx,
  ref: RepoRef,
  octokit: Octokit,
  prompt: string,
  phase: string,
): Promise<string> {
  return runPhaseTask(
    ctx,
    BUILD_REVIEWER_PROFILE_NAME,
    phase,
    prompt,
    githubReadTools(ref, octokit),
  );
}

/** Default reviewer-phase deps: real token mint + Octokit + clone + subagent task. */
export function defaultReviewerPhaseDeps(): ReviewerPhaseDeps {
  return {
    mintToken: mintRepoWriteToken,
    makeOctokit: (token) => new Octokit({ auth: token }),
    ensureCheckout: ensureBuildCheckout,
    runReviewerSession,
  };
}

/**
 * Run a REVIEWER phase (`reviewer:N` is the first review; `recheck:N` re-reviews after
 * fix cycle N): mint a repo-write token, build an Octokit, ensure the repo is cloned
 * into the coordinator harness's /workspace (carrying the executor's committed changes
 * + any prior verdict/fix commits), render the prompt (reviewer.md for the first
 * review, re-reviewer.md for a recheck), delegate the reviewer subagent task, and
 * return its text (ending in the VERDICT marker the loop parses). NO GitHub post — this
 * is an internal build review.
 */
export async function runReviewerPhase(
  ctx: BuildRunCtx,
  run: BuildRun,
  cycle: number,
  isRecheck: boolean,
  deps: ReviewerPhaseDeps = defaultReviewerPhaseDeps(),
): Promise<PhaseResult> {
  const ref: RepoRef = { owner: run.owner, repo: run.repo };
  const token = await deps.mintToken(run);
  const octokit = deps.makeOctokit(token);
  await deps.ensureCheckout(ctx.harness, run, token);

  const promptCtx = {
    owner: run.owner,
    repo: run.repo,
    issue: run.issue,
    branch: run.branch,
  };
  const prompt = isRecheck
    ? renderReReviewerPrompt(promptCtx, cycle)
    : renderReviewerPrompt(promptCtx);
  const phase = `${isRecheck ? 'recheck' : 'reviewer'}:${cycle}`;

  const text = await deps.runReviewerSession(ctx, ref, octokit, prompt, phase);

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
 * Injectable seams for the fix phase, so the default `runPhase('fix:N')` is testable
 * OFFLINE. Mirrors the executor's seams (mint + octokit + clone + task + sha + push).
 */
export interface FixPhaseDeps {
  mintToken(run: BuildRun): Promise<string>;
  makeOctokit(token: string): Octokit;
  ensureCheckout(harness: FlueHarness, run: BuildRun, token: string): Promise<void>;
  /**
   * Delegate the fix subagent task against the shared checkout (carrying the
   * reviewer-verdict.md the agent reads) + the rendered fix prompt; returns its raw
   * text. The agent COMMITS its fixes in-sandbox via the git CLI but does NOT push.
   */
  runFixSession(
    ctx: BuildRunCtx,
    ref: RepoRef,
    octokit: Octokit,
    prompt: string,
    phase: string,
  ): Promise<string>;
  /** Read the branch HEAD sha after the fix committed (the recheck/PR anchor). */
  readHeadSha(harness: FlueHarness): Promise<string>;
  /** Push the working branch to origin (shares the executor's push contract). */
  pushBranch(harness: FlueHarness, branch: string): Promise<void>;
}

/** The real fix run: delegate to the build-fix subagent profile. */
async function runFixSession(
  ctx: BuildRunCtx,
  ref: RepoRef,
  octokit: Octokit,
  prompt: string,
  phase: string,
): Promise<string> {
  return runPhaseTask(
    ctx,
    BUILD_FIX_PROFILE_NAME,
    phase,
    prompt,
    githubReadTools(ref, octokit),
  );
}

/** Default fix-phase deps: real token mint + Octokit + clone + task + sha + push. */
export function defaultFixPhaseDeps(): FixPhaseDeps {
  return {
    mintToken: mintRepoWriteToken,
    makeOctokit: (token) => new Octokit({ auth: token }),
    ensureCheckout: ensureBuildCheckout,
    runFixSession,
    readHeadSha,
    pushBranch,
  };
}

/**
 * Run a FIX phase (`fix:N`): mint a repo-write token, build an Octokit, ensure the repo
 * is cloned into the coordinator harness's /workspace (carrying the reviewer-verdict.md
 * the agent reads), render the fix prompt (it names the reviewer-verdict path so the
 * agent fixes ONLY the reported issues), delegate the fix subagent task (the agent
 * addresses the notes + COMMITS in-sandbox via the git CLI), read the committed HEAD
 * sha, then PUSH the branch over the deterministic seam (mocked in tests). Returns the
 * agent text + the new sha (the recheck/PR anchor).
 */
export async function runFixPhase(
  ctx: BuildRunCtx,
  run: BuildRun,
  cycle: number,
  deps: FixPhaseDeps = defaultFixPhaseDeps(),
): Promise<FixRunResult> {
  const ref: RepoRef = { owner: run.owner, repo: run.repo };
  const token = await deps.mintToken(run);
  const octokit = deps.makeOctokit(token);
  await deps.ensureCheckout(ctx.harness, run, token);

  const prompt = renderFixPrompt(
    { owner: run.owner, repo: run.repo, issue: run.issue, branch: run.branch },
    cycle,
  );
  const phase = `fix:${cycle}`;

  const text = await deps.runFixSession(ctx, ref, octokit, prompt, phase);
  const sha = await deps.readHeadSha(ctx.harness);
  // The CONTROLLED repo-write side effect: push the bound branch (mocked in tests).
  await deps.pushBranch(ctx.harness, run.branch);
  return { text, sha };
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
 * model-chosen (mirrors github-post.ts). The workflow guards the call (it posts once
 * per gate hit via the run record's `pendingGate`); the returned comment id is recorded.
 */
export async function runPostGateComment(
  _ctx: BuildRunCtx,
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
 * Deterministically open the PR (the finalize step) over the scoped repo-write token.
 * IDEMPOTENT: reuses an already-open PR for the working branch. owner/repo/head/base
 * come from the bound run + the repo's default branch, NEVER the model.
 */
export async function runOpenPullRequest(
  _ctx: BuildRunCtx,
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

// ───────────────────────────────────────────────────────────────────────────
// PROGRESS REPORTER — the Phase 8 in-place egress notifier (best-effort).
// ───────────────────────────────────────────────────────────────────────────

/**
 * Build + seed the live progress reporter for a build run. Posts (and edits in
 * place) ONE GitHub status comment on the originating issue, and mirrors to ONE
 * Slack message when the run carries a Slack `conversationKey` + a bot token is
 * configured. The in-place-update handles are read from / persisted to the run
 * record's scratch (via `save`) so a RESUMED run re-attaches to the SAME
 * surfaces instead of creating duplicates. Egress is best-effort: a failed
 * token mint or transport degrades to {@link NULL_REPORTER}, never the spine.
 */
export async function makeBuildReporter(
  ctx: BuildRunCtx,
  run: BuildRun,
  save: (patch: NotifierState) => void,
): Promise<ProgressReporter> {
  const cfg = loadConfig();
  const transports: NotifierTransport[] = [];
  const state = readNotifierState(run.scratch);

  // GitHub surface — a build always has an originating issue. A token-mint
  // failure must not break the build, so it just drops the GitHub transport.
  try {
    const token = await mintRepoWriteToken(run);
    const octokit = new Octokit({ auth: token });
    transports.push(
      new GitHubTransport({
        octokit,
        owner: run.owner,
        repo: run.repo,
        issueNumber: run.issue,
        commentId: state.githubCommentId,
        save: (commentId) => save({ githubCommentId: commentId }),
      }),
    );
  } catch (err: unknown) {
    ctx.log.warn('build: notifier GitHub transport unavailable (continuing)', {
      runId: run.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Slack mirror — only when the run carries a Slack conversation AND a bot
  // token is set (slackPosterFromConfig → undefined → no Slack egress). The run
  // record's conversationKey isn't written until the first gate pause, so fall
  // back to the input's (a Slack-triggered build mirrors from the first pass).
  const slackKey = run.conversationKey ?? ctx.input.conversationKey;
  const loc = slackKey ? parseSlackConversationKey(slackKey) : undefined;
  const poster = loc ? slackPosterFromConfig() : undefined;
  if (loc && poster) {
    transports.push(
      new SlackTransport({
        poster,
        channel: loc.channelId,
        thread: loc.threadTs,
        ts: state.slackTs,
        save: (ts) => save({ slackTs: ts, slackChannel: loc.channelId, slackThread: loc.threadTs }),
      }),
    );
  }

  if (transports.length === 0) return NULL_REPORTER;
  const reporter = new ProgressNotifier(transports);
  const runUrl = runDashboardUrl(cfg.publicUrl, run.id, 'build');
  await reporter.start(buildBuildModel(run, { runUrl }));
  return reporter;
}

/**
 * Default production deps. ALL build-workflow phase bodies + side effects are WIRED:
 * guardrails / architect / executor / reviewer-loop (reviewer / fix / recheck), the
 * deterministic gate ask, and the deterministic open-PR. Each is driven OFFLINE in
 * tests via injected sub-deps; production delegates to the coordinator's subagent
 * profiles. Gate enablement is positive-enable from config.
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
    gateEnabled: (gate) => loadConfig().approval?.[gate] === true,
    parseVerdict: (text) => parseReviewerVerdict(text),
    makeReporter: makeBuildReporter,
  };
}
