/**
 * `pr-comment` workflow — a Phase 5 single-phase workflow.
 *
 * Discoverable as `src/workflows/pr-comment.ts` (filename = workflow name), invoked via
 *   `flue run pr-comment --payload '{"owner":..,"repo":..,"prNumber":..,"commentBody":..,"commentId":..,"sender":..}'`.
 *
 * The PR-side counterpart to `issue-comment` (design/phase-5-workflows-chat.md →
 * "Single-phase workflows" + ~/work/lastlight/workflows/pr-comment.yaml — kind: comment,
 * skill: pr-comment, model: {{models.comment}}, profile issues-write). A maintainer
 * @mentioned the bot on an OPEN PR with a QUESTION about the change (the classifier
 * returns a non-build intent and prNumber is set). pr-comment is distinguished from
 * issue-comment because PR questions need the DIFF and a higher file-read cap — but the
 * mechanism is identical (a PR accepts issue comments at the same endpoint), so the
 * deterministic poster + bot-loop + dedup guards are REUSED from issue-comment-post.ts
 * by import (no duplication, no shared-file edits).
 *
 * Control flow:
 *   1. BOT-LOOP floor: if the triggering comment was authored by the bot itself, do
 *      nothing — never reply to our own comment (infinite-loop guard). The reference
 *      drops bot senders at the webhook connector (Phase 6 here); this is the
 *      defensive workflow-local second floor (shared `isBotSender`).
 *   2. Mint an `issues-write` scoped GitHub App token (downscoped to this repo).
 *   3. Fetch the PR context (title/body/base/head/labels/comments) AND the unified
 *      DIFF DETERMINISTICALLY over the bound octokit — this is workflow code, not a
 *      model tool. (The agent ALSO has the diff read tool, but seeding the prompt keeps
 *      a real answer cheap.)
 *   4. Build the pr-comment agent (read tools bound to ref+token — incl. the PR diff
 *      tool, `pr-comment` skill, persona, comment model/thinkingLevel, NO sandbox).
 *      init → session.prompt with the PR + diff + thread + the TRIGGERING question, ALL
 *      user text wrapped (wrapUntrusted).
 *   5. The agent composes a free-form, code-cited markdown REPLY (no marker). The
 *      WORKFLOW posts it DETERMINISTICALLY over the scoped token
 *      (postIssueReplyDeterministically — shared with issue-comment), with a DEDUP
 *      guard keyed by the triggering comment id (re-`invoke` / duplicate webhook never
 *      double-replies — design Q5.4).
 *
 * WHY agent-composes-text + deterministic post (vs the skill posting via MCP tools):
 * we keep the JUDGMENT agent-side but pull the createComment SIDE EFFECT off the model
 * surface (spec/09: owner/repo/pr/token never model-selectable). Mirrors the pr-review
 * verdict→post and issue-triage classification→apply splits.
 *
 * NO SANDBOX: pr-comment is tool-only (reads the PR + diff + thread via bound read
 * tools — the skill caps it at ≤8 file reads, no checkout). Cheaper + lower latency.
 *
 * Beta.3 form: `export default defineWorkflow({ agent, input, run })`. The bound
 * `prCommentAgent` is the root harness/policy; the per-run READ tools (closed over
 * ref + scoped-token Octokit) are injected per-call via `session.prompt(_, {
 * tools })`, so the security spine is unchanged. `ctx.payload`→`input`,
 * `ctx.init(agent)`→the supplied `harness`, `ctx.id`→`harness.name`.
 *
 * TESTABILITY: `run` defers to `runPrComment(ctx, deps)` with an injectable `deps`
 * seam (token minter, octokit factory, context fetcher, agent runner, poster). The
 * default deps wire the real implementations; tests pass fakes so the whole flow runs
 * with NO live model and NO live GitHub.
 */
import { defineWorkflow, type FlueHarness, type FlueLogger, type JsonValue } from "@flue/runtime";
import * as v from "valibot";
import { Octokit } from "octokit";
import {
  GITHUB_PERMISSION_PROFILES,
  type GitAccessProfile,
} from "../engine/profiles.ts";
import { configureGitAuth } from "../engine/git-auth.ts";
import { loadConfig } from "../config.ts";
import { prCommentAgent } from "../agent-lib/pr-comment.ts";
import { githubReadTools } from "../tools/github-read.ts";
import {
  renderPrCommentPrompt,
  type PrCommentPromptContext,
} from "../agent-lib/pr-comment-prompt.ts";
import {
  postIssueReplyDeterministically,
  isBotSender,
  type IssueCommentRef,
  type PostedReply,
} from "../issue-comment-post.ts";

