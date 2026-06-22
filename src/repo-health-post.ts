/**
 * Deterministic delivery of a repo-health report — APPLICATION code, never a model tool.
 *
 * Mirrors `src/answer-post.ts` / `src/triage-post.ts`: the health AGENT composes the
 * report TEXT; the WORKFLOW (`src/workflows/repo-health.ts`) delivers it
 * DETERMINISTICALLY over the scoped token. owner / repo / token are CLOSED OVER here —
 * NEVER model-selected (spec/09: a tool's parameters are model-selected inputs, not an
 * authorization boundary). Only the report BODY flows from the model.
 *
 * REFERENCE BEHAVIOR + THE ONE DEVIATION (documented):
 * In `~/work/lastlight`, `repo-health` runs under the *read* profile and the runner
 * surfaces the agent's final message via `MessageDeliveryService` — a Slack delivery
 * channel on the weekly cron, or stdout on the CLI. It does NOT write to GitHub: there
 * is no per-repo tracking issue in the reference. The messaging-channel sink is a later
 * phase here (Phase 6 — channels are not built yet), so this slice delivers the report
 * via the one durable, deterministic, *idempotent* surface available now: a GitHub
 * TRACKING ISSUE per repo. This is the explicit second option the build slice calls for
 * ("open/update a tracking ISSUE … reproduce the 'update the existing health issue
 * instead of opening a new one each run' idempotency") and keeps the deterministic-post
 * + bound-ref security shape consistent with the other ported workflows. The Slack /
 * channel delivery target lands with Phase 6 channels as an additional sink behind the
 * same `deliver` seam (TODO(phase-6/channels)).
 *
 * IDEMPOTENCY (the load-bearing requirement — design Q5.4 single-pass re-invoke + the
 * weekly cron running forever): a re-`invoke` of a crashed run, a duplicate cron tick,
 * or next week's run must NOT pile up a new issue each time. The tracking issue carries
 * an invisible, repo-keyed marker (`<!-- lastlight:repo-health:<owner>/<repo> -->`);
 * before delivering, the workflow searches the repo's OPEN issues for a BOT-authored one
 * carrying that marker and UPDATES its body (a fresh point-in-time snapshot) instead of
 * opening a new one. Only when none exists is an issue created. The author check guards
 * against a human pasting the marker to hijack the tracking issue.
 *
 * The tracking issue is LEFT OPEN (it is a living dashboard; a maintainer closes it to
 * opt out — the next run re-opens a fresh one).
 */
import type { Octokit } from "octokit";
import type { RepoRef } from "./tools/github-read.ts";

/** The `repo-health` tracking-issue title prefix + the label it carries. */
export const HEALTH_ISSUE_TITLE_PREFIX = "Repo Health";
/** The label applied to the tracking issue (reference monitoring/reporting tag). */
export const HEALTH_LABEL = "repo-health";
/** The tracking-issue label color. */
export const HEALTH_LABEL_COLOR = "0e8a16";

/** Result of a deterministic health-report delivery. */
export interface DeliveredHealthReport {
  /** Whether a report was actually delivered (false → empty report, nothing posted). */
  delivered: boolean;
  /** The tracking issue number the report was delivered to. */
  issueNumber?: number;
  /** The tracking issue URL. */
  html_url?: string;
  /** True when an EXISTING tracking issue was updated (idempotency — no duplicate). */
  updated: boolean;
  /** Whether the `repo-health` label was applied. */
  labelled: boolean;
}

/**
 * The invisible per-repo marker embedded in every tracking issue, keyed by the bound
 * repo. Every run of the SAME repo carries the same marker → the find step locates the
 * existing tracking issue and updates it. The marker is an HTML comment (renders as
 * nothing).
 */
export function healthIssueMarker(ref: RepoRef): string {
  return `<!-- lastlight:repo-health:${ref.owner}/${ref.repo} -->`;
}

/**
 * Find this repo's existing OPEN health tracking issue (the one carrying OUR marker on a
 * bot-authored issue), or `undefined` if none exists. owner/repo come from the bound
 * `ref`, never the model. The author check (`botLogin` / `…[bot]`) guards against a human
 * pasting the marker to hijack the tracking issue.
 */
