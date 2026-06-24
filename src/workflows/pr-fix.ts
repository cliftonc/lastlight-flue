/**
 * `pr-fix` workflow — a Phase 5 repo-write workflow (no architect / no review loop).
 *
 * Discoverable as `src/workflows/pr-fix.ts` (filename = workflow name), invoked via
 *   `flue run pr-fix --payload '{"owner":..,"repo":..,"prNumber":..,"fixRequest":..}'`.
 *
 * pr-fix is essentially a STANDALONE EXECUTOR-ON-A-PR (design/phase-5 → "Single-phase
 * workflows": `pr-fix` is the single-pass shape with a repo-write→push deterministic
 * side effect; reference pr-fix.yaml — "Lightweight PR fix — no architect/reviewer,
 * just fix and push", profile repo-write, skill: building). It is for fixing an
 * EXISTING PR (a review comment / a "fix that" instruction / failing CI), DISTINCT
 * from `build` ("fix that bug" on a fresh issue redirects to `build`).
 *
 * Control flow (mirrors the build EXECUTOR phase, but on the PR's own head branch):
 *   1. Mint a `repo-write` scoped GitHub App token (downscoped to this repo — PEM wall).
 *   2. Resolve the PR head ref DETERMINISTICALLY (`pulls.get().head.ref` — workflow
 *      code, NOT a model tool) so the fix lands on the PR's branch, not a new one.
 *   3. `withPrFixSandbox`: pre-clone + check out the PR HEAD branch into /workspace
 *      (CALLER owns the container lifetime — torn down in a `finally`, even on throw).
 *   4. Build the fix agent (persona, `building` skill, READ-ONLY github tools bound to
 *      ref+token, sandbox, cwd /workspace, model=resolveModel('fix')). Render pr-fix.md
 *      with the PR context + the fix request — all user/PR/CI text UNTRUSTED-wrapped.
 *   5. The agent implements the fix + COMMITS in-sandbox via the git CLI (NOT a write
 *      tool). The workflow reads the HEAD sha + PUSHES the PR head branch via the SAME
 *      mocked `pushBranch` seam as the build executor (no real push in tests).
 *   6. OPTIONALLY post a deterministic ack comment on the PR (reference on_success).
 *
 * Single-shot — no run-record gate / loop (the reference pr-fix has no gate). A crash
 * re-invokes the whole pass; the agent re-reads current state (idempotent enough). The
 * push targets the BOUND head branch; the ack/push refs are never model-selectable.
 *
 * SANDBOX REQUIRED (not additive): the fix needs the workspace, so a clone failure
 * THROWS. ⚠ EGRESS DEFERRED — do NOT run untrusted input through it.
 *
 * Beta.3 form: `export default defineWorkflow({ agent, input, run })`. The bound
 * `fixAgent` declares `sandbox: dockerSandbox()` (the HARNESS owns a fresh
 * self-terminating container); `run()` clones the PR HEAD branch into `/workspace`
 * via `cloneRepoIntoHarness` (NO remote scrub — the token-bearing origin is needed
 * for the push), then reads HEAD + pushes via `harness.shell`. `ctx.payload`→`input`,
 * `ctx.init`→`harness`.
 *
 * TESTABILITY: the inline `run` defers to `runPrFix(ctx, deps)` with an injectable
 * `deps` seam (token minter, octokit factory, head-ref resolver, fix-session runner,
 * head-sha read, the MOCKED push, the ack poster). Tests pass fakes so the whole flow
 * runs with NO live model / git / GitHub / Docker.
 */
import { defineWorkflow, type FlueHarness, type FlueLogger, type JsonValue } from "@flue/runtime";
import { Octokit } from "octokit";
import * as v from "valibot";
import {
  GITHUB_PERMISSION_PROFILES,
  type GitAccessProfile,
} from "../engine/profiles.ts";
import { configureGitAuth } from "../engine/git-auth.ts";
import { loadConfig } from "../config.ts";
import { fixAgent } from "../agent-lib/build-reviewer.ts";
import { renderPrFixPrompt } from "../agent-lib/pr-fix-prompt.ts";
import { cloneRepoIntoHarness } from "../agent-lib/build-sandbox.ts";
import { githubReadTools, type RepoRef } from "../tools/github-read.ts";
import {
  renderAckComment,
  postAckCommentDeterministically,
  type PrFixRef,
  type PostedAck,
} from "../pr-fix-post.ts";

