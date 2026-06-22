/**
 * The PR-review reviewer agent.
 *
 * NOT a discovered agent: this is a `createReviewerAgent(ref, octokit)` FACTORY
 * (no default export) used by the `pr-review` workflow, so it lives in
 * `src/agent-lib/` (not `src/agents/`) — Flue discovers every IMMEDIATE file in
 * `src/agents/` as an addressable agent, so a non-default-export helper there
 * would be mis-discovered as a phantom agent. See PROGRESS / flue-reference §0.
 *
 * Phase 3 vertical slice (design/phase-3-pr-review.md). The reviewer:
 *   - has READ-ONLY GitHub tools bound to (ref, token) — closed over, never
 *     model-selected (spec/09 security spine);
 *   - loads the `pr-review` procedure + the `building` (install/test gate) +
 *     `code-review` (rubric) skills, surfaced to the model by NAME;
 *   - carries the shared persona as `instructions` (loadPersona);
 *   - resolves model + thinkingLevel for the `review` task key (config).
 *
 * Its job ends at emitting a `VERDICT:` marker + a review body. The WORKFLOW posts
 * the review deterministically (src/github-post.ts) — the review-submit action is
 * deliberately NOT a model tool here.
 *
 * ⚠ SANDBOX DEFERRED FOR THIS SLICE (recorded deviation): the design's sketch puts
 * the reviewer in a managed sandbox so it can `git checkout` the PR and run the
 * build/test gate. For slice 1 the reviewer is TOOL-ONLY — it reads the PR diff and
 * files via the bound read tools (github_get_pull_request_diff / _file_contents),
 * with NO sandbox. This keeps the slice's core (verdict → deterministic post) fully
 * proven while leaving the build/test gate (which needs the Docker factory wired in)
 * to a later slice. The `sandbox` field is intentionally omitted; wire it via
 * `docker(container)` when the build gate lands. See PROGRESS.md.
 */
import { createAgent } from "@flue/runtime";
import type { Octokit } from "octokit";
import { githubReadTools, type RepoRef } from "../tools/github-read.ts";
import { loadPersona } from "./persona.ts";
import { resolveModel, resolveThinking } from "../config.ts";
import prReview from "../skills/pr-review/SKILL.md" with { type: "skill" };
import building from "../skills/building/SKILL.md" with { type: "skill" };
import codeReview from "../skills/code-review/SKILL.md" with { type: "skill" };

export const description =
  "Reviews an open GitHub pull request and emits a VERDICT marker; the workflow posts the review deterministically.";

/** The task key both `resolveModel` and `resolveThinking` read for this phase. */
export const REVIEW_TASK_KEY = "review" as const;

/**
 * Build the reviewer agent bound to a specific PR's repo ref + read-scoped Octokit.
 *
 * The Octokit is authenticated with the run's scoped token (review-write profile,
 * but the agent only ever calls READ tools); both `ref` and `octokit` are closed
 * over the tool factories, so the model cannot widen scope.
 */
export function createReviewerAgent(ref: RepoRef, octokit: Octokit) {
  return createAgent(() => ({
    model: resolveModel(REVIEW_TASK_KEY),
    thinkingLevel: resolveThinking(REVIEW_TASK_KEY),
    instructions: loadPersona(),
    tools: githubReadTools(ref, octokit),
    skills: [prReview, building, codeReview],
    // sandbox: DEFERRED for this slice — see the module header.
  }));
}
