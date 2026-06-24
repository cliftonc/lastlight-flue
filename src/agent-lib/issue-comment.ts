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
import { defineAgent } from "@flue/runtime";
import { loadPersona } from "./persona.ts";
import { resolveModel, resolveThinking } from "../config.ts";
import issueComment from "../skills/issue-comment/SKILL.md" with { type: "skill" };

export const description =
  "Composes a short, helpful reply to a maintainer comment on an issue/PR; the workflow posts it deterministically.";

/** The task key both `resolveModel` and `resolveThinking` read for this phase. */
export const COMMENT_TASK_KEY = "comment" as const;

/**
 * The issue-comment agent definition (beta.3: a static `defineAgent`, bound on the
 * `issue-comment` workflow). Model/thinking/persona/skills are resolved in the
 * initializer (env-dependent policy belongs here per the beta.3 contract — the
 * initializer cannot see workflow input).
 *
 * SECURITY SPINE (unchanged): the agent carries NO write tools. The per-run
 * READ-only GitHub tools are bound to (ref, scoped-token Octokit) in trusted
 * workflow code and injected per-call via `session.prompt(prompt, { tools })`,
 * so `owner`/`repo`/token are closed over and never model-selectable. No sandbox:
 * issue-comment is tool-only (design phase-5).
 */
export const issueCommentAgent = defineAgent(() => ({
  model: resolveModel(COMMENT_TASK_KEY),
  thinkingLevel: resolveThinking(COMMENT_TASK_KEY),
  instructions: loadPersona(),
  skills: [issueComment],
  // NO sandbox / cwd — tool-only. NO static tools — read tools injected per-call.
}));
