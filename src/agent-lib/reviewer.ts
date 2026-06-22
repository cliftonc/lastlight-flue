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
 * SANDBOX (now wired, optional): the reviewer can be built WITH a Docker sandbox so
 * it can inspect the CHECKED-OUT PR code (read files, run read-only commands at
 * `/workspace`) on top of the bound read tools, OR tool-only (sandbox omitted).
 *
 * IMPORTANT — caller-owned lifetime (Spike-2 contract): this factory does NOT
 * create or remove any container. The WORKFLOW (src/workflows/pr-review.ts)
 * `DockerContainer.create()`s, pre-clones the PR at its head ref into `/workspace`,
 * passes `docker(container)` here, and `await container.remove()`s in a `finally`.
 * This factory is a pure mapper from (ref, octokit, sandbox?) → CreatedAgent.
 *
 * ⚠ EGRESS DEFERRED: the container runs with full network + no SSRF floor (the
 * clone reaches github.com over the open network). Do NOT run untrusted input
 * through it. See PROGRESS.md / spec/09.
 */
import { createAgent } from "@flue/runtime";
import type { SandboxFactory } from "@flue/runtime";
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

/** The working directory the PR is pre-cloned into (matches docker.ts WORKSPACE). */
export const REVIEWER_CWD = "/workspace" as const;

/**
 * Build the reviewer agent bound to a specific PR's repo ref + read-scoped Octokit.
 *
 * The Octokit is authenticated with the run's scoped token (review-write profile,
 * but the agent only ever calls READ tools); both `ref` and `octokit` are closed
 * over the tool factories, so the model cannot widen scope.
 *
 * When `sandbox` is supplied (a `docker(container)` factory whose container the
 * CALLER created + pre-cloned the PR into), the agent also gets `cwd: /workspace`
 * so its bash/file tools operate on the checked-out code. When omitted, the agent
 * is tool-only (the proven path) — both forms are valid.
 */
export function createReviewerAgent(
  ref: RepoRef,
  octokit: Octokit,
  sandbox?: SandboxFactory,
) {
  return createAgent(() => ({
    model: resolveModel(REVIEW_TASK_KEY),
    thinkingLevel: resolveThinking(REVIEW_TASK_KEY),
    instructions: loadPersona(),
    tools: githubReadTools(ref, octokit),
    skills: [prReview, building, codeReview],
    ...(sandbox ? { sandbox, cwd: REVIEWER_CWD } : {}),
  }));
}
