import { describe, it, expect, vi } from "vitest";
import type { FlueHarness } from "@flue/runtime";
import type { Octokit } from "octokit";
import {
  buildReviewerProfile,
  buildFixProfile,
  BUILD_REVIEWER_PROFILE_NAME,
  BUILD_FIX_PROFILE_NAME,
  REVIEW_TASK_KEY,
  FIX_TASK_KEY,
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
  type BuildRunCtx,
} from "../build-phases.ts";
import { resolveModel, resolveThinking } from "../../config.ts";
import { loadPersona } from "../persona.ts";
import type { BuildRun } from "../../build-run-store.ts";

// beta.3 — reviewer-loop (reviewer / fix / recheck) SUBAGENT-PROFILE config + phase
// WIRING, all offline (no live model / GitHub / Docker / push). Profiles are STATIC
// `defineAgentProfile`s; the phase wiring (token mint, clone-into-harness, subagent
// task, verdict parse, fix sha read, the MOCKED push seam) is asserted over injected deps.

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

/** A stub coordinator harness — the wiring tests fake every harness-touching dep. */
const STUB_HARNESS = { name: "default" } as unknown as FlueHarness;

function ctx(input: Partial<BuildInput> = {}): BuildRunCtx {
  return {
    harness: STUB_HARNESS,
    input: {
      runId: RUN.id,
      owner: RUN.owner,
      repo: RUN.repo,
      issue: RUN.issue,
      ...input,
    },
    log: { info() {}, warn() {}, error() {} },
  };
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

describe("buildReviewerProfile — static subagent-profile config (review key / persona / 3 skills)", () => {
  it("resolves the review task key, carries persona + 3 review skills, and NO tools/sandbox/cwd", () => {
    expect(buildReviewerProfile.name).toBe(BUILD_REVIEWER_PROFILE_NAME);
    expect(buildReviewerProfile.model).toBe(resolveModel(REVIEW_TASK_KEY));
    expect(buildReviewerProfile.thinkingLevel).toBe(resolveThinking(REVIEW_TASK_KEY));
    expect(buildReviewerProfile.instructions).toBe(loadPersona());
    // pr-review + building + code-review.
    expect(buildReviewerProfile.skills?.length).toBe(3);
    expect(buildReviewerProfile.tools).toBeUndefined();
    expect((buildReviewerProfile as { sandbox?: unknown }).sandbox).toBeUndefined();
  });
});

describe("buildFixProfile — static subagent-profile config (fix key / persona / building skill)", () => {
  it("resolves the fix task key, carries persona + the building skill, and NO tools/sandbox/cwd", () => {
    expect(buildFixProfile.name).toBe(BUILD_FIX_PROFILE_NAME);
    expect(buildFixProfile.model).toBe(resolveModel(FIX_TASK_KEY));
    expect(buildFixProfile.thinkingLevel).toBe(resolveThinking(FIX_TASK_KEY));
    expect(buildFixProfile.instructions).toBe(loadPersona());
    expect(buildFixProfile.skills?.length).toBe(1); // building
    expect(buildFixProfile.tools).toBeUndefined();
  });
});

describe("runReviewerPhase — wiring (reviewer:N + recheck:N) over injected deps", () => {
  function makeDeps(opts: { verdict?: string } = {}) {
    const calls = {
      minted: 0,
      cloned: 0,
      prompt: undefined as string | undefined,
      phaseSeen: undefined as string | undefined,
      refSeen: undefined as { owner: string; repo: string } | undefined,
    };
    const deps: ReviewerPhaseDeps = {
      async mintToken() {
        calls.minted += 1;
        return "ghs_review_token";
      },
      makeOctokit: () => FAKE_OCTOKIT,
      async ensureCheckout() {
        calls.cloned += 1;
      },
      async runReviewerSession(_c, ref, _o, prompt, phase) {
        calls.prompt = prompt;
        calls.phaseSeen = phase;
        calls.refSeen = ref;
        return opts.verdict ?? "VERDICT: APPROVED\n\nLGTM.";
      },
    };
    return { deps, calls };
  }

  it("reviewer:0 renders reviewer.md, runs the session, returns the verdict text + the verdict pointer", async () => {
    const { deps, calls } = makeDeps({ verdict: "VERDICT: APPROVED\n\nClean." });
    const res = await runReviewerPhase(ctx(), RUN, 0, false, deps);

    expect(res.text).toContain("VERDICT: APPROVED");
    expect(res.scratch?.[REVIEWER_VERDICT_SCRATCH_KEY]).toBe(
      ".lastlight/issue-42/reviewer-verdict.md",
    );
    expect(calls.minted).toBe(1);
    expect(calls.cloned).toBe(1);
    expect(calls.phaseSeen).toBe("reviewer:0");
    expect(calls.refSeen).toEqual(REF);
    // reviewer.md (first review) names the architect plan + the diff command.
    expect(calls.prompt).toContain("git diff main...HEAD");
  });

  it("recheck:1 renders re-reviewer.md naming the fix cycle in a recheck phase", async () => {
    const { deps, calls } = makeDeps({ verdict: "VERDICT: REQUEST_CHANGES\n\nStill broken." });
    const res = await runReviewerPhase(ctx(), RUN, 1, true, deps);

    expect(res.text).toContain("VERDICT: REQUEST_CHANGES");
    expect(calls.phaseSeen).toBe("recheck:1");
    expect(calls.prompt).toContain("RE-REVIEW after fix cycle 1");
  });

  it("propagates a reviewer session throw (no swallow)", async () => {
    const { deps } = makeDeps();
    deps.runReviewerSession = async () => {
      throw new Error("model exploded mid-review");
    };
    await expect(runReviewerPhase(ctx(), RUN, 0, false, deps)).rejects.toThrow(
      "model exploded mid-review",
    );
  });
});

describe("runFixPhase — wiring (fix:N) over injected deps (mocked push, no real push)", () => {
  function makeDeps(opts: { sessionText?: string; sha?: string } = {}) {
    const calls = {
      minted: 0,
      cloned: 0,
      prompt: undefined as string | undefined,
      phaseSeen: undefined as string | undefined,
      headRead: 0,
      pushed: [] as string[],
    };
    const deps: FixPhaseDeps = {
      async mintToken() {
        calls.minted += 1;
        return "ghs_fix_token";
      },
      makeOctokit: () => FAKE_OCTOKIT,
      async ensureCheckout() {
        calls.cloned += 1;
      },
      async runFixSession(_c, _ref, _o, prompt, phase) {
        calls.prompt = prompt;
        calls.phaseSeen = phase;
        return opts.sessionText ?? "Fixed the null deref; tests pass.";
      },
      async readHeadSha() {
        calls.headRead += 1;
        return opts.sha ?? "fixsha0000";
      },
      // The MOCKED push seam: records the branch it WOULD push — NO real push.
      async pushBranch(_harness, branch) {
        calls.pushed.push(branch);
      },
    };
    return { deps, calls };
  }

  it("fix:0 renders fix.md (naming the reviewer-verdict handoff), commits, reads the sha, pushes the bound branch", async () => {
    const { deps, calls } = makeDeps({ sessionText: "FIXED", sha: "fix0sha" });
    const res = await runFixPhase(ctx(), RUN, 0, deps);

    expect(res.text).toBe("FIXED");
    expect(res.sha).toBe("fix0sha");
    expect(calls.minted).toBe(1);
    expect(calls.cloned).toBe(1);
    expect(calls.phaseSeen).toBe("fix:0");
    expect(calls.headRead).toBe(1);
    // The fix reads the reviewer notes from the committed handoff file.
    expect(calls.prompt).toContain(".lastlight/issue-42/reviewer-verdict.md");
    expect(calls.prompt).toContain("fix cycle 0");
    // The push targets the run's BOUND branch — never model-chosen.
    expect(calls.pushed).toEqual(["lastlight/42"]);
  });

  it("does NOT push when the fix session throws (a failed fix never pushes)", async () => {
    const { deps, calls } = makeDeps();
    deps.runFixSession = async () => {
      throw new Error("model exploded mid-fix");
    };
    await expect(runFixPhase(ctx(), RUN, 0, deps)).rejects.toThrow("model exploded mid-fix");
    expect(calls.pushed).toEqual([]); // a failed fix never pushes
  });

  it("never leaks the token through the logger", async () => {
    const warn = vi.fn();
    const { deps } = makeDeps();
    const c: BuildRunCtx = {
      harness: STUB_HARNESS,
      input: { runId: RUN.id, owner: RUN.owner, repo: RUN.repo, issue: RUN.issue },
      log: { info() {}, warn, error() {} },
    };
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
    return {
      async mintToken() {
        return "ghs_review_token";
      },
      makeOctokit: () => FAKE_OCTOKIT,
      async ensureCheckout() {},
      async runReviewerSession() {
        return verdict;
      },
    };
  }

  function fixDeps(): { deps: FixPhaseDeps; pushed: string[] } {
    const pushed: string[] = [];
    const deps: FixPhaseDeps = {
      async mintToken() {
        return "ghs_fix_token";
      },
      makeOctokit: () => FAKE_OCTOKIT,
      async ensureCheckout() {},
      async runFixSession() {
        return "fixed";
      },
      async readHeadSha() {
        return "routed-fix-sha";
      },
      async pushBranch(_h, branch) {
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
