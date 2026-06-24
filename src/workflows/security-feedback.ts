/**
 * `security-feedback` workflow — a Phase 5 single-phase workflow.
 *
 * Discoverable as `src/workflows/security-feedback.ts` (filename = workflow name), invoked
 * via
 *   `flue run security-feedback --payload '{"owner":..,"repo":..,"issueNumber":..,"commentBody":..,"sender":..}'`
 * and (Phase 6) routed from a `@last-light` mention on a `security`-labelled issue
 * (config route `security_feedback`). The triggering issue is almost always the per-run
 * scan SUMMARY issue that `security-review` files.
 *
 * SHAPE — `kind: health`, single phase `feedback`, skill `security-feedback`,
 * model `{{models.security}}` (~/work/lastlight/workflows/security-feedback.yaml). This is
 * the CONSUMER of the scan-summary issue that `security-review` PRODUCES; the issue-format
 * contract (issue-format.md / both skills' §1 regexes) is parsed DETERMINISTICALLY here.
 *
 * Control flow (SKILL.md §1–§3):
 *   1. Mint an `issues-write` scoped GitHub App token (downscoped to this repo) — the
 *      create-issues primary flow files sub-issues + rewrites the parent + comments.
 *   2. Fetch the parent issue body + comments DETERMINISTICALLY over the bound octokit
 *      (workflow code, not a model tool).
 *   3. PARSE the parent body deterministically (parseScanIssue) — version check + the
 *      finding rows. A missing/unknown version → reply with the SKILL.md §1 "unknown
 *      scan-summary format" message and stop (do NOT parse further).
 *   4. Build the security-feedback agent (read tools bound to ref+token, `security-feedback`
 *      skill, persona, `security` model/thinkingLevel, NO sandbox). init → session.prompt
 *      with the parsed findings + the parent body + the TRIGGERING comment, all user/issue
 *      text wrapped (wrapUntrusted). The agent emits a `FEEDBACK:` marker (intent + selection).
 *   5. ACT deterministically on the bound ref (security-feedback-post.ts):
 *      - create-issues → resolve the selection, create sub-issues, rewrite the parent body
 *        to broken-out, post the summary comment. Empty selection → the SKILL.md §3 "no rows
 *        ticked / no matches" reply.
 *      - discuss / reopen → post the agent's reply (reopen falls back to the SKILL.md §reopen
 *        instruction when the agent gives no body).
 *      - accept-risk / false-positive → DEFERRED (SECURITY.md-PR clone path) → honest reply
 *        (see security-feedback-post.ts TODO).
 *      - ignore → no action.
 *
 * WHY classify-then-deterministic-act (vs the skill's agent-calls-github_* shape): we keep
 * the JUDGMENT agent-side but pull the create/update/comment SIDE EFFECTS off the model
 * surface (spec/09: owner/repo/issue/token never model-selectable). Mirrors the issue-triage
 * CLASSIFICATION→apply and pr-review VERDICT→post splits.
 *
 * NO SANDBOX: the create-issues flow is tool-only (parses the scan + comments via reads).
 *
 * Beta.2 form: `export async function run(ctx)` (no `defineWorkflow` — flue-ref §0).
 *
 * TESTABILITY: `run` defers to `runSecurityFeedback(ctx, deps, today)` with an injectable
 * `deps` seam (token minter, octokit factory, issue fetcher, agent runner, action funcs).
 * The default deps wire the real implementations; tests pass fakes so the whole flow runs
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
import { securityFeedbackAgent } from "../agent-lib/security-feedback.ts";
import {
  renderSecurityFeedbackPrompt,
  type SecurityFeedbackPromptContext,
} from "../agent-lib/security-feedback-prompt.ts";
import {
  parseScanIssue,
  severityCounts,
  type ParsedScan,
} from "../agent-lib/security-feedback-parse.ts";
import {
  parseFeedbackMarker,
  resolveSelection,
  extractFeedbackReply,
} from "../agent-lib/security-feedback-classify.ts";
import {
  createSubIssuesDeterministically,
  postFeedbackReply,
  type FeedbackCreateResult,
} from "../security-feedback-post.ts";
import { githubReadTools, type RepoRef } from "../tools/github-read.ts";

/** The workflow input payload (identifies the scan issue + the triggering comment). */
export const SecurityFeedbackInputSchema = v.object({
  owner: v.string(),
  repo: v.string(),
  /** The security scan-summary (parent) issue number. */
  issueNumber: v.pipe(v.number(), v.integer(), v.minValue(1)),
  /** The triggering comment body — the maintainer's request. */
  commentBody: v.string(),
  /** Who wrote the triggering comment (the @{sender} in sub-issue bodies / summaries). */
  sender: v.optional(v.string()),
  /** Optional trigger provenance: "webhook" | "cron" | "cli". */
  triggerType: v.optional(v.string()),
  /** App run id for stats correlation; falls back to `harness.name` when absent. */
  runId: v.optional(v.string()),
});
export type SecurityFeedbackInput = v.InferOutput<typeof SecurityFeedbackInputSchema>;

