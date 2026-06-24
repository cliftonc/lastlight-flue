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
import { defineWorkflow, type FlueHarness, type FlueLogger, type JsonValue } from "@flue/runtime";
import * as v from "valibot";
import { Octokit } from "octokit";
import {
  GITHUB_PERMISSION_PROFILES,
  type GitAccessProfile,
} from "../engine/profiles.ts";
import { configureGitAuth } from "../engine/git-auth.ts";
import { loadConfig } from "../config.ts";
import { answerAgent } from "../agent-lib/answer.ts";
import { githubReadTools } from "../tools/github-read.ts";
import {
  renderAnswerPrompt,
  type AnswerPromptContext,
} from "../agent-lib/answer-prompt.ts";
import {
  postAnswerDeterministically,
  type AnswerRef,
  type PostedAnswer,
} from "../answer-post.ts";
import {
  slackPosterFromConfig,
  parseSlackConversationKey,
  type SlackPoster,
} from "../slack-client.ts";
import { deliverReply } from "../reply.ts";
import { resolveRepoFromText, type OwnerRepo } from "../agent-lib/repo-ref.ts";

/**
 * The workflow input — the NORMALIZED envelope (one schema for both origins).
 * GitHub-initiated runs carry `owner`/`repo`/`issueNumber`; Slack-initiated runs carry
 * `source:"slack"` + `conversationKey` (the thread) and NO issue. `answer` deals with
 * the no-issue case (parity with the reference: delivery is uniform via the origin
 * thread's reply, and a Slack answer is scoped to a repo parsed from the message).
 */
export const AnswerInputSchema = v.object({
  /** GitHub origin: the target repo (the answer is posted on its issue). Optional for Slack. */
  owner: v.optional(v.string()),
  repo: v.optional(v.string()),
  /** GitHub origin: the issue number (answer posted here, labelled `question`). */
  issueNumber: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  /**
   * The specific question. For a routed comment / a Slack message this IS the question;
   * for a GitHub issue with no routed comment the issue title/body is the question.
   */
  question: v.optional(v.string()),
  /** Who asked (trigger metadata). */
  sender: v.optional(v.string()),
  /** Normalized origin. Absent → inferred GitHub when an issue ref is present. */
  source: v.optional(v.picklist(["github", "slack"])),
  /** Slack origin: the thread conversation key (`slack:v1:…`) the answer replies into. */
  conversationKey: v.optional(v.string()),
  /** Optional trigger provenance: "webhook" | "cron" | "cli" | "slack". */
  triggerType: v.optional(v.string()),
  /** App run id for stats correlation; falls back to `harness.name` when absent. */
  runId: v.optional(v.string()),
});
export type AnswerInput = v.InferOutput<typeof AnswerInputSchema>;

/** True when the input carries a complete GitHub issue reference (GitHub origin). */
function isGithubOrigin(input: AnswerInput): input is AnswerInput & {
  owner: string;
  repo: string;
  issueNumber: number;
} {
  return (
    typeof input.owner === "string" &&
    typeof input.repo === "string" &&
    typeof input.issueNumber === "number"
  );
}

/**
 * The action context surface the testable core needs: the supplied `harness`
 * (already initialized from the bound `answerAgent`), the validated `input`, and the
 * run-stream `log`. Mirrors Flue's `ActionContext` so the inline `run` passes straight
 * through.
 */
export interface AnswerRunCtx {
  harness: FlueHarness;
  input: AnswerInput;
  log: FlueLogger;
}

/** The workflow result. */
export interface AnswerResult {
  /** The origin the answer was delivered to. */
  origin: "github" | "slack" | "none";
  /** Whether an answer was actually delivered (posted to the issue / thread). */
  posted: boolean;
  /** The posted comment's URL, when GitHub. */
  commentUrl?: string;
  /** The posted Slack message ts, when Slack. */
  slackTs?: string;
  /** Whether the `question` label was applied (GitHub only). */
  labelled: boolean;
  /** True when we skipped posting because the issue was already answered (dedup; GitHub). */
  deduped: boolean;
}

/** The `issues-write` profile the GitHub answer path runs under (spec/09 / design). */
export const ANSWER_PROFILE: GitAccessProfile = "issues-write";
/** The `read` profile the Slack answer path runs under (read-only repo context). */
export const ANSWER_READ_PROFILE: GitAccessProfile = "read";

/** Issue context fetched deterministically for the prompt (workflow code, not a tool). */
export interface AnswerContext {
  title: string;
  body: string;
  author?: string;
  labels: string[];
  comments: { author?: string; body: string }[];
}

