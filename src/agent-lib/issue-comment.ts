/**
 * The issue-comment agent.
 *
 * NOT a discovered agent: this is a `createIssueCommentAgent(ref, octokit)` FACTORY
 * (no default export) used by the `issue-comment` workflow, so it lives in
 * `src/agent-lib/` (not `src/agents/`) — Flue discovers every IMMEDIATE file in
 * `src/agents/` as an addressable agent (flue-reference §0 / PROGRESS DISCOVERY
 * RULE), so a non-default-export helper there would be a phantom agent.
 *
 * Phase 5 (design/phase-5-workflows-chat.md → "Single-phase workflows"): a maintainer
 * @mentioned the bot on an issue/PR with a request that is NOT a build — the agent
 * reads the thread + repo context and composes ONE short, helpful reply. It:
 *   - has READ-ONLY GitHub tools bound to (ref, token) — closed over, never
 *     model-selected (spec/09 security spine);
 *   - loads the `issue-comment` skill (the bounded-action state machine: answer a
 *     brief question / redirect a build request — at most 2 reads, 1 reply), by NAME;
 *   - carries the shared persona as `instructions` (loadPersona — incl. security.md);
 *   - resolves model + thinkingLevel for the `comment` task key (config / the
 *     reference's `{{models.comment}}` in issue-comment.yaml).
 *
 * TOOL-ONLY, NO SANDBOX (design phase-5 §"Single-phase workflows" + the reference
 * issue-comment.yaml — no `type: context`/checkout, no sandbox flags): the agent
 * reads the issue/PR + thread via the bound read tools and replies in prose. It never
 * needs a repo checkout, so no Docker container is provisioned (the issue-comment
 * skill caps it at ≤2 file reads and explicitly forbids code changes / branches).
 *
 * The agent's job ends at composing the reply TEXT. The WORKFLOW posts that reply
 * DETERMINISTICALLY over the scoped token (src/issue-comment-post.ts) — the
 * createComment side effect is deliberately NOT a model tool, mirroring the pr-review
 * verdict→post and issue-triage classification→apply splits.
 */
import { createAgent } from "@flue/runtime";
import type { Octokit } from "octokit";
import { githubReadTools, type RepoRef } from "../tools/github-read.ts";
import { loadPersona } from "./persona.ts";
import { resolveModel, resolveThinking } from "../config.ts";
import issueComment from "../skills/issue-comment/SKILL.md" with { type: "skill" };

export const description =
  "Composes a short, helpful reply to a maintainer comment on an issue/PR; the workflow posts it deterministically.";

/** The task key both `resolveModel` and `resolveThinking` read for this phase. */
export const COMMENT_TASK_KEY = "comment" as const;

/**
 * Build the issue-comment agent bound to a specific issue/PR's repo ref + read-scoped
 * Octokit.
 *
 * The Octokit is authenticated with the run's scoped token (issues-write profile, but
 * the AGENT only ever calls READ tools — the reply post happens deterministically in
 * the workflow); both `ref` and `octokit` are closed over the tool factories, so the
 * model cannot widen scope. No sandbox: issue-comment is tool-only (design phase-5).
 */
export function createIssueCommentAgent(ref: RepoRef, octokit: Octokit) {
  return createAgent(() => ({
    model: resolveModel(COMMENT_TASK_KEY),
    thinkingLevel: resolveThinking(COMMENT_TASK_KEY),
    instructions: loadPersona(),
    tools: githubReadTools(ref, octokit),
    skills: [issueComment],
    // NO sandbox / cwd — tool-only.
  }));
}