/**
 * The action context surface the testable core needs: the supplied `harness`
 * (already initialized from the bound `securityFeedbackAgent`), the validated `input`,
 * and the run-stream `log`. Mirrors Flue's `ActionContext` so the inline `run` passes
 * straight through.
 */
export interface SecurityFeedbackRunCtx {
  harness: FlueHarness;
  input: SecurityFeedbackInput;
  log: FlueLogger;
}

/** The workflow result. */
export interface SecurityFeedbackResult {
  /** The classified intent. */
  intent: string;
  /** True when the parent body carried the supported scan version. */
  versionOk: boolean;
  /** Sub-issue numbers created (create-issues flow). */
  createdIssues: number[];
  /** Whether the parent body was rewritten to the broken-out state. */
  parentRewritten: boolean;
  /** Whether a comment (summary or reply) was posted. */
  commented: boolean;
}

/** The `issues-write` profile this workflow runs under (create sub-issues + rewrite + comment). */
export const SECURITY_FEEDBACK_PROFILE: GitAccessProfile = "issues-write";

/** Parent issue context fetched deterministically for parsing + the prompt. */
export interface ParentIssue {
  body: string;
}

/**
 * Injectable dependencies — the seams that make `run()` testable without a live model or
 * GitHub. The default factory wires the real implementations.
 */
export interface SecurityFeedbackDeps {
  /** Mint an `issues-write` scoped installation token for this repo. */
  mintToken(input: SecurityFeedbackInput): Promise<string>;
  /** Build an Octokit authenticated with the scoped token. */
  makeOctokit(token: string): Octokit;
  /** Fetch the parent scan issue body over the bound octokit. */
  fetchParent(octokit: Octokit, ref: RepoRef, issueNumber: number): Promise<ParentIssue>;
  /** Run the feedback agent and return its raw text output (FEEDBACK marker + optional reply). */
  runFeedback(
    ctx: SecurityFeedbackRunCtx,
    ref: RepoRef,
    octokit: Octokit,
    parsed: ParsedScan,
    parentBody: string,
  ): Promise<string>;
  /** Deterministically create sub-issues + rewrite the parent + post the summary. */
  createSubIssues: typeof createSubIssuesDeterministically;
  /** Deterministically post a plain reply comment (discuss / reopen / version-mismatch). */
  postReply: typeof postFeedbackReply;
}

