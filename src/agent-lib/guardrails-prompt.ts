/**
 * Assemble the GUARDRAILS phase prompt for the `build` workflow.
 *
 * The guardrails phase is the FIRST build phase: a PRE-FLIGHT SCREEN that checks
 * the pre-cloned repo for a working test/lint/typecheck baseline and emits exactly
 * one of READY / BLOCKED (the prompt↔code marker). The workflow (`build.ts`) parses
 * `^\s*BLOCKED` and bypasses/stops the build (with bootstrap parity — see
 * `bootstrapBypass`), exactly like the reference's `contains_BLOCKED` rule
 * (build.yaml).
 *
 * The prompt body is the ported `src/prompts/guardrails.md` (Flue inlines it at
 * build time via `with { type: 'markdown' }`). This module renders it through the
 * shared `renderTemplate` engine with the build context (`repo`/`branch`/
 * `issueDir`/`issueNumber`/`bootstrapLabel`) and a `contextSnapshot`.
 *
 * UNTRUSTED CONTENT (spec/07 invariant): the issue title/body/comment is user-
 * provided and is wrapped in `<<<USER_CONTENT_UNTRUSTED …>>>` markers
 * (`wrapUntrusted`) before it lands in the snapshot — mirrors the architect prompt.
 * The screen reads the issue to judge the bootstrap escape hatch, but treats the
 * text as DATA, never instructions.
 *
 * Pure function → golden-testable offline (no model, no GitHub).
 */
import guardrailsTemplate from "../prompts/guardrails.md" with { type: "markdown" };
import { renderTemplate, type TemplateContext } from "../engine/templates.ts";
import {
  issueDirFor,
  buildContextSnapshot,
  type ArchitectIssueContext,
} from "./architect-prompt.ts";

/** The guardrails-report artifact path (committed to the branch handoff folder). */
export function guardrailsReportPath(issue: number): string {
  return `${issueDirFor(issue)}/guardrails-report.md`;
}

export interface GuardrailsPromptContext {
  owner: string;
  repo: string;
  issue: number;
  branch: string;
  /** The bootstrap label name (build.yaml `unless_label`) the report can reference. */
  bootstrapLabel: string;
  /** User-provided issue text — wrapped untrusted before it enters the prompt. */
  issue_context?: ArchitectIssueContext;
}

/**
 * Render the guardrails prompt for a build run. Pure: same inputs → same text.
 * The user issue text is wrapped untrusted inside `contextSnapshot` (re-uses the
 * architect's snapshot builder so the wrapping is identical).
 */
export function renderGuardrailsPrompt(ctx: GuardrailsPromptContext): string {
  const contextSnapshot = buildContextSnapshot({
    owner: ctx.owner,
    repo: ctx.repo,
    issue: ctx.issue,
    branch: ctx.branch,
    issue_context: ctx.issue_context,
  });
  return renderTemplate(guardrailsTemplate, {
    owner: ctx.owner,
    repo: ctx.repo,
    branch: ctx.branch,
    issueNumber: ctx.issue,
    issueDir: issueDirFor(ctx.issue),
    bootstrapLabel: ctx.bootstrapLabel,
    contextSnapshot,
  } as unknown as TemplateContext);
}
