import { describe, it, expect } from "vitest";
import type { FlueHarness } from "@flue/runtime";
import type { Octokit } from "octokit";
import {
  runGuardrailsPhase,
  runArchitectPhase,
  defaultGuardrailsPhaseDeps,
  defaultArchitectPhaseDeps,
  type BuildRunCtx,
} from "../build-phases.ts";
import { setRuntimeConfig, resetRuntimeConfigForTests } from "../../config.ts";
import type { BuildRun } from "../../build-run-store.ts";

// beta.3 — build phases share ONE coordinator harness across an invocation.
//
// In beta.2 each phase called `ctx.init(agent, { name })` and a default name
// collided ("init() has already been called with name 'default'"). beta.3 removes
// `ctx.init` entirely: there is ONE bound coordinator agent whose harness owns the
// sandbox, and phases delegate to subagent profiles via `session.task`. The new
// invariant these tests guard: running several phases over ONE shared harness (a)
// delegates each to the right subagent profile and (b) CLONES the checkout exactly
// ONCE (the rest reuse it). The token mint + Octokit are faked so they run offline;
// the REAL default `ensureCheckout` + session runners are exercised over a fake harness.

const FAKE_OCTOKIT = { __fake: "octokit" } as unknown as Octokit;

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

/**
 * A fake coordinator harness recording `shell` commands (the clone) + the subagent
 * profile each `session.task` delegated to. One shared instance models one invocation.
 */
function makeHarness() {
  const shellCmds: string[] = [];
  const taskAgents: string[] = [];
  const session = {
    async task(_text: string, opts?: { agent?: string }) {
      taskAgents.push(opts?.agent ?? "");
      return { text: "READY — ok", usage: undefined, model: undefined };
    },
    async prompt() {
      return { text: "READY — ok", usage: undefined, model: undefined };
    },
  };
  const harness = {
    name: "default",
    async shell(cmd: string) {
      shellCmds.push(cmd);
      if (cmd.includes("rev-parse")) return { stdout: "deadbeef\n", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    async session() {
      return session;
    },
  } as unknown as FlueHarness;
  return { harness, shellCmds, taskAgents };
}

function ctx(harness: FlueHarness): BuildRunCtx {
  return {
    harness,
    input: { runId: RUN.id, owner: RUN.owner, repo: RUN.repo, issue: RUN.issue },
    log: { info() {}, warn() {}, error() {} },
  };
}

/** Override the I/O deps (token mint + Octokit) while keeping the REAL clone + session runner. */
function offline<T extends { mintToken: unknown; makeOctokit: unknown }>(base: T): T {
  return {
    ...base,
    async mintToken() {
      return "ghs_test_token";
    },
    makeOctokit() {
      return FAKE_OCTOKIT;
    },
  };
}

describe("build phases share one coordinator harness (beta.3 — clone once, delegate per profile)", () => {
  it("runs guardrails THEN architect on one harness, delegating each to its subagent profile", async () => {
    setRuntimeConfig({ models: { default: "openai/gpt-5.1" } } as never);
    try {
      const h = makeHarness();
      const c = ctx(h.harness);
      await runGuardrailsPhase(c, RUN, offline(defaultGuardrailsPhaseDeps()));
      await runArchitectPhase(c, RUN, offline(defaultArchitectPhaseDeps()));
      // Each phase delegated to its named subagent profile.
      expect(h.taskAgents).toEqual(["guardrails", "architect"]);
      // The checkout was cloned EXACTLY ONCE for the shared harness (architect reused it).
      const clones = h.shellCmds.filter((c2) => c2.includes("git clone"));
      expect(clones).toHaveLength(1);
    } finally {
      resetRuntimeConfigForTests();
    }
  });

  it("a fresh harness (a resumed run) re-clones — the clone-once guard is per harness", async () => {
    const first = makeHarness();
    await runGuardrailsPhase(ctx(first.harness), RUN, offline(defaultGuardrailsPhaseDeps()));
    expect(first.shellCmds.filter((c) => c.includes("git clone"))).toHaveLength(1);

    // A different harness instance (a re-invoke) clones again — continuing the remote tip.
    const second = makeHarness();
    await runGuardrailsPhase(ctx(second.harness), RUN, offline(defaultGuardrailsPhaseDeps()));
    expect(second.shellCmds.filter((c) => c.includes("git clone"))).toHaveLength(1);
  });
});
