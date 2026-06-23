/**
 * `security-review` workflow — a Phase 5 SANDBOXED, REPO-SCOPED security scan.
 *
 * Discoverable as `src/workflows/security-review.ts` (filename = workflow name), invoked
 * via `flue run security-review --payload '{"owner":..,"repo":..,"triggerType":"cron"}'`
 * and (a LATER slice) by the weekly `cron-security` schedule (reference cron-security.yaml:
 * `0 10 * * 1`). There is NO specific issue/PR — this is a scan of the whole repo.
 *
 * SHAPE — `kind: health`, the STRUCTURAL SIBLING of `repo-health` (repo-scoped {owner,repo};
 * agent produces a report; the workflow does the deterministic post), but UNLIKE repo-health
 * it is SANDBOXED: it CLONES the repo and the agent reviews the ACTUAL code. Reference:
 * ~/work/lastlight/workflows/security-review.yaml — `kind: health`, repo-scoped, SANDBOXED;
 * skill: security-review, model: {{models.security}}, variant: {{variants.security}}.
 *
 * Control flow:
 *   1. Mint a scoped GitHub App token (contents:read to CLONE + issues:write to FILE the
 *      summary issue → the `issues-write` profile; see SECURITY_PROFILE).
 *   2. Fetch the repo metadata (default branch / description / topics) DETERMINISTICALLY
 *      over the bound octokit — workflow code, not a model tool (the small bit of untrusted
 *      repo-authored text the prompt wraps).
 *   3. Reuse `withBuildSandbox` (BY IMPORT — shared file, not modified) to CLONE the repo
 *      into `/workspace`. Build the security agent (read tools bound to ref+token,
 *      `security-review` skill, persona, security model/thinkingLevel, sandbox + cwd
 *      /workspace). init → session.prompt — the agent performs the SDLC/diff review over
 *      the checkout and emits the findings REPORT (the summary-issue body). The container
 *      is ALWAYS torn down by `withBuildSandbox`'s `finally` (incl. on throw).
 *   4. The agent emits the report. The WORKFLOW files a NEW dated summary issue
 *      DETERMINISTICALLY over the scoped token (fileSecurityScanIssue) — title
 *      `Security scan — <date>`, labels `["security", "security-scan"]` — inverting the
 *      reference's agent-files-issue into our deterministic-post security spine (same
 *      artifact/format so `security-feedback` can parse it). The agent's `NO_FINDINGS`
 *      sentinel (or an empty body) files NOTHING (the cron is low-noise).
 *
 * PROFILE: `issues-write` (contents:read + issues:write + pull_requests:read + metadata:read)
 * — contents:read is needed to clone the repo into the sandbox, issues:write to file the
 * summary issue. This matches the reference's effective access (clone + create one issue).
 *
 * SCANNER-TOOLING DEVIATION (documented, not a blocker): the reference skill also runs
 * `gitleaks` + `semgrep`. The `node:22-bookworm` sandbox image lacks them AND egress is
 * still DEFERRED (no SSRF floor), so this slice does the LLM SDLC/diff review ONLY;
 * gitleaks/semgrep are a TODO(phase-9/egress + scanner-image) — exactly like repo-health
 * deferred its Slack delivery. We do NOT apt-install scanners.
 *
 * DATED-ISSUE (NOT update-in-place): the reference files a fresh point-in-time snapshot
 * issue EACH run and never edits a prior `security-scan` issue (issue-format §Title). So
 * the poster always CREATES — this is the deliberate difference from repo-health's
 * idempotent tracking issue.
 *
 * Beta.2 form: `export async function run(ctx)` (no `defineWorkflow` — flue-ref §0).
 *
 * TESTABILITY: `run` defers to `runSecurityReview(ctx, deps)` with an injectable `deps`
 * seam (token minter, octokit factory, repo-metadata fetcher, sandboxed agent runner,
 * issue filer). The default deps wire the real implementations (and the real
 * `withBuildSandbox` clone); tests pass fakes so the whole flow runs with NO live model,
 * NO live GitHub, and NO live Docker.
 */
