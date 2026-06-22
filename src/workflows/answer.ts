/**
 * `answer` workflow — a Phase 5 single-phase workflow.
 *
 * Discoverable as `src/workflows/answer.ts` (filename = workflow name), invoked via
 *   `flue run answer --payload '{"owner":..,"repo":..,"issueNumber":..,"question":..,"sender":..}'`
 * and routed from `issue_answer` / Slack `answer` (config/default.yaml routes).
 *
 * Control flow (design/phase-5-workflows-chat.md → "Single-phase workflows" +
 * ~/work/lastlight/workflows/answer.yaml — kind: answer, skill: issue-answer,
 * model: {{models.answer}}, profile issues-write):
 *   1. Mint an `issues-write` scoped GitHub App token (downscoped to this repo) — the
 *      same profile as issue-comment/triage (the only write is the answer comment +
 *      the `question` label).
 *   2. Fetch the issue context (title/body/labels/comments) DETERMINISTICALLY over the
 *      bound octokit — this is workflow code, not a model tool.
 *   3. Build the answer agent (read tools bound to ref+token, `issue-answer` skill,
 *      persona, answer model/thinkingLevel, NO sandbox). init → session.prompt with the
 *      question + issue context, ALL user text wrapped (wrapUntrusted).
 *   4. The agent composes a free-form markdown ANSWER (no marker). The WORKFLOW posts
 *      it DETERMINISTICALLY over the scoped token (postAnswerDeterministically) and
 *      applies the `question` label, with a DEDUP guard keyed by the issue number
 *      (re-`invoke` / duplicate webhook never double-answers — design Q5.4). The issue
 *      is LEFT OPEN (the skill's rule — a human closes it when satisfied).
 *
 * WHY answer vs issue-comment: issue-comment is a SHORT, bounded reply (answer a brief
 * question, do one labelling action, or REDIRECT a build request) — at most ~2 reads.
 * answer is a THOROUGH, skill-backed SOURCED response to a direct question: it reads
 * more repo context, applies the `question` label, and leaves the issue open. Same
 * agent-composes-text + deterministic-post shape, different skill/scope.
 *
 * WEB-RESEARCH DEFERRED (this slice): the reference answer phase ran with a `context`
 * checkout + `web_search: true` + `unrestricted_egress: true`. The web tools are NOT
 * yet built in this port (design phase-5 §"DRIFT: Flue has no built-in web_search" —
 * they land later as gated `defineTool`s on the explorer agent). This slice ports the
 * answer STRUCTURE and scopes the agent to the GitHub/repo-context answer path (the
 * agent answers from the issue + repo via bound read tools, flagging anything it can't
 * verify). The web-research step is a clearly-marked TODO(phase-5/web-tools) seam in
 * `createAnswerAgent` / `renderAnswerPrompt`; it does NOT block this slice.
 *
 * NO SANDBOX (this slice): tool-only (reads the issue + repo via bound read tools).
 *
 * Beta.2 form: `export async function run(ctx)` (no `defineWorkflow` — flue-ref §0).
 *
 * TESTABILITY: `run` defers to `runAnswer(ctx, deps)` with an injectable `deps` seam
 * (token minter, octokit factory, context fetcher, agent runner, poster). The default
 * deps wire the real implementations; tests pass fakes so the whole flow runs with NO
 * live model and NO live GitHub.
 */
import type { FlueContext } from "@flue/runtime";
import { Octokit } from "octokit";
import {
  GITHUB_PERMISSION_PROFILES,
  type GitAccessProfile,
} from "../engine/profiles.ts";
import { configureGitAuth } from "../engine/git-auth.ts";
import { loadConfig } from "../config.ts";
import { createAnswerAgent } from "../agent-lib/answer.ts";
import {
  renderAnswerPrompt,
  type AnswerPromptContext,
} from "../agent-lib/answer-prompt.ts";
import {
  postAnswerDeterministically,
  type AnswerRef,
  type PostedAnswer,
} from "../answer-post.ts";

/** The workflow input payload (identifies the question issue + how to answer it). */
export interface AnswerInput {
  owner: string;
  repo: string;
  /** The originating issue number (the answer is posted here, labelled `question`). */
  issueNumber: number;
  /**
   * The specific question, when the trigger is a routed comment rather than the issue
   * itself. When absent, the issue title/body IS the question.
   */
  question?: string;
  /** Who asked (trigger metadata). */
  sender?: string;
  /** Optional trigger provenance: "webhook" | "cron" | "cli". */
  triggerType?: string;
}

/** The workflow result. */
export interface AnswerResult {
  /** Whether an answer was actually posted. */
  posted: boolean;
  /** The posted comment's URL, when one was posted. */
  commentUrl?: string;
  /** Whether the `question` label was applied. */
  labelled: boolean;
  /** True when we skipped posting because the issue was already answered (dedup). */
  deduped: boolean;
}

/** The `issues-write` profile this workflow always runs under (spec/09 / design). */
export const ANSWER_PROFILE: GitAccessProfile = "issues-write";

