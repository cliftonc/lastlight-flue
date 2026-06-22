/**
 * The build EXECUTOR agent.
 *
 * NOT a discovered agent: this is a `createExecutorAgent(ref, octokit, sandbox)`
 * FACTORY (no default export) used by the `build` workflow's executor phase, so it
 * lives in `src/agent-lib/` — Flue discovers every IMMEDIATE file in `src/agents/`
 * as an addressable agent, so a non-default-export helper there would be
 * mis-discovered (see PROGRESS / flue-reference §0).
 *
 * Phase 4 (design/phase-4-build-gate.md). The executor runs AFTER the
 * `post_architect` gate is approved. It runs as a top-level
 * `harness.session('executor')` (NOT a subagent — the design's role split is
 * separate sessions in run(), so a post-gate resume re-enters the right
 * conversation). It reads the architect's committed plan
 * (`.lastlight/issue-<N>/architect-plan.md`) from the pre-cloned checkout,
 * implements the file manifest in `/workspace`, runs the install/test gate, and
 * COMMITS the changes to the working branch via the SANDBOX GIT CLI (model-directed
 * shell — NOT a defineTool; spec/09 keeps credentials/repo out of model-selectable
 * tool args). It does NOT push: the workflow pushes the branch deterministically
 * over the repo-write token after the session ends (the mockable push seam).
 *
 * Config mirrors the architect (same shape, executor task key):
 *   - READ-ONLY GitHub tools bound to (ref, token) — closed over, never
 *     model-selected (spec/09 security spine). Code lands via the sandbox git CLI,
 *     not a github write tool.
 *   - the `building` skill (install deps + run the full test/lint/typecheck gate
 *     before committing), surfaced by NAME;
 *   - the shared persona as `instructions` (loadPersona), carrying
 *     `agent-context/security.md`;
 *   - model + thinkingLevel for the `executor` task key (config; falls back to
 *     `default` when no explicit executor entry is configured).
 *
 * SANDBOX (required, not additive): the executor ALWAYS runs WITH a Docker sandbox
 * — the WORKFLOW (`build.ts` → `withBuildSandbox`) owns the container lifetime: it
 * creates the container, pre-clones the repo at the working branch into
 * `/workspace` (the architect's committed plan is on that branch), passes
 * `docker(container)` here, and `remove()`s it in a `finally`. This factory is a
 * pure mapper from (ref, octokit, sandbox) → CreatedAgent; it creates/removes
 * nothing.
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
  "Reads the architect's committed plan and implements + commits it on the working branch (the executor phase).";

/** The task key both `resolveModel` and `resolveThinking` read for this phase. */
export const EXECUTOR_TASK_KEY = "executor" as const;

/** The working directory the repo is pre-cloned into (matches docker.ts WORKSPACE). */
export const EXECUTOR_CWD = "/workspace" as const;

/**
 * Build the executor agent bound to a repo ref + scoped Octokit + the build
 * sandbox. `ref`/`octokit` are closed over the read-tool factories (the model
 * cannot widen scope); `cwd: /workspace` points the agent's bash/file tools at the
 * pre-cloned checkout where it reads the plan, implements, and commits.
 */
export function createExecutorAgent(
  ref: RepoRef,
  octokit: Octokit,
  sandbox: SandboxFactory,
) {
  return createAgent(() => ({
    model: resolveModel(EXECUTOR_TASK_KEY),
    thinkingLevel: resolveThinking(EXECUTOR_TASK_KEY),
    instructions: loadPersona(),
    tools: githubReadTools(ref, octokit),
    skills: [building],
    sandbox,
    cwd: EXECUTOR_CWD,
  }));
}
