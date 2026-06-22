/**
 * `repo-health` workflow — a Phase 5 single-phase, REPO-SCOPED workflow.
 *
 * Discoverable as `src/workflows/repo-health.ts` (filename = workflow name), invoked via
 *   `flue run repo-health --payload '{"owner":..,"repo":..,"triggerType":"cron"}'`
 * and (a LATER slice) by the weekly `cron-health` schedule (reference cron-health.yaml:
 * `0 9 * * 1`). There is NO specific issue/PR — this is a scan of the whole repo.
 *
 * Control flow (design/phase-5-workflows-chat.md → "Single-phase workflows" +
 * ~/work/lastlight/workflows/repo-health.yaml — kind: health, skill: repo-health,
 * model: {{models.health}}):
 *   1. Mint a scoped GitHub App token downscoped to this repo (see PROFILE note below).
 *   2. Fetch the repo metadata (default branch / description / topics) DETERMINISTICALLY
 *      over the bound octokit — this is workflow code, not a model tool. It's the small
 *      bit of untrusted repo-authored text the report summarizes.
 *   3. Build the health agent (read tools bound to ref+token, `repo-health` skill,
 *      persona, health model/thinkingLevel, NO sandbox). init → session.prompt — the
 *      agent gathers its own metrics via the bound `github_*` read tools and composes the
 *      report; the repo metadata snapshot is wrapped (wrapUntrusted).
 *   4. The agent produces the report markdown. The WORKFLOW delivers it DETERMINISTICALLY
 *      over the scoped token (deliverHealthReport) into an IDEMPOTENT per-repo tracking
 *      issue — find the existing open tracking issue by marker → UPDATE it; else create
 *      one. So the weekly cron (or a crash re-invoke) never piles up duplicate issues.
 *
 * PROFILE — a documented deviation from the reference (see src/repo-health-post.ts):
 * the reference repo-health runs READ-only and surfaces the report via the Slack
 * delivery channel / CLI stdout (no GitHub write). The messaging-channel sink is Phase 6
 * here (not built yet), so this slice delivers via the one durable, deterministic,
 * idempotent surface available now — a GitHub tracking issue — which needs `issues-write`
 * (same profile as triage/answer/issue-comment). The Slack/channel delivery lands behind
 * the same `deliver` seam with Phase 6 channels (TODO(phase-6/channels)).
 *
 * NO SANDBOX: tool-only (gathers metrics via bound read tools; no code inspected).
 *
 * Beta.2 form: `export async function run(ctx)` (no `defineWorkflow` — flue-ref §0).
 *
 * TESTABILITY: `run` defers to `runRepoHealth(ctx, deps)` with an injectable `deps` seam
 * (token minter, octokit factory, repo-metadata fetcher, agent runner, deliverer). The
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
import { createHealthAgent } from "../agent-lib/repo-health.ts";
import {
  renderHealthPrompt,
  type HealthPromptContext,
} from "../agent-lib/repo-health-prompt.ts";
import {
  deliverHealthReport,
  type DeliveredHealthReport,
} from "../repo-health-post.ts";
import type { RepoRef } from "../tools/github-read.ts";

/** The workflow input payload (identifies the repo to scan — no issue/PR). */
export interface RepoHealthInput {
  owner: string;
  repo: string;
  /** Optional trigger provenance: "cron" | "cli" (no webhook — repo-scoped). */
  triggerType?: string;
}

/** The workflow result. */
export interface RepoHealthResult {
  /** Whether a report was delivered (false → the agent produced an empty report). */
  delivered: boolean;
  /** The tracking issue number the report landed in. */
  issueNumber?: number;
  /** The tracking issue URL. */
  issueUrl?: string;
  /** True when an EXISTING tracking issue was updated (idempotency — no duplicate). */
  updated: boolean;
  /** Whether the `repo-health` label was applied. */
  labelled: boolean;
}

/**
 * The profile this workflow runs under. See the module + poster docs: the reference is
 * read-only (Slack/CLI delivery), but this slice delivers to a tracking issue, so it
 * mints `issues-write` (contents:read, issues:write, pull_requests:read).
 */
export const REPO_HEALTH_PROFILE: GitAccessProfile = "issues-write";

/** Repo metadata fetched deterministically for the prompt (workflow code, not a tool). */
export interface RepoMeta {
  defaultBranch?: string;
  description?: string;
  topics: string[];
}

/**
 * Injectable dependencies — the seams that make `run()` testable without a live model or
 * GitHub. The default factory wires the real implementations.
 */