/** Issue context fetched deterministically for the prompt (workflow code, not a tool). */
export interface AnswerContext {
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
export interface AnswerDeps {
  /** Mint an `issues-write` scoped installation token for this repo. */
  mintToken(input: AnswerInput): Promise<string>;
  /** Build an Octokit authenticated with the scoped token. */
  makeOctokit(token: string): Octokit;
  /** Fetch the issue context (title/body/labels/comments) over the bound octokit. */
  fetchIssue(octokit: Octokit, ref: AnswerRef): Promise<AnswerContext>;
  /**
   * Run the answer agent and return its raw text answer. Wraps agent-init +
   * session.prompt so tests can return a canned answer.
   */
  runAnswerAgent(
    ctx: FlueContext<AnswerInput>,
    ref: AnswerRef,
    octokit: Octokit,
    issue: AnswerContext,
  ): Promise<string>;
  /** Deterministically post the answer + apply the `question` label (with dedup). */
  post(
    octokit: Octokit,
    ref: AnswerRef,
    body: string,
    opts: { botLogin: string },
  ): Promise<PostedAnswer>;
  /** The bot's own login (for the dedup author check). */
  botLogin: string;
}

/** Mint an issues-write token downscoped to the target repo via the ported git-auth. */
async function mintIssuesWriteToken(input: AnswerInput): Promise<string> {
  const cfg = loadConfig();
  if (!cfg.githubApp) {
    throw new Error(
      "answer: GitHub App not configured (GITHUB_APP_ID / _PRIVATE_KEY_PATH / _INSTALLATION_ID). Cannot mint an issues-write token.",
    );
  }
  const { token } = await configureGitAuth({
    appId: cfg.githubApp.appId,
    privateKeyPath: cfg.githubApp.privateKeyPath,
    installationId: cfg.githubApp.installationId,
    botName: cfg.botLogin.replace(/\[bot\]$/, ""),
    repositories: [input.repo],
    permissions: GITHUB_PERMISSION_PROFILES[ANSWER_PROFILE],
  });
  return token;
}

/** Fetch the issue + its comments deterministically (workflow code, not a model tool). */
async function fetchIssueContext(
  octokit: Octokit,
  ref: AnswerRef,
): Promise<AnswerContext> {
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

/** The real run: init the agent, open a session, prompt with the question + issue. */
async function runAnswerSession(
  ctx: FlueContext<AnswerInput>,
  ref: AnswerRef,
  octokit: Octokit,
  issue: AnswerContext,
): Promise<string> {
  const agent = createAnswerAgent(ref, octokit);
  const harness = await ctx.init(agent);
  const session = await harness.session("answer");
  const promptCtx: AnswerPromptContext = {
    owner: ref.owner,
    repo: ref.repo,
    issueNumber: ref.issue_number,
    title: issue.title,
    body: issue.body,
    author: issue.author,
    labels: issue.labels,
    comments: issue.comments,
    question: ctx.payload.question,
    sender: ctx.payload.sender,
    triggerType: ctx.payload.triggerType,
  };
  const res = await session.prompt(renderAnswerPrompt(promptCtx));
  return res.text;
}

/** Default production dependencies. */
export function defaultDeps(): AnswerDeps {
  return {
    mintToken: mintIssuesWriteToken,
    makeOctokit: (token) => new Octokit({ auth: token }),
    fetchIssue: fetchIssueContext,
    runAnswerAgent: runAnswerSession,
    post: postAnswerDeterministically,
    botLogin: loadConfig().botLogin,
  };
}

/**
 * The testable core. Drives the full flow over injected dependencies; production uses
 * `defaultDeps()`, tests pass fakes (no live model, no live GitHub).
 */
export async function runAnswer(
  ctx: FlueContext<AnswerInput>,
  deps: AnswerDeps = defaultDeps(),
): Promise<AnswerResult> {
  const { owner, repo, issueNumber } = ctx.payload;
  const ref: AnswerRef = { owner, repo, issue_number: issueNumber };

  // 1. Mint the issues-write scoped token + an Octokit bound to it.
  const token = await deps.mintToken(ctx.payload);
  const octokit = deps.makeOctokit(token);

  // 2. Fetch the issue context deterministically (workflow code, not a model tool).
  const issue = await deps.fetchIssue(octokit, ref);

  // 3. Run the answer agent (tool-only, read tools bound to ref+token). The agent
  //    reads the issue + repo context and composes a free-form markdown answer.
  const answer = await deps.runAnswerAgent(ctx, ref, octokit, issue);

  // 4. DETERMINISTIC post + label (workflow, not the model), with the dedup guard keyed
  //    by the issue number (re-invoke / duplicate delivery safe — design Q5.4). The
  //    issue is left OPEN.
  const posted = await deps.post(octokit, ref, answer, { botLogin: deps.botLogin });
  if (posted.deduped) {
    ctx.log.info("answer: skipping post — issue already answered", {
      owner,
      repo,
      issueNumber,
    });
  }

  return {
    posted: posted.posted,
    commentUrl: posted.html_url,
    labelled: posted.labelled,
    deduped: !!posted.deduped,
  };
}

/** Flue workflow entry — discovered as the `answer` workflow. */
export async function run(ctx: FlueContext<AnswerInput>): Promise<AnswerResult> {
  return runAnswer(ctx);
}
