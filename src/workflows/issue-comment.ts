/**
 * `issue-comment` workflow — a Phase 5 single-phase workflow.
 *
 * Discoverable as `src/workflows/issue-comment.ts` (filename = workflow name),
 * invoked via
 *   `flue run issue-comment --payload '{"owner":..,"repo":..,"issueNumber":..,"commentBody":..,"commentId":..,"sender":..}'`.
 *
 * Control flow (design/phase-5-workflows-chat.md → "Single-phase workflows" +
 * ~/work/lastlight/workflows/issue-comment.yaml — kind: comment, skill: issue-comment,
 * model: {{models.comment}}, profile issues-write):
 *   1. BOT-LOOP floor: if the triggering comment was authored by the bot itself, do
 *      nothing — never reply to our own comment (infinite-loop guard). The reference
 *      drops bot senders at the webhook connector (Phase 6 here); this is the
 *      defensive workflow-local second floor.
 *   2. Mint an `issues-write` scoped GitHub App token (downscoped to this repo).
 *   3. Fetch the issue/PR context (title/body/labels/comments) DETERMINISTICALLY over
 *      the bound octokit — this is workflow code, not a model tool.
 *   4. Build the issue-comment agent (read tools bound to ref+token, `issue-comment`
 *      skill, persona, comment model/thinkingLevel, NO sandbox). init → session.prompt
 *      with the thread + the TRIGGERING comment, ALL user text wrapped (wrapUntrusted).
 *   5. The agent composes a free-form markdown REPLY (no marker). The WORKFLOW posts
 *      it DETERMINISTICALLY over the scoped token (postIssueReplyDeterministically),
 *      with a DEDUP guard keyed by the triggering comment id (re-`invoke` / duplicate
 *      webhook never double-replies — design Q5.4).
 *
 * WHY agent-composes-text + deterministic post (vs the skill posting via MCP tools):
 * we keep the JUDGMENT agent-side but pull the createComment SIDE EFFECT out of the
 * model surface (spec/09: owner/repo/issue/token never model-selectable). Mirrors the
 * pr-review verdict→post and issue-triage classification→apply splits.
 *
 * NO SANDBOX: issue-comment is tool-only (reads the issue/PR + thread via bound read
 * tools — the skill caps it at ≤2 file reads, no checkout). Cheaper + lower latency.
 *
 * Beta.2 form: `export async function run(ctx)` (no `defineWorkflow` — flue-ref §0).
 *
 * TESTABILITY: `run` defers to `runIssueComment(ctx, deps)` with an injectable `deps`
 * seam (token minter, octokit factory, context fetcher, agent runner, poster). The
 * default deps wire the real implementations; tests pass fakes so the whole flow runs
 * with NO live model and NO live GitHub.
 */
import type { FlueContext } from "@flue/runtime";
import { Octokit } from "octokit";
import {
  GITHUB_PERMISSION_PROFILES,
  type GitAccessProfile,
} from "../engine/profiles.ts";
import { configureGitAuth } from "../engine/git-auth.ts";
import { loadConfig } from "../config.ts";
import { createIssueCommentAgent } from "../agent-lib/issue-comment.ts";
import {
  renderIssueCommentPrompt,
  type IssueCommentPromptContext,
} from "../agent-lib/issue-comment-prompt.ts";
import {
  postIssueReplyDeterministically,
  isBotSender,
  type IssueCommentRef,
  type PostedReply,
} from "../issue-comment-post.ts";

/** The workflow input payload (identifies the issue/PR + the triggering comment). */
export interface IssueCommentInput {
  owner: string;
  repo: string;
  /** The issue or PR number the comment is on. */
  issueNumber: number;
  /** The body of the triggering comment — the request the agent answers. */
  commentBody: string;
  /** The triggering comment's id — the dedup key (re-invoke / duplicate-delivery safe). */
  commentId: number | string;
  /** Who wrote the triggering comment — the bot-loop guard reads this. */
  sender?: string;
  /** Whether the target is a PR (vs an issue) — phrasing + the comments API are the same. */
  isPullRequest?: boolean;
  /** Optional trigger provenance: "webhook" | "cron" | "cli". */
  triggerType?: string;
}

