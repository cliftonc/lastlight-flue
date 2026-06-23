import { describe, it, expect, vi, afterEach } from "vitest";
import type { SandboxFactory, AgentCreateContext } from "@flue/runtime";
import type { Octokit } from "octokit";
import type { FlueContext } from "@flue/runtime";
import {
  createBuildReviewerAgent,
  createFixAgent,
  REVIEW_TASK_KEY,
  FIX_TASK_KEY,
  BUILD_REVIEWER_CWD,
} from "../build-reviewer.ts";
import {
  runReviewerPhase,
  runFixPhase,
  cycleFromPhaseName,
  defaultBuildDeps,
  fixShaScratchKey,
  REVIEWER_VERDICT_SCRATCH_KEY,
  type ReviewerPhaseDeps,
  type FixPhaseDeps,
  type ArchitectPhaseDeps,
  type ExecutorPhaseDeps,
  type BuildInput,
} from "../build-phases.ts";
import {
  resolveModel,
  resolveThinking,
  setRuntimeConfig,
  resetRuntimeConfigForTests,
} from "../../config.ts";
import { loadPersona } from "../persona.ts";
import type { BuildRun } from "../../build-run-store.ts";
import { closeBuildWorkspace, resetBuildWorkspacesForTests } from "../build-sandbox.ts";
import type { BuildSandboxOps, BuildContainer } from "../build-sandbox.ts";

afterEach(() => resetBuildWorkspacesForTests());

// Phase 4 — reviewer-loop (reviewer / fix / recheck) agent CONFIG + phase WIRING,
// all offline (no live model / GitHub / Docker / push). Config is asserted by
// invoking each agent's `initialize` closure; the phase wiring (token mint,
// pre-clone, session, verdict parse, fix sha read, the MOCKED push seam, teardown)
// is asserted over injected deps.

const SANDBOX = { __fake: true } as unknown as SandboxFactory;
const FAKE_OCTOKIT = { __fake: "octokit" } as unknown as Octokit;
const REF = { owner: "cliftonc", repo: "widget" };

const RUN: BuildRun = {
  id: "cliftonc/widget#42",
  owner: "cliftonc",
  repo: "widget",
  issue: 42,
  branch: "lastlight/42",
  taskId: "widget-42-build",
  phasesDone: {},
  scratch: {},
  pendingGate: null,
  reviewerCycle: 0,
  restartCount: 0,
  status: "active",
  failReason: null,
};

function ctx(payload: Partial<BuildInput> = {}): FlueContext<BuildInput> {
  return {
    payload: {
      runId: RUN.id,
      owner: RUN.owner,
      repo: RUN.repo,
      issue: RUN.issue,
      ...payload,
    },
    log: { info() {}, warn() {}, error() {} },
  } as unknown as FlueContext<BuildInput>;
}

describe("cycleFromPhaseName — per-cycle key parsing", () => {
  it("extracts the cycle index from each reviewer-loop phase name", () => {
    expect(cycleFromPhaseName("reviewer:0")).toBe(0);
    expect(cycleFromPhaseName("fix:1")).toBe(1);
    expect(cycleFromPhaseName("recheck:2")).toBe(2);
  });
  it("throws on a name missing the :<cycle> suffix", () => {
    expect(() => cycleFromPhaseName("reviewer")).toThrow(/missing its :<cycle>/);
  });
});

