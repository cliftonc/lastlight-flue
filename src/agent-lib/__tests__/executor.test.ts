import { describe, it, expect, vi } from "vitest";
import type { SandboxFactory, AgentCreateContext } from "@flue/runtime";
import type { Octokit } from "octokit";
import type { FlueContext } from "@flue/runtime";
import {
  createExecutorAgent,
  EXECUTOR_TASK_KEY,
  EXECUTOR_CWD,
} from "../executor.ts";
import {
  runExecutorPhase,
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
import type { BuildSandboxOps, BuildContainer } from "../build-sandbox.ts";
import { UNTRUSTED_OPEN } from "../../engine/untrusted.ts";

// Phase 4 — executor agent CONFIG + phase WIRING, all offline (no live model /
// GitHub / Docker / PUSH). Config is asserted by invoking the agent's `initialize`
// closure; the phase wiring (token mint, pre-clone, session, sha read, the MOCKED
// push seam, teardown) is asserted over injected deps.

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

describe("createExecutorAgent — config (model / thinking / persona / skills / sandbox / cwd)", () => {
  it("resolves model+thinking for the executor task key, carries the persona, the building skill, sandbox + cwd, read-only tools", async () => {
    setRuntimeConfig({
      models: { default: "openai/gpt-5.1", executor: "openai/gpt-5.1-codex" },
      variants: { executor: "high" },
    } as never);
    try {
      const agent = createExecutorAgent(REF, FAKE_OCTOKIT, SANDBOX);
      const cfg = await agent.initialize({} as AgentCreateContext<unknown>);

      expect(cfg.model).toBe(resolveModel(EXECUTOR_TASK_KEY));
      expect(cfg.model).toBe("openai/gpt-5.1-codex");
      expect(cfg.thinkingLevel).toBe(resolveThinking(EXECUTOR_TASK_KEY));
      expect(cfg.thinkingLevel).toBe("high");
      expect(cfg.instructions).toBe(loadPersona());
      expect(cfg.skills?.length).toBe(1); // building
      expect(cfg.sandbox).toBe(SANDBOX);
      expect(cfg.cwd).toBe(EXECUTOR_CWD);
      expect(cfg.cwd).toBe("/workspace");
      // GitHub tools are READ-ONLY (code lands via the sandbox git CLI, not a tool).
      expect((cfg.tools ?? []).length).toBeGreaterThan(0);
    } finally {
      resetRuntimeConfigForTests();
    }
  });

  it("falls back to the default model when no explicit executor key is configured", async () => {
    setRuntimeConfig({ models: { default: "openai/gpt-5.1" }, variants: {} } as never);
    try {
      const cfg = await createExecutorAgent(REF, FAKE_OCTOKIT, SANDBOX).initialize(
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
        return { stdout: `${opts.sha ?? "deadbeefcafe"}\n`, stderr: "", exitCode: 0 };
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

describe("runExecutorPhase — wiring over injected deps (no live model / GitHub / Docker / push)", () => {
  function makeDeps(opts: { sessionText?: string; sha?: string } = {}) {
    const fc = fakeContainer({ sha: opts.sha });
    const calls = {
      minted: 0,
      octokitForToken: undefined as string | undefined,
      prompt: undefined as string | undefined,
      sandboxSeen: undefined as SandboxFactory | undefined,
      refSeen: undefined as { owner: string; repo: string } | undefined,
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
      sandboxOps: { createContainer: vi.fn(async () => fc.container) } as BuildSandboxOps,
      async runExecutorSession(_c, ref, _octokit, sandbox, prompt) {
        calls.prompt = prompt;
        calls.sandboxSeen = sandbox;
        calls.refSeen = ref;
        return opts.sessionText ?? "Changed src/foo.ts; tests pass; sha deadbeefcafe";
      },
      async readHeadSha() {
        calls.headRead += 1;
        return opts.sha ?? "deadbeefcafe";
      },
      // The MOCKED push seam: records the branch it WOULD push — NO real push.
      async pushBranch(_container, branch) {
        calls.pushed.push(branch);
      },
    };
    return { deps, calls, fc };
  }

  it("mints a repo-write token, pre-clones into a sandbox, runs the session, reads the sha, returns text+sha", async () => {
    const { deps, calls } = makeDeps({ sessionText: "DONE", sha: "abc123" });
    const res = await runExecutorPhase(ctx(), RUN, deps);

    expect(res.text).toBe("DONE");
    expect(res.sha).toBe("abc123");
    expect(calls.minted).toBe(1);
    expect(calls.octokitForToken).toBe("ghs_exec_token");
    expect(calls.sandboxSeen).toBe(SANDBOX);
    expect(calls.refSeen).toEqual(REF);
    expect(calls.headRead).toBe(1);
    expect((deps.sandboxOps.createContainer as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
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

  it("tears the container down even when the session throws (finally) — and does NOT push", async () => {
    const { deps, fc, calls } = makeDeps();
    deps.runExecutorSession = async () => {
      throw new Error("model exploded mid-executor");
    };
    await expect(runExecutorPhase(ctx(), RUN, deps)).rejects.toThrow(
      "model exploded mid-executor",
    );
    expect(fc.removed()).toBe(1);
    expect(calls.pushed).toEqual([]); // a failed run never pushes
  });

  it("never leaks the token through the logger", async () => {
    const warn = vi.fn();
    const { deps } = makeDeps();
    const c = {
      payload: { runId: RUN.id, owner: RUN.owner, repo: RUN.repo, issue: RUN.issue },
      log: { info() {}, warn, error() {} },
    } as unknown as FlueContext<BuildInput>;
    await runExecutorPhase(c, RUN, deps);
    for (const call of warn.mock.calls) {
      expect(JSON.stringify(call)).not.toContain("ghs_exec_token");
    }
  });
});

describe("defaultExecutorPhaseDeps — the real push seam runs git push in-sandbox (over a fake container)", () => {
  it("readHeadSha + pushBranch use the bound branch via the sandbox git CLI (no model tool)", async () => {
    const { defaultExecutorPhaseDeps } = await import("../build-phases.ts");
    const deps = defaultExecutorPhaseDeps();
    const fc = fakeContainer({ sha: "feed1234" });

    const sha = await deps.readHeadSha(fc.container);
    expect(sha).toBe("feed1234");

    await deps.pushBranch(fc.container, "lastlight/42");
    const push = fc.execCalls.find((x) => x.includes("git push"))!;
    expect(push).toContain("origin");
    expect(push).toContain("'lastlight/42'"); // branch is shell-quoted + bound
  });

  it("pushBranch THROWS on a non-zero git push exit (live failure surfaces)", async () => {
    const { defaultExecutorPhaseDeps } = await import("../build-phases.ts");
    const deps = defaultExecutorPhaseDeps();
    const failing: BuildContainer = {
      async exec() {
        return { stdout: "", stderr: "rejected: non-fast-forward", exitCode: 1 };
      },
      async remove() {},
      sandbox: () => SANDBOX,
    };
    await expect(deps.pushBranch(failing, "lastlight/42")).rejects.toThrow(/git push failed/);
  });
});
