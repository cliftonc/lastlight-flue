/**
 * The build GUARDRAILS agent — the pre-flight screening agent.
 *
 * NOT a discovered agent: this is a `createGuardrailsAgent(ref, octokit, sandbox)`
 * FACTORY (no default export) used by the `build` workflow's guardrails phase, so
 * it lives in `src/agent-lib/` (Flue discovers every IMMEDIATE file in
 * `src/agents/` as an addressable agent — see PROGRESS / flue-reference §0).
 *
 * Phase 4 (design/phase-4-build-gate.md). Guardrails runs FIRST, BEFORE the
 * architect: it screens the pre-cloned repo for a working test/lint/typecheck
 * baseline and emits exactly one of READY / BLOCKED (the prompt↔code marker the
 * workflow parses). A BLOCKED verdict stops the build — UNLESS the issue is itself
 * a bootstrap task (the `lastlight:bootstrap` label / a `guardrails:` title prefix),
 * in which case the workflow bypasses the BLOCK so the executor can ESTABLISH the
 * missing tooling (parity with build.yaml `contains_BLOCKED.unless_*`).
 *
 * Config MIRRORS the architect (the design's "it's a screen" note — same shape,
 * different task key):
 *   - model + thinkingLevel for the `guardrails` task key (config);
 *   - READ-ONLY GitHub tools bound to (ref, token) — closed over, never
 *     model-selected (spec/09 security spine);
 *   - the `building` skill (the install/test-gate discipline it checks for);
 *   - the shared persona as `instructions` (loadPersona), carrying security.md so
 *     the untrusted issue text in the prompt is treated as data.
 *
 * SANDBOX (required, not additive): the guardrails prompt inspects the pre-cloned
 * repo (it runs the test/lint/typecheck commands + commits a report), so it ALWAYS
 * runs WITH a Docker sandbox — the WORKFLOW (`build.ts` → `withBuildSandbox`) owns
 * the container lifetime exactly as for the architect. This factory is a pure
 * mapper from (ref, octokit, sandbox) → CreatedAgent; it creates/removes nothing.
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
  "Pre-flight guardrails screen: checks a pre-cloned repo's test/lint/typecheck baseline and emits READY or BLOCKED.";

/** The task key both `resolveModel` and `resolveThinking` read for this phase. */
export const GUARDRAILS_TASK_KEY = "guardrails" as const;

/** The working directory the repo is pre-cloned into (matches docker.ts WORKSPACE). */
export const GUARDRAILS_CWD = "/workspace" as const;

/**
 * Build the guardrails agent bound to a repo ref + scoped Octokit + the build
 * sandbox. `ref`/`octokit` are closed over the read-tool factories (the model
 * cannot widen scope); `cwd: /workspace` points the agent's bash/file tools at the
 * pre-cloned checkout where it runs the baseline checks + commits the report.
 */
export function createGuardrailsAgent(
  ref: RepoRef,
  octokit: Octokit,
  sandbox: SandboxFactory,
) {
  return createAgent(() => ({
    model: resolveModel(GUARDRAILS_TASK_KEY),
    thinkingLevel: resolveThinking(GUARDRAILS_TASK_KEY),
    instructions: loadPersona(),
    tools: githubReadTools(ref, octokit),
    skills: [building],
    sandbox,
    cwd: GUARDRAILS_CWD,
  }));
}
