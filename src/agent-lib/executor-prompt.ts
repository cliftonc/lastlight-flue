/**
 * Assemble the EXECUTOR phase prompt for the `build` workflow.
 *
 * The prompt body is the ported `src/prompts/executor.md` (Flue inlines it at
 * build time via `with { type: 'markdown' }`). This module renders it through the
 * shared `renderTemplate` engine with the build context (`repo`/`branch`/
 * `issueDir`/`issueNumber`).
 *
 * THE PLAN IS THE HANDOFF (spec/07, design/phase-4): the executor reads the
 * architect's committed `.lastlight/issue-<N>/architect-plan.md` from the
 * pre-cloned checkout — the prompt names that path (via `issueDir`) so the agent
 * starts there. The plan is NOT inlined into the prompt (it's a branch file, not
 * session memory — spec/10 split rule; resume re-reads it from disk).
 *
 * UNTRUSTED CONTENT (spec/07 invariant): any user-provided issue text passed
 * alongside is wrapped in `<<<USER_CONTENT_UNTRUSTED …>>>` markers (`wrapUntrusted`)
 * so the executor — anchored by `agent-context/security.md` in its persona —
 * treats it as DATA, never instructions. Trigger metadata (repo ref, branch,
 * requester) sits OUTSIDE the wrappers. The executor works primarily from the
 * committed plan; the snapshot is supplementary context only.
 *
 * Pure function → golden-testable offline (no model, no GitHub).
 */
import executorTemplate from "../prompts/executor.md" with { type: "markdown" };
import { renderTemplate, type TemplateContext } from "../engine/templates.ts";
import { wrapUntrusted } from "../engine/untrusted.ts";
import {
  issueDirFor,
  type ArchitectIssueContext,
} from "./architect-prompt.ts";

/** The executor-summary artifact path (run-record scratch pointer + branch file). */
export function executorSummaryPath(issue: number): string {
  return `${issueDirFor(issue)}/executor-summary.md`;
}

export interface ExecutorPromptContext {
  owner: string;
  repo: string;
  issue: number;
  branch: string;
  /** User-provided issue text — wrapped untrusted before it enters the prompt. */
  issue_context?: ArchitectIssueContext;
}

/**
 * Build the executor's supplementary `contextSnapshot` — repo/branch/requester
 * metadata OUTSIDE the wrappers; every piece of user text wrapped untrusted.
 * Returns "" when there is no user content (the executor then works from the
 * committed plan alone).
 */
export function buildExecutorContextSnapshot(ctx: ExecutorPromptContext): string {
  const ic = ctx.issue_context ?? {};
  const issueRef = `${ctx.owner}/${ctx.repo}#${ctx.issue}`;
  const hasUserContent = !!(ic.title || ic.body || ic.comment);
  if (!hasUserContent) return "";

  return [
    `Repo: ${issueRef}`,
    `Issue title: ${ic.title || "(none)"}`,
    ic.sender ? `Requested by: ${ic.sender}` : "",
    `Branch: ${ctx.branch}`,
    ic.body
      ? `Issue body and thread (for reference; the PLAN is authoritative):\n${wrapUntrusted(
          ic.body,
          { source: "github-issue-thread" },
        )}`
      : "",
    ic.comment
      ? `Triggering comment:\n${wrapUntrusted(ic.comment, {
          source: "github-comment",
          author: ic.sender,
        })}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Render the executor prompt for a build run. Pure: same inputs → same text.
 * Any user issue text is wrapped untrusted inside an appended contextSnapshot.
 */
export function renderExecutorPrompt(ctx: ExecutorPromptContext): string {
  const base = renderTemplate(executorTemplate, {
    owner: ctx.owner,
    repo: ctx.repo,
    branch: ctx.branch,
    issueNumber: ctx.issue,
    issueDir: issueDirFor(ctx.issue),
  } as unknown as TemplateContext);

  const snapshot = buildExecutorContextSnapshot(ctx);
  if (!snapshot) return base;
  return `${base}\n\nCONTEXT (supplementary — the committed plan is authoritative):\n${snapshot}`;
}