/** The workflow input payload (identifies the PR + the triggering comment). */
export const PrCommentInputSchema = v.object({
  owner: v.string(),
  repo: v.string(),
  /** The PR number the comment is on. */
  prNumber: v.pipe(v.number(), v.integer(), v.minValue(1)),
  /** The body of the triggering comment — the question the agent answers. */
  commentBody: v.string(),
  /** The triggering comment's id — the dedup key (re-invoke / duplicate-delivery safe). */
  commentId: v.union([v.number(), v.string()]),
  /** Who wrote the triggering comment — the bot-loop guard reads this. */
  sender: v.optional(v.string()),
  /** Optional trigger provenance: "webhook" | "cron" | "cli". */
  triggerType: v.optional(v.string()),
  /** App run id for stats correlation; falls back to `harness.name` when absent. */
  runId: v.optional(v.string()),
});
export type PrCommentInput = v.InferOutput<typeof PrCommentInputSchema>;

/**
 * The action context surface the testable core needs: the supplied `harness`
 * (already initialized from the bound `prCommentAgent`), the validated `input`, and
 * the run-stream `log`. Mirrors Flue's `ActionContext` so the inline `run` passes
 * straight through.
 */
export interface PrCommentRunCtx {
  harness: FlueHarness;
  input: PrCommentInput;
  log: FlueLogger;
}

/** The workflow result. */
export interface PrCommentResult {
  /** Whether a reply was actually posted. */
  posted: boolean;
  /** The posted comment's URL, when one was posted. */
  commentUrl?: string;
  /** True when we skipped because the trigger was the bot's own comment. */
  skippedBotLoop: boolean;
  /** True when we skipped because a reply to this trigger already existed (dedup). */
  deduped: boolean;
}

/** The `issues-write` profile this workflow always runs under (spec/09 / design). */
export const PR_COMMENT_PROFILE: GitAccessProfile = "issues-write";

/** PR context fetched deterministically for the prompt (workflow code, not a tool). */
export interface PrCommentContext {
  title: string;
  body: string;
  author?: string;
  base?: string;
  head?: string;
  labels: string[];
  diff: string;
  comments: { author?: string; body: string }[];
}

/**
 * Injectable dependencies — the seams that make `run()` testable without a live model
 * or GitHub. The default factory wires the real implementations.
 */
export interface PrCommentDeps {
  /** Mint an `issues-write` scoped installation token for this repo. */
  mintToken(input: PrCommentInput): Promise<string>;
  /** Build an Octokit authenticated with the scoped token. */
  makeOctokit(token: string): Octokit;
  /** Fetch the PR context (title/body/base/head/labels/diff/comments) over the octokit. */
  fetchPr(octokit: Octokit, ref: IssueCommentRef): Promise<PrCommentContext>;
  /**
   * Run the pr-comment agent and return its raw text reply. Wraps agent-init +
   * session.prompt so tests can return a canned reply.
   */
  runComment(
    ctx: PrCommentRunCtx,
    ref: IssueCommentRef,
    octokit: Octokit,
    pr: PrCommentContext,
  ): Promise<string>;
  /** Deterministically post the reply (with bot-loop + dedup guards). */
  post(
    octokit: Octokit,
    ref: IssueCommentRef,
    body: string,
    opts: { triggerCommentId: number | string; sender?: string; botLogin: string },
  ): Promise<PostedReply>;
  /** The bot's own login (for the bot-loop / dedup author checks). */
  botLogin: string;
}

/** Mint an issues-write token downscoped to the target repo via the ported git-auth. */
async function mintIssuesWriteToken(input: PrCommentInput): Promise<string> {
  const cfg = loadConfig();
  if (!cfg.githubApp) {
    throw new Error(
      "pr-comment: GitHub App not configured (GITHUB_APP_ID / _PRIVATE_KEY_PATH / _INSTALLATION_ID). Cannot mint an issues-write token.",
    );
  }
  const { token } = await configureGitAuth({
    appId: cfg.githubApp.appId,
    privateKeyPath: cfg.githubApp.privateKeyPath,
    installationId: cfg.githubApp.installationId,
    botName: cfg.botLogin.replace(/\[bot\]$/, ""),
    repositories: [input.repo],
    permissions: GITHUB_PERMISSION_PROFILES[PR_COMMENT_PROFILE],
  });
  return token;
}

