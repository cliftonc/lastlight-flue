/**
 * Assemble the REVIEWER / RE-REVIEWER / FIX phase prompts for the `build` workflow's
 * reviewer loop.
 *
 * The prompt bodies are the ported `src/prompts/{reviewer,re-reviewer,fix}.md` (Flue
 * inlines them at build time via `with { type: 'markdown' }`). This module renders
 * them through the shared `renderTemplate` engine with the build context
 * (`repo`/`branch`/`issueDir`/`issueNumber` + `fixCycle` for the fix/re-review).
 *
 * THE ARTIFACTS ARE THE HANDOFF (spec/07, design/phase-4): the reviewer commits
 * `.lastlight/issue-<N>/reviewer-verdict.md` in the checkout; the fix agent reads
 * that file (its cwd is the checkout) and the re-reviewer reads it back — none of
 * these blobs is inlined into the prompt (they are branch files, not session memory
 * — spec/10 split rule; a resume re-reads them from disk). The reviewer notes flow
 * to the fix phase via that committed file (named in the prompt), and the verdict
 * marker flows to the durable loop via the run-record scratch (`verdict:N`).
 *
 * Pure functions → golden-testable offline (no model, no GitHub).
 */
import reviewerTemplate from "../prompts/reviewer.md" with { type: "markdown" };
import reReviewerTemplate from "../prompts/re-reviewer.md" with { type: "markdown" };
import fixTemplate from "../prompts/fix.md" with { type: "markdown" };
import { renderTemplate, type TemplateContext } from "../engine/templates.ts";
import { issueDirFor } from "./architect-prompt.ts";

/** The reviewer-verdict artifact path (run-record pointer + branch file). */
export function reviewerVerdictPath(issue: number): string {
  return `${issueDirFor(issue)}/reviewer-verdict.md`;
}

export interface ReviewerPromptContext {
  owner: string;
  repo: string;
  issue: number;
  branch: string;
}

/** Shared base context for every reviewer-loop prompt (no untrusted user text). */
function baseContext(ctx: ReviewerPromptContext): TemplateContext {
  return {
    owner: ctx.owner,
    repo: ctx.repo,
    branch: ctx.branch,
    issueNumber: ctx.issue,
    issueDir: issueDirFor(ctx.issue),
  } as unknown as TemplateContext;
}

/**
 * Render the REVIEWER prompt (first review of the executor's committed changes).
 * Pure: same inputs → same text.
 */
export function renderReviewerPrompt(ctx: ReviewerPromptContext): string {
  return renderTemplate(reviewerTemplate, baseContext(ctx));
}

/**
 * Render the RE-REVIEWER prompt for fix cycle `fixCycle` (re-review after the fix).
 * Pure: same inputs → same text. `fixCycle` is the loop iteration index the fix
 * just ran in (so the re-reviewer reads the matching summary section).
 */
export function renderReReviewerPrompt(
  ctx: ReviewerPromptContext,
  fixCycle: number,
): string {
  return renderTemplate(reReviewerTemplate, {
    ...baseContext(ctx),
    fixCycle,
  } as unknown as TemplateContext);
}

/**
 * Render the FIX prompt for fix cycle `fixCycle`. The agent reads
 * `.lastlight/issue-<N>/reviewer-verdict.md` from the checkout (the reviewer notes
 * are the handoff — NOT inlined), addresses ONLY those issues, runs the gate, and
 * commits. Pure: same inputs → same text.
 */
export function renderFixPrompt(
  ctx: ReviewerPromptContext,
  fixCycle: number,
): string {
  return renderTemplate(fixTemplate, {
    ...baseContext(ctx),
    fixCycle,
  } as unknown as TemplateContext);
}