/** Mint an issues-write token downscoped to the target repo via the ported git-auth. */
async function mintIssuesWriteToken(input: SecurityFeedbackInput): Promise<string> {
  const cfg = loadConfig();
  if (!cfg.githubApp) {
    throw new Error(
      "security-feedback: GitHub App not configured (GITHUB_APP_ID / _PRIVATE_KEY_PATH / _INSTALLATION_ID). Cannot mint an issues-write token.",
    );
  }
  const { token } = await configureGitAuth({
    appId: cfg.githubApp.appId,
    privateKeyPath: cfg.githubApp.privateKeyPath,
    installationId: cfg.githubApp.installationId,
    botName: cfg.botLogin.replace(/\[bot\]$/, ""),
    repositories: [input.repo],
    permissions: GITHUB_PERMISSION_PROFILES[SECURITY_FEEDBACK_PROFILE],
  });
  return token;
}

/** Fetch the parent scan issue body deterministically (workflow code, not a model tool). */
async function fetchParentIssue(
  octokit: Octokit,
  ref: RepoRef,
  issueNumber: number,
): Promise<ParentIssue> {
  const { data } = await octokit.rest.issues.get({
    owner: ref.owner,
    repo: ref.repo,
    issue_number: issueNumber,
  });
  return { body: data.body ?? "" };
}

/** The real run: open a session on the bound harness, prompt with the parsed scan + comment. */
async function runFeedbackSession(
  ctx: SecurityFeedbackRunCtx,
  ref: RepoRef,
  octokit: Octokit,
  parsed: ParsedScan,
  parentBody: string,
): Promise<string> {
  const session = await ctx.harness.session("security-feedback");
  const promptCtx: SecurityFeedbackPromptContext = {
    owner: ref.owner,
    repo: ref.repo,
    parentIssueNumber: ctx.input.issueNumber,
    sender: ctx.input.sender,
    commentBody: ctx.input.commentBody,
    parentBody,
    findings: parsed.findings,
    triggerType: ctx.input.triggerType,
  };
  // The per-run READ tools (closed over ref + scoped-token Octokit) are injected
  // for THIS call only — owner/repo/token are never model-selectable.
  const res = await session.prompt(renderSecurityFeedbackPrompt(promptCtx), {
    tools: githubReadTools(ref, octokit),
  });
  return res.text;
}

/** Default production dependencies. */
export function defaultDeps(): SecurityFeedbackDeps {
  return {
    mintToken: mintIssuesWriteToken,
    makeOctokit: (token) => new Octokit({ auth: token }),
    fetchParent: fetchParentIssue,
    runFeedback: runFeedbackSession,
    createSubIssues: createSubIssuesDeterministically,
    postReply: postFeedbackReply,
  };
}

/** The SKILL.md §1 reply when the parent's scan version is missing/unknown. */
export const UNKNOWN_VERSION_REPLY =
  "Unknown scan-summary format — this skill is at version 1 but the parent reports a " +
  "different version. Ask the maintainer to re-run `@last-light security-review`.";

/** The SKILL.md §reopen reply (used when the agent supplies no reopen body). */
export const REOPEN_REPLY =
  "To re-evaluate this finding, run `@last-light security-review` — the next scan " +
  "re-picks it up if `SECURITY.md` has been updated.";

/** The UTC date stamp (YYYY-MM-DD). Computed INSIDE run() — never at module top-level. */
function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * The testable core. Drives the full flow over injected dependencies; production uses
 * `defaultDeps()`, tests pass fakes (no live model, no live GitHub). `today` is injectable
 * so tests pin the sub-issue body date deterministically.
 */