/** What the answer agent is run against (GitHub: full issue; Slack: question + repo). */
export interface AnswerAgentArgs {
  /** The repo the agent reads from (its read tools are bound here). Absent → no repo tools. */
  repo?: OwnerRepo;
  /** The scoped read Octokit for `repo`, when one was minted. */
  octokit?: Octokit;
  /** The issue number, for the GitHub prompt context. */
  issueNumber?: number;
  /** The fetched issue context (GitHub origin); absent for a Slack question. */
  issue?: AnswerContext;
}

/**
 * Injectable dependencies — the seams that make `run()` testable without a live model
 * or GitHub or Slack. The default factory wires the real implementations.
 */
export interface AnswerDeps {
  /** Build an Octokit authenticated with the scoped token. */
  makeOctokit(token: string): Octokit;
  /** Mint a scoped installation token (issues-write for GitHub, read for Slack) for a repo. */
  mintToken(repo: string, profile: GitAccessProfile): Promise<string>;
  /** Fetch the issue context (title/body/labels/comments) over the bound octokit. */
  fetchIssue(octokit: Octokit, ref: AnswerRef): Promise<AnswerContext>;
  /**
   * Run the answer agent and return its raw text answer. Wraps agent-init +
   * session.prompt so tests can return a canned answer. Repo read tools are bound only
   * when `args.repo` + `args.octokit` are present.
   */
  runAnswerAgent(ctx: AnswerRunCtx, args: AnswerAgentArgs): Promise<string>;
  /** Deterministically post the answer + apply the `question` label (with dedup; GitHub). */
  post(
    octokit: Octokit,
    ref: AnswerRef,
    body: string,
    opts: { botLogin: string },
  ): Promise<PostedAnswer>;
  /** The egress poster for Slack delivery (undefined when no bot token configured). */
  poster?: SlackPoster;
  /** The bot's own login (for the dedup author check). */
  botLogin: string;
  /** The managed-repo allowlist (for the Slack repo resolution). */
  managedRepos: string[];
  /** The fallback repo (`owner/repo`) when a Slack message names none. */
  fallbackRepo?: string;
}

