/**
 * Deterministic security-feedback actions — APPLICATION code, never a model tool.
 *
 * The security-feedback AGENT classifies the maintainer's comment intent + selection (the
 * `FEEDBACK:` marker, parsed by `agent-lib/security-feedback-classify.ts`). The WORKFLOW
 * (`src/workflows/security-feedback.ts`) executes the resulting side effects HERE,
 * deterministically over the bound `issues-write` token: it creates sub-issues, rewrites
 * the parent scan-issue body to the broken-out state, and posts the summary comment. The
 * owner / repo / parent issue number / token are CLOSED OVER — NEVER model-selected (spec/09:
 * a tool's parameters are model-selected inputs, not an authorization boundary). Only the
 * classification payload (intent + selection) flows from the model.
 *
 * This is the create-issues PRIMARY flow (SKILL.md §3 create-issues + references/templates.md
 * "Sub-issue body"). The reply branches (version-mismatch / reopen / discuss / empty
 * selection) post a single comment via `postFeedbackReply`.
 *
 * IDEMPOTENCY (design Q5.4 — re-`invoke` / duplicate-delivery safe): `alreadyBrokenOut`
 * rows are immutable — the selection resolver drops them before we ever reach here, and the
 * parent-body rewrite matches by `item:N` and only touches the rows we just created
 * sub-issues for. A crash-then-re-invoke that re-selects the same ticked rows would create
 * fresh sub-issues; the security-review snapshot is point-in-time, so the run-store guard
 * (Phase 7) is the durable de-dup layer — documented like security-review's snapshot
 * semantics.
 *
 * DEFERRED (documented, not a blocker): the reference also handles `accept-risk` /
 * `false-positive` by cloning the repo, editing `SECURITY.md`, and opening a PR (the
 * `repo-write` clone path profiles.ts already anticipates for security-feedback). That
 * secondary branch needs the build-sandbox clone+push surface (like pr-fix); this slice
 * ports the PRIMARY create-issues flow + the reply branches, and routes accept-risk /
 * false-positive to a clear, honest reply that records them for the SECURITY.md-PR slice —
 * exactly as security-review deferred gitleaks/semgrep and repo-health deferred Slack.
 * TODO(phase-9/security-md-pr): clone + edit SECURITY.md + open the suppression PR.
 */
import type { Octokit } from "octokit";
import type { RepoRef } from "./tools/github-read.ts";
import { SECURITY_LABEL } from "./security-review-post.ts";
import type { ParsedFinding } from "./agent-lib/security-feedback-parse.ts";

/** A finding selected for break-out plus the new sub-issue number once created. */
export interface CreatedSubIssue {
  finding: ParsedFinding;
  subIssueNumber: number;
  html_url?: string;
}

/** The outcome of the create-issues deterministic action. */
export interface FeedbackCreateResult {
  /** The sub-issues actually created, in selection order. */
  created: CreatedSubIssue[];
  /** Findings dropped because they were already broken out (mentioned in the summary). */
  skipped: ParsedFinding[];
  /** Whether the parent body was rewritten to the broken-out state. */
  parentRewritten: boolean;
  /** Whether a summary comment was posted. */
  commented: boolean;
  /** The summary comment URL, when posted. */
  commentUrl?: string;
}

/** Map a canonical severity label to itself — the severity label every sub-issue carries. */
function severityLabel(f: ParsedFinding): string {
  return f.severity;
}

/**
 * The sub-issue body (references/templates.md "Sub-issue body"). The agent does NOT compose
 * this — it is rendered deterministically from the parsed finding + bound metadata so the
 * artifact is stable and the build skill can later consume it. `today` is the UTC date.
 */
export function renderSubIssueBody(
  finding: ParsedFinding,
  opts: { parentIssueNumber: number; sender: string; today: string },
): string {
  return [
    `<!-- fp:${finding.fp} -->`,
    `<!-- parent-security-scan: #${opts.parentIssueNumber} -->`,
    "",
    `Broken out from security scan #${opts.parentIssueNumber} on ${opts.today} at @${opts.sender}'s request.`,
    "",
    `**File**: \`${finding.file}:${finding.line}\``,
    `**Tool**: ${finding.tool} · \`${finding.rule}\``,
    `**Severity**: ${finding.severity}`,
    "",
    "---",
    "",
    "_To build a fix for this finding, comment `@last-light build` on this issue._",
  ].join("\n");
}

/**
 * Rewrite a single finding's task-list row in the parent body to the BROKEN-OUT state
 * (issue-format §Finding-row grammar / SKILL.md §3.3):
 *
 *   - [x] <!-- item:N fp:FP --> ~~**TITLE** — `FILE:LINE` (TOOL · `RULE`)~~ → #SUBISSUE
 *
 * Matches the row by its `item:N fp:FP` marker (so only the intended row changes); preserves
 * everything else byte-for-byte. Pure: returns the rewritten body. If the row isn't found
 * (e.g. already broken out / unexpected shape), the body is returned unchanged.
 */