describe("createBuildReviewerAgent — config (review key / persona / skills / sandbox / cwd)", () => {
  it("resolves model+thinking for the review task key, carries persona + 3 review skills + sandbox/cwd + read-only tools", async () => {
    setRuntimeConfig({
      models: { default: "openai/gpt-5.1", review: "openai/gpt-5.1-codex" },
      variants: { review: "high" },
    } as never);
    try {
      const cfg = await createBuildReviewerAgent(REF, FAKE_OCTOKIT, SANDBOX).initialize(
        {} as AgentCreateContext<unknown>,
      );
      expect(cfg.model).toBe(resolveModel(REVIEW_TASK_KEY));
      expect(cfg.model).toBe("openai/gpt-5.1-codex");
      expect(cfg.thinkingLevel).toBe(resolveThinking(REVIEW_TASK_KEY));
      expect(cfg.thinkingLevel).toBe("high");
      expect(cfg.instructions).toBe(loadPersona());
      // pr-review + building + code-review.
      expect(cfg.skills?.length).toBe(3);
      // The reviewer REQUIRES the sandbox (it inspects the checkout).
      expect(cfg.sandbox).toBe(SANDBOX);
      expect(cfg.cwd).toBe(BUILD_REVIEWER_CWD);
      expect(cfg.cwd).toBe("/workspace");
      expect((cfg.tools ?? []).length).toBeGreaterThan(0);
    } finally {
      resetRuntimeConfigForTests();
    }
  });
});

describe("createFixAgent — config (fix key / persona / building skill / sandbox / cwd)", () => {
  it("resolves model+thinking for the fix task key, carries persona + the building skill + sandbox/cwd", async () => {
    setRuntimeConfig({
      models: { default: "openai/gpt-5.1", fix: "openai/gpt-5.1-codex" },
      variants: { fix: "high" },
    } as never);
    try {
      const cfg = await createFixAgent(REF, FAKE_OCTOKIT, SANDBOX).initialize(
        {} as AgentCreateContext<unknown>,
      );
      expect(cfg.model).toBe(resolveModel(FIX_TASK_KEY));
      expect(cfg.model).toBe("openai/gpt-5.1-codex");
      expect(cfg.thinkingLevel).toBe("high");
      expect(cfg.instructions).toBe(loadPersona());
      expect(cfg.skills?.length).toBe(1); // building
      expect(cfg.sandbox).toBe(SANDBOX);
      expect(cfg.cwd).toBe("/workspace");
    } finally {
      resetRuntimeConfigForTests();
    }
  });

  it("falls back to the default model when no explicit fix key is configured", async () => {
    setRuntimeConfig({ models: { default: "openai/gpt-5.1" }, variants: {} } as never);
    try {
      const cfg = await createFixAgent(REF, FAKE_OCTOKIT, SANDBOX).initialize(
        {} as AgentCreateContext<unknown>,
      );
      expect(cfg.model).toBe("openai/gpt-5.1");
    } finally {
      resetRuntimeConfigForTests();
    }
  });
});