export async function findHealthIssue(
  octokit: Octokit,
  ref: RepoRef,
  botLogin: string,
): Promise<{ number: number; html_url: string } | undefined> {
  const marker = healthIssueMarker(ref);
  const issues = await octokit.paginate(octokit.rest.issues.listForRepo, {
    owner: ref.owner,
    repo: ref.repo,
    state: "open",
    // The tracking issue carries the label; filtering by it keeps the scan cheap on
    // busy repos. (Falls back to a marker scan over whatever the API returns.)
    labels: HEALTH_LABEL,
    per_page: 100,
  });
  const match = issues.find((i) => {
    // listForRepo returns PRs too; a PR carries `pull_request`. Skip those.
    if ((i as { pull_request?: unknown }).pull_request) return false;
    const login = i.user?.login ?? "";
    const isBot = login === botLogin || login.endsWith("[bot]");
    return isBot && (i.body ?? "").includes(marker);
  });
  return match ? { number: match.number, html_url: match.html_url } : undefined;
}

/**
 * Ensure the `repo-health` label exists (idempotent) and apply it to the tracking issue.
 * Best-effort, exactly as the other posters: a 422 ("already exists") is fine; a 403
 * (label-creation denied) or any other error skips labelling without failing the
 * delivery. owner/repo come from the bound `ref`. Returns whether the label was applied.
 */
export async function applyHealthLabel(
  octokit: Octokit,
  ref: RepoRef,
  issueNumber: number,
): Promise<boolean> {
  try {
    await octokit.rest.issues.createLabel({
      owner: ref.owner,
      repo: ref.repo,
      name: HEALTH_LABEL,
      color: HEALTH_LABEL_COLOR,
    });
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 403) return false;
    if (status !== 422) return false;
  }
  try {
    await octokit.rest.issues.addLabels({
      owner: ref.owner,
      repo: ref.repo,
      issue_number: issueNumber,
      labels: [HEALTH_LABEL],
    });
    return true;
  } catch {
    return false;
  }
}

/** Build the tracking-issue title (includes the date for an at-a-glance freshness cue). */
export function healthIssueTitle(ref: RepoRef, dateISO: string): string {
  return `${HEALTH_ISSUE_TITLE_PREFIX}: ${ref.owner}/${ref.repo} — ${dateISO}`;
}

/**
 * Deterministically deliver the agent's health report to the repo's tracking issue.
 *
 * Steps (all over the bound ref + scoped token, none model-selectable):
 *   1. Find the existing OPEN, bot-authored, marker-carrying tracking issue for THIS
 *      repo. If found → UPDATE its title + body (idempotency: no duplicate issue).
 *   2. Otherwise CREATE a new tracking issue.
 *   3. Ensure the `repo-health` label (best-effort; the issue is left OPEN).
 *
 * An empty/whitespace report is treated as "nothing to deliver" → no issue touched.
 * `now` is injectable so the title date is deterministic in tests.
 */
export async function deliverHealthReport(
  octokit: Octokit,
  ref: RepoRef,
  report: string,
  opts: { botLogin: string; now?: () => Date },
): Promise<DeliveredHealthReport> {
  const trimmed = (report ?? "").trim();
  if (!trimmed) {
    return { delivered: false, updated: false, labelled: false };
  }

  const dateISO = (opts.now?.() ?? new Date()).toISOString().slice(0, 10);
  const marker = healthIssueMarker(ref);
  const body = `${trimmed}\n\n${marker}`;
  const title = healthIssueTitle(ref, dateISO);

  const existing = await findHealthIssue(octokit, ref, opts.botLogin);

  let issueNumber: number;
  let html_url: string;
  let updated: boolean;
  if (existing) {
    const { data } = await octokit.rest.issues.update({
      owner: ref.owner,
      repo: ref.repo,
      issue_number: existing.number,
      title,
      body,
    });
    issueNumber = existing.number;
    html_url = data.html_url ?? existing.html_url;
    updated = true;
  } else {
    const { data } = await octokit.rest.issues.create({
      owner: ref.owner,
      repo: ref.repo,
      title,
      body,
    });
    issueNumber = data.number;
    html_url = data.html_url;
    updated = false;
  }

  const labelled = await applyHealthLabel(octokit, ref, issueNumber);
  return { delivered: true, issueNumber, html_url, updated, labelled };
}
