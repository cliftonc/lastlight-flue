/**
 * Deterministic GitHub side-effects for the `build` workflow — APPLICATION code,
 * never a model tool. Mirrors `github-post.ts` (the Phase-3 deterministic poster):
 * the owner/repo/issue/PR and the authenticating `Octokit` (which holds the scoped
 * `repo-write` token) are CLOSED OVER in the bound `ref`, NEVER model-selectable.
 * Flue's security rule — "a tool's parameters are model-selected inputs, not an
 * authorization boundary" — so these side effects are kept off the model surface.
 *
 * Two functions:
 *   - `postGateComment` — the APPROVAL GATE ASK. When `build.ts` parks at a gate,
 *     it posts a single issue comment surfacing the artifact (the architect plan /
 *     the reviewer verdict) + the approve/reject instructions the human resumes
 *     with (parity with build.yaml `approval_gate_message`).
 *   - `openPullRequest` — the FINALIZE step. After the reviewer loop APPROVES, it
 *     renders the PR body (pr.md contract) + opens a PR via `pulls.create`
 *     (head=working branch, base=default branch), IDEMPOTENTLY (an already-open PR
 *     for the branch is reused, never double-opened).
 *
 * Both are DETERMINISTIC WORKFLOW ACTIONS — the builder agent's GitHub tools are
 * read-only; code lands via the sandbox git CLI + these helpers open the PR / post
 * the ask (design/phase-4 §"Deterministic side-effects", carries P3).
 */
import type { Octokit } from "octokit";
import type { RepoRef } from "./tools/github-read.ts";

// ───────────────────────────────────────────────────────────────────────────
// GATE ASK — the approval-gate comment (deterministic, bound ref).
// ───────────────────────────────────────────────────────────────────────────

/** Render the body of an approval-gate comment (parity with build.yaml messages). */
export interface GateCommentContext {
  gate: string;
  branch: string;
  /** The artifact path the human reviews before approving (plan / verdict). */
  artifactPath: string;
  /** The fix cycle for a post_reviewer gate (omitted for post_architect). */
  cycle?: number;
}

/**
 * Render the gate-ask comment body. Pure (golden-testable). Surfaces the artifact
 * the human reviews + the exact approve/reject commands. The `post_architect` gate
 * announces the plan; the `post_reviewer` gate announces the reviewer verdict +
 * the cycle (mirrors build.yaml `approval_gate_message` / `on_pause_for_approval`).
 */
export function renderGateComment(ctx: GateCommentContext): string {
  const isReviewer = ctx.gate.startsWith("post_reviewer");
  const header = isReviewer
    ? `**Review: REQUEST_CHANGES** — approval required before the fix loop` +
      (ctx.cycle !== undefined ? ` (cycle ${ctx.cycle})` : "")
    : `**Architect analysis complete** — approval required before implementation.`;
  const artifactLabel = isReviewer ? "Verdict" : "Plan";
  return [
    header,
    "",
    `- Branch: \`${ctx.branch}\``,
    `- ${artifactLabel}: \`${ctx.artifactPath}\``,
    "",
    "**To proceed:** comment `@last-light approve`",
    "**To abort:** comment `@last-light reject [reason]`",
  ].join("\n");
}

/** Result of posting the gate ask: the created issue-comment id + its URL. */
export interface PostedGateComment {
  id: number;
  html_url: string;
}

/**
 * Deterministically post the approval-gate ask as an ISSUE COMMENT on the bound
 * issue. The `octokit` is authenticated with the scoped `repo-write` token; the
 * owner/repo/issue_number come from the bound `ref`/`issue`, NEVER from the model.
 * `build.ts` already guards this so it posts at most once per gate hit (idempotency
 * lives in the run record's `pendingGate`); the returned id is recorded for audit.
 */
export async function postGateCommentDeterministically(
  octokit: Octokit,
  ref: RepoRef,
  issue: number,
  body: string,
): Promise<PostedGateComment> {
  const { data } = await octokit.rest.issues.createComment({
    owner: ref.owner,
    repo: ref.repo,
    issue_number: issue,
    body,
  });
  return { id: data.id, html_url: data.html_url };
}

// ───────────────────────────────────────────────────────────────────────────
// OPEN PR — the deterministic finalize (bound ref, idempotent).
// ───────────────────────────────────────────────────────────────────────────

