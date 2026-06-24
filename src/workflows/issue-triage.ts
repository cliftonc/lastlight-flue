/**
 * `issue-triage` workflow — a Phase 5 single-phase workflow.
 *
 * Discoverable as `src/workflows/issue-triage.ts` (filename = workflow name),
 * invoked via `flue run issue-triage --payload '{"owner":..,"repo":..,"issueNumber":..}'`.
 *
 * Control flow (design/phase-5-workflows-chat.md → "Single-phase workflows" +
 * ~/work/lastlight/workflows/issue-triage.yaml):
 *   1. Mint an `issues-write` scoped GitHub App token (downscoped to this repo).
 *   2. Fetch the issue context (title/body/labels/comments) DETERMINISTICALLY over
 *      the bound octokit — this is workflow code, not a model tool.
 *   3. Build the triage agent (read tools bound to ref+token, `issue-triage` skill,
 *      persona, triage model/thinkingLevel, NO sandbox). init → session.prompt with
 *      the issue context, the untrusted issue text wrapped (wrapUntrusted).
 *   4. parseTriageClassification(agent output) — the `CLASSIFICATION:` marker.
 *   5. The WORKFLOW applies labels / comment / close DETERMINISTICALLY (not the
 *      model) over the scoped token — `applyTriageDeterministically`, mirroring the
 *      pr-review verdict→post split. Canonical labels are created-if-missing
 *      (existing-only fallback on 403), matching the reference skill's §0.
 *
 * WHY agent-emits-marker + deterministic apply (vs the reference's agent-applies-
 * labels-via-MCP-tools): we keep the JUDGMENT agent-side but pull the SIDE EFFECT
 * out of the model surface (spec/09: owner/repo/issue/token never model-selectable).
 * `triage-classification.ts` documents the seam.
 *
 * NO SANDBOX: triage is tool-only (reads the issue + searches duplicates via bound
 * read tools — no checkout needed). Cheaper + lower-latency than build/review.
 *
 * Beta.3 form: `export default defineWorkflow({ agent, input, run })`. The bound
 * `triageAgent` is the root harness/policy; the per-run READ tools (closed over
 * ref + scoped-token Octokit) are injected per-call via `session.prompt(_, {
 * tools })`, so the security spine is unchanged. `ctx.payload`→`input`,
 * `ctx.init(agent)`→the supplied `harness`, `ctx.id`→`harness.name`.
 *
 * TESTABILITY: the inline `run` defers to `runIssueTriage(ctx, deps)` with an
 * injectable `deps` seam (token minter, octokit factory, context fetcher, agent
 * runner, applier). The default deps wire the real implementations; tests pass
 * fakes so the whole flow runs with NO live model and NO live GitHub.
 */
import { defineWorkflow, type FlueHarness, type FlueLogger, type JsonValue } from "@flue/runtime";
import * as v from "valibot";
import { Octokit } from "octokit";
import { triageAgent } from "../agent-lib/triage.ts";
import { githubReadTools } from "../tools/github-read.ts";
import { runPhasePrompt } from "../agent-lib/record-execution.ts";
import {
  parseTriageClassification,
  classificationToLabels,
  extractTriageComment,
  type TriageClassification,
} from "../agent-lib/triage-classification.ts";
import {
  GITHUB_PERMISSION_PROFILES,
  type GitAccessProfile,
} from "../engine/profiles.ts";
import { configureGitAuth } from "../engine/git-auth.ts";
import { loadConfig } from "../config.ts";
import {
  renderTriagePrompt,
  type TriagePromptContext,
} from "../agent-lib/triage-prompt.ts";
import {
  applyTriageDeterministically,
  type IssueRef,
  type TriageApplied,
} from "../triage-post.ts";

