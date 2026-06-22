import { describe, it, expect, vi } from "vitest";
import type { FlueContext } from "@flue/runtime";
import type { Octokit } from "octokit";
import { runPrReview, type PrReviewDeps, type PrReviewInput } from "../pr-review.ts";
import type { PostedReview, PrRef } from "../../github-post.ts";
import type {
  ReviewerContainer,
  ReviewerSandboxOps,
} from "../../agent-lib/reviewer-sandbox.ts";
import type { SandboxFactory } from "@flue/runtime";

// A minimal FlueContext stand-in: only `payload` + `log` + `init` are touched by
// runPrReview, and `init` is never called because the reviewer run is injected.
function fakeCtx(payload: PrReviewInput): FlueContext<PrReviewInput> {
  return {
    id: "test-run",
    payload,
    env: {},
    req: undefined,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    init: vi.fn(async () => {
      throw new Error("init must not be called — runReviewer is injected in tests");
    }),
  } as unknown as FlueContext<PrReviewInput>;
}

/**
 * A fake container that records the commands exec'd against it (so we can assert
 * the `git clone --branch <headRef>` and that the token is NEVER logged/exposed in
 * a way the test can see leaked), plus whether `remove()` was called.
 */
function fakeContainer(opts: { cloneExitCode?: number } = {}) {
  const SANDBOX = { __fakeSandbox: true } as unknown as SandboxFactory;
  const execCalls: string[] = [];
  let removed = 0;
  const container: ReviewerContainer = {
    async exec(command) {
      execCalls.push(command);
      return { stdout: "", stderr: "", exitCode: opts.cloneExitCode ?? 0 };
    },
    async remove() {
      removed += 1;
    },
    sandbox: () => SANDBOX,
  };
  return {
    container,
    sandbox: SANDBOX,
    execCalls,
    removedCount: () => removed,
  };
}

/**
 * Build a fully-faked dependency set. `output` is the canned reviewer text;
 * `selfAuthored` decides the self-authored guard; the poster + token minter are
 * spies. `sandbox` controls the Docker-lifecycle fake: 'ok' (clone succeeds),
 * 'clone-fails' (clone exits non-zero → tool-only fallback), or 'create-fails'
 * (createContainer throws → tool-only fallback).
 */
function fakeDeps(opts: {
  output: string;
  selfAuthored: boolean;
  sandbox?: "ok" | "clone-fails" | "create-fails";
  reviewerThrows?: Error;
}) {
  const mode = opts.sandbox ?? "ok";
  const fc =
    mode === "clone-fails" ? fakeContainer({ cloneExitCode: 128 }) : fakeContainer();
  const createContainer = vi.fn(
    async (_opts: { image: string; env: Record<string, string> }) => {
      if (mode === "create-fails") throw new Error("docker daemon not running");
      return fc.container;
    },
  );
  const sandboxOps: ReviewerSandboxOps = { createContainer };

  const mintToken = vi.fn(async () => "ghs_fake_review_write_token");
  const makeOctokit = vi.fn(() => ({}) as unknown as Octokit);
  const botLogin = vi.fn(() => "last-light[bot]");
  const getHeadRef = vi.fn(async () => "feature/cool-branch");
  let sandboxSeen: SandboxFactory | undefined;
  const runReviewer = vi.fn(
    async (
      _ctx: FlueContext<PrReviewInput>,
      _ref: PrRef,
      _octokit: Octokit,
      sandbox: SandboxFactory | undefined,
    ) => {
      sandboxSeen = sandbox;
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
    getHeadRef,
    runReviewer,
    sandboxOps,
    isSelfAuthored,
    post,
  };
  return {
    deps,
    mintToken,
    makeOctokit,
    getHeadRef,
    runReviewer,
    isSelfAuthored,
    post,
    createContainer,
    fakeContainer: fc,
    sandboxSeen: () => sandboxSeen,
  };
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
});