/** A fake build container recording exec calls (incl. push) + teardown. */
function fakeContainer(opts: { sha?: string } = {}) {
  const execCalls: string[] = [];
  let removed = 0;
  const container: BuildContainer = {
    async exec(command) {
      execCalls.push(command);
      if (command.includes("git rev-parse HEAD")) {
        return { stdout: `${opts.sha ?? "fixsha0000"}\n`, stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    async remove() {
      removed += 1;
    },
    sandbox: () => SANDBOX,
  };
  return { container, execCalls, removed: () => removed };
}

describe("runReviewerPhase — wiring (reviewer:N + recheck:N) over injected deps", () => {
  function makeDeps(opts: { verdict?: string } = {}) {
    const fc = fakeContainer();
    const calls = {
      minted: 0,
      prompt: undefined as string | undefined,
      sessionName: undefined as string | undefined,
      sandboxSeen: undefined as SandboxFactory | undefined,
      refSeen: undefined as { owner: string; repo: string } | undefined,
    };
    const deps: ReviewerPhaseDeps = {
      async mintToken() {
        calls.minted += 1;
        return "ghs_review_token";
      },
      makeOctokit: () => FAKE_OCTOKIT,
      sandboxOps: { createContainer: vi.fn(async () => fc.container) } as BuildSandboxOps,
      async runReviewerSession(_c, ref, _o, sandbox, prompt, sessionName) {
        calls.prompt = prompt;
        calls.sessionName = sessionName;
        calls.sandboxSeen = sandbox;
        calls.refSeen = ref;
        return opts.verdict ?? "VERDICT: APPROVED\n\nLGTM.";
      },
    };
    return { deps, calls, fc };
  }

  it("reviewer:0 renders reviewer.md, runs the session, returns the verdict text + the verdict pointer", async () => {
    const { deps, calls } = makeDeps({ verdict: "VERDICT: APPROVED\n\nClean." });
    const res = await runReviewerPhase(ctx(), RUN, 0, false, deps);

    expect(res.text).toContain("VERDICT: APPROVED");
    expect(res.scratch?.[REVIEWER_VERDICT_SCRATCH_KEY]).toBe(
      ".lastlight/issue-42/reviewer-verdict.md",
    );
    expect(calls.minted).toBe(1);
    expect(calls.sessionName).toBe("reviewer:0");
    expect(calls.sandboxSeen).toBe(SANDBOX);
    expect(calls.refSeen).toEqual(REF);
    // reviewer.md (first review) names the architect plan + the diff command.
    expect(calls.prompt).toContain("git diff main...HEAD");
  });

  it("recheck:1 renders re-reviewer.md naming the fix cycle in a recheck session", async () => {
    const { deps, calls } = makeDeps({ verdict: "VERDICT: REQUEST_CHANGES\n\nStill broken." });
    const res = await runReviewerPhase(ctx(), RUN, 1, true, deps);

    expect(res.text).toContain("VERDICT: REQUEST_CHANGES");
    expect(calls.sessionName).toBe("recheck:1");
    expect(calls.prompt).toContain("RE-REVIEW after fix cycle 1");
  });

  it("tears the container down even when the reviewer session throws (finally)", async () => {
    const { deps, fc } = makeDeps();
    deps.runReviewerSession = async () => {
      throw new Error("model exploded mid-review");
    };
    await expect(runReviewerPhase(ctx(), RUN, 0, false, deps)).rejects.toThrow(
      "model exploded mid-review",
    );
    expect(fc.removed()).toBe(0); // shared workspace — NOT torn down per phase
    await closeBuildWorkspace(RUN.taskId);
    expect(fc.removed()).toBe(1);
  });
});

describe("runFixPhase — wiring (fix:N) over injected deps (mocked push, no real push)", () => {
  function makeDeps(opts: { sessionText?: string; sha?: string } = {}) {
    const fc = fakeContainer({ sha: opts.sha });
    const calls = {
      minted: 0,
      prompt: undefined as string | undefined,
      sessionName: undefined as string | undefined,
      headRead: 0,
      pushed: [] as string[],
    };
    const deps: FixPhaseDeps = {
      async mintToken() {
        calls.minted += 1;
        return "ghs_fix_token";
      },
      makeOctokit: () => FAKE_OCTOKIT,
      sandboxOps: { createContainer: vi.fn(async () => fc.container) } as BuildSandboxOps,
      async runFixSession(_c, _ref, _o, _sandbox, prompt, sessionName) {
        calls.prompt = prompt;
        calls.sessionName = sessionName;
        return opts.sessionText ?? "Fixed the null deref; tests pass.";
      },
      async readHeadSha() {
        calls.headRead += 1;
        return opts.sha ?? "fixsha0000";
      },
      // The MOCKED push seam: records the branch it WOULD push — NO real push.
      async pushBranch(_container, branch) {
        calls.pushed.push(branch);
      },
    };
    return { deps, calls, fc };
  }

  it("fix:0 renders fix.md (naming the reviewer-verdict handoff), commits, reads the sha, pushes the bound branch", async () => {
    const { deps, calls } = makeDeps({ sessionText: "FIXED", sha: "fix0sha" });
    const res = await runFixPhase(ctx(), RUN, 0, deps);

    expect(res.text).toBe("FIXED");
    expect(res.sha).toBe("fix0sha");
    expect(calls.minted).toBe(1);
    expect(calls.sessionName).toBe("fix:0");
    expect(calls.headRead).toBe(1);
    // The fix reads the reviewer notes from the committed handoff file.
    expect(calls.prompt).toContain(".lastlight/issue-42/reviewer-verdict.md");
    expect(calls.prompt).toContain("fix cycle 0");
    // The push targets the run's BOUND branch — never model-chosen.
    expect(calls.pushed).toEqual(["lastlight/42"]);
  });

  it("tears the container down even when the fix session throws (finally) — and does NOT push", async () => {
    const { deps, fc, calls } = makeDeps();
    deps.runFixSession = async () => {
      throw new Error("model exploded mid-fix");
    };
    await expect(runFixPhase(ctx(), RUN, 0, deps)).rejects.toThrow("model exploded mid-fix");
    expect(fc.removed()).toBe(0); // shared workspace — NOT torn down per phase
    await closeBuildWorkspace(RUN.taskId);
    expect(fc.removed()).toBe(1);
    expect(calls.pushed).toEqual([]); // a failed fix never pushes
  });

  it("never leaks the token through the logger", async () => {
    const warn = vi.fn();
    const { deps } = makeDeps();
    const c = {
      payload: { runId: RUN.id, owner: RUN.owner, repo: RUN.repo, issue: RUN.issue },
      log: { info() {}, warn, error() {} },
    } as unknown as FlueContext<BuildInput>;
    await runFixPhase(c, RUN, 0, deps);
    for (const call of warn.mock.calls) {
      expect(JSON.stringify(call)).not.toContain("ghs_fix_token");
    }
  });
});

describe("defaultBuildDeps.runPhase — per-cycle reviewer-loop routing (over injected sub-deps)", () => {
  // A no-op stub for the architect/executor sub-deps (unused by these routes).
  const noopArch = {} as ArchitectPhaseDeps;
  const noopExec = {} as ExecutorPhaseDeps;

  function reviewerDeps(verdict: string): ReviewerPhaseDeps {
    const fc = fakeContainer();
    return {
      async mintToken() {
        return "ghs_review_token";
      },
      makeOctokit: () => FAKE_OCTOKIT,
      sandboxOps: { createContainer: async () => fc.container } as BuildSandboxOps,
      async runReviewerSession() {
        return verdict;
      },
    };
  }

  function fixDeps(): { deps: FixPhaseDeps; pushed: string[] } {
    const fc = fakeContainer({ sha: "routed-fix-sha" });
    const pushed: string[] = [];
    const deps: FixPhaseDeps = {
      async mintToken() {
        return "ghs_fix_token";
      },
      makeOctokit: () => FAKE_OCTOKIT,
      sandboxOps: { createContainer: async () => fc.container } as BuildSandboxOps,
      async runFixSession() {
        return "fixed";
      },
      async readHeadSha() {
        return "routed-fix-sha";
      },
      async pushBranch(_c, branch) {
        pushed.push(branch);
      },
    };
    return { deps, pushed };
  }

  it("routes reviewer:N + recheck:N to the reviewer body and fix:N to the fix body (parsing the per-cycle key)", async () => {
    const fx = fixDeps();
    const deps = defaultBuildDeps(
      noopArch,
      noopExec,
      reviewerDeps("VERDICT: REQUEST_CHANGES\n\nfix it"),
      fx.deps,
    );

    const rv = await deps.runPhase(ctx(), RUN, "reviewer:0");
    expect(rv.text).toContain("REQUEST_CHANGES");
    expect(rv.scratch?.[REVIEWER_VERDICT_SCRATCH_KEY]).toBe(
      ".lastlight/issue-42/reviewer-verdict.md",
    );

    const fxRes = await deps.runPhase(ctx(), RUN, "fix:0");
    expect(fxRes.scratch?.[fixShaScratchKey(0)]).toBe("routed-fix-sha");
    expect(fx.pushed).toEqual(["lastlight/42"]); // mocked push, bound branch

    const rc = await deps.runPhase(ctx(), RUN, "recheck:0");
    expect(rc.text).toContain("REQUEST_CHANGES");
  });

  it("throws on an UNKNOWN phase name (no body routed)", async () => {
    const deps = defaultBuildDeps(noopArch, noopExec, reviewerDeps("VERDICT: APPROVED"), fixDeps().deps);
    await expect(deps.runPhase(ctx(), RUN, "bogus-phase")).rejects.toThrow(/unknown phase/);
  });
});