/** The workflow input payload (identifies the PR + the fix request). */
export const PrFixInputSchema = v.object({
  owner: v.string(),
  repo: v.string(),
  prNumber: v.pipe(v.number(), v.integer(), v.minValue(1)),
  /** The review comment / "fix that" instruction / failed-checks context (UNTRUSTED). */
  fixRequest: v.optional(v.string()),
  /** Optional CI / failing-checks context (UNTRUSTED) when the trigger is failing CI. */
  ciContext: v.optional(v.string()),
  /** Trigger provenance: "review_comment" | "comment" | "ci" | "cli" (drives messaging). */
  triggerType: v.optional(v.string()),
  /** Who requested the fix (trigger metadata — stays outside the untrusted wrappers). */
  requestedBy: v.optional(v.string()),
  /** App run id for stats correlation; falls back to `harness.name` when absent. */
  runId: v.optional(v.string()),
});
export type PrFixInput = v.InferOutput<typeof PrFixInputSchema>;

/** The action context surface the testable core needs (harness + input + log). */
export interface PrFixRunCtx {
  harness: FlueHarness;
  input: PrFixInput;
  log: FlueLogger;
}

/** The workflow result. */
export interface PrFixResult {
  /** The PR head branch the fix landed on (resolved deterministically). */
  branch: string;
  /** The HEAD sha after the fix committed (the push anchor). */
  sha: string;
  /** Whether the branch was pushed (always true on the happy path; the seam is mocked in tests). */
  pushed: boolean;
  /** Whether an ack comment was posted. */
  acked: boolean;
  /** The ack comment URL, when one was posted. */
  ackUrl?: string;
}

/** The `repo-write` profile this workflow always runs under (spec/09 / design — PEM wall). */
export const PR_FIX_PROFILE: GitAccessProfile = "repo-write";

/** The cwd the repo is pre-cloned into (matches docker.ts WORKSPACE). */
const PR_FIX_WORKSPACE = "/workspace" as const;

/**
 * Injectable dependencies — the seams that make `run()` testable without a live
 * model / git / GitHub / Docker. The default factory wires the real implementations.
 */
export interface PrFixDeps {
  /** Mint a `repo-write` scoped installation token for this repo. */
  mintToken(input: PrFixInput): Promise<string>;
  /** Build an Octokit authenticated with the scoped token. */
  makeOctokit(token: string): Octokit;
  /**
   * Resolve the PR's head ref (branch) + title DETERMINISTICALLY (workflow code, not
   * a model tool) — reads `pulls.get()` over the bound octokit.
   */
  getPrHead(octokit: Octokit, ref: PrFixRef): Promise<{ headRef: string; title: string }>;
  /**
   * Run the fix agent session against the PR-head checkout (in the harness sandbox) +
   * the rendered prompt; returns its raw text. The agent COMMITS its fix in-sandbox
   * via the git CLI but does NOT push.
   */
  runFixSession(
    ctx: PrFixRunCtx,
    ref: RepoRef,
    octokit: Octokit,
    prompt: string,
  ): Promise<string>;
  /** Read the branch HEAD sha after the fix committed (the push anchor). */
  readHeadSha(harness: FlueHarness): Promise<string>;
  /**
   * Push the PR head branch to origin over the token-bearing origin URL (the
   * controlled, workflow-owned side effect — a SEAM so tests assert it WOULD push the
   * BOUND ref WITHOUT a real push). LIVE form runs `git push origin <branch>` in-sandbox.
   */
  pushBranch(harness: FlueHarness, branch: string): Promise<void>;
  /** Deterministically post the ack comment (bound ref, not a model tool). */
  postAck(octokit: Octokit, ref: PrFixRef, branch: string, sha: string): Promise<PostedAck>;
}

/** Mint a repo-write token downscoped to the target repo via the ported git-auth. */
async function mintRepoWriteToken(input: PrFixInput): Promise<string> {
  const cfg = loadConfig();
  if (!cfg.githubApp) {
    throw new Error(
      "pr-fix: GitHub App not configured (GITHUB_APP_ID / _PRIVATE_KEY_PATH / _INSTALLATION_ID). Cannot mint a repo-write token.",
    );
  }
  const { token } = await configureGitAuth({
    appId: cfg.githubApp.appId,
    privateKeyPath: cfg.githubApp.privateKeyPath,
    installationId: cfg.githubApp.installationId,
    botName: cfg.botLogin.replace(/\[bot\]$/, ""),
    repositories: [input.repo],
    permissions: GITHUB_PERMISSION_PROFILES[PR_FIX_PROFILE],
  });
  return token;
}

/** Resolve the PR head ref + title deterministically (workflow code, not a model tool). */
async function getPrHead(
  octokit: Octokit,
  ref: PrFixRef,
): Promise<{ headRef: string; title: string }> {
  const { data } = await octokit.rest.pulls.get({
    owner: ref.owner,
    repo: ref.repo,
    pull_number: ref.pull_number,
  });
  return { headRef: data.head.ref, title: data.title ?? "" };
}