export interface RepoHealthDeps {
  /** Mint an `issues-write` scoped installation token for this repo. */
  mintToken(input: RepoHealthInput): Promise<string>;
  /** Build an Octokit authenticated with the scoped token. */
  makeOctokit(token: string): Octokit;
  /** Fetch the repo metadata (default branch / description / topics) over the octokit. */
  fetchRepoMeta(octokit: Octokit, ref: RepoRef): Promise<RepoMeta>;
  /**
   * Run the health agent and return its raw report text. Wraps agent-init +
   * session.prompt so tests can return a canned report.
   */
  runHealthAgent(
    ctx: FlueContext<RepoHealthInput>,
    ref: RepoRef,
    octokit: Octokit,
    meta: RepoMeta,
  ): Promise<string>;
  /** Deterministically deliver the report to the idempotent tracking issue. */
  deliver(
    octokit: Octokit,
    ref: RepoRef,
    report: string,
    opts: { botLogin: string },
  ): Promise<DeliveredHealthReport>;
  /** The bot's own login (for the tracking-issue author check / idempotency). */
  botLogin: string;
}

/** Mint an issues-write token downscoped to the target repo via the ported git-auth. */
async function mintIssuesWriteToken(input: RepoHealthInput): Promise<string> {
  const cfg = loadConfig();
  if (!cfg.githubApp) {
    throw new Error(
      "repo-health: GitHub App not configured (GITHUB_APP_ID / _PRIVATE_KEY_PATH / _INSTALLATION_ID). Cannot mint an issues-write token.",
    );
  }
  const { token } = await configureGitAuth({
    appId: cfg.githubApp.appId,
    privateKeyPath: cfg.githubApp.privateKeyPath,
    installationId: cfg.githubApp.installationId,
    botName: cfg.botLogin.replace(/\[bot\]$/, ""),
    repositories: [input.repo],
    permissions: GITHUB_PERMISSION_PROFILES[REPO_HEALTH_PROFILE],
  });
  return token;
}

/** Fetch the repo metadata deterministically (workflow code, not a model tool). */
async function fetchRepoMeta(octokit: Octokit, ref: RepoRef): Promise<RepoMeta> {
  const { data } = await octokit.rest.repos.get({
    owner: ref.owner,
    repo: ref.repo,
  });
  return {
    defaultBranch: data.default_branch,
    description: data.description ?? undefined,
    topics: data.topics ?? [],
  };
}

/** The real run: init the agent, open a session, prompt with the repo context. */
async function runHealthSession(
  ctx: FlueContext<RepoHealthInput>,
  ref: RepoRef,
  octokit: Octokit,
  meta: RepoMeta,
): Promise<string> {
  const agent = createHealthAgent(ref, octokit);
  const harness = await ctx.init(agent);
  const session = await harness.session("repo-health");
  const promptCtx: HealthPromptContext = {
    owner: ref.owner,
    repo: ref.repo,
    defaultBranch: meta.defaultBranch,
    description: meta.description,
    topics: meta.topics,
    triggerType: ctx.payload.triggerType,
  };
  const res = await session.prompt(renderHealthPrompt(promptCtx));
  return res.text;
}

/** Default production dependencies. */
export function defaultDeps(): RepoHealthDeps {
  return {
    mintToken: mintIssuesWriteToken,
    makeOctokit: (token) => new Octokit({ auth: token }),
    fetchRepoMeta,
    runHealthAgent: runHealthSession,
    deliver: deliverHealthReport,
    botLogin: loadConfig().botLogin,
  };
}

/**
 * The testable core. Drives the full flow over injected dependencies; production uses
 * `defaultDeps()`, tests pass fakes (no live model, no live GitHub).
 */
export async function runRepoHealth(
  ctx: FlueContext<RepoHealthInput>,
  deps: RepoHealthDeps = defaultDeps(),
): Promise<RepoHealthResult> {
  const { owner, repo } = ctx.payload;
  const ref: RepoRef = { owner, repo };

  // 1. Mint the issues-write scoped token + an Octokit bound to it.
  const token = await deps.mintToken(ctx.payload);
  const octokit = deps.makeOctokit(token);

  // 2. Fetch the repo metadata deterministically (workflow code, not a model tool).
  const meta = await deps.fetchRepoMeta(octokit, ref);

  // 3. Run the health agent (tool-only, read tools bound to ref+token). The agent
  //    gathers metrics via the bound github_* tools and composes the report markdown.
  const report = await deps.runHealthAgent(ctx, ref, octokit, meta);

  // 4. DETERMINISTIC delivery (workflow, not the model) to the IDEMPOTENT per-repo
  //    tracking issue — update the existing one rather than opening a duplicate each
  //    run (weekly cron / crash re-invoke safe).
  const delivered = await deps.deliver(octokit, ref, report, { botLogin: deps.botLogin });
  if (!delivered.delivered) {
    ctx.log.warn("repo-health: agent produced an empty report — nothing delivered", {
      owner,
      repo,
    });
  } else {
    ctx.log.info("repo-health: report delivered", {
      owner,
      repo,
      issueNumber: delivered.issueNumber,
      updated: delivered.updated,
    });
  }

  return {
    delivered: delivered.delivered,
    issueNumber: delivered.issueNumber,
    issueUrl: delivered.html_url,
    updated: delivered.updated,
    labelled: delivered.labelled,
  };
}

/** Flue workflow entry — discovered as the `repo-health` workflow. */
export async function run(ctx: FlueContext<RepoHealthInput>): Promise<RepoHealthResult> {
  return runRepoHealth(ctx);
}