/** The workflow input payload (identifies the issue + trigger). */
export const IssueTriageInputSchema = v.object({
  owner: v.string(),
  repo: v.string(),
  issueNumber: v.pipe(v.number(), v.integer(), v.minValue(1)),
  /** Optional trigger provenance: "webhook" | "cron" | "cli". */
  triggerType: v.optional(v.string()),
  /** App run id for stats correlation; falls back to `harness.name` when absent. */
  runId: v.optional(v.string()),
});
export type IssueTriageInput = v.InferOutput<typeof IssueTriageInputSchema>;

/**
 * The action context surface the testable core needs: the supplied `harness`
 * (already initialized from the bound `triageAgent`), the validated `input`, and
 * the run-stream `log`. Mirrors Flue's `ActionContext` so the inline `run` passes
 * straight through.
 */
export interface TriageRunCtx {
  harness: FlueHarness;
  input: IssueTriageInput;
  log: FlueLogger;
}

/** The workflow result. */
export interface IssueTriageResult {
  classification: TriageClassification;
  /** Whether the marker was missing → conservative needs-triage fallback. */
  viaFallback: boolean;
  /** The labels actually applied (after create-if-missing / existing-only). */
  labelsApplied: string[];
  commented: boolean;
  commentUrl?: string;
  closed: boolean;
}

/** The `issues-write` profile this workflow always runs under (spec/09 / design). */
export const ISSUE_TRIAGE_PROFILE: GitAccessProfile = "issues-write";

/** Issue context fetched deterministically for the prompt (workflow code, not a tool). */
export interface IssueContext {
  title: string;
  body: string;
  author?: string;
  labels: string[];
  comments: { author?: string; body: string }[];
}

/**
 * Injectable dependencies — the seams that make `run()` testable without a live
 * model or GitHub. The default factory wires the real implementations.
 */
export interface IssueTriageDeps {
  /** Mint an `issues-write` scoped installation token for this repo. */
  mintToken(input: IssueTriageInput): Promise<string>;
  /** Build an Octokit authenticated with the scoped token. */
  makeOctokit(token: string): Octokit;
  /** Fetch the issue context (title/body/labels/comments) over the bound octokit. */
  fetchIssue(octokit: Octokit, ref: IssueRef): Promise<IssueContext>;
  /**
   * Run the triage agent for this issue and return its raw text output. Opens a
   * session on the supplied harness and prompts it, injecting the per-run READ
   * tools so tests can return canned CLASSIFICATION output.
   */
  runTriage(
    ctx: TriageRunCtx,
    ref: IssueRef,
    octokit: Octokit,
    issue: IssueContext,
  ): Promise<string>;
  /** Deterministically apply the classification (labels / comment / close). */
  apply(
    octokit: Octokit,
    ref: IssueRef,
    opts: { labels: string[]; comment?: string; close: boolean },
  ): Promise<TriageApplied>;
}

/** Mint an issues-write token downscoped to the target repo via the ported git-auth. */
async function mintIssuesWriteToken(input: IssueTriageInput): Promise<string> {
  const cfg = loadConfig();
  if (!cfg.githubApp) {
    throw new Error(
      "issue-triage: GitHub App not configured (GITHUB_APP_ID / _PRIVATE_KEY_PATH / _INSTALLATION_ID). Cannot mint an issues-write token.",
    );
  }
  const { token } = await configureGitAuth({
    appId: cfg.githubApp.appId,
    privateKeyPath: cfg.githubApp.privateKeyPath,
    installationId: cfg.githubApp.installationId,
    botName: cfg.botLogin.replace(/\[bot\]$/, ""),
    repositories: [input.repo],
    permissions: GITHUB_PERMISSION_PROFILES[ISSUE_TRIAGE_PROFILE],
  });
  return token;
}