/** The real fix run: open the session on the bound harness, prompt with the request. */
async function runFixSession(
  ctx: PrFixRunCtx,
  ref: RepoRef,
  octokit: Octokit,
  prompt: string,
): Promise<string> {
  const session = await ctx.harness.session("pr-fix");
  // Per-run READ tools injected for THIS call only — owner/repo/token never model-selectable.
  const res = await session.prompt(prompt, { tools: githubReadTools(ref, octokit) });
  return res.text;
}

/** Read the branch HEAD sha over the same checkout (deterministic, not a model tool). */
async function readHeadSha(harness: FlueHarness): Promise<string> {
  const r = await harness.shell("git rev-parse HEAD", { cwd: PR_FIX_WORKSPACE });
  return r.stdout.trim();
}

/**
 * Push the PR head branch to origin (the LIVE side effect). Runs in-sandbox over the
 * token-bearing origin URL the clone left in place. The branch ref is BOUND (the
 * workflow-resolved head ref), never model-chosen. In tests this seam is mocked → NO
 * real push happens.
 */
async function pushBranch(harness: FlueHarness, branch: string): Promise<void> {
  const r = await harness.shell(`git push origin ${shellArgInline(branch)}`, {
    cwd: PR_FIX_WORKSPACE,
  });
  if (r.exitCode !== 0) {
    throw new Error(`pr-fix: git push failed (${r.exitCode}): ${r.stderr.trim()}`);
  }
}

/** Single-quote for safe `sh -c` interpolation (the branch is workflow-resolved). */
function shellArgInline(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Default production dependencies. */
export function defaultDeps(): PrFixDeps {
  return {
    mintToken: mintRepoWriteToken,
    makeOctokit: (token) => new Octokit({ auth: token }),
    getPrHead,
    runFixSession,
    readHeadSha,
    pushBranch,
    postAck: (octokit, ref, branch, sha) =>
      postAckCommentDeterministically(octokit, ref, renderAckComment({ branch, sha })),
  };
}

/**
 * The testable core. Drives the full flow over injected dependencies; production uses
 * `defaultDeps()`, tests pass fakes (no live model / git / GitHub / Docker).
 */
export async function runPrFix(
  ctx: PrFixRunCtx,
  deps: PrFixDeps = defaultDeps(),
): Promise<PrFixResult> {
  const { owner, repo, prNumber } = ctx.input;
  const ref: PrFixRef = { owner, repo, pull_number: prNumber };
  const repoRef: RepoRef = { owner, repo };

  // 1. Mint the repo-write scoped token (PEM wall) + an Octokit bound to it.
  const token = await deps.mintToken(ctx.input);
  const octokit = deps.makeOctokit(token);

  // 2. Resolve the PR head ref DETERMINISTICALLY (workflow code, not a model tool) so
  //    the fix lands on — and pushes back to — the PR's OWN branch (not a new one).
  const { headRef, title } = await deps.getPrHead(octokit, ref);

  const prompt = renderPrFixPrompt({
    owner,
    repo,
    branch: headRef,
    prNumber,
    prTitle: title,
    fixRequest: ctx.input.fixRequest,
    ciContext: ctx.input.ciContext,
    requestedBy: ctx.input.requestedBy,
  });

  // 3. Clone + check out the PR HEAD branch into the harness sandbox (the agent's
  //    `dockerSandbox()` stood the container up at init; it self-terminates). The
  //    token-bearing origin is LEFT IN PLACE (no scrub) so the push authenticates.
  //    Run the fix agent, read the committed HEAD sha, then PUSH the bound head branch
  //    over the deterministic seam (mocked in tests → asserts it WOULD push).
  await cloneRepoIntoHarness(ctx.harness, { owner, repo, branch: headRef }, token);
  const text = await deps.runFixSession(ctx, repoRef, octokit, prompt);
  void text;
  const sha = await deps.readHeadSha(ctx.harness);
  await deps.pushBranch(ctx.harness, headRef);

  // 4. OPTIONALLY post a deterministic ack comment on the PR (reference on_success).
  const posted = await deps.postAck(octokit, ref, headRef, sha);

  return {
    branch: headRef,
    sha,
    pushed: true,
    acked: true,
    ackUrl: posted.html_url,
  };
}

/** Flue workflow — discovered as the `pr-fix` workflow. */
export default defineWorkflow({
  agent: fixAgent,
  input: PrFixInputSchema,
  async run({ harness, input, log }) {
    return (await runPrFix({ harness, input, log })) as unknown as JsonValue;
  },
});