/** Fetch the PR + diff + comments deterministically (workflow code, not a model tool). */
async function fetchPrContext(
  octokit: Octokit,
  ref: IssueCommentRef,
): Promise<PrCommentContext> {
  const { data: pr } = await octokit.rest.pulls.get({
    owner: ref.owner,
    repo: ref.repo,
    pull_number: ref.issue_number,
  });
  // The diff: pulls.get with the `diff` media type returns the unified diff as a string.
  const { data: diffData } = await octokit.rest.pulls.get({
    owner: ref.owner,
    repo: ref.repo,
    pull_number: ref.issue_number,
    mediaType: { format: "diff" },
  });
  // issues.listComments serves PRs too (a PR is an issue for this endpoint).
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner: ref.owner,
    repo: ref.repo,
    issue_number: ref.issue_number,
    per_page: 100,
  });
  return {
    title: pr.title ?? "",
    body: pr.body ?? "",
    author: pr.user?.login,
    base: pr.base?.ref,
    head: pr.head?.ref,
    labels: (pr.labels ?? []).map((l) => (typeof l === "string" ? l : (l.name ?? ""))),
    diff: diffData as unknown as string,
    comments: comments.map((c) => ({ author: c.user?.login, body: c.body ?? "" })),
  };
}

/** The real run: open a session on the bound harness, prompt with the PR + diff + trigger. */
async function runCommentSession(
  ctx: PrCommentRunCtx,
  ref: IssueCommentRef,
  octokit: Octokit,
  pr: PrCommentContext,
): Promise<string> {
  const session = await ctx.harness.session("pr-comment");
  const promptCtx: PrCommentPromptContext = {
    owner: ref.owner,
    repo: ref.repo,
    prNumber: ref.issue_number,
    title: pr.title,
    body: pr.body,
    author: pr.author,
    base: pr.base,
    head: pr.head,
    labels: pr.labels,
    diff: pr.diff,
    comments: pr.comments,
    sender: ctx.input.sender,
    commentBody: ctx.input.commentBody,
    triggerType: ctx.input.triggerType,
  };
  // The per-run READ tools (closed over ref + scoped-token Octokit) are injected
  // for THIS call only — owner/repo/token are never model-selectable.
  const res = await session.prompt(renderPrCommentPrompt(promptCtx), {
    tools: githubReadTools(ref, octokit),
  });
  return res.text;
}

/** Default production dependencies. */
export function defaultDeps(): PrCommentDeps {
  return {
    mintToken: mintIssuesWriteToken,
    makeOctokit: (token) => new Octokit({ auth: token }),
    fetchPr: fetchPrContext,
    runComment: runCommentSession,
    post: postIssueReplyDeterministically,
    botLogin: loadConfig().botLogin,
  };
}

/**
 * The testable core. Drives the full flow over injected dependencies; production uses
 * `defaultDeps()`, tests pass fakes (no live model, no live GitHub).
 */
export async function runPrComment(
  ctx: PrCommentRunCtx,
  deps: PrCommentDeps = defaultDeps(),
): Promise<PrCommentResult> {
  const { owner, repo, prNumber, commentId, sender } = ctx.input;
  // A PR is addressed as an issue for the comments API — `issue_number === prNumber`.
  const ref: IssueCommentRef = { owner, repo, issue_number: prNumber };

  // 1. BOT-LOOP floor — never act on (or reply to) the bot's own comment.
  if (isBotSender(sender, deps.botLogin)) {
    ctx.log.info("pr-comment: skipping — triggering comment is bot-authored", {
      owner,
      repo,
      prNumber,
    });
    return { posted: false, skippedBotLoop: true, deduped: false };
  }

  // 2. Mint the issues-write scoped token + an Octokit bound to it.
  const token = await deps.mintToken(ctx.input);
  const octokit = deps.makeOctokit(token);

  // 3. Fetch the PR context + diff deterministically (workflow code, not a model tool).
  const pr = await deps.fetchPr(octokit, ref);

  // 4. Run the pr-comment agent (tool-only, read tools bound to ref+token). The agent
  //    reads the PR + diff + thread and composes a free-form, code-cited reply.
  const reply = await deps.runComment(ctx, ref, octokit, pr);

  // 5. DETERMINISTIC post (workflow, not the model), with the dedup guard keyed by the
  //    triggering comment id (re-invoke / duplicate delivery safe — design Q5.4).
  const posted = await deps.post(octokit, ref, reply, {
    triggerCommentId: commentId,
    sender,
    botLogin: deps.botLogin,
  });
  if (posted.deduped) {
    ctx.log.info("pr-comment: skipping — already replied to this comment", {
      owner,
      repo,
      prNumber,
      commentId,
    });
  }

  return {
    posted: posted.posted,
    commentUrl: posted.html_url,
    skippedBotLoop: false,
    deduped: !!posted.deduped,
  };
}

/**
 * Flue workflow — discovered as the `pr-comment` workflow. The runner owns root
 * harness init from `prCommentAgent`; the inline `run` defers to the testable core.
 */
export default defineWorkflow({
  agent: prCommentAgent,
  input: PrCommentInputSchema,
  async run({ harness, input, log }) {
    // The result is JSON-serializable; cast to JsonValue so Flue snapshots it.
    // The typed `PrCommentResult` is preserved on the testable core for tests.
    return (await runPrComment({ harness, input, log })) as unknown as JsonValue;
  },
});
