/**
 * Assemble the ARCHITECT phase prompt for the `build` workflow.
 *
 * The prompt body is the ported `src/prompts/architect.md` (Flue inlines it at
 * build time via `with { type: 'markdown' }`). This module renders it through the
 * shared `renderTemplate` engine with the build context (`repo`/`branch`/
 * `issueDir`/`issueNumber`) and a `contextSnapshot` block.
 *
 * UNTRUSTED CONTENT (spec/07 invariant): the issue title/body/comment is user-
 * provided and is wrapped in `<<<USER_CONTENT_UNTRUSTED …>>>` markers
 * (`wrapUntrusted`) before it lands in the snapshot, so the architect — anchored
 * by `agent-context/security.md` in its persona — treats it as DATA, never as
 * instructions. Trigger metadata (repo ref, branch, requester) sits OUTSIDE the
 * wrappers so identity is established out of band. Mirrors the reference's
 * `simple.ts` contextSnapshot assembly.
 *
 * Pure function → golden-testable offline (no model, no GitHub).
 */
import architectTemplate from "../prompts/architect.md" with { type: "markdown" };
import { renderTemplate, type TemplateContext } from "../engine/templates.ts";
import { wrapUntrusted } from "../engine/untrusted.ts";

/** The handoff-folder path on the branch where the plan + status are committed. */
export function issueDirFor(issue: number): string {
  return `.lastlight/issue-${issue}`;
}

/** The architect-plan artifact path (run-record scratch pointer + branch file). */
export function architectPlanPath(issue: number): string {
  return `${issueDirFor(issue)}/architect-plan.md`;
}

/** The user-provided issue context the architect plans against (all UNTRUSTED). */
export interface ArchitectIssueContext {
  /** Issue title (untrusted). */
  title?: string;
  /** Issue body / full thread (untrusted). */
  body?: string;
  /** Triggering comment, if any (untrusted). */
  comment?: string;
  /** The requester's handle (trigger metadata — established out of band). */
  sender?: string;
}

export interface ArchitectPromptContext {
  owner: string;
  repo: string;
  issue: number;
  branch: string;
  /** User-provided issue text — wrapped untrusted before it enters the prompt. */
  issue_context?: ArchitectIssueContext;
}

/**
 * Build the architect's `contextSnapshot` — repo/branch/requester metadata OUTSIDE
 * the wrappers; every piece of user text wrapped untrusted. Returns "" when there
 * is no user content (the architect then plans from the checked-out repo alone).
 */
export function buildContextSnapshot(ctx: ArchitectPromptContext): string {
  const ic = ctx.issue_context ?? {};
  const issueRef = `${ctx.owner}/${ctx.repo}#${ctx.issue}`;
  const hasUserContent = !!(ic.title || ic.body || ic.comment);
  if (!hasUserContent) return "";

  return [
    `Repo: ${issueRef}`,
    `Issue title: ${ic.title || "(none)"}`,
    ic.sender ? `Requested by: ${ic.sender}` : "",
    `Branch: ${ctx.branch}`,
    ic.comment
      ? `Triggering comment:\n${wrapUntrusted(ic.comment, {
          source: "github-comment",
          author: ic.sender,
        })}`
      : "",
    ic.body
      ? `Issue body and thread:\n${wrapUntrusted(ic.body, { source: "github-issue-thread" })}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Render the architect prompt for a build run. Pure: same inputs → same text.
 * The user issue text is wrapped untrusted inside `contextSnapshot`.
 */
export function renderArchitectPrompt(ctx: ArchitectPromptContext): string {
  const contextSnapshot = buildContextSnapshot(ctx);
  return renderTemplate(architectTemplate, {
    owner: ctx.owner,
    repo: ctx.repo,
    branch: ctx.branch,
    issueNumber: ctx.issue,
    issueDir: issueDirFor(ctx.issue),
    contextSnapshot,
  } as unknown as TemplateContext);
}
