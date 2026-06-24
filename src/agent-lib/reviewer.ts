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
import { defineAgent } from "@flue/runtime";
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
 * The PR-review reviewer agent (beta.3: a static `defineAgent`, bound on the
 * `pr-review` workflow). Reviews the PR via the bound READ tools (injected
 * per-call in the workflow) + the PR diff; emits a `VERDICT:` marker. The
 * WORKFLOW posts the review deterministically — the review-submit action is
 * deliberately NOT a model tool.
 *
 * SECURITY SPINE (unchanged): per-run read tools are bound to (ref, scoped-token
 * Octokit) in workflow code and injected via `session.prompt(_, { tools })`.
 *
 * SANDBOX: this migration runs the reviewer TOOL-ONLY (the beta.2 additive Docker
 * checkout is dropped for now; the tool-only path was already the proven fallback).
 * TODO(phase-F/sandbox): optionally re-add `sandbox: dockerSandbox()` + a PR-head
 * clone in the workflow `run()` so the reviewer can inspect checked-out files.
 */
export const reviewerAgent = defineAgent(() => ({
  model: resolveModel(REVIEW_TASK_KEY),
  thinkingLevel: resolveThinking(REVIEW_TASK_KEY),
  instructions: loadPersona(),
  skills: [prReview, building, codeReview],
}));
