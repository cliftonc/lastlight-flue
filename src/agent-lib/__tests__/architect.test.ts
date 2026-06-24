import { describe, it, expect, vi } from "vitest";
import type { FlueHarness } from "@flue/runtime";
import type { Octokit } from "octokit";
import {
  architectProfile,
  ARCHITECT_PROFILE_NAME,
  ARCHITECT_TASK_KEY,
} from "../architect.ts";
import {
  runArchitectPhase,
  type ArchitectPhaseDeps,
  type BuildInput,
  type BuildRunCtx,
} from "../build-phases.ts";
import { resolveModel, resolveThinking } from "../../config.ts";
import { loadPersona } from "../persona.ts";
import type { BuildRun } from "../../build-run-store.ts";
import { UNTRUSTED_OPEN } from "../../engine/untrusted.ts";

// beta.3 — architect SUBAGENT-PROFILE config + phase WIRING, all offline (no live model
// / GitHub / Docker). The profile is a STATIC `defineAgentProfile` (resolved at module
// load); the phase wiring (token mint, clone-into-harness, subagent task) is asserted
// over injected deps.

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

describe("architectProfile — static subagent-profile config (model / thinking / persona / skill)", () => {
  it("carries the architect model+thinking task key, the persona, the building skill, and NO tools/sandbox/cwd", () => {
    expect(architectProfile.name).toBe(ARCHITECT_PROFILE_NAME);
    expect(architectProfile.model).toBe(resolveModel(ARCHITECT_TASK_KEY));
    expect(architectProfile.thinkingLevel).toBe(resolveThinking(ARCHITECT_TASK_KEY));
    expect(architectProfile.instructions).toBe(loadPersona());
    // The architect gets the `building` skill (install/test gate).
    expect(architectProfile.skills?.length).toBe(1);
    // Profiles carry NO tools (injected per `session.task`) and NO sandbox/cwd
    // (inherited from the coordinator harness — the shared /workspace checkout).
    expect(architectProfile.tools).toBeUndefined();
    expect((architectProfile as { sandbox?: unknown }).sandbox).toBeUndefined();
  });
});

describe("runArchitectPhase — wiring over injected deps (no live model / GitHub / Docker)", () => {
  function makeDeps(opts: { sessionText?: string } = {}) {
    const calls = {
      minted: 0,
      octokitForToken: undefined as string | undefined,
      prompt: undefined as string | undefined,
      refSeen: undefined as { owner: string; repo: string } | undefined,
      cloned: 0,
      clonedToken: undefined as string | undefined,
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
      async ensureCheckout(_harness, _run, token) {
        calls.cloned += 1;
        calls.clonedToken = token;
      },
      async runArchitectSession(_c, ref, _octokit, prompt) {
        calls.prompt = prompt;
        calls.refSeen = ref;
        return opts.sessionText ?? "Branch lastlight/42; wrote the plan.";
      },
    };
    return { deps, calls };
  }

  it("mints a repo-write token, builds octokit, clones into the harness, runs the architect session, returns its text", async () => {
    const { deps, calls } = makeDeps({ sessionText: "PLAN WRITTEN" });
    const res = await runArchitectPhase(ctx(), RUN, deps);

    expect(res.text).toBe("PLAN WRITTEN");
    expect(calls.minted).toBe(1);
    expect(calls.octokitForToken).toBe("ghs_arch_token");
    expect(calls.refSeen).toEqual(REF);
    // The checkout was ensured (cloned once) with the minted token.
    expect(calls.cloned).toBe(1);
    expect(calls.clonedToken).toBe("ghs_arch_token");
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

  it("propagates a session throw (no swallow)", async () => {
    const { deps } = makeDeps();
    deps.runArchitectSession = async () => {
      throw new Error("model exploded mid-architect");
    };
    await expect(runArchitectPhase(ctx(), RUN, deps)).rejects.toThrow(
      "model exploded mid-architect",
    );
  });

  it("never leaks the token through the logger", async () => {
    const warn = vi.fn();
    const { deps } = makeDeps();
    const c: BuildRunCtx = {
      harness: STUB_HARNESS,
      input: { runId: RUN.id, owner: RUN.owner, repo: RUN.repo, issue: RUN.issue },
      log: { info() {}, warn, error() {} },
    };
    await runArchitectPhase(c, RUN, deps);
    for (const call of warn.mock.calls) {
      expect(JSON.stringify(call)).not.toContain("ghs_arch_token");
    }
  });
});
