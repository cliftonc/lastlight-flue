/**
 * ⚠️ GATED LIVE INTEGRATION TEST — DOES NOT RUN BY DEFAULT. ⚠️
 *
 * This is the ONLY test in the suite that would post to a REAL GitHub PR. It is
 * skipped unless `PR_REVIEW_LIVE=1` is set in the environment, which is NOT set in
 * CI or by `pnpm test`. The live acceptance (a real review/comment on the
 * authorized throwaway PR `cliftonc/drizzle-cube#941`) is performed deliberately by
 * the MAIN BUILD LOOP with the user watching — NOT by a build subagent and NOT by
 * `pnpm test`. See PROGRESS.md "Phase 3 live-acceptance directive".
 *
 * DO NOT set PR_REVIEW_LIVE. DO NOT run this test as part of an automated slice.
 *
 * What it does WHEN deliberately enabled:
 *   1. mint a `review-write` scoped token (real GitHub App, via secrets/.env),
 *   2. run the real reviewer model against PR #941,
 *   3. DETERMINISTICALLY POST a real review (or COMMENT fallback) to PR #941.
 *
 * Preconditions (also enforced by the workflow): the App in secrets/.env must be
 * installed on `cliftonc/drizzle-cube`; otherwise token minting fails → it throws.
 */
import { describe, it, expect } from "vitest";
import { runPrReview, type PrReviewInput, type PrReviewRunCtx } from "../src/workflows/pr-review.ts";

const LIVE = process.env.PR_REVIEW_LIVE === "1";

// Authorized throwaway target — see PROGRESS.md / memory `pr-review-live-target`.
const TARGET: PrReviewInput = {
  owner: "cliftonc",
  repo: "drizzle-cube",
  prNumber: 941,
  triggerType: "cli",
};

describe.skipIf(!LIVE)("pr-review LIVE (gated on PR_REVIEW_LIVE=1 — posts to a real PR)", () => {
  it(
    "mints a review-write token, runs the reviewer, and posts a real review to the authorized PR",
    async () => {
      // NOTE: this requires a running Flue runtime context (init/session). When the
      // main loop runs this for real, it does so via `flue run pr-review` (which
      // supplies a real FlueContext), not via this bare-call harness. This bare call
      // is a placeholder that documents the contract; the canonical live path is the
      // CLI invocation. Left throwing-by-default-skipped so it never runs silently.
      const ctx = {
        input: TARGET,
        log: { info: console.log, warn: console.warn, error: console.error },
        harness: {
          name: "default",
          async session() {
            throw new Error(
              "Live pr-review must run under a real Flue runtime (flue run pr-review), which supplies the harness/session.",
            );
          },
        },
      } as unknown as PrReviewRunCtx;

      const res = await runPrReview(ctx);
      expect(["APPROVE", "REQUEST_CHANGES", "COMMENT"]).toContain(res.event);
      expect(res.posted).toBe(true);
    },
    300_000,
  );
});