import type { FlueContext } from "@flue/runtime";
import { Octokit } from "octokit";
import {
  GITHUB_PERMISSION_PROFILES,
  type GitAccessProfile,
} from "../engine/profiles.ts";
import { configureGitAuth } from "../engine/git-auth.ts";
import { loadConfig } from "../config.ts";
import { createSecurityAgent } from "../agent-lib/security-review.ts";
import {
  renderSecurityPrompt,
  type SecurityPromptContext,
  SECURITY_NO_FINDINGS,
} from "../agent-lib/security-review-prompt.ts";
import { withBuildSandbox, closeBuildWorkspace, type BuildSandboxOps } from "../agent-lib/build-sandbox.ts";
import {
  fileSecurityScanIssue,
  type FiledSecurityScan,
} from "../security-review-post.ts";
import type { RepoRef } from "../tools/github-read.ts";

/** The workflow input payload (identifies the repo to scan — no issue/PR). */
export interface SecurityReviewInput {
  owner: string;
  repo: string;
  /** Optional trigger provenance: "cron" | "cli" | "webhook" | "slack". */
  triggerType?: string;
}

/** The workflow result. */
export interface SecurityReviewResult {
  /** Whether a summary issue was filed (false → NO_FINDINGS / empty report). */
  filed: boolean;
  /** The summary issue number, when filed. */
  issueNumber?: number;
  /** The summary issue URL, when filed. */
  issueUrl?: string;
  /** Whether the security labels were applied. */
  labelled: boolean;
}

/**
 * The profile this workflow runs under: `issues-write` — contents:read (to CLONE the repo
 * into the sandbox) + issues:write (to FILE the summary issue). Matches the reference's
 * effective access.
 */
export const SECURITY_PROFILE: GitAccessProfile = "issues-write";

/** Repo metadata fetched deterministically for the prompt (workflow code, not a tool). */
export interface RepoMeta {
  defaultBranch?: string;
  description?: string;
  topics: string[];
}

/**
 * Injectable dependencies — the seams that make `run()` testable without a live model,
 * GitHub, or Docker. The default factory wires the real implementations.
 */
export interface SecurityReviewDeps {
  /** Mint an `issues-write` scoped installation token for this repo. */
  mintToken(input: SecurityReviewInput): Promise<string>;
  /** Build an Octokit authenticated with the scoped token. */
  makeOctokit(token: string): Octokit;
  /** Fetch the repo metadata (default branch / description / topics) over the octokit. */
  fetchRepoMeta(octokit: Octokit, ref: RepoRef): Promise<RepoMeta>;
  /**
   * Clone the repo into a sandbox, run the security agent over the checkout, and return
   * its raw report text. Wraps `withBuildSandbox` + agent-init + session.prompt so tests
   * can return a canned report (and assert the clone + ALWAYS-teardown contract).
   */
  runSecurityAgent(
    ctx: FlueContext<SecurityReviewInput>,
    ref: RepoRef,
    octokit: Octokit,
    token: string,
    meta: RepoMeta,
    scanDate: string,
    sandboxOps?: BuildSandboxOps,
  ): Promise<string>;
  /** Deterministically file the dated summary issue (NEW snapshot each run). */
  fileIssue(
    octokit: Octokit,
    ref: RepoRef,
    report: string,
    opts: { dateISO: string },
  ): Promise<FiledSecurityScan>;
  /** Docker ops for the sandbox (injected so tests mock Docker entirely). */
  sandboxOps?: BuildSandboxOps;
}

