/**
 * Assemble the PR-AUTHOR phase prompt + parse its output for the `build` workflow.
 *
 * The PR is still opened DETERMINISTICALLY (workflow code, scoped repo-write token,
 * bound owner/repo/head/base — spec/09). What this phase changes is WHO writes the
 * title + body: an LLM subagent authors them (reading the branch's handoff artifacts +
 * diff) instead of the old deterministic `renderPrTitle`/`renderPrBody` templates. The
 * agent gets READ tools + the shared checkout; it has NO write tool and never calls the
 * GitHub API. Its output is parsed here into `{ title, body }` and handed to the
 * deterministic `pulls.create`.
 *
 * The prompt body is `src/prompts/pr.md` (Flue inlines it via `with { type: 'markdown' }`).
 * Pure functions → golden-testable offline (no model, no GitHub).
 */
import prTemplate from "../prompts/pr.md" with { type: "markdown" };
import { renderTemplate, type TemplateContext } from "../engine/templates.ts";
import { issueDirFor } from "./architect-prompt.ts";

/** Context the PR-author prompt renders against (all trigger metadata, no user text). */
export interface PrAuthorPromptContext {
  owner: string;
  repo: string;
  issue: number;
  branch: string;
  /** The PR base branch (repo default) — for the diff range hint in the prompt. */
  base: string;
  /** True when the reviewer loop ended NOT approved → the prompt adds the open-issues note. */
  reviewerOpenIssues: boolean;
}

/** Render the PR-author prompt for a build run. Pure: same inputs → same text. */
export function renderPrAuthorPrompt(ctx: PrAuthorPromptContext): string {
  return renderTemplate(prTemplate, {
    owner: ctx.owner,
    repo: ctx.repo,
    branch: ctx.branch,
    base: ctx.base,
    issueNumber: ctx.issue,
    issueDir: issueDirFor(ctx.issue),
    reviewerOpenIssues: ctx.reviewerOpenIssues,
  } as unknown as TemplateContext);
}

/** The parsed PR-author output. A `null` field means the marker was absent/empty. */
export interface ParsedPrAuthoring {
  title: string | null;
  body: string | null;
}

/**
 * Parse the PR-author agent's text into `{ title, body }` (the prompt↔code contract):
 *   PR_TITLE: <one line>
 *   PR_BODY:
 *   <body to end of output>
 * Tolerant: a missing/empty marker yields `null` for that field (the caller falls back
 * to the deterministic render). Strips an accidental wrapping code fence on the body.
 */
export function parsePrAuthoring(text: string): ParsedPrAuthoring {
  const titleMatch = text.match(/^[ \t]*PR_TITLE:[ \t]*(.+?)[ \t]*$/m);
  const title = titleMatch?.[1]?.trim() || null;

  let body: string | null = null;
  const bodyMatch = text.match(/^[ \t]*PR_BODY:[ \t]*\r?\n([\s\S]*)$/m);
  const rawBody = bodyMatch?.[1];
  if (rawBody !== undefined) {
    body = rawBody.replace(/^\s*```[a-z]*\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim() || null;
  }

  return { title, body };
}
