/**
 * `pr-review` workflow — the Phase 3 vertical slice.
 *
 * Discoverable as `src/workflows/pr-review.ts` (filename = workflow name), invoked
 * via `flue run pr-review --payload '{"owner":..,"repo":..,"prNumber":..}'`.
 *
 * Control flow (design/phase-3-pr-review.md):
 *   1. Mint a `review-write` scoped GitHub App token (downscoped to this repo).
 *   2. Build the reviewer agent (read tools bound to the ref+token, pr-review skill,
 *      persona, review model/thinkingLevel). init → session.prompt(review request).
 *   3. parseReviewerVerdict(agent output) — the `VERDICT:` marker contract.
 *   4. The WORKFLOW posts the review DETERMINISTICALLY (not the model): a formal
 *      review whose event maps from the verdict, with the bot's-own-PR → COMMENT
 *      fallback (GitHub forbids reviewing your own PR).
 *
 * Slice scope: single phase, no loop, no gate, no run-record/resume (that's Phase 4).
 * SANDBOX DEFERRED — the reviewer is tool-only this slice (see agents/reviewer.ts).
 *
 * Beta.2 form: `export async function run(ctx)` — there is NO `defineWorkflow` /
 * object form in @flue/runtime 1.0.0-beta.2 (spec/flue-reference.md §0).
 *
 * TESTABILITY: `run` defers to `runPrReview(ctx, deps)` with an injectable `deps`
 * seam (token minter, octokit factory, reviewer prompt runner, poster, config).
 * The default deps wire the real implementations; tests pass fakes so the whole
 * flow runs with NO live model and NO live GitHub.
 */
import type { FlueContext } from "@flue/runtime";
import { Octokit } from "octokit";
import { parseReviewerVerdict, type ReviewerVerdict } from "../engine/verdict.ts";
import {
  GITHUB_PERMISSION_PROFILES,
  type GitAccessProfile,
} from "../engine/profiles.ts";
import { configureGitAuth } from "../engine/git-auth.ts";
import { loadConfig } from "../config.ts";
import { createReviewerAgent } from "../agents/reviewer.ts";
import { renderReviewPrompt } from "./pr-review-prompt.ts";
import {
  mapVerdictToEvent,
  extractReviewBody,
  selfAuthored as selfAuthoredImpl,
  postReviewDeterministically,
  type PrRef,
  type PostedReview,
} from "../github-post.ts";

/** The workflow input payload (validated shape; identifies the PR + trigger). */
export interface PrReviewInput {
  owner: string;
  repo: string;
  prNumber: number;
  /** Optional trigger provenance: "webhook" | "cron" | "cli". */
  triggerType?: string;
}

/** The workflow result. */
export interface PrReviewResult {
  verdict: ReviewerVerdict;
  /** Whether the marker was missing and the verdict came from the fragile fallback. */
  viaFallback: boolean;
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
  selfAuthored: boolean;
  posted: boolean;
  reviewUrl?: string;
  postKind?: "review" | "comment";
}

/** The `review-write` profile this workflow always runs under (spec/09 / design). */
export const PR_REVIEW_PROFILE: GitAccessProfile = "review-write";

/**
 * Injectable dependencies — the seams that make `run()` testable without a live
 * model or GitHub. The default factory wires the real implementations.
 */
export interface PrReviewDeps {
  /** Mint a `review-write` scoped installation token for this repo. */
  mintToken(input: PrReviewInput): Promise<string>;
  /** Build an Octokit authenticated with the scoped token. */
  makeOctokit(token: string): Octokit;
  /** Resolve the bot login used for the self-authored guard. */
  botLogin(): string;
  /**
   * Run the reviewer agent for this PR and return its raw text output. Wraps
   * agent-init + session.prompt so tests can return a canned VERDICT output.
   */
  runReviewer(
    ctx: FlueContext<PrReviewInput>,
    ref: PrRef,
    octokit: Octokit,
  ): Promise<string>;
  /** Determine whether the PR is bot-authored (COMMENT-fallback decision). */
  isSelfAuthored(octokit: Octokit, ref: PrRef, botLogin: string): Promise<boolean>;
  /** Deterministically post the review (formal review or issue-comment fallback). */
  post(
    octokit: Octokit,
    ref: PrRef,
    event: PrReviewResult["event"],
    body: string,
    opts: { selfAuthored: boolean },
  ): Promise<PostedReview>;
}