/** Mint an issues-write token downscoped to the target repo via the ported git-auth. */
async function mintIssuesWriteToken(input: SecurityReviewInput): Promise<string> {
  const cfg = loadConfig();
  if (!cfg.githubApp) {
    throw new Error(
      "security-review: GitHub App not configured (GITHUB_APP_ID / _PRIVATE_KEY_PATH / _INSTALLATION_ID). Cannot mint an issues-write token.",
    );
  }
  const { token } = await configureGitAuth({
    appId: cfg.githubApp.appId,
    privateKeyPath: cfg.githubApp.privateKeyPath,
    installationId: cfg.githubApp.installationId,
    botName: cfg.botLogin.replace(/\[bot\]$/, ""),
    repositories: [input.repo],
    permissions: GITHUB_PERMISSION_PROFILES[SECURITY_PROFILE],
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

/**
 * The real run: CLONE the repo into a sandbox (reusing `withBuildSandbox` by import), init
 * the security agent over the checkout, open a session, prompt with the repo context. The
 * container is ALWAYS torn down by `withBuildSandbox`'s `finally` (incl. on throw). We
 * clone the default branch onto a throwaway scan branch (`checkout -B`) — the scan never
 * commits/pushes, so the branch name is inert.
 */
async function runSecuritySession(
  ctx: FlueContext<SecurityReviewInput>,
  ref: RepoRef,
  octokit: Octokit,
  token: string,
  meta: RepoMeta,
  scanDate: string,
  sandboxOps?: BuildSandboxOps,
): Promise<string> {
  const branch = meta.defaultBranch ?? "main";
  // security-review is SINGLE-phase (one scan, no commit/push), so it does not
  // share its workspace across phases — it creates one container and tears it
  // down right after the scan via `closeBuildWorkspace` in the finally.
  const taskId = `security:${ref.owner}/${ref.repo}:${scanDate}`;
  try {
    return await withBuildSandbox(
      { owner: ref.owner, repo: ref.repo, branch, taskId },
      token,
      async (sandbox) => {
        const agent = createSecurityAgent(ref, octokit, sandbox);
        const harness = await ctx.init(agent);
        const session = await harness.session("security-review");
        const promptCtx: SecurityPromptContext = {
          owner: ref.owner,
          repo: ref.repo,
          defaultBranch: meta.defaultBranch,
          description: meta.description,
          topics: meta.topics,
          triggerType: ctx.payload.triggerType,
          scanDate,
        };
        const res = await session.prompt(renderSecurityPrompt(promptCtx));
        return res.text;
      },
      { ops: sandboxOps, log: ctx.log },
    );
  } finally {
    await closeBuildWorkspace(taskId, ctx.log);
  }
}

/** Default production dependencies. */
export function defaultDeps(): SecurityReviewDeps {
  return {
    mintToken: mintIssuesWriteToken,
    makeOctokit: (token) => new Octokit({ auth: token }),
    fetchRepoMeta,
    runSecurityAgent: (ctx, ref, octokit, token, meta, scanDate, sandboxOps) =>
      runSecuritySession(ctx, ref, octokit, token, meta, scanDate, sandboxOps),
    fileIssue: fileSecurityScanIssue,
  };
}

/** The scan's UTC date stamp (YYYY-MM-DD). Computed INSIDE run() — never at module top-level. */
function scanDateUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * The testable core. Drives the full flow over injected dependencies; production uses
 * `defaultDeps()`, tests pass fakes (no live model, no live GitHub, no live Docker).
 *
 * `scanDate` is injectable so tests pin the issue title deterministically; production
 * stamps it INSIDE run() (never at module top-level — flue inlines the discovered module,
 * so a top-level `Date` would freeze at build time).
 */
export async function runSecurityReview(
  ctx: FlueContext<SecurityReviewInput>,
  deps: SecurityReviewDeps = defaultDeps(),
  scanDate: string = scanDateUTC(),
): Promise<SecurityReviewResult> {
  const { owner, repo } = ctx.payload;
  const ref: RepoRef = { owner, repo };

  // 1. Mint the issues-write scoped token (contents:read to clone + issues:write to file).
  const token = await deps.mintToken(ctx.payload);
  const octokit = deps.makeOctokit(token);

  // 2. Fetch the repo metadata deterministically (workflow code, not a model tool).
  const meta = await deps.fetchRepoMeta(octokit, ref);

  // 3. CLONE into a sandbox + run the security agent over the checkout. The agent reviews
  //    the actual code and emits the findings REPORT (summary-issue body). Container
  //    ALWAYS torn down by withBuildSandbox's finally (incl. on throw).
  const report = await deps.runSecurityAgent(
    ctx,
    ref,
    octokit,
    token,
    meta,
    scanDate,
    deps.sandboxOps,
  );

  // 4. NO_FINDINGS / empty → file NOTHING (the cron is intentionally low-noise).
  const trimmed = (report ?? "").trim();
  if (!trimmed || trimmed === SECURITY_NO_FINDINGS) {
    ctx.log.info("security-review: no findings — no summary issue filed", { owner, repo });
    return { filed: false, labelled: false };
  }

  // DETERMINISTIC filing (workflow, not the model) of a NEW dated snapshot issue.
  const filed = await deps.fileIssue(octokit, ref, trimmed, { dateISO: scanDate });
  if (filed.filed) {
    ctx.log.info("security-review: summary issue filed", {
      owner,
      repo,
      issueNumber: filed.issueNumber,
    });
  }

  return {
    filed: filed.filed,
    issueNumber: filed.issueNumber,
    issueUrl: filed.html_url,
    labelled: filed.labelled,
  };
}

/** Flue workflow entry — discovered as the `security-review` workflow. */
export async function run(
  ctx: FlueContext<SecurityReviewInput>,
): Promise<SecurityReviewResult> {
  return runSecurityReview(ctx);
}
