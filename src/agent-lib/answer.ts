/**
 * The answer agent.
 *
 * NOT a discovered agent: this is a `createAnswerAgent(ref, octokit)` FACTORY (no
 * default export) used by the `answer` workflow, so it lives in `src/agent-lib/`
 * (not `src/agents/`) — Flue discovers every IMMEDIATE file in `src/agents/` as an
 * addressable agent (flue-reference §0 / PROGRESS DISCOVERY RULE), so a non-default
 * export there would be a phantom agent.
 *
 * Phase 5 (design/phase-5-workflows-chat.md → "Single-phase workflows" +
 * ~/work/lastlight/workflows/answer.yaml — kind: answer, skill: issue-answer,
 * model: {{models.answer}}): a newly-opened issue (or a routed comment) asks a
 * QUESTION — the user wants information, an explanation, or a comparison, not a code
 * change. The agent researches and composes ONE sourced, neutral answer. Unlike
 * `issue-comment` (a short bounded reply / build redirect), `answer` is a thorough,
 * skill-backed response to a direct question. It:
 *   - has READ-ONLY GitHub tools bound to (ref, token) — closed over, never
 *     model-selected (spec/09 security spine);
 *   - loads the `issue-answer` skill (the sourced-answer procedure: research the repo
 *     + web, write the answer, label `question`, leave open) by NAME;
 *   - carries the shared persona as `instructions` (loadPersona — incl. security.md);
 *   - resolves model + thinkingLevel for the `answer` task key (config / the
 *     reference's `{{models.answer}}` in answer.yaml).
 *
 * TOOL-ONLY, NO SANDBOX (this slice): the reference answer phase ran with a `context`
 * checkout + `web_search: true` + `unrestricted_egress: true`. The web tools
 * (`web_search`/`web_fetch`) are NOT yet built in this port — design phase-5 §"DRIFT:
 * Flue has no built-in web_search" defers them to a later slice (they land as gated
 * `defineTool`s on the explorer agent). So this slice ports the answer STRUCTURE and
 * scopes the agent to the GitHub/repo-context answer path: it reads the issue + repo
 * via the bound read tools and answers from that. The web-research step is a clearly
 * marked TODO(phase-5/web-tools) seam below — the agent still answers, just without
 * external sources, and the skill already tells it to flag anything it can't verify.
 *
 * The agent's job ends at composing the answer TEXT. The WORKFLOW posts that answer
 * DETERMINISTICALLY over the scoped token (src/answer-post.ts) and applies the
 * `question` label deterministically — the createComment / addLabels side effects are
 * deliberately NOT model tools, mirroring the issue-comment reply→post and pr-review
 * verdict→post splits.
 */
import { createAgent } from "@flue/runtime";
import type { Octokit } from "octokit";
import { githubReadTools, type RepoRef } from "../tools/github-read.ts";
import { loadPersona } from "./persona.ts";
import { resolveModel, resolveThinking } from "../config.ts";
import issueAnswer from "../skills/issue-answer/SKILL.md" with { type: "skill" };

export const description =
  "Researches and composes a sourced answer to a question issue; the workflow posts it deterministically and labels `question`.";

/** The task key both `resolveModel` and `resolveThinking` read for this phase. */
export const ANSWER_TASK_KEY = "answer" as const;

/**
 * Build the answer agent bound to a specific issue's repo ref + read-scoped Octokit.
 *
 * The Octokit is authenticated with the run's scoped token (issues-write profile, but
 * the AGENT only ever calls READ tools — the answer post + label happen
 * deterministically in the workflow); both `ref` and `octokit` are closed over the
 * tool factories, so the model cannot widen scope. No sandbox / web tools this slice
 * (see the module note: web-research is deferred to a later slice).
 */
export function createAnswerAgent(ref: RepoRef, octokit: Octokit) {
  return createAgent(() => ({
    model: resolveModel(ANSWER_TASK_KEY),
    thinkingLevel: resolveThinking(ANSWER_TASK_KEY),
    instructions: loadPersona(),
    tools: githubReadTools(ref, octokit),
    // TODO(phase-5/web-tools): once `web_search`/`web_fetch` land as gated
    // defineTools (design phase-5 §DRIFT), add them here + flip the answer phase
    // to unrestricted-egress so the agent can cite external sources. Until then
    // the agent answers from repo/GitHub context only and flags the unverified.
    skills: [issueAnswer],
    // NO sandbox / cwd — tool-only this slice.
  }));
}
