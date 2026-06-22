import { describe, it, expect, vi } from "vitest";
import type { SandboxFactory, AgentCreateContext } from "@flue/runtime";
import type { Octokit } from "octokit";
import type { FlueContext } from "@flue/runtime";
import {
  createArchitectAgent,
  ARCHITECT_TASK_KEY,
  ARCHITECT_CWD,
} from "../architect.ts";
import {
  runArchitectPhase,
  type ArchitectPhaseDeps,
  type BuildInput,
} from "../build-phases.ts";
import { resolveModel, resolveThinking, setRuntimeConfig, resetRuntimeConfigForTests } from "../../config.ts";
import { loadPersona } from "../persona.ts";
import type { BuildRun } from "../../build-run-store.ts";
import type { BuildSandboxOps, BuildContainer } from "../build-sandbox.ts";
import { UNTRUSTED_OPEN } from "../../engine/untrusted.ts";

// Phase 4 — architect agent CONFIG + phase WIRING, all offline (no live model /
// GitHub / Docker). The agent's config is asserted by invoking its `initialize`
// closure; the phase wiring is asserted over injected deps.

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

describe("createArchitectAgent — config (model / thinking / persona / skills / sandbox / cwd)", () => {
  it("resolves model+thinking for the architect task key, carries the persona, the building skill, sandbox + cwd", async () => {
    // A minimal config so resolveModel/resolveThinking are deterministic.
    setRuntimeConfig({
      models: { default: "openai/gpt-5.1", architect: "openai/gpt-5.1-codex" },
      variants: { architect: "high" },
    } as never);
    try {
      const agent = createArchitectAgent(REF, FAKE_OCTOKIT, SANDBOX);
      const cfg = await agent.initialize({} as AgentCreateContext<unknown>);

      expect(cfg.model).toBe(resolveModel(ARCHITECT_TASK_KEY));
      expect(cfg.model).toBe("openai/gpt-5.1-codex");
      expect(cfg.thinkingLevel).toBe(resolveThinking(ARCHITECT_TASK_KEY));
      expect(cfg.thinkingLevel).toBe("high");
      expect(cfg.instructions).toBe(loadPersona());
      // The architect gets the `building` skill (install/test gate).
      expect(cfg.skills?.length).toBe(1);
      // Sandbox + cwd point the agent at the pre-cloned checkout.
      expect(cfg.sandbox).toBe(SANDBOX);
      expect(cfg.cwd).toBe(ARCHITECT_CWD);
      expect(cfg.cwd).toBe("/workspace");
      // Read-only GitHub tools are bound (closed over ref/octokit).
      expect((cfg.tools ?? []).length).toBeGreaterThan(0);
    } finally {
      resetRuntimeConfigForTests();
    }
  });
});

/** A fake build container that records exec calls + teardown, for the sandbox ops. */
function fakeContainer() {
  const execCalls: string[] = [];
  let removed = 0;
  const container: BuildContainer = {
    async exec(command) {
      execCalls.push(command);
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    async remove() {
      removed += 1;
    },
    sandbox: () => SANDBOX,
  };
  return { container, execCalls, removed: () => removed };
}

describe("runArchitectPhase — wiring over injected deps (no live model / GitHub / Docker)", () => {
  function makeDeps(opts: { sessionText?: string } = {}) {
    const fc = fakeContainer();
    const calls = {
      minted: 0,
      octokitForToken: undefined as string | undefined,
      prompt: undefined as string | undefined,
      sandboxSeen: undefined as SandboxFactory | undefined,
      refSeen: undefined as { owner: string; repo: string } | undefined,
    };
    const deps: ArchitectPhaseDeps = {
      async mintToken() {
        calls.minted += 1;
        return "ghs_arch_token";
      },
      makeOctokit(token) {
        calls.octokitForToken = token;
        return FAKE_OCTOKIT;
      },
      sandboxOps: { createContainer: vi.fn(async () => fc.container) } as BuildSandboxOps,
      async runArchitectSession(_c, ref, _octokit, sandbox, prompt) {
        calls.prompt = prompt;
        calls.sandboxSeen = sandbox;
        calls.refSeen = ref;
        return opts.sessionText ?? "Branch lastlight/42; wrote the plan.";
      },
    };
    return { deps, calls, fc };
  }

  it("mints a repo-write token, builds octokit, pre-clones into a sandbox, runs the architect session, returns its text", async () => {
    const { deps, calls, fc } = makeDeps({ sessionText: "PLAN WRITTEN" });
    const res = await runArchitectPhase(ctx(), RUN, deps);

    expect(res.text).toBe("PLAN WRITTEN");
    expect(calls.minted).toBe(1);
    expect(calls.octokitForToken).toBe("ghs_arch_token");
    // The session got the sandbox (pre-clone happened) + the bound ref.
    expect(calls.sandboxSeen).toBe(SANDBOX);
    expect(calls.refSeen).toEqual(REF);
    // The container was created (pre-clone) and torn down in finally.
    expect((deps.sandboxOps.createContainer as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    expect(fc.removed()).toBe(1);
  });

  it("renders the prompt with repo/branch/issue + wraps untrusted issue text", async () => {
    const { deps, calls } = makeDeps();
    await runArchitectPhase(
      ctx({ issueContext: { body: "make the parser robust", sender: "octo-dev" } }),
      RUN,
      deps,
    );
    expect(calls.prompt).toContain("inside the widget repo at branch lastlight/42");
    expect(calls.prompt).toContain(".lastlight/issue-42/architect-plan.md");
    // The issue body is wrapped UNTRUSTED inside the prompt's contextSnapshot.
    expect(calls.prompt).toContain(UNTRUSTED_OPEN);
    expect(calls.prompt).toContain("make the parser robust");
  });

  it("tears the container down even when the session throws (finally)", async () => {
    const { deps, fc } = makeDeps();
    deps.runArchitectSession = async () => {
      throw new Error("model exploded mid-architect");
    };
    await expect(runArchitectPhase(ctx(), RUN, deps)).rejects.toThrow(
      "model exploded mid-architect",
    );
    expect(fc.removed()).toBe(1);
  });

  it("never leaks the token through the logger", async () => {
    const warn = vi.fn();
    const { deps } = makeDeps();
    const c = {
      payload: { runId: RUN.id, owner: RUN.owner, repo: RUN.repo, issue: RUN.issue },
      log: { info() {}, warn, error() {} },
    } as unknown as FlueContext<BuildInput>;
    await runArchitectPhase(c, RUN, deps);
    for (const call of warn.mock.calls) {
      expect(JSON.stringify(call)).not.toContain("ghs_arch_token");
    }
  });
});
