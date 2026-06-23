/**
 * The security-feedback agent.
 *
 * NOT a discovered agent: this is a `createSecurityFeedbackAgent(ref, octokit)` FACTORY
 * (no default export) used by the `security-feedback` workflow, so it lives in
 * `src/agent-lib/` (not `src/agents/`) — Flue discovers every IMMEDIATE file in
 * `src/agents/` as an addressable agent (flue-reference §0 / PROGRESS DISCOVERY RULE), so a
 * non-default export there would be a phantom agent.
 *
 * Phase 5 (~/work/lastlight/workflows/security-feedback.yaml — `kind: health`, single phase
 * `feedback`, skill: security-feedback, model: {{models.security}}). Triggered by a
 * `@last-light` mention on a `security`-labelled issue — almost always the per-run scan
 * SUMMARY issue that `security-review` files. The agent reads the maintainer's comment +
 * the parsed scan, and CLASSIFIES the intent + selection (the `FEEDBACK:` marker); the
 * WORKFLOW then creates the sub-issues / rewrites the parent / posts the summary
 * deterministically (src/security-feedback-post.ts) — judgment is agent-side, the side
 * effects are pulled off the model surface (spec/09), mirroring triage's
 * CLASSIFICATION→apply and pr-review's VERDICT→post splits.
 *
 * Config mirrors issue-comment / repo-health (the TOOL-ONLY single-phase pattern):
 *   - READ-ONLY GitHub tools bound to (ref, token) — closed over, never model-selected;
 *   - the `security-feedback` skill (the classify → select → act state machine + the
 *     scan-issue grammar), surfaced by NAME;
 *   - the shared persona as `instructions` (loadPersona — incl. agent-context/security.md),
 *     anchoring the untrusted-content markers in the feedback prompt's parent-issue snapshot;
 *   - model + thinkingLevel for the `security` task key (config / the reference's
 *     `{{models.security}}` in security-feedback.yaml — the SAME key as security-review).
 *
 * TOOL-ONLY, NO SANDBOX for the PRIMARY (create-issues) flow: the agent reads the parent
 * scan issue + the comment via bound read tools and classifies — no checkout. (The
 * reference's secondary accept-risk / false-positive branch clones the repo to edit
 * SECURITY.md and open a PR; that path is deferred — see src/security-feedback-post.ts.)
 */
import { createAgent } from "@flue/runtime";
import type { Octokit } from "octokit";
import { githubReadTools, type RepoRef } from "../tools/github-read.ts";
import { loadPersona } from "./persona.ts";
import { resolveModel, resolveThinking } from "../config.ts";
import securityFeedback from "../skills/security-feedback/SKILL.md" with { type: "skill" };

export const description =
  "Classifies a maintainer's comment on a security scan-summary issue and selects findings; the workflow breaks them out into sub-issues deterministically.";

/**
 * The task key both `resolveModel` and `resolveThinking` read for this phase — the SAME
 * `security` key as security-review (the reference uses `{{models.security}}` for both).
 */
export const SECURITY_FEEDBACK_TASK_KEY = "security" as const;

/**
 * Build the security-feedback agent bound to the scan issue's repo ref + read-scoped
 * Octokit. `ref`/`octokit` are closed over the read-tool factories (the model cannot widen
 * scope to another repo). No write tool is bound — the sub-issue creation / parent rewrite /
 * summary comment are done deterministically by the workflow. No sandbox: the create-issues
 * flow is tool-only.
 */
export function createSecurityFeedbackAgent(ref: RepoRef, octokit: Octokit) {
  return createAgent(() => ({
    model: resolveModel(SECURITY_FEEDBACK_TASK_KEY),
    thinkingLevel: resolveThinking(SECURITY_FEEDBACK_TASK_KEY),
    instructions: loadPersona(),
    tools: githubReadTools(ref, octokit),
    skills: [securityFeedback],
    // NO sandbox / cwd — tool-only (classifies the comment against the parsed scan).
  }));
}
