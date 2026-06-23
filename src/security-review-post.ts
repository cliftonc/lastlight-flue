/**
 * Deterministic filing of a security-scan summary issue — APPLICATION code, never a
 * model tool.
 *
 * The security-review AGENT composes the issue BODY text (the findings report, to the
 * `security-review` skill's machine-parsed issue-format). The WORKFLOW
 * (`src/workflows/security-review.ts`) files it DETERMINISTICALLY over the scoped token,
 * here. owner / repo / token are CLOSED OVER — NEVER model-selected (spec/09: a tool's
 * parameters are model-selected inputs, not an authorization boundary). Only the report
 * BODY flows from the model.
 *
 * REFERENCE BEHAVIOR + THE ONE DEVIATION (documented):
 * In `~/work/lastlight`, the `security-review` skill itself calls `github_create_issue`
 * (the agent files the issue). This slice INVERTS that to our security spine — the agent
 * emits the report text and the workflow files the issue deterministically (the same split
 * as answer/triage/issue-comment/repo-health). The ARTIFACT is identical: a NEW dated
 * snapshot issue, title `Security scan — <YYYY-MM-DD>`, labels `["security",
 * "security-scan"]`, exactly per the skill's issue-format contract so the next slice
 * (`security-feedback`) can parse it.
 *
 * SNAPSHOT, NOT UPDATE-IN-PLACE (the key difference from repo-health): the reference files
 * a fresh point-in-time issue EACH run and never edits a prior `security-scan` issue —
 * GitHub disambiguates same-day re-scans by issue number (issue-format.md §Title). So this
 * poster always CREATES; it never searches-and-updates. (Idempotency against a crash
 * re-invoke is left to the workflow's `NO_FINDINGS` early-exit + the run record, matching
 * the reference's "each scan is a point-in-time snapshot" contract.)
 */
import type { Octokit } from "octokit";
import type { RepoRef } from "./tools/github-read.ts";

/** The two labels every security-scan summary issue carries (issue-format §Title). */
export const SECURITY_LABEL = "security";
export const SECURITY_SCAN_LABEL = "security-scan";
/** The label colors (skill §2 "Ensure labels exist"). */
export const SECURITY_LABEL_COLOR = "ee0701";
export const SECURITY_SCAN_LABEL_COLOR = "fbca04";

/** The em-dash-separated title prefix (issue-format §Title: exactly one ` — ` U+2014). */
export const SECURITY_ISSUE_TITLE_PREFIX = "Security scan";

/** Result of a deterministic security-scan issue filing. */
export interface FiledSecurityScan {
  /** Whether an issue was actually filed (false → no findings / empty body, nothing posted). */
  filed: boolean;
  /** The summary issue number, when filed. */
  issueNumber?: number;
  /** The summary issue URL, when filed. */
  html_url?: string;
  /** Whether the `security` + `security-scan` labels were applied. */
  labelled: boolean;
}

/**
 * The dated summary-issue title. Exactly one em-dash (U+2014) surrounded by single
 * spaces (issue-format §Title). `dateISO` is the scan's UTC date (YYYY-MM-DD).
 */
export function securityIssueTitle(dateISO: string): string {
  return `${SECURITY_ISSUE_TITLE_PREFIX} — ${dateISO}`;
}

/**
 * Ensure the `security` + `security-scan` labels exist (idempotent) and apply them to the
 * summary issue. Best-effort, exactly as the other posters: a 422 ("already exists") is
 * fine; a 403 (label-creation denied) skips that label without failing the filing.
 * owner/repo come from the bound `ref`. Returns whether BOTH labels were applied to the
 * issue.
 */
export async function applySecurityLabels(
  octokit: Octokit,
  ref: RepoRef,
  issueNumber: number,
): Promise<boolean> {
  for (const [name, color] of [
    [SECURITY_LABEL, SECURITY_LABEL_COLOR],
    [SECURITY_SCAN_LABEL, SECURITY_SCAN_LABEL_COLOR],
  ] as const) {
    try {
      await octokit.rest.issues.createLabel({
        owner: ref.owner,
        repo: ref.repo,
        name,
        color,
      });
    } catch (err) {
      const status = (err as { status?: number }).status;
      // 422 = already exists (fine). 403 = creation denied → can't ensure this label;
      // try to add it anyway (it may pre-exist), but a missing label means a failed add.
      if (status !== 422 && status !== 403) {
        // Unexpected error ensuring the label — skip labelling, don't fail the filing.
        return false;
      }
    }
  }
  try {
    await octokit.rest.issues.addLabels({
      owner: ref.owner,
      repo: ref.repo,
      issue_number: issueNumber,
      labels: [SECURITY_LABEL, SECURITY_SCAN_LABEL],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Deterministically file the security-scan summary issue (a NEW dated snapshot — never an
 * update of a prior scan).
 *
 * Steps (all over the bound ref + scoped token, none model-selectable):
 *   1. CREATE a new issue titled `Security scan — <dateISO>` with the agent's body.
 *   2. Ensure + apply the `security` + `security-scan` labels (best-effort).
 *
 * An empty/whitespace report (or the agent's `NO_FINDINGS` sentinel, handled upstream by
 * the workflow) is treated as "nothing to file" → no issue created.
 */
export async function fileSecurityScanIssue(
  octokit: Octokit,
  ref: RepoRef,
  report: string,
  opts: { dateISO: string },
): Promise<FiledSecurityScan> {
  const body = (report ?? "").trim();
  if (!body) {
    return { filed: false, labelled: false };
  }

  const title = securityIssueTitle(opts.dateISO);
  const { data } = await octokit.rest.issues.create({
    owner: ref.owner,
    repo: ref.repo,
    title,
    body,
    labels: [SECURITY_LABEL, SECURITY_SCAN_LABEL],
  });
  const issueNumber = data.number;
  const html_url = data.html_url;

  const labelled = await applySecurityLabels(octokit, ref, issueNumber);
  return { filed: true, issueNumber, html_url, labelled };
}