export function rewriteParentRow(
  body: string,
  finding: ParsedFinding,
  subIssueNumber: number,
): string {
  // Match a PENDING or USER-TICKED row for this exact item+fp (not an already-broken-out one).
  const rowRe = new RegExp(
    `^- \\[[ x]\\] <!-- item:${finding.item} fp:${finding.fp} --> \\*\\*(.+?)\\*\\* — \`([^\`]+):(\\d+)\` \\(([a-z][a-z0-9-]*) · \`([^\`]+)\`\\)$`,
    "m",
  );
  return body.replace(rowRe, (_full, title, file, line, tool, rule) => {
    return `- [x] <!-- item:${finding.item} fp:${finding.fp} --> ~~**${title}** — \`${file}:${line}\` (${tool} · \`${rule}\`)~~ → #${subIssueNumber}`;
  });
}

/** Render the create-issues summary comment (SKILL.md §3.4). */
export function renderSummaryComment(
  created: CreatedSubIssue[],
  skipped: ParsedFinding[],
  sender: string,
): string {
  const lines: string[] = [];
  lines.push(`Created ${created.length} sub-issue(s) at @${sender}'s request:`);
  lines.push("");
  for (const c of created) {
    lines.push(`- #${c.subIssueNumber} — ${c.finding.title} (item ${c.finding.item})`);
  }
  if (skipped.length) {
    lines.push("");
    lines.push(
      `Skipped ${skipped.length} item(s) already broken out: items ${skipped
        .map((f) => f.item)
        .join(", ")}.`,
    );
  }
  lines.push("");
  lines.push("Comment `@last-light build` on any sub-issue to start a fix.");
  return lines.join("\n");
}

/**
 * Execute the create-issues flow deterministically (SKILL.md §3 create-issues):
 *   1. For each selected finding, `issues.create` a sub-issue (title = finding title,
 *      labels = ["security", severity], body = the template).
 *   2. Rewrite the parent body, transitioning each created row to broken-out, then
 *      `issues.update` the parent (preserving all other content byte-for-byte).
 *   3. Post the summary comment on the parent.
 *
 * All over the bound ref + scoped token. `selected` excludes already-broken-out rows
 * (the resolver dropped them into `skipped`). An empty `selected` posts nothing here —
 * the workflow handles the "no rows matched" reply separately.
 */
export async function createSubIssuesDeterministically(
  octokit: Octokit,
  ref: RepoRef,
  opts: {
    parentIssueNumber: number;
    parentBody: string;
    selected: ParsedFinding[];
    skipped: ParsedFinding[];
    sender: string;
    today: string;
  },
): Promise<FeedbackCreateResult> {
  const created: CreatedSubIssue[] = [];
  let body = opts.parentBody;

  for (const finding of opts.selected) {
    const { data } = await octokit.rest.issues.create({
      owner: ref.owner,
      repo: ref.repo,
      title: finding.title,
      labels: [SECURITY_LABEL, severityLabel(finding)],
      body: renderSubIssueBody(finding, {
        parentIssueNumber: opts.parentIssueNumber,
        sender: opts.sender,
        today: opts.today,
      }),
    });
    created.push({ finding, subIssueNumber: data.number, html_url: data.html_url });
    body = rewriteParentRow(body, finding, data.number);
  }

  let parentRewritten = false;
  if (created.length) {
    await octokit.rest.issues.update({
      owner: ref.owner,
      repo: ref.repo,
      issue_number: opts.parentIssueNumber,
      body,
    });
    parentRewritten = true;
  }

  let commented = false;
  let commentUrl: string | undefined;
  if (created.length) {
    const { data } = await octokit.rest.issues.createComment({
      owner: ref.owner,
      repo: ref.repo,
      issue_number: opts.parentIssueNumber,
      body: renderSummaryComment(created, opts.skipped, opts.sender),
    });
    commented = true;
    commentUrl = data.html_url;
  }

  return { created, skipped: opts.skipped, parentRewritten, commented, commentUrl };
}

/**
 * Post a plain reply comment on the parent scan issue (the discuss / reopen / version-
 * mismatch / empty-selection branches). owner/repo/issue come from the bound ref. An
 * empty/whitespace body posts nothing.
 */
export async function postFeedbackReply(
  octokit: Octokit,
  ref: RepoRef,
  parentIssueNumber: number,
  body: string,
): Promise<{ posted: boolean; html_url?: string }> {
  const trimmed = (body ?? "").trim();
  if (!trimmed) return { posted: false };
  const { data } = await octokit.rest.issues.createComment({
    owner: ref.owner,
    repo: ref.repo,
    issue_number: parentIssueNumber,
    body: trimmed,
  });
  return { posted: true, html_url: data.html_url };
}