/** Fetch the issue + its comments deterministically (workflow code, not a model tool). */
async function fetchIssueContext(octokit: Octokit, ref: IssueRef): Promise<IssueContext> {
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

/** The real triage run: open a session on the bound harness, prompt with the issue context. */
async function runTriageSession(
  ctx: TriageRunCtx,
  ref: IssueRef,
  octokit: Octokit,
  issue: IssueContext,
): Promise<string> {
  const session = await ctx.harness.session("triage");
  const promptCtx: TriagePromptContext = {
    owner: ref.owner,
    repo: ref.repo,
    issueNumber: ref.issue_number,
    title: issue.title,
    body: issue.body,
    author: issue.author,
    labels: issue.labels,
    comments: issue.comments,
    triggerType: ctx.input.triggerType,
  };
  // Shared phase-prompt seam: records per-phase usage (cost/tokens) into the
  // app-owned `executions` stats table — NON-FATAL + TEST-INERT (record-execution.ts).
  // The per-run READ tools (closed over ref + scoped-token Octokit) are injected
  // for THIS call only — owner/repo/token are never model-selectable.
  const res = await runPhasePrompt(
    session,
    renderTriagePrompt(promptCtx),
    {
      runId: ctx.input.runId ?? ctx.harness.name,
      workflow: 'issue-triage',
      phase: 'triage',
    },
    { tools: githubReadTools(ref, octokit) },
  );
  return res.text;
}

/** Default production dependencies. */
export function defaultDeps(): IssueTriageDeps {
  return {
    mintToken: mintIssuesWriteToken,
    makeOctokit: (token) => new Octokit({ auth: token }),
    fetchIssue: fetchIssueContext,
    runTriage: runTriageSession,
    apply: applyTriageDeterministically,
  };
}

/**
 * The testable core. Drives the full flow over injected dependencies; production
 * uses `defaultDeps()`, tests pass fakes (no live model, no live GitHub).
 */
export async function runIssueTriage(
  ctx: TriageRunCtx,
  deps: IssueTriageDeps = defaultDeps(),
): Promise<IssueTriageResult> {
  const { owner, repo, issueNumber } = ctx.input;
  const ref: IssueRef = { owner, repo, issue_number: issueNumber };

  // 1. Mint the issues-write scoped token + an Octokit bound to it.
  const token = await deps.mintToken(ctx.input);
  const octokit = deps.makeOctokit(token);

  // 2. Fetch the issue context deterministically (workflow code, not a model tool).
  const issue = await deps.fetchIssue(octokit, ref);

  // 3. Run the triage agent (tool-only, read tools bound to ref+token). The agent
  //    reads + searches for duplicates and emits a CLASSIFICATION marker.
  const output = await deps.runTriage(ctx, ref, octokit, issue);

  // 4. Parse the CLASSIFICATION marker (the code↔prompt contract).
  const { classification, viaFallback } = parseTriageClassification(output);
  if (viaFallback) {
    ctx.log.warn(
      "issue-triage: classification via fallback (marker missing/unparseable)",
      { owner, repo, issueNumber },
    );
  }

  // 5. DETERMINISTIC apply (workflow, not the model). Labels mapped from the
  //    classification; the agent's pre-marker text (if any) becomes the comment.
  const labels = classificationToLabels(classification);
  const comment = extractTriageComment(output);
  const applied = await deps.apply(octokit, ref, {
    labels,
    comment: comment || undefined,
    close: classification.close,
  });

  return {
    classification,
    viaFallback,
    labelsApplied: applied.labelsApplied,
    commented: applied.commented,
    commentUrl: applied.commentUrl,
    closed: applied.closed,
  };
}

/**
 * Flue workflow — discovered as the `issue-triage` workflow. The runner owns root
 * harness init from `triageAgent`; the inline `run` defers to the testable core.
 */
export default defineWorkflow({
  agent: triageAgent,
  input: IssueTriageInputSchema,
  async run({ harness, input, log }) {
    // The result is JSON-serializable; cast to JsonValue so Flue snapshots it.
    // The typed `IssueTriageResult` is preserved on the testable core for tests.
    return (await runIssueTriage({ harness, input, log })) as unknown as JsonValue;
  },
});
