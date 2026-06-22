/**
 * Assemble the `pr-fix` workflow prompt.
 *
 * The prompt body is the ported `src/prompts/pr-fix.md` (Flue inlines it at build
 * time via `with { type: 'markdown' }`). This module renders it through the shared
 * `renderTemplate` engine with the PR context (`repo`/`branch`/`prNumber`/
 * `prTitle`) plus the maintainer fix request and any CI / failing-checks context.
 *
 * UNTRUSTED CONTENT (spec/07 invariant): the fix request and the CI text are
 * MAINTAINER- / CI-authored and therefore UNTRUSTED — they are wrapped in
 * `<<<USER_CONTENT_UNTRUSTED …>>>` markers (`wrapUntrusted`) so the fix agent,
 * anchored by `agent-context/security.md` in its persona, treats them as DATA, not
 * instructions. The PR title is likewise wrapped (it is user-authored). Trigger
 * metadata (repo ref, branch, PR number) sits OUTSIDE the wrappers.
 *
 * Pure function → golden-testable offline (no model, no GitHub).
 */
import prFixTemplate from "../prompts/pr-fix.md" with { type: "markdown" };
import { renderTemplate, type TemplateContext } from "../engine/templates.ts";
import { wrapUntrusted } from "../engine/untrusted.ts";

export interface PrFixPromptContext {
  owner: string;
  repo: string;
  /** The PR head branch the fix lands on (the pre-cloned checkout). */
  branch: string;
  prNumber: number;
  /** The PR title — user-authored, wrapped untrusted. */
  prTitle?: string;
  /** The maintainer request / "fix that" instruction / review comment — UNTRUSTED. */
  fixRequest?: string;
  /** Optional CI / failing-checks context — UNTRUSTED (CI output / logs). */
  ciContext?: string;
  /** Who requested the fix (trigger metadata; stays outside the wrappers). */
  requestedBy?: string;
}

/**
 * Render the pr-fix prompt for a run. Pure: same inputs → same text. The fix
 * request, CI text, and PR title are wrapped UNTRUSTED; the workflow resolves the
 * branch + PR number (never the model).
 */
export function renderPrFixPrompt(ctx: PrFixPromptContext): string {
  const fixRequest = ctx.fixRequest?.trim()
    ? wrapUntrusted(ctx.fixRequest, {
        source: "github-pr-fix-request",
        author: ctx.requestedBy,
      })
    : "(no explicit request text — infer from the PR thread and any CI context below)";

  const ciSection = ctx.ciContext?.trim()
    ? wrapUntrusted(ctx.ciContext, { source: "ci-failing-checks" })
    : "";

  const prTitle = ctx.prTitle?.trim()
    ? wrapUntrusted(ctx.prTitle, { source: "github-pr-title" })
    : "(untitled)";

  return renderTemplate(prFixTemplate, {
    owner: ctx.owner,
    repo: ctx.repo,
    branch: ctx.branch,
    prNumber: ctx.prNumber,
    prTitle,
    fixRequest,
    ciSection,
  } as unknown as TemplateContext);
}