export async function runSecurityFeedback(
  ctx: SecurityFeedbackRunCtx,
  deps: SecurityFeedbackDeps = defaultDeps(),
  today: string = todayUTC(),
): Promise<SecurityFeedbackResult> {
  const { owner, repo, issueNumber } = ctx.input;
  const sender = ctx.input.sender ?? "maintainer";
  const ref: RepoRef = { owner, repo };

  // 1. Mint the issues-write scoped token + an Octokit bound to it.
  const token = await deps.mintToken(ctx.input);
  const octokit = deps.makeOctokit(token);

  // 2. Fetch the parent scan issue body deterministically.
  const parent = await deps.fetchParent(octokit, ref, issueNumber);

  // 3. PARSE deterministically (version check + finding rows).
  const parsed = parseScanIssue(parent.body);
  if (!parsed.versionOk) {
    ctx.log.info("security-feedback: parent scan version unknown — refusing to parse", {
      owner,
      repo,
      issueNumber,
    });
    const r = await deps.postReply(octokit, ref, issueNumber, UNKNOWN_VERSION_REPLY);
    return {
      intent: "version-mismatch",
      versionOk: false,
      createdIssues: [],
      parentRewritten: false,
      commented: r.posted,
    };
  }

  // 4. Run the agent to CLASSIFY (judgment); the workflow ACTS deterministically.
  const output = await deps.runFeedback(ctx, ref, octokit, parsed, parent.body);
  const { classification } = parseFeedbackMarker(output);

  // 5. ACT on the bound ref.
  if (classification.intent === "create-issues") {
    const { selected, skippedAlreadyBrokenOut } = resolveSelection(
      classification,
      parsed.findings,
    );
    if (!selected.length) {
      // SKILL.md §3 "no rows ticked / no matches" — reply, create nothing.
      const c = severityCounts(parsed.findings);
      const nTicked = parsed.findings.filter((f) => f.userTicked).length;
      const nDone = parsed.findings.filter((f) => f.alreadyBrokenOut).length;
      const msg = `No findings matched \`${classification.selectionText ?? "ticked"}\`. This scan has: ${c.critical} critical, ${c.high} high, ${c.medium} medium, ${c.low} low. Ticked: ${nTicked}. Already broken out: ${nDone}.`;
      const r = await deps.postReply(octokit, ref, issueNumber, msg);
      return {
        intent: "create-issues",
        versionOk: true,
        createdIssues: [],
        parentRewritten: false,
        commented: r.posted,
      };
    }
    const result: FeedbackCreateResult = await deps.createSubIssues(octokit, ref, {
      parentIssueNumber: issueNumber,
      parentBody: parent.body,
      selected,
      skipped: skippedAlreadyBrokenOut,
      sender,
      today,
    });
    ctx.log.info("security-feedback: created sub-issues", {
      owner,
      repo,
      issueNumber,
      created: result.created.map((c) => c.subIssueNumber),
    });
    return {
      intent: "create-issues",
      versionOk: true,
      createdIssues: result.created.map((c) => c.subIssueNumber),
      parentRewritten: result.parentRewritten,
      commented: result.commented,
    };
  }

  if (classification.intent === "ignore") {
    ctx.log.info("security-feedback: ignore — no action", { owner, repo, issueNumber });
    return {
      intent: "ignore",
      versionOk: true,
      createdIssues: [],
      parentRewritten: false,
      commented: false,
    };
  }

  // discuss / reopen / accept-risk / false-positive → reply (the SECURITY.md-PR path for
  // accept-risk / false-positive is deferred; we record an honest reply via the agent body
  // or the canned fallback so the maintainer isn't left hanging).
  let body = extractFeedbackReply(output);
  if (!body && classification.intent === "reopen") body = REOPEN_REPLY;
  const r = await deps.postReply(octokit, ref, issueNumber, body);
  return {
    intent: classification.intent,
    versionOk: true,
    createdIssues: [],
    parentRewritten: false,
    commented: r.posted,
  };
}

/**
 * Flue workflow — discovered as the `security-feedback` workflow. The runner owns root
 * harness init from `securityFeedbackAgent`; the inline `run` defers to the testable core.
 */
export default defineWorkflow({
  agent: securityFeedbackAgent,
  input: SecurityFeedbackInputSchema,
  async run({ harness, input, log }) {
    // The result is JSON-serializable; cast to JsonValue so Flue snapshots it.
    // The typed `SecurityFeedbackResult` is preserved on the testable core for tests.
    return (await runSecurityFeedback({ harness, input, log })) as unknown as JsonValue;
  },
});
