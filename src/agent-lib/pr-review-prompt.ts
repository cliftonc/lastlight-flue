/**
 * Assemble the reviewer's prompt for the pr-review workflow.
 *
 * The prompt is intentionally THIN: the `pr-review` skill (imported on the agent)
 * carries the full procedure; this just hands the agent its target (the PR context
 * block) and pins the output contract (end with a VERDICT marker line). Kept as a
 * pure function so the assembly is golden-testable offline (no model, no GitHub).
 */
import { renderTemplate } from "../engine/templates.ts";

export interface ReviewPromptContext {
  owner: string;
  repo: string;
  prNumber: number;
  /** Optional trigger provenance (webhook / cron / cli) for the agent's awareness. */
  triggerType?: string;
}

/**
 * The base review request template. `{{...}}` placeholders are filled by the
 * shared `renderTemplate` engine (Phase 1 ported). The VERDICT contract here MUST
 * stay in lock-step with `parseReviewerVerdict` (engine/verdict.ts).
 */
export const REVIEW_PROMPT_TEMPLATE = `# Review request

You are reviewing an open pull request. Follow the **pr-review** skill's procedure.

## Context
- repository: {{owner}}/{{repo}}
- prNumber: {{prNumber}}
{{#if triggerType}}- trigger: {{triggerType}}{{/if}}

The PR number above is your target — go straight to it; do not list PRs to "find" it.
Read the diff and changed files, absorb the prior discussion, apply the
**code-review** rubric, and write your review.

## Output contract
Do NOT post the review yourself — the workflow posts it deterministically. Your
output's FIRST non-empty line MUST be exactly one of, on its own line with no
leading whitespace:

    VERDICT: APPROVED
    VERDICT: REQUEST_CHANGES

After the marker line, write the review body (summary, findings grouped by tier
with path:line references, an overall assessment, and thanks to the contributor).
`;

/**
 * Render the reviewer prompt for a given PR context. Pure: same inputs → same text.
 */
export function renderReviewPrompt(ctx: ReviewPromptContext): string {
  // renderTemplate's TemplateContext expects a broad shape; we only use the
  // fields referenced by the template. Cast through the loose index signature.
  return renderTemplate(REVIEW_PROMPT_TEMPLATE, {
    owner: ctx.owner,
    repo: ctx.repo,
    prNumber: ctx.prNumber,
    triggerType: ctx.triggerType ?? "",
    // unused-but-required-by-type fields are read lazily; the template never
    // references them, so empty stand-ins are fine.
  } as unknown as Parameters<typeof renderTemplate>[1]);
}