describe("runPrReview — Docker sandbox wiring (mocked Docker, no real container)", () => {
  it("creates a container, clones the PR head ref, builds the reviewer WITH the sandbox, then tears the container down", async () => {
    const t = fakeDeps({ output: "VERDICT: APPROVED\n\nLGTM.", selfAuthored: false });
    const res = await runPrReview(fakeCtx(INPUT), t.deps);

    // Container was created with the node+git image and the token baked as env.
    expect(t.createContainer).toHaveBeenCalledTimes(1);
    const createArg = t.createContainer.mock.calls[0]![0];
    expect(createArg.image).toBe("node:22-bookworm");
    expect(createArg.env.GIT_TOKEN).toBe("ghs_fake_review_write_token");

    // The clone used `git clone ... --branch <headRef> ... /workspace`.
    const cloneCmd = t.fakeContainer.execCalls.find((c) => c.includes("git clone"));
    expect(cloneCmd).toBeDefined();
    expect(cloneCmd).toContain("git clone");
    expect(cloneCmd).toContain("--branch 'feature/cool-branch'");
    expect(cloneCmd).toContain("/workspace");

    // The reviewer was built WITH the sandbox (additive path).
    expect(t.sandboxSeen()).toBe(t.fakeContainer.sandbox);
    expect(res.usedSandbox).toBe(true);

    // Teardown ALWAYS happened.
    expect(t.fakeContainer.removedCount()).toBe(1);
    expect(res.verdict).toBe("APPROVED");
  });

  it("does NOT log the scoped token (no leak in the clone command or warnings)", async () => {
    const ctx = fakeCtx(INPUT);
    const t = fakeDeps({ output: "VERDICT: APPROVED\n\nLGTM.", selfAuthored: false });
    await runPrReview(ctx, t.deps);

    // The token is embedded in the tokenized clone URL (so git auth works) but must
    // never reach a log. Assert no log call carries the raw token.
    const TOKEN = "ghs_fake_review_write_token";
    const warnCalls = (ctx.log.warn as ReturnType<typeof vi.fn>).mock.calls;
    const infoCalls = (ctx.log.info as ReturnType<typeof vi.fn>).mock.calls;
    for (const call of [...warnCalls, ...infoCalls]) {
      expect(JSON.stringify(call)).not.toContain(TOKEN);
    }
  });

  it("clone failure → falls back to tool-only, logs a warning (token-free), still tears down + reviews", async () => {
    const ctx = fakeCtx(INPUT);
    const t = fakeDeps({
      output: "VERDICT: APPROVED\n\nLGTM.",
      selfAuthored: false,
      sandbox: "clone-fails",
    });
    const res = await runPrReview(ctx, t.deps);

    expect(t.sandboxSeen()).toBeUndefined(); // tool-only
    expect(res.usedSandbox).toBe(false);
    expect(t.fakeContainer.removedCount()).toBe(1); // still torn down
    expect(ctx.log.warn).toHaveBeenCalled();
    const TOKEN = "ghs_fake_review_write_token";
    for (const call of (ctx.log.warn as ReturnType<typeof vi.fn>).mock.calls) {
      expect(JSON.stringify(call)).not.toContain(TOKEN);
    }
    expect(res.verdict).toBe("APPROVED"); // review still produced
  });

  it("container creation failure → tool-only fallback, no teardown needed, run still succeeds", async () => {
    const ctx = fakeCtx(INPUT);
    const t = fakeDeps({
      output: "VERDICT: REQUEST_CHANGES\n\nFix it.",
      selfAuthored: false,
      sandbox: "create-fails",
    });
    const res = await runPrReview(ctx, t.deps);

    expect(t.sandboxSeen()).toBeUndefined();
    expect(res.usedSandbox).toBe(false);
    expect(t.fakeContainer.removedCount()).toBe(0); // never created → nothing to remove
    expect(ctx.log.warn).toHaveBeenCalled();
    expect(res.verdict).toBe("REQUEST_CHANGES");
  });

  it("teardown is in finally — the container is removed even when the reviewer run THROWS mid-review", async () => {
    const boom = new Error("model exploded mid-review");
    const t = fakeDeps({
      output: "unused",
      selfAuthored: false,
      reviewerThrows: boom,
    });
    await expect(runPrReview(fakeCtx(INPUT), t.deps)).rejects.toThrow(
      "model exploded mid-review",
    );
    // The container was created (clone ok) then the body threw → finally still removes.
    expect(t.createContainer).toHaveBeenCalledTimes(1);
    expect(t.fakeContainer.removedCount()).toBe(1);
  });
});
