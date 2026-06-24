import { describe, it, expect, vi } from "vitest";
import type { FlueHarness } from "@flue/runtime";
import type { Octokit } from "octokit";
import { runPrFix, type PrFixDeps, type PrFixInput, type PrFixRunCtx } from "../pr-fix.ts";
import type { PrFixRef, PostedAck } from "../../pr-fix-post.ts";

// Phase 5 / beta.3 — pr-fix run-level tests over FAKES: repo-write token minted, PR
// head ref resolved deterministically, the HARNESS sandbox clones + checks out the PR
// BRANCH (not a new one) via `harness.shell` (the agent's `dockerSandbox()` self-
// terminates — no per-run teardown), the fix is committed + the bound head branch
// PUSHED via the MOCKED seam (no real push), the ack comment posts to the bound PR,
// and the token is never logged. NO live model/git/GitHub/Docker.

const TOKEN = "ghs_prfix_test_token";

/** A fake harness recording shell commands; `cloneFails` makes `git clone` exit non-zero. */
function fakeHarness(opts: { cloneFails?: boolean } = {}) {
  const shellCalls: string[] = [];
  const harness = {
    name: "default",
    async shell(command: string) {
      shellCalls.push(command);
      if (opts.cloneFails && command.includes("git clone")) {
        return { stdout: "", stderr: "boom", exitCode: 128 };
      }
      // `git rev-parse --verify` of the remote head ref → exists (PR branch is real).
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    async session() {
      throw new Error("session must not be called — runFixSession is injected in tests");
    },
    fs: {},
  } as unknown as FlueHarness;
  return { harness, shellCalls };
}

function fakeCtx(
  payload: PrFixInput,
  harnessOpts: { cloneFails?: boolean } = {},
): PrFixRunCtx & { _shellCalls: string[] } {
  const { harness, shellCalls } = fakeHarness(harnessOpts);
  return {
    input: payload,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    harness,
    _shellCalls: shellCalls,
  };
}

interface Recorder {
  pushed: { branch: string }[];
  acked: { ref: PrFixRef; branch: string; sha: string }[];
  minted: PrFixInput[];
  headResolved: PrFixRef[];
  fixSessions: { ref: { owner: string; repo: string }; prompt: string }[];
}

function makeDeps(
  rec: Recorder,
  over: Partial<PrFixDeps> = {},
): PrFixDeps {
  return {
    mintToken: vi.fn(async (input) => {
      rec.minted.push(input);
      return TOKEN;
    }),
    makeOctokit: vi.fn((_token) => ({ __octokit: true }) as unknown as Octokit),
    getPrHead: vi.fn(async (_octokit, ref) => {
      rec.headResolved.push(ref);
      return { headRef: "feature/login", title: "Add login" };
    }),
    runFixSession: vi.fn(async (_ctx, ref, _octokit, prompt) => {
      rec.fixSessions.push({ ref, prompt });
      return "Fixed the handler. tests pass. abc1234";
    }),
    readHeadSha: vi.fn(async (_harness) => "headsha123"),
    pushBranch: vi.fn(async (_harness, branch) => {
      rec.pushed.push({ branch });
    }),
    postAck: vi.fn(async (_octokit, ref, branch, sha): Promise<PostedAck> => {
      rec.acked.push({ ref, branch, sha });
      return { id: 555, html_url: "https://github.com/o/r/pull/77#issuecomment-555" };
    }),
    ...over,
  };
}

function newRecorder(): Recorder {
  return {
    pushed: [],
    acked: [],
    minted: [],
    headResolved: [],
    fixSessions: [],
  };
}

const INPUT: PrFixInput = {
  owner: "octocat",
  repo: "widget",
  prNumber: 77,
  fixRequest: "Rename the handler and add a test.",
  requestedBy: "maintainer-bob",
};

describe("runPrFix — happy path", () => {
  it("mints repo-write, resolves the PR head, fixes, pushes the bound branch, acks", async () => {
    const rec = newRecorder();
    const deps = makeDeps(rec);
    const res = await runPrFix(fakeCtx(INPUT), deps);

    // Token minted with the repo downscoped.
    expect(rec.minted).toEqual([INPUT]);
    // PR head resolved deterministically against the BOUND ref (not model-chosen).
    expect(rec.headResolved).toEqual([
      { owner: "octocat", repo: "widget", pull_number: 77 },
    ]);
    // The fix landed on the PR head branch, which was then PUSHED (mocked seam).
    expect(res.branch).toBe("feature/login");
    expect(rec.pushed).toEqual([{ branch: "feature/login" }]);
    expect(res.sha).toBe("headsha123");
    // Ack comment posted to the BOUND PR ref.
    expect(rec.acked).toEqual([
      {
        ref: { owner: "octocat", repo: "widget", pull_number: 77 },
        branch: "feature/login",
        sha: "headsha123",
      },
    ]);
    expect(res.acked).toBe(true);
    expect(res.ackUrl).toContain("issuecomment-555");
  });

  it("clones the PR head branch into the harness sandbox via git CLI (not a model tool)", async () => {
    const ctx = fakeCtx(INPUT);
    await runPrFix(ctx, makeDeps(newRecorder()));
    const clone = ctx._shellCalls.find((c) => c.includes("git clone"));
    expect(clone).toBeTruthy();
  });

  it("renders the prompt with the UNTRUSTED-wrapped fix request + the resolved branch", async () => {
    const rec = newRecorder();
    await runPrFix(fakeCtx(INPUT), makeDeps(rec));
    const { prompt, ref } = rec.fixSessions[0]!;
    // Read tools bound to the repo ref (owner/repo), never the PR number from a tool.
    expect(ref).toEqual({ owner: "octocat", repo: "widget" });
    expect(prompt).toContain("branch feature/login");
    expect(prompt).toContain("<<<USER_CONTENT_UNTRUSTED");
    expect(prompt).toContain("Rename the handler and add a test.");
    expect(prompt).toContain("Do NOT push");
  });
});

describe("runPrFix — security + teardown", () => {
  it("the push targets the workflow-resolved head ref, NOT anything model-influenced", async () => {
    const rec = newRecorder();
    // Even if the agent text mentions another branch, the push uses the bound ref.
    const deps = makeDeps(rec, {
      runFixSession: vi.fn(async () => "pushed to attacker-branch lol"),
    });
    await runPrFix(fakeCtx(INPUT), deps);
    expect(rec.pushed).toEqual([{ branch: "feature/login" }]);
  });

  it("a fix session throw surfaces — no push, no ack", async () => {
    const rec = newRecorder();
    const deps = makeDeps(rec, {
      runFixSession: vi.fn(async () => {
        throw new Error("fix boom");
      }),
    });
    await expect(runPrFix(fakeCtx(INPUT), deps)).rejects.toThrow("fix boom");
    expect(rec.pushed).toEqual([]);
    expect(rec.acked).toEqual([]);
  });

  it("a clone failure (harness git clone exits non-zero) surfaces — no push/ack", async () => {
    const rec = newRecorder();
    const deps = makeDeps(rec);
    await expect(runPrFix(fakeCtx(INPUT, { cloneFails: true }), deps)).rejects.toThrow(
      /git clone/,
    );
    expect(rec.pushed).toEqual([]);
    expect(rec.acked).toEqual([]);
  });

  it("never logs the scoped token", async () => {
    const rec = newRecorder();
    const ctx = fakeCtx(INPUT);
    await runPrFix(ctx, makeDeps(rec));
    const logged = (
      ["info", "warn", "error"] as const
    ).flatMap((lvl) => (ctx.log[lvl] as ReturnType<typeof vi.fn>).mock.calls);
    for (const call of logged) {
      expect(JSON.stringify(call)).not.toContain(TOKEN);
    }
  });
});
