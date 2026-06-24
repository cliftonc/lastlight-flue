import { describe, it, expect, vi } from "vitest";
import type { FlueHarness } from "@flue/runtime";
import type { Octokit } from "octokit";
import {
  runPrReview,
  type PrReviewDeps,
  type PrReviewInput,
  type PrReviewRunCtx,
} from "../pr-review.ts";
import type { PostedReview, PrRef } from "../../github-post.ts";

// beta.3 — pr-review is TOOL-ONLY this slice (the beta.2 additive Docker checkout was
// dropped — see the workflow header + reviewer.ts TODO(phase-F/sandbox)). The reviewer
// runs over the bound READ tools + the PR diff; the workflow does the deterministic post.

// A minimal RunCtx stand-in: only `input` + `log` are touched by runPrReview, and the
// harness `session()` is never reached because the reviewer run is injected.
function fakeCtx(payload: PrReviewInput): PrReviewRunCtx {
  return {
    input: payload,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    harness: {
      name: "default",
      async session() {
        throw new Error("session must not be called — runReviewer is injected in tests");
      },
    } as unknown as FlueHarness,
  };
}

/**
 * Build a fully-faked dependency set. `output` is the canned reviewer text;
 * `selfAuthored` decides the self-authored guard; the poster + token minter are spies.
 */
function fakeDeps(opts: {
  output: string;
  selfAuthored: boolean;
  reviewerThrows?: Error;
}) {
  const mintToken = vi.fn(async () => "ghs_fake_review_write_token");
  const makeOctokit = vi.fn(() => ({}) as unknown as Octokit);
  const botLogin = vi.fn(() => "last-light[bot]");
  const runReviewer = vi.fn(
    async (_ctx: PrReviewRunCtx, _ref: PrRef, _octokit: Octokit) => {
      if (opts.reviewerThrows) throw opts.reviewerThrows;
      return opts.output;
    },
  );
  const isSelfAuthored = vi.fn(async () => opts.selfAuthored);
  const post = vi.fn(
    async (
      _octokit: Octokit,
      ref: PrRef,
      event: string,
      _body: string,
      o: { selfAuthored: boolean },
    ): Promise<PostedReview> =>
      o.selfAuthored
        ? { kind: "comment", id: 1, html_url: `https://gh/comment/${ref.pull_number}` }
        : {
            kind: "review",
            id: 2,
            html_url: `https://gh/review/${ref.pull_number}`,
            state: event === "APPROVE" ? "APPROVED" : "CHANGES_REQUESTED",
          },
  );
  const deps: PrReviewDeps = {
    mintToken,
    makeOctokit,
    botLogin,
    runReviewer,
    isSelfAuthored,
    post,
  };
  return { deps, mintToken, makeOctokit, runReviewer, isSelfAuthored, post };
}

const INPUT: PrReviewInput = { owner: "cliftonc", repo: "drizzle-cube", prNumber: 941 };

describe("runPrReview — full flow over injected deps (no live model / GitHub)", () => {
  it("APPROVED verdict on a human PR → mints token, parses verdict, posts an APPROVE review", async () => {
    const { deps, mintToken, post } = fakeDeps({
      output: "VERDICT: APPROVED\n\nClean change, tests pass. Thanks!",
      selfAuthored: false,
    });
    const res = await runPrReview(fakeCtx(INPUT), deps);

    expect(mintToken).toHaveBeenCalledWith(INPUT);
    expect(res.verdict).toBe("APPROVED");
    expect(res.viaFallback).toBe(false);
    expect(res.event).toBe("APPROVE");
    expect(res.selfAuthored).toBe(false);
    expect(res.posted).toBe(true);
    expect(res.postKind).toBe("review");
    // Tool-only this slice — no Docker sandbox.
    expect(res.usedSandbox).toBe(false);

    // The poster received the bound ref + the marker-stripped body + APPROVE.
    expect(post).toHaveBeenCalledWith(
      expect.anything(),
      { owner: "cliftonc", repo: "drizzle-cube", pull_number: 941 },
      "APPROVE",
      "Clean change, tests pass. Thanks!",
      { selfAuthored: false },
    );
  });

  it("REQUEST_CHANGES verdict → posts a REQUEST_CHANGES review", async () => {
    const { deps, post } = fakeDeps({
      output: "VERDICT: REQUEST_CHANGES\n\nNull-deref at a.ts:10.",
      selfAuthored: false,
    });
    const res = await runPrReview(fakeCtx(INPUT), deps);
    expect(res.event).toBe("REQUEST_CHANGES");
    expect(post).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "REQUEST_CHANGES",
      "Null-deref at a.ts:10.",
      { selfAuthored: false },
    );
  });

  it("bot's own PR → COMMENT event + comment-fallback post, even with an APPROVED verdict", async () => {
    const { deps, post } = fakeDeps({
      output: "VERDICT: APPROVED\n\nSelf-review note.",
      selfAuthored: true,
    });
    const res = await runPrReview(fakeCtx(INPUT), deps);
    expect(res.verdict).toBe("APPROVED");
    expect(res.event).toBe("COMMENT");
    expect(res.selfAuthored).toBe(true);
    expect(res.postKind).toBe("comment");
    expect(post).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "COMMENT",
      "Self-review note.",
      { selfAuthored: true },
    );
  });

  it("missing VERDICT marker → viaFallback true, logs a warning, still posts", async () => {
    const ctx = fakeCtx(INPUT);
    const { deps, post } = fakeDeps({
      output: "I think this looks fine but I forgot the marker.",
      selfAuthored: false,
    });
    const res = await runPrReview(ctx, deps);
    expect(res.viaFallback).toBe(true);
    expect(ctx.log.warn).toHaveBeenCalled();
    expect(post).toHaveBeenCalled();
  });

  it("a reviewer run throw surfaces (no post)", async () => {
    const boom = new Error("model exploded mid-review");
    const { deps, post } = fakeDeps({
      output: "unused",
      selfAuthored: false,
      reviewerThrows: boom,
    });
    await expect(runPrReview(fakeCtx(INPUT), deps)).rejects.toThrow(
      "model exploded mid-review",
    );
    expect(post).not.toHaveBeenCalled();
  });

  it("does NOT log the scoped token", async () => {
    const ctx = fakeCtx(INPUT);
    const { deps } = fakeDeps({ output: "VERDICT: APPROVED\n\nLGTM.", selfAuthored: false });
    await runPrReview(ctx, deps);
    const TOKEN = "ghs_fake_review_write_token";
    const warnCalls = (ctx.log.warn as ReturnType<typeof vi.fn>).mock.calls;
    const infoCalls = (ctx.log.info as ReturnType<typeof vi.fn>).mock.calls;
    for (const call of [...warnCalls, ...infoCalls]) {
      expect(JSON.stringify(call)).not.toContain(TOKEN);
    }
  });
});
