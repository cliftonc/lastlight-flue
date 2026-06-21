/**
 * Deterministic PR-review posting — APPLICATION code, never a model tool.
 *
 * Phase 3 design decision (design/phase-3-pr-review.md → "WHO posts the review"):
 * the reviewer AGENT's job ends at emitting a `VERDICT:` marker + a review body.
 * The WORKFLOW (this module) posts the review deterministically over the scoped
 * `review-write` token. Rationale: Flue's security rule — "a tool's parameters are
 * model-selected inputs, not an authorization boundary" — so the side effect is
 * kept out of the model's surface entirely. The owner/repo/PR/token are closed
 * over here, never model-chosen.
 *
 * GitHub forbids a user/app FORMALLY reviewing its OWN pull request (a 422). So
 * when the PR author is the bot, we fall back to posting an issue COMMENT instead
 * of a formal review — matching the reference's COMMENT fallback. The decision of
 * WHICH path runs is `mapVerdictToEvent` + `selfAuthored`, both deterministic.
 */
import type { Octokit } from "octokit";
import type { ReviewerVerdict } from "./engine/verdict.ts";
import type { RepoRef } from "./tools/github-read.ts";

/** A PR reference: a repo ref plus the pull number under review. */
export interface PrRef extends RepoRef {
  pull_number: number;
}

/** A formal GitHub review event. (`COMMENT` is the self-authored fallback.) */
export type ReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

/**
 * Map a parsed reviewer verdict to a formal GitHub review event.
 *
 *   APPROVED         → APPROVE
 *   REQUEST_CHANGES  → REQUEST_CHANGES
 *   (PR authored by the bot) → COMMENT, regardless of verdict
 *
 * `selfAuthored` is the self-review guard: GitHub rejects an APPROVE/REQUEST_CHANGES
 * on your own PR, so a bot-authored PR always downgrades to COMMENT. This is a pure
 * function — the same inputs always yield the same event.
 */
export function mapVerdictToEvent(
  verdict: ReviewerVerdict,
  opts: { selfAuthored: boolean },
): ReviewEvent {
  if (opts.selfAuthored) return "COMMENT";
  return verdict === "APPROVED" ? "APPROVE" : "REQUEST_CHANGES";
}

/**
 * Strip the `VERDICT:` marker line from the agent output, leaving the human-facing
 * review body. The marker is the code↔prompt contract (parseReviewerVerdict); it is
 * not meant for the PR reader, so we remove exactly the first matching marker line
 * and post the rest (trimmed). Everything else — including any prose that merely
 * mentions "approved" — is preserved verbatim. (design Q3.3.)
 */
export function extractReviewBody(output: string): string {
  const lines = output.split(/\r?\n/);
  const markerIdx = lines.findIndex((l) =>
    /^\s*VERDICT:\s*(APPROVED|REQUEST_CHANGES)\s*$/i.test(l),
  );
  if (markerIdx >= 0) lines.splice(markerIdx, 1);
  return lines.join("\n").trim();
}

/**
 * Decide whether the PR is authored by the bot itself. Used to pick the COMMENT
 * fallback path. `botLogin` defaults to the App's `…[bot]` identity; a GitHub App
 * authors PRs/comments as `<app-slug>[bot]` regardless of how the agent identified
 * itself, so a login compare is the right discriminator (matches the reference's
 * `getLatestBotReview` botLogin default).
 *
 * The PR author is fetched over the SAME scoped token (closed over in `octokit`) —
 * never a model input.
 */
export async function selfAuthored(
  octokit: Octokit,
  ref: PrRef,
  botLogin: string,
): Promise<boolean> {
  const { data } = await octokit.rest.pulls.get({
    owner: ref.owner,
    repo: ref.repo,
    pull_number: ref.pull_number,
  });
  return data.user?.login === botLogin;
}

/** Result of a deterministic post: the kind of object created + its URL. */
export interface PostedReview {
  kind: "review" | "comment";
  id: number;
  html_url: string;
  /** The review `state` (e.g. "APPROVED"/"CHANGES_REQUESTED"/"COMMENTED"); absent for comment fallback. */
  state?: string;
}

/**
 * Deterministically post the review.
 *
 * - `event` ∈ {APPROVE, REQUEST_CHANGES}  → a FORMAL `pulls.createReview`.
 * - `event` === COMMENT, on a NON-self-authored PR → a formal COMMENT review.
 * - `event` === COMMENT, on a SELF-authored PR → an ISSUE COMMENT
 *   (`issues.createComment`), because GitHub forbids reviewing your own PR.
 *
 * The `octokit` here is authenticated with the `review-write` scoped token; the
 * owner/repo/pull_number come from the bound `ref`, NEVER from the model. The
 * `body` is the agent's review text (marker already stripped by the caller).
 */
export async function postReviewDeterministically(
  octokit: Octokit,
  ref: PrRef,
  event: ReviewEvent,
  body: string,
  opts: { selfAuthored: boolean },
): Promise<PostedReview> {
  // A bot reviewing its own PR is rejected by GitHub even for COMMENT events on
  // some configurations; the safe, reference-matching path is an issue comment.
  if (opts.selfAuthored) {
    const { data } = await octokit.rest.issues.createComment({
      owner: ref.owner,
      repo: ref.repo,
      issue_number: ref.pull_number, // PRs are issues for the comments API
      body,
    });
    return { kind: "comment", id: data.id, html_url: data.html_url };
  }

  const { data } = await octokit.rest.pulls.createReview({
    owner: ref.owner,
    repo: ref.repo,
    pull_number: ref.pull_number,
    event,
    body,
  });
  return { kind: "review", id: data.id, html_url: data.html_url ?? "", state: data.state };
}