/** The workflow result. */
export interface IssueCommentResult {
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
export const ISSUE_COMMENT_PROFILE: GitAccessProfile = "issues-write";

/** Issue/PR context fetched deterministically for the prompt (workflow code, not a tool). */
export interface IssueCommentContext {
  title: string;
  body: string;
  author?: string;
  labels: string[];
  comments: { author?: string; body: string }[];
}

/**
 * Injectable dependencies — the seams that make `run()` testable without a live model
 * or GitHub. The default factory wires the real implementations.
 */
export interface IssueCommentDeps {
  /** Mint an `issues-write` scoped installation token for this repo. */
  mintToken(input: IssueCommentInput): Promise<string>;
  /** Build an Octokit authenticated with the scoped token. */
  makeOctokit(token: string): Octokit;
  /** Fetch the issue/PR context (title/body/labels/comments) over the bound octokit. */
  fetchIssue(octokit: Octokit, ref: IssueCommentRef): Promise<IssueCommentContext>;
  /**
   * Run the issue-comment agent and return its raw text reply. Wraps agent-init +
   * session.prompt so tests can return a canned reply.
   */
  runComment(
    ctx: FlueContext<IssueCommentInput>,
    ref: IssueCommentRef,
    octokit: Octokit,
    issue: IssueCommentContext,
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
async function mintIssuesWriteToken(input: IssueCommentInput): Promise<string> {
  const cfg = loadConfig();
  if (!cfg.githubApp) {
    throw new Error(
      "issue-comment: GitHub App not configured (GITHUB_APP_ID / _PRIVATE_KEY_PATH / _INSTALLATION_ID). Cannot mint an issues-write token.",
    );
  }
  const { token } = await configureGitAuth({
    appId: cfg.githubApp.appId,
    privateKeyPath: cfg.githubApp.privateKeyPath,
    installationId: cfg.githubApp.installationId,
    botName: cfg.botLogin.replace(/\[bot\]$/, ""),
    repositories: [input.repo],
    permissions: GITHUB_PERMISSION_PROFILES[ISSUE_COMMENT_PROFILE],
  });
  return token;
}

/** Fetch the issue/PR + its comments deterministically (workflow code, not a model tool). */
async function fetchIssueContext(
  octokit: Octokit,
  ref: IssueCommentRef,
): Promise<IssueCommentContext> {
  // issues.get + listComments serve PRs too (a PR is an issue for these endpoints).
  const { data: issue } = await octokit.rest.issues.get({
    owner: ref.owner,
    repo: ref.repo,
    issue_number: ref.issue_number,
  });
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner: ref.owner,
    repo: ref.repo,
    issue_number: ref.issue_number,
    per_page: 100,
  });
  return {
    title: issue.title ?? "",
    body: issue.body ?? "",
    author: issue.user?.login,
    labels: (issue.labels ?? []).map((l) => (typeof l === "string" ? l : (l.name ?? ""))),
    comments: comments.map((c) => ({ author: c.user?.login, body: c.body ?? "" })),
  };
}

/** The real run: init the agent, open a session, prompt with the thread + trigger. */
async function runCommentSession(
  ctx: FlueContext<IssueCommentInput>,
  ref: IssueCommentRef,
  octokit: Octokit,
  issue: IssueCommentContext,
): Promise<string> {
  const agent = createIssueCommentAgent(ref, octokit);
  const harness = await ctx.init(agent);
  const session = await harness.session("issue-comment");
  const promptCtx: IssueCommentPromptContext = {
    owner: ref.owner,
    repo: ref.repo,
    issueNumber: ref.issue_number,
    isPullRequest: ctx.payload.isPullRequest,
    title: issue.title,
    body: issue.body,
    author: issue.author,
    labels: issue.labels,
    comments: issue.comments,
    sender: ctx.payload.sender,
    commentBody: ctx.payload.commentBody,
    triggerType: ctx.payload.triggerType,
  };
  const res = await session.prompt(renderIssueCommentPrompt(promptCtx));
  return res.text;
}

/** Default production dependencies. */
export function defaultDeps(): IssueCommentDeps {
  return {
    mintToken: mintIssuesWriteToken,
    makeOctokit: (token) => new Octokit({ auth: token }),
    fetchIssue: fetchIssueContext,
    runComment: runCommentSession,
    post: postIssueReplyDeterministically,
    botLogin: loadConfig().botLogin,
  };
}

/**
 * The testable core. Drives the full flow over injected dependencies; production uses
 * `defaultDeps()`, tests pass fakes (no live model, no live GitHub).
 */
export async function runIssueComment(
  ctx: FlueContext<IssueCommentInput>,
  deps: IssueCommentDeps = defaultDeps(),
): Promise<IssueCommentResult> {
  const { owner, repo, issueNumber, commentBody, commentId, sender } = ctx.payload;
  const ref: IssueCommentRef = { owner, repo, issue_number: issueNumber };

  // 1. BOT-LOOP floor — never act on (or reply to) the bot's own comment.
  if (isBotSender(sender, deps.botLogin)) {
    ctx.log.info("issue-comment: skipping — triggering comment is bot-authored", {
      owner,
      repo,
      issueNumber,
    });
    return { posted: false, skippedBotLoop: true, deduped: false };
  }

  // 2. Mint the issues-write scoped token + an Octokit bound to it.
  const token = await deps.mintToken(ctx.payload);
  const octokit = deps.makeOctokit(token);

  // 3. Fetch the issue/PR context deterministically (workflow code, not a model tool).
  const issue = await deps.fetchIssue(octokit, ref);

  // 4. Run the issue-comment agent (tool-only, read tools bound to ref+token). The
  //    agent reads the thread + composes a free-form markdown reply.
  const reply = await deps.runComment(ctx, ref, octokit, issue);

  // 5. DETERMINISTIC post (workflow, not the model), with the dedup guard keyed by the
  //    triggering comment id (re-invoke / duplicate delivery safe — design Q5.4).
  const posted = await deps.post(octokit, ref, reply, {
    triggerCommentId: commentId,
    sender,
    botLogin: deps.botLogin,
  });
  if (posted.deduped) {
    ctx.log.info("issue-comment: skipping — already replied to this comment", {
      owner,
      repo,
      issueNumber,
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

/** Flue workflow entry — discovered as the `issue-comment` workflow. */
export async function run(
  ctx: FlueContext<IssueCommentInput>,
): Promise<IssueCommentResult> {
  return runIssueComment(ctx);
}
