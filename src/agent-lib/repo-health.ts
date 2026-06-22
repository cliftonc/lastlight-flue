/**
 * The repo-health agent.
 *
 * NOT a discovered agent: this is a `createHealthAgent(ref, octokit)` FACTORY (no
 * default export) used by the `repo-health` workflow, so it lives in `src/agent-lib/`
 * (not `src/agents/`) — Flue discovers every IMMEDIATE file in `src/agents/` as an
 * addressable agent (flue-reference §0 / PROGRESS DISCOVERY RULE), so a non-default
 * export there would be a phantom agent.
 *
 * Phase 5 (design/phase-5-workflows-chat.md → "Single-phase workflows" +
 * ~/work/lastlight/workflows/repo-health.yaml — kind: health, skill: repo-health,
 * model: {{models.health}}): a cron- or CLI-triggered, REPO-SCOPED scan (no specific
 * issue/PR). The agent gathers the repo's health metrics — open-issue and PR backlog,
 * unreviewed PRs, stale `needs-info`, recent throughput — and composes ONE point-in-time
 * report with the action items it implies. It:
 *   - has READ-ONLY GitHub tools bound to (ref, token) — closed over, never
 *     model-selected (spec/09 security spine). It uses listIssues / listPullRequests /
 *     searchIssues / getRepository / listIssueComments to gather the numbers;
 *   - loads the `repo-health` skill (the gather → derive-action-items → render →
 *     deliver procedure) by NAME;
 *   - carries the shared persona as `instructions` (loadPersona — incl. security.md);
 *   - resolves model + thinkingLevel for the `health` task key (config / the
 *     reference's `{{models.health}}` in repo-health.yaml).
 *
 * TOOL-ONLY, NO SANDBOX: the reference repo-health phase had no checkout — it pulls
 * everything via `github_*` tools (the skill says so explicitly: "Pull these via
 * github_* MCP tools"). No code is inspected, so no sandbox / cwd.
 *
 * The agent's job ends at composing the report TEXT. The WORKFLOW delivers that report
 * DETERMINISTICALLY over the scoped token (src/repo-health-post.ts) into an idempotent
 * per-repo tracking issue — the create/update side effect is deliberately NOT a model
 * tool, mirroring the answer/triage/issue-comment deterministic-post splits.
 */
import { createAgent } from "@flue/runtime";
import type { Octokit } from "octokit";
import { githubReadTools, type RepoRef } from "../tools/github-read.ts";
import { loadPersona } from "./persona.ts";
import { resolveModel, resolveThinking } from "../config.ts";
import repoHealth from "../skills/repo-health/SKILL.md" with { type: "skill" };

export const description =
  "Scans a repository's issue/PR backlog and composes a point-in-time health report; the workflow delivers it deterministically to a tracking issue.";

/** The task key both `resolveModel` and `resolveThinking` read for this phase. */
export const HEALTH_TASK_KEY = "health" as const;

/**
 * Build the repo-health agent bound to a specific repo ref + read-scoped Octokit.
 *
 * The Octokit is authenticated with the run's scoped token; the AGENT only ever calls
 * READ tools — the tracking-issue create/update happens deterministically in the
 * workflow. Both `ref` and `octokit` are closed over the tool factories, so the model
 * cannot widen scope to another repo. No sandbox (tool-only — the skill gathers metrics
 * entirely via `github_*` reads).
 */
export function createHealthAgent(ref: RepoRef, octokit: Octokit) {
  return createAgent(() => ({
    model: resolveModel(HEALTH_TASK_KEY),
    thinkingLevel: resolveThinking(HEALTH_TASK_KEY),
    instructions: loadPersona(),
    tools: githubReadTools(ref, octokit),
    skills: [repoHealth],
    // NO sandbox / cwd — tool-only (reads repo state via bound github tools).
  }));
}
