import { describe, it, expect, vi } from "vitest";
import type { FlueHarness } from "@flue/runtime";
import type { Octokit } from "octokit";
import {
  executorProfile,
  EXECUTOR_PROFILE_NAME,
  EXECUTOR_TASK_KEY,
} from "../executor.ts";
import {
  runExecutorPhase,
  defaultExecutorPhaseDeps,
  type ExecutorPhaseDeps,
  type BuildInput,
  type BuildRunCtx,
} from "../build-phases.ts";
import { resolveModel, resolveThinking } from "../../config.ts";
import { loadPersona } from "../persona.ts";
import type { BuildRun } from "../../build-run-store.ts";
import { UNTRUSTED_OPEN } from "../../engine/untrusted.ts";

// beta.3 — executor SUBAGENT-PROFILE config + phase WIRING, all offline (no live model
// / GitHub / Docker / PUSH). The profile is a STATIC `defineAgentProfile` (resolved at
// module load); the phase wiring (token mint, clone-into-harness, subagent task, sha
// read, the MOCKED push seam) is asserted over injected deps.

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

function ctx(input: Partial<BuildInput> = {}, harness: FlueHarness = STUB_HARNESS): BuildRunCtx {
  return {
    harness,
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

describe("executorProfile — static subagent-profile config (model / thinking / persona / skill)", () => {
  it("carries the executor model+thinking task key, the persona, the building skill, and NO tools/sandbox/cwd", () => {
    expect(executorProfile.name).toBe(EXECUTOR_PROFILE_NAME);
    expect(executorProfile.model).toBe(resolveModel(EXECUTOR_TASK_KEY));
    expect(executorProfile.thinkingLevel).toBe(resolveThinking(EXECUTOR_TASK_KEY));
    expect(executorProfile.instructions).toBe(loadPersona());
    expect(executorProfile.skills?.length).toBe(1); // building
    // Profiles carry NO tools (injected per `session.task`) and NO sandbox/cwd
    // (inherited from the coordinator harness — the shared /workspace checkout).
    expect(executorProfile.tools).toBeUndefined();
    expect((executorProfile as { sandbox?: unknown }).sandbox).toBeUndefined();
  });
});

describe("runExecutorPhase — wiring over injected deps (no live model / GitHub / Docker / push)", () => {
  function makeDeps(opts: { sessionText?: string; sha?: string } = {}) {
    const calls = {
      minted: 0,
      octokitForToken: undefined as string | undefined,
      prompt: undefined as string | undefined,
      refSeen: undefined as { owner: string; repo: string } | undefined,
      cloned: 0,
      clonedToken: undefined as string | undefined,
      headRead: 0,
      pushed: [] as string[],
    };
    const deps: ExecutorPhaseDeps = {
      async mintToken() {
        calls.minted += 1;
        return "ghs_exec_token";
      },
      makeOctokit(token) {
        calls.octokitForToken = token;
        return FAKE_OCTOKIT;
      },
      // Clone-into-harness seam: records that the checkout was ensured with the token.
      async ensureCheckout(_harness, _run, token) {
        calls.cloned += 1;
        calls.clonedToken = token;
      },
      async runExecutorSession(_c, ref, _octokit, prompt) {
        calls.prompt = prompt;
        calls.refSeen = ref;
        return opts.sessionText ?? "Changed src/foo.ts; tests pass; sha deadbeefcafe";
      },
      async readHeadSha() {
        calls.headRead += 1;
        return opts.sha ?? "deadbeefcafe";
      },
      // The MOCKED push seam: records the branch it WOULD push — NO real push.
      async pushBranch(_harness, branch) {
        calls.pushed.push(branch);
      },
    };
    return { deps, calls };
  }

  it("mints a repo-write token, clones into the harness, runs the session, reads the sha, returns text+sha", async () => {
    const { deps, calls } = makeDeps({ sessionText: "DONE", sha: "abc123" });
    const res = await runExecutorPhase(ctx(), RUN, deps);

    expect(res.text).toBe("DONE");
    expect(res.sha).toBe("abc123");
    expect(calls.minted).toBe(1);
    expect(calls.octokitForToken).toBe("ghs_exec_token");
    expect(calls.refSeen).toEqual(REF);
    expect(calls.cloned).toBe(1);
    expect(calls.clonedToken).toBe("ghs_exec_token");
    expect(calls.headRead).toBe(1);
  });

  it("PUSHES the bound working branch through the mocked seam (asserts it WOULD push)", async () => {
    const { deps, calls } = makeDeps();
    await runExecutorPhase(ctx(), RUN, deps);
    // The push targets the run's bound branch — never model-chosen.
    expect(calls.pushed).toEqual(["lastlight/42"]);
  });

  it("renders the prompt naming the architect plan + wraps untrusted issue text", async () => {
    const { deps, calls } = makeDeps();
    await runExecutorPhase(
      ctx({ issueContext: { body: "make the parser robust", sender: "octo-dev" } }),
      RUN,
      deps,
    );
    expect(calls.prompt).toContain("inside the widget repo at branch lastlight/42");
    expect(calls.prompt).toContain(".lastlight/issue-42/architect-plan.md");
    // Untrusted issue text is wrapped.
    expect(calls.prompt).toContain(UNTRUSTED_OPEN);
    expect(calls.prompt).toContain("make the parser robust");
  });

  it("does NOT push when the session throws (a failed run never pushes)", async () => {
    const { deps, calls } = makeDeps();
    deps.runExecutorSession = async () => {
      throw new Error("model exploded mid-executor");
    };
    await expect(runExecutorPhase(ctx(), RUN, deps)).rejects.toThrow(
      "model exploded mid-executor",
    );
    expect(calls.pushed).toEqual([]); // a failed run never pushes
  });

  it("never leaks the token through the logger", async () => {
    const warn = vi.fn();
    const { deps } = makeDeps();
    const c: BuildRunCtx = {
      harness: STUB_HARNESS,
      input: { runId: RUN.id, owner: RUN.owner, repo: RUN.repo, issue: RUN.issue },
      log: { info() {}, warn, error() {} },
    };
    await runExecutorPhase(c, RUN, deps);
    for (const call of warn.mock.calls) {
      expect(JSON.stringify(call)).not.toContain("ghs_exec_token");
    }
  });
});

/** A fake coordinator harness recording `shell` commands (sha read + push). */
function fakeHarness(opts: { sha?: string; pushExit?: number; pushStderr?: string } = {}) {
  const shellCalls: string[] = [];
  const harness = {
    name: "default",
    async shell(command: string) {
      shellCalls.push(command);
      if (command.includes("git rev-parse HEAD")) {
        return { stdout: `${opts.sha ?? "deadbeefcafe"}\n`, stderr: "", exitCode: 0 };
      }
      if (command.includes("git push")) {
        return { stdout: "", stderr: opts.pushStderr ?? "", exitCode: opts.pushExit ?? 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  } as unknown as FlueHarness;
  return { harness, shellCalls };
}

describe("defaultExecutorPhaseDeps — the real push seam runs git push in the harness sandbox", () => {
  it("readHeadSha + pushBranch use the bound branch via the harness git CLI (no model tool)", async () => {
    const deps = defaultExecutorPhaseDeps();
    const fh = fakeHarness({ sha: "feed1234" });

    const sha = await deps.readHeadSha(fh.harness);
    expect(sha).toBe("feed1234");

    await deps.pushBranch(fh.harness, "lastlight/42");
    const push = fh.shellCalls.find((x) => x.includes("git push"))!;
    expect(push).toContain("origin");
    expect(push).toContain("'lastlight/42'"); // branch is shell-quoted + bound
  });

  it("pushBranch THROWS on a non-zero git push exit (live failure surfaces)", async () => {
    const deps = defaultExecutorPhaseDeps();
    const fh = fakeHarness({ pushExit: 1, pushStderr: "rejected: non-fast-forward" });
    await expect(deps.pushBranch(fh.harness, "lastlight/42")).rejects.toThrow(/git push failed/);
  });
});
