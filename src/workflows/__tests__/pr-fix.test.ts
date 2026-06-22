import { describe, it, expect, vi } from "vitest";
import type { FlueContext, SandboxFactory } from "@flue/runtime";
import type { Octokit } from "octokit";
import { runPrFix, type PrFixDeps, type PrFixInput } from "../pr-fix.ts";
import type { BuildContainer, BuildSandboxOps } from "../../agent-lib/build-sandbox.ts";
import type { PrFixRef, PostedAck } from "../../pr-fix-post.ts";

// Phase 5 — pr-fix run-level tests over FAKES: repo-write token minted, PR head ref
// resolved deterministically, the sandbox pre-clones + checks out the PR BRANCH (not
// a new one), the container is ALWAYS torn down (incl. on throw), the fix is committed
// + the bound head branch PUSHED via the MOCKED seam (no real push), the ack comment
// posts to the bound PR, and the token is never logged. NO live model/git/GitHub/Docker.

const TOKEN = "ghs_prfix_test_token";

const SANDBOX = { __fake: true } as unknown as SandboxFactory;

function fakeCtx(payload: PrFixInput): FlueContext<PrFixInput> {
  return {
    id: "test-run",
    payload,
    env: {},
    req: undefined,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    init: vi.fn(async () => {
      throw new Error("init must not be called — runFixSession is injected in tests");
    }),
  } as unknown as FlueContext<PrFixInput>;
}

/** A fake container recording exec'd commands + whether it was removed. */
function fakeContainer() {
  const execCalls: string[] = [];
  let removed = 0;
  const container: BuildContainer = {
    async exec(command) {
      execCalls.push(command);
      return { stdout: "headsha123\n", stderr: "", exitCode: 0 };
    },
    async remove() {
      removed += 1;
    },
    sandbox: () => SANDBOX,
  };
  return { container, execCalls, removed: () => removed };
}

interface Recorder {
  pushed: { branch: string }[];
  acked: { ref: PrFixRef; branch: string; sha: string }[];
  minted: PrFixInput[];
  headResolved: PrFixRef[];
  fixSessions: { ref: { owner: string; repo: string }; prompt: string }[];
  container: ReturnType<typeof fakeContainer>;
}

function makeDeps(
  rec: Recorder,
  over: Partial<PrFixDeps> = {},
): PrFixDeps {
  const ops: BuildSandboxOps = {
    createContainer: vi.fn(async () => rec.container.container),
  };
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
    sandboxOps: ops,
    runFixSession: vi.fn(async (_ctx, ref, _octokit, _sandbox, prompt) => {
      rec.fixSessions.push({ ref, prompt });
      return "Fixed the handler. tests pass. abc1234";
    }),
    readHeadSha: vi.fn(async (container) => {
      const r = await container.exec("git rev-parse HEAD", { cwd: "/workspace" });
      return r.stdout.trim();
    }),
    pushBranch: vi.fn(async (_container, branch) => {
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
    container: fakeContainer(),
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
    // Container torn down.
    expect(rec.container.removed()).toBe(1);
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

  it("tears the container down even when the fix session throws (no push, no ack)", async () => {
    const rec = newRecorder();
    const deps = makeDeps(rec, {
      runFixSession: vi.fn(async () => {
        throw new Error("fix boom");
      }),
    });
    await expect(runPrFix(fakeCtx(INPUT), deps)).rejects.toThrow("fix boom");
    expect(rec.container.removed()).toBe(1);
    expect(rec.pushed).toEqual([]);
    expect(rec.acked).toEqual([]);
  });

  it("a clone failure (createContainer ok, clone throws) still tears down — no push/ack", async () => {
    const rec = newRecorder();
    // Make the container's clone exec fail.
    const failing = fakeContainer();
    failing.container.exec = vi.fn(async (command: string) => {
      failing.execCalls.push(command);
      const isClone = command.includes("git clone");
      return { stdout: "", stderr: "boom", exitCode: isClone ? 128 : 0 };
    }) as BuildContainer["exec"];
    rec.container = failing;
    const deps = makeDeps(rec);
    await expect(runPrFix(fakeCtx(INPUT), deps)).rejects.toThrow(/git clone/);
    expect(failing.removed()).toBe(1);
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
