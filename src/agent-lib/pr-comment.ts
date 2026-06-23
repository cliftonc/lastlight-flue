/**
 * The pr-comment agent.
 *
 * NOT a discovered agent: this is a `createPrCommentAgent(ref, octokit)` FACTORY
 * (no default export) used by the `pr-comment` workflow, so it lives in
 * `src/agent-lib/` (not `src/agents/`) — Flue discovers every IMMEDIATE file in
 * `src/agents/` as an addressable agent (flue-reference §0 / PROGRESS DISCOVERY
 * RULE), so a non-default-export helper there would be a phantom agent.
 *
 * Phase 5 (design/phase-5-workflows-chat.md → "Single-phase workflows" +
 * ~/work/lastlight/workflows/pr-comment.yaml — kind: comment, skill: pr-comment,
 * model: {{models.comment}}): a maintainer @mentioned the bot on an OPEN PR with a
 * QUESTION about the change (not a build request, not "review this"). pr-comment is
 * the PR-side counterpart to issue-comment — distinguished because PR questions need
 * the DIFF and a higher file-read cap (the skill caps it at 8 reads vs issue-comment's
 * 2). The agent reads the PR + diff + thread and composes ONE evidence-cited reply. It:
 *   - has READ-ONLY GitHub tools bound to (ref, token) — incl. github_get_pull_request
 *     and github_get_pull_request_diff — closed over, never model-selected (spec/09);
 *   - loads the `pr-comment` skill (answer the question with `path:line` evidence in
 *     one comment — at most 8 file reads, no review, no code changes), by NAME;
 *   - carries the shared persona as `instructions` (loadPersona — incl. security.md);
 *   - resolves model + thinkingLevel for the `comment` task key (config / the
 *     reference's `{{models.comment}}` in pr-comment.yaml — same key as issue-comment).
 *
 * TOOL-ONLY, NO SANDBOX (design phase-5 §"Single-phase workflows" + pr-comment.yaml —
 * no `type: context`/checkout, no sandbox flags): the agent reads the PR + diff + code
 * via the bound read tools (the skill explicitly says not to clone unless a single
 * answer genuinely needs cross-file traces no MCP tool can give) and replies in prose.
 * No Docker container is provisioned. A FULL audit is redirected to `pr-review`.
 *
 * The agent's job ends at composing the reply TEXT. The WORKFLOW posts that reply
 * DETERMINISTICALLY over the scoped token (src/issue-comment-post.ts, shared with
 * issue-comment — a PR accepts issue comments at the same endpoint) — the createComment
 * side effect is deliberately NOT a model tool, mirroring the pr-review verdict→post
 * and issue-triage classification→apply splits.
 */
import { createAgent } from "@flue/runtime";
import type { Octokit } from "octokit";
import { githubReadTools, type RepoRef } from "../tools/github-read.ts";
import { loadPersona } from "./persona.ts";
import { resolveModel, resolveThinking } from "../config.ts";
import prComment from "../skills/pr-comment/SKILL.md" with { type: "skill" };

export const description =
  "Answers a maintainer's question about an open PR with code-cited evidence; the workflow posts the reply deterministically.";

/**
 * The task key both `resolveModel` and `resolveThinking` read for this phase. The
 * reference's pr-comment.yaml uses `{{models.comment}}` — the SAME key as
 * issue-comment, so we reuse it rather than minting a new one.
 */
export const COMMENT_TASK_KEY = "comment" as const;

/**
 * Build the pr-comment agent bound to a specific PR's repo ref + read-scoped Octokit.
 *
 * The Octokit is authenticated with the run's scoped token (issues-write profile, but
 * the AGENT only ever calls READ tools — the reply post happens deterministically in
 * the workflow); both `ref` and `octokit` are closed over the tool factories, so the
 * model cannot widen scope. No sandbox: pr-comment is tool-only (design phase-5).
 */
export function createPrCommentAgent(ref: RepoRef, octokit: Octokit) {
  return createAgent(() => ({
    model: resolveModel(COMMENT_TASK_KEY),
    thinkingLevel: resolveThinking(COMMENT_TASK_KEY),
    instructions: loadPersona(),
    tools: githubReadTools(ref, octokit),
    skills: [prComment],
    // NO sandbox / cwd — tool-only.
  }));
}