/** Mint a scoped token downscoped to the target repo via the ported git-auth. */
async function mintScopedToken(repo: string, profile: GitAccessProfile): Promise<string> {
  const cfg = loadConfig();
  if (!cfg.githubApp) {
    throw new Error(
      "answer: GitHub App not configured (GITHUB_APP_ID / _PRIVATE_KEY_PATH / _INSTALLATION_ID). Cannot mint a scoped token.",
    );
  }
  const { token } = await configureGitAuth({
    appId: cfg.githubApp.appId,
    privateKeyPath: cfg.githubApp.privateKeyPath,
    installationId: cfg.githubApp.installationId,
    botName: cfg.botLogin.replace(/\[bot\]$/, ""),
    repositories: [repo],
    permissions: GITHUB_PERMISSION_PROFILES[profile],
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

/**
 * The real run: open a session on the bound harness, prompt with the question + issue.
 * Repo READ tools (closed over ref + scoped-token Octokit) are injected for THIS call
 * only and ONLY when a repo was resolved — owner/repo/token are never model-selectable.
 */
async function runAnswerSession(
  ctx: AnswerRunCtx,
  args: AnswerAgentArgs,
): Promise<string> {
  const session = await ctx.harness.session("answer");
  const promptCtx: AnswerPromptContext = {
    owner: args.repo?.owner ?? "",
    repo: args.repo?.repo ?? "",
    issueNumber: args.issueNumber,
    title: args.issue?.title ?? "",
    body: args.issue?.body ?? "",
    author: args.issue?.author,
    labels: args.issue?.labels,
    comments: args.issue?.comments,
    question: ctx.input.question,
    sender: ctx.input.sender,
    triggerType: ctx.input.triggerType,
  };
  const tools =
    args.repo && args.octokit
      ? githubReadTools({ owner: args.repo.owner, repo: args.repo.repo }, args.octokit)
      : [];
  const res = await session.prompt(
    renderAnswerPrompt(promptCtx),
    tools.length ? { tools } : undefined,
  );
  return res.text;
}

/** Default production dependencies. */
export function defaultDeps(): AnswerDeps {
  const cfg = loadConfig();
  return {
    makeOctokit: (token) => new Octokit({ auth: token }),
    mintToken: mintScopedToken,
    fetchIssue: fetchIssueContext,
    runAnswerAgent: runAnswerSession,
    post: postAnswerDeterministically,
    poster: slackPosterFromConfig(),
    botLogin: cfg.botLogin,
    managedRepos: cfg.managedRepos,
    // A Slack message that names no repo falls back to the workspace's default repo
    // (the explore default, else the first managed repo).
    fallbackRepo: cfg.exploreDefaultRepo ?? cfg.managedRepos[0],
  };
}

/**
 * The testable core. Drives the full flow over injected dependencies; production uses
 * `defaultDeps()`, tests pass fakes (no live model, no live GitHub, no live Slack).
 * Dispatches on the normalized origin: a GitHub issue gets a posted+labelled comment;
 * a Slack thread gets the answer delivered back into the thread.
 */
export async function runAnswer(
  ctx: AnswerRunCtx,
  deps: AnswerDeps = defaultDeps(),
): Promise<AnswerResult> {
  if (isGithubOrigin(ctx.input)) {
    return runGithubAnswer(ctx, deps);
  }
  if (ctx.input.source === "slack" && ctx.input.conversationKey) {
    return runSlackAnswer(ctx, deps);
  }
  // Neither a GitHub issue nor a Slack thread — nothing to answer (defensive).
  ctx.log.info("answer: input carries no GitHub issue or Slack thread — skipping", {
    source: ctx.input.source,
  });
  return { origin: "none", posted: false, labelled: false, deduped: false };
}

/** GitHub origin: mint issues-write, fetch the issue, answer, deterministic post + label. */
async function runGithubAnswer(
  ctx: AnswerRunCtx,
  deps: AnswerDeps,
): Promise<AnswerResult> {
  const input = ctx.input as AnswerInput & { owner: string; repo: string; issueNumber: number };
  const ref: AnswerRef = { owner: input.owner, repo: input.repo, issue_number: input.issueNumber };

  const token = await deps.mintToken(input.repo, ANSWER_PROFILE);
  const octokit = deps.makeOctokit(token);
  const issue = await deps.fetchIssue(octokit, ref);

  const answer = await deps.runAnswerAgent(ctx, {
    repo: { owner: input.owner, repo: input.repo },
    octokit,
    issueNumber: input.issueNumber,
    issue,
  });

  // DETERMINISTIC post + label, with the dedup guard keyed by the issue number. OPEN.
  const posted = await deps.post(octokit, ref, answer, { botLogin: deps.botLogin });
  if (posted.deduped) {
    ctx.log.info("answer: skipping post — issue already answered", {
      owner: input.owner,
      repo: input.repo,
      issueNumber: input.issueNumber,
    });
  }
  return {
    origin: "github",
    posted: posted.posted,
    commentUrl: posted.html_url,
    labelled: posted.labelled,
    deduped: !!posted.deduped,
  };
}

/**
 * Slack origin (no GitHub issue): resolve a repo from the message (managed allowlist +
 * fallback), run the agent over that read context, and DELIVER the answer back into the
 * originating thread via the shared reply layer. No label, no GitHub write.
 */
async function runSlackAnswer(
  ctx: AnswerRunCtx,
  deps: AnswerDeps,
): Promise<AnswerResult> {
  const loc = parseSlackConversationKey(ctx.input.conversationKey!);
  if (!loc) {
    ctx.log.info("answer: Slack run has an unparseable conversation key — skipping", {});
    return { origin: "slack", posted: false, labelled: false, deduped: false };
  }

  // Resolve which repo the question is about (named in the message, else the fallback).
  const repo = resolveRepoFromText(ctx.input.question ?? "", {
    managedRepos: deps.managedRepos,
    fallback: deps.fallbackRepo,
  });
  let octokit: Octokit | undefined;
  if (repo) {
    const token = await deps.mintToken(repo.repo, ANSWER_READ_PROFILE);
    octokit = deps.makeOctokit(token);
  }

  const answer = (await deps.runAnswerAgent(ctx, { repo, octokit })).trim();
  if (!answer) {
    return { origin: "slack", posted: false, labelled: false, deduped: false };
  }

  if (!deps.poster) {
    ctx.log.warn("answer: Slack egress inactive (no SLACK_BOT_TOKEN) — answer not delivered", {});
    return { origin: "slack", posted: false, labelled: false, deduped: false };
  }

  // Reply INTO the thread (thread_ts only when the key's tail is a real message ts).
  const threadTs = /^\d+\.\d+$/.test(loc.threadTs) ? loc.threadTs : undefined;
  const delivered = await deliverReply(
    { kind: "slack", poster: deps.poster, channel: loc.channelId, threadTs },
    answer,
  );
  return { origin: "slack", posted: true, slackTs: delivered.ts, labelled: false, deduped: false };
}

/**
 * Flue workflow — discovered as the `answer` workflow. The runner owns root harness
 * init from `answerAgent`; the inline `run` defers to the testable core.
 */
export default defineWorkflow({
  agent: answerAgent,
  input: AnswerInputSchema,
  async run({ harness, input, log }) {
    // The result is JSON-serializable; cast to JsonValue so Flue snapshots it.
    // The typed `AnswerResult` is preserved on the testable core for tests.
    return (await runAnswer({ harness, input, log })) as unknown as JsonValue;
  },
});