/** The handoff-folder artifacts the PR body links (omitted if not on the branch). */
export interface PrArtifactLinks {
  owner: string;
  repo: string;
  branch: string;
  issueDir: string;
  /** Filenames known to exist on the branch (callers filter to what was produced). */
  files: string[];
}

/**
 * Render the PR body (pr.md contract): `Closes #N`, a Summary placeholder, the
 * planning/execution doc links (only for artifacts present), and a review note if
 * the reviewer never approved. Pure (golden-testable). The agent does NOT write
 * this — the workflow renders it deterministically and `pulls.create`s it.
 */
export interface PrBodyContext {
  issue: number;
  branch: string;
  links: PrArtifactLinks;
  /** True when the reviewer loop ended APPROVED; false → append the open-issues note. */
  approved: boolean;
  /** The number of fix cycles run (for the not-approved note). */
  cycles: number;
  /** Optional executor-summary text to inline under Test results. */
  summary?: string;
}

function branchUrl(links: PrArtifactLinks, file: string): string {
  const encoded = encodeURIComponent(links.branch);
  return `https://github.com/${links.owner}/${links.repo}/blob/${encoded}/${links.issueDir}/${file}`;
}

/** Stable label order for the planning/execution docs (matches pr.md). */
const ARTIFACT_LABELS: Array<{ file: string; label: string }> = [
  { file: "guardrails-report.md", label: "Guardrails report" },
  { file: "architect-plan.md", label: "Architect plan" },
  { file: "executor-summary.md", label: "Executor summary" },
  { file: "reviewer-verdict.md", label: "Reviewer verdict" },
  { file: "status.md", label: "Status" },
];

export function renderPrBody(ctx: PrBodyContext): string {
  const present = new Set(ctx.links.files);
  const docLines = ARTIFACT_LABELS.filter((a) => present.has(a.file)).map(
    (a) => `- [${a.label}](${branchUrl(ctx.links, a.file)})`,
  );
  const lines = [
    `Closes #${ctx.issue}`,
    "",
    "## Summary",
    "",
    "## Planning and execution docs",
    ...(docLines.length ? docLines : ["(no handoff artifacts on the branch)"]),
    "",
    "## Test results",
    ctx.summary?.trim() ? ctx.summary.trim() : "(see executor-summary.md on the branch)",
  ];
  if (!ctx.approved) {
    lines.push(
      "",
      `Note: There are unresolved reviewer issues after ${ctx.cycles} fix cycle(s). ` +
        "See reviewer-verdict.md on the branch.",
    );
  }
  return lines.join("\n");
}

/** Render a concise PR title referencing the issue (the agent never picks this). */
export function renderPrTitle(issue: number, branch: string): string {
  return `Build #${issue} (${branch})`;
}

/** Result of opening (or finding) the PR: number + URL + whether it pre-existed. */
export interface OpenedPullRequest {
  number: number;
  html_url: string;
  /** True when an OPEN PR for the branch already existed (idempotent reuse). */
  reused: boolean;
}

/** The default branch of the bound repo (the PR base), fetched over the scoped token. */
export async function defaultBranchOf(octokit: Octokit, ref: RepoRef): Promise<string> {
  const { data } = await octokit.rest.repos.get({ owner: ref.owner, repo: ref.repo });
  return data.default_branch;
}

/**
 * Deterministically open the PR — IDEMPOTENTLY. First checks for an existing OPEN
 * PR whose head is the working branch (`pulls.list` filtered to `head=owner:branch`)
 * and reuses it if found (a resumed/retried run must NOT double-open). Otherwise
 * `pulls.create`s head=branch → base=default branch with the rendered title/body.
 * owner/repo/head/base come from the bound `ref`/`branch`/`base`, NEVER the model.
 */
export async function openPullRequestDeterministically(
  octokit: Octokit,
  ref: RepoRef,
  args: { branch: string; base: string; title: string; body: string },
): Promise<OpenedPullRequest> {
  const existing = await octokit.rest.pulls.list({
    owner: ref.owner,
    repo: ref.repo,
    state: "open",
    head: `${ref.owner}:${args.branch}`,
  });
  const open = existing.data[0];
  if (open) {
    return { number: open.number, html_url: open.html_url, reused: true };
  }

  const { data } = await octokit.rest.pulls.create({
    owner: ref.owner,
    repo: ref.repo,
    head: args.branch,
    base: args.base,
    title: args.title,
    body: args.body,
  });
  return { number: data.number, html_url: data.html_url, reused: false };
}
