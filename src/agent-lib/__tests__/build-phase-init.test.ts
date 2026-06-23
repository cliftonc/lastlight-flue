import { describe, it, expect, vi } from "vitest";
import type { SandboxFactory, FlueContext } from "@flue/runtime";
import type { Octokit } from "octokit";
import {
  runGuardrailsPhase,
  runArchitectPhase,
  defaultGuardrailsPhaseDeps,
  defaultArchitectPhaseDeps,
  type BuildInput,
} from "../build-phases.ts";
import { setRuntimeConfig, resetRuntimeConfigForTests } from "../../config.ts";
import type { BuildRun } from "../../build-run-store.ts";
import type { BuildSandboxOps, BuildContainer } from "../build-sandbox.ts";

// Regression for the multi-phase `ctx.init()` collision.
//
// Flue's contract (api/agent-api): "Each harness name may be initialized once
// per context. The default harness name is 'default'." A gateless `flue run
// build` executes several phases in ONE invocation, so each phase MUST init a
// distinctly-named harness. The original code called `ctx.init(agent)` (default
// name) in every phase → the architect phase crashed with
// `init() has already been called with name "default"`.
//
// These tests drive the REAL default session runners (which call `ctx.init`)
// over a Flue-accurate fake `ctx` that throws on a duplicate harness name, with
// the token-mint + Docker sandbox faked so they run fully offline.

const SANDBOX = { __fake: true } as unknown as SandboxFactory;
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

function fakeContainer(): BuildContainer {
  return {
    async exec() {
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    async remove() {},
    sandbox: () => SANDBOX,
  };
}

/** A Flue-accurate fake context: `init` enforces "one harness name per context". */
function makeCtx() {
  const initNames: string[] = [];
  const ctx = {
    payload: { runId: RUN.id, owner: RUN.owner, repo: RUN.repo, issue: RUN.issue },
    log: { info() {}, warn() {}, error() {} },
    async init(_agent: unknown, opts?: { name?: string }) {
      const name = opts?.name ?? "default";
      if (initNames.includes(name)) {
        // Mirror Flue's real error text.
        throw new Error(`[flue] init() has already been called with name "${name}" in this request.`);
      }
      initNames.push(name);
      return {
        name,
        async session() {
          return { async prompt() { return { text: "READY — ok" }; } };
        },
      };
    },
  } as unknown as FlueContext<BuildInput>;
  return { ctx, initNames };
}

/** Override the I/O deps (token mint + Docker) while keeping the REAL session runner. */
function offline<T extends { mintToken: unknown; makeOctokit: unknown; sandboxOps: unknown }>(base: T): T {
  return {
    ...base,
    async mintToken() {
      return "ghs_test_token";
    },
    makeOctokit() {
      return FAKE_OCTOKIT;
    },
    sandboxOps: { createContainer: vi.fn(async () => fakeContainer()) } as unknown as BuildSandboxOps,
  };
}

describe("build phases use a distinct harness name per phase (Flue init-once-per-name)", () => {
  it("runs guardrails THEN architect on one ctx without an init-name collision", async () => {
    setRuntimeConfig({ models: { default: "openai/gpt-5.1" } } as never);
    try {
      const { ctx, initNames } = makeCtx();
      await runGuardrailsPhase(ctx, RUN, offline(defaultGuardrailsPhaseDeps()));
      // Before the fix this threw `init() has already been called with name "default"`.
      await runArchitectPhase(ctx, RUN, offline(defaultArchitectPhaseDeps()));
      expect(initNames).toEqual(["guardrails", "architect"]);
    } finally {
      resetRuntimeConfigForTests();
    }
  });

  it("the fake ctx mirrors Flue: a duplicate harness name throws (so this test can catch a regression)", async () => {
    const { ctx } = makeCtx();
    const agent = {} as never;
    await ctx.init(agent, { name: "x" });
    await expect(ctx.init(agent, { name: "x" })).rejects.toThrow(/already been called/);
  });
});
