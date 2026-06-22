/**
 * The build ARCHITECT agent.
 *
 * NOT a discovered agent: this is a `createArchitectAgent(ref, octokit, sandbox)`
 * FACTORY (no default export) used by the `build` workflow's architect phase, so
 * it lives in `src/agent-lib/` — Flue discovers every IMMEDIATE file in
 * `src/agents/` as an addressable agent, so a non-default-export helper there
 * would be mis-discovered (see PROGRESS / flue-reference §0).
 *
 * Phase 4 (design/phase-4-build-gate.md). The architect is the FIRST real build
 * phase: it runs as a top-level `harness.session('architect')` (NOT a subagent —
 * the design's role split is separate sessions in run(), so resume can re-enter),
 * reads the issue + the pre-cloned repo, and writes + commits an implementation
 * PLAN to `.lastlight/issue-<N>/architect-plan.md` on the working branch (the
 * durable cross-phase handoff — spec/07). Its output is text/markdown.
 *
 * Config mirrors the reviewer:
 *   - READ-ONLY GitHub tools bound to (ref, token) — closed over, never
 *     model-selected (spec/09 security spine);
 *   - the `building` skill (install/test-gate discipline for the pre-cloned repo),
 *     surfaced by NAME;
 *   - the shared persona as `instructions` (loadPersona) — which carries
 *     `agent-context/security.md`, anchoring the untrusted-content markers in the
 *     architect prompt's contextSnapshot;
 *   - model + thinkingLevel for the `architect` task key (config).
 *
 * SANDBOX (required, not additive): the architect ALWAYS runs WITH a Docker
 * sandbox — the WORKFLOW (`build.ts` → `withBuildSandbox`) owns the container
 * lifetime: it creates the container, pre-clones the repo at the working branch
 * into `/workspace`, passes `docker(container)` here, and `remove()`s it in a
 * `finally`. This factory is a pure mapper from (ref, octokit, sandbox) →
 * CreatedAgent; it creates/removes nothing.
 *
 * ⚠ EGRESS DEFERRED: the container runs with full network + no SSRF floor. Do NOT
 * run untrusted input through it. See PROGRESS.md / spec/09.
 */
import { createAgent } from "@flue/runtime";
import type { SandboxFactory } from "@flue/runtime";
import type { Octokit } from "octokit";
import { githubReadTools, type RepoRef } from "../tools/github-read.ts";
import { loadPersona } from "./persona.ts";
import { resolveModel, resolveThinking } from "../config.ts";
import building from "../skills/building/SKILL.md" with { type: "skill" };

export const description =
  "Analyzes a pre-cloned repo + issue and writes a committed implementation plan (architect-plan.md) for the executor.";

/** The task key both `resolveModel` and `resolveThinking` read for this phase. */
export const ARCHITECT_TASK_KEY = "architect" as const;

/** The working directory the repo is pre-cloned into (matches docker.ts WORKSPACE). */
export const ARCHITECT_CWD = "/workspace" as const;

/**
 * Build the architect agent bound to a repo ref + scoped Octokit + the build
 * sandbox. `ref`/`octokit` are closed over the read-tool factories (the model
 * cannot widen scope); `cwd: /workspace` points the agent's bash/file tools at
 * the pre-cloned checkout where it writes + commits the plan.
 */
export function createArchitectAgent(
  ref: RepoRef,
  octokit: Octokit,
  sandbox: SandboxFactory,
) {
  return createAgent(() => ({
    model: resolveModel(ARCHITECT_TASK_KEY),
    thinkingLevel: resolveThinking(ARCHITECT_TASK_KEY),
    instructions: loadPersona(),
    tools: githubReadTools(ref, octokit),
    skills: [building],
    sandbox,
    cwd: ARCHITECT_CWD,
  }));
}