/** Mint a review-write token downscoped to the target repo via the ported git-auth. */
async function mintReviewWriteToken(input: PrReviewInput): Promise<string> {
  const cfg = loadConfig();
  if (!cfg.githubApp) {
    throw new Error(
      "pr-review: GitHub App not configured (GITHUB_APP_ID / _PRIVATE_KEY_PATH / _INSTALLATION_ID). Cannot mint a review-write token.",
    );
  }
  const { token } = await configureGitAuth({
    appId: cfg.githubApp.appId,
    privateKeyPath: cfg.githubApp.privateKeyPath,
    installationId: cfg.githubApp.installationId,
    botName: cfg.botLogin.replace(/\[bot\]$/, ""),
    repositories: [input.repo],
    permissions: GITHUB_PERMISSION_PROFILES[PR_REVIEW_PROFILE],
  });
  return token;
}

/** The real reviewer run: init the agent, open a session, prompt with the request. */
async function runReviewerSession(
  ctx: FlueContext<PrReviewInput>,
  ref: PrRef,
  octokit: Octokit,
): Promise<string> {
  const agent = createReviewerAgent(ref, octokit);
  const harness = await ctx.init(agent);
  const session = await harness.session();
  const res = await session.prompt(
    renderReviewPrompt({
      owner: ref.owner,
      repo: ref.repo,
      prNumber: ref.pull_number,
      triggerType: ctx.payload.triggerType,
    }),
  );
  return res.text;
}

/** Default production dependencies. */
export function defaultDeps(): PrReviewDeps {
  return {
    mintToken: mintReviewWriteToken,
    makeOctokit: (token) => new Octokit({ auth: token }),
    botLogin: () => loadConfig().botLogin,
    runReviewer: runReviewerSession,
    isSelfAuthored: selfAuthoredImpl,
    post: postReviewDeterministically,
  };
}

/**
 * The testable core. Drives the full flow over injected dependencies; production
 * uses `defaultDeps()`, tests pass fakes (no live model, no live GitHub).
 */
export async function runPrReview(
  ctx: FlueContext<PrReviewInput>,
  deps: PrReviewDeps = defaultDeps(),
): Promise<PrReviewResult> {
  const { owner, repo, prNumber } = ctx.payload;
  const ref: PrRef = { owner, repo, pull_number: prNumber };

  // 1. Mint the review-write scoped token + an Octokit bound to it.
  const token = await deps.mintToken(ctx.payload);
  const octokit = deps.makeOctokit(token);

  // 2. Self-review guard (defense in depth; decides the COMMENT fallback).
  const botLogin = deps.botLogin();
  const isSelf = await deps.isSelfAuthored(octokit, ref, botLogin);

  // 3. Reviewer session → raw agent output.
  const output = await deps.runReviewer(ctx, ref, octokit);

  // 4. Parse the VERDICT marker (the code↔prompt contract).
  const { verdict, viaFallback } = parseReviewerVerdict(output);
  if (viaFallback) {
    ctx.log.warn("pr-review: verdict via fallback heuristic (no VERDICT marker)", {
      owner,
      repo,
      prNumber,
    });
  }

  // 5. DETERMINISTIC post (workflow, not the model).
  const event = mapVerdictToEvent(verdict, { selfAuthored: isSelf });
  const body = extractReviewBody(output);
  const posted = await deps.post(octokit, ref, event, body, { selfAuthored: isSelf });

  return {
    verdict,
    viaFallback,
    event,
    selfAuthored: isSelf,
    posted: true,
    reviewUrl: posted.html_url || undefined,
    postKind: posted.kind,
  };
}

/** Flue workflow entry — discovered as the `pr-review` workflow. */
export async function run(ctx: FlueContext<PrReviewInput>): Promise<PrReviewResult> {
  return runPrReview(ctx);
}
