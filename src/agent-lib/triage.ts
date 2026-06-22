/**
 * The issue-triage agent.
 *
 * NOT a discovered agent: this is a `createTriageAgent(ref, octokit)` FACTORY
 * (no default export) used by the `issue-triage` workflow, so it lives in
 * `src/agent-lib/` (not `src/agents/`) — Flue discovers every IMMEDIATE file in
 * `src/agents/` as an addressable agent (flue-reference §0 / PROGRESS DISCOVERY
 * RULE), so a non-default-export helper there would be a phantom agent.
 *
 * Phase 5 (design/phase-5-workflows-chat.md → "Single-phase workflows"): the triage
 * agent is a single read-only pass over the `issue-triage` skill. It:
 *   - has READ-ONLY GitHub tools bound to (ref, token) — closed over, never
 *     model-selected (spec/09 security spine);
 *   - loads the `issue-triage` skill (the canonical state machine), surfaced by NAME;
 *   - carries the shared persona as `instructions` (loadPersona — incl. security.md);
 *   - resolves model + thinkingLevel for the `triage` task key (config).
 *
 * TOOL-ONLY, NO SANDBOX (confirmed against design phase-5 §"Single-phase workflows"
 * + the trivial-run() sketch): triage reads the issue + searches for duplicates via
 * the bound read tools — it never needs a repo checkout, so no Docker container is
 * provisioned (cheaper + lower-latency than the sandboxed build/review agents).
 *
 * The agent's job ends at emitting a `CLASSIFICATION:` marker (+ an optional comment
 * body). The WORKFLOW applies the labels / comment / close DETERMINISTICALLY over
 * the scoped token (src/triage-post.ts) — the label/close side effects are
 * deliberately NOT model tools here, mirroring the pr-review verdict→post split.
 */
import { createAgent } from "@flue/runtime";
import type { Octokit } from "octokit";
import { githubReadTools, type RepoRef } from "../tools/github-read.ts";
import { loadPersona } from "./persona.ts";
import { resolveModel, resolveThinking } from "../config.ts";
import issueTriage from "../skills/issue-triage/SKILL.md" with { type: "skill" };

export const description =
  "Triages an open GitHub issue and emits a CLASSIFICATION marker; the workflow applies the labels/comment/close deterministically.";

/** The task key both `resolveModel` and `resolveThinking` read for this phase. */
export const TRIAGE_TASK_KEY = "triage" as const;

/**
 * Build the triage agent bound to a specific issue's repo ref + read-scoped Octokit.
 *
 * The Octokit is authenticated with the run's scoped token (issues-write profile,
 * but the AGENT only ever calls READ tools — the writes happen deterministically in
 * the workflow); both `ref` and `octokit` are closed over the tool factories, so the
 * model cannot widen scope. No sandbox: triage is tool-only (design phase-5).
 */
export function createTriageAgent(ref: RepoRef, octokit: Octokit) {
  return createAgent(() => ({
    model: resolveModel(TRIAGE_TASK_KEY),
    thinkingLevel: resolveThinking(TRIAGE_TASK_KEY),
    instructions: loadPersona(),
    tools: githubReadTools(ref, octokit),
    skills: [issueTriage],
    // NO sandbox / cwd — tool-only.
  }));
}
