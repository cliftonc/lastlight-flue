/**
 * Deterministic issue-triage actions — APPLICATION code, never a model tool.
 *
 * Mirrors `src/github-post.ts` (the pr-review poster). The triage AGENT's job ends
 * at emitting a `CLASSIFICATION:` marker (+ an optional comment body). The WORKFLOW
 * (this module, via `src/workflows/issue-triage.ts`) applies the labels / comment /
 * close DETERMINISTICALLY over the scoped `issues-write` token. The owner / repo /
 * issue_number / token are CLOSED OVER here — NEVER model-selected. Only the
 * classification payload (the label roles) flows from the model, parsed and mapped
 * by `triage-classification.ts`.
 *
 * Label create-if-missing matches the `issue-triage` skill's §0 "ensure the labels
 * exist" step: each canonical label is created idempotently (422 "already exists"
 * is swallowed); if creation is denied (403 — the token lacks the permission) we
 * fall back to applying only the labels that already exist on the repo, exactly as
 * the reference does. `issues.addLabels` is itself idempotent (re-applying an
 * existing label is a no-op), so a re-`invoke` of a crashed run re-labels safely
 * (design Q5.4).
 */
import type { Octokit } from "octokit";
import type { RepoRef } from "./tools/github-read.ts";
import { TRIAGE_LABEL_COLORS } from "./agent-lib/triage-classification.ts";

/** An issue reference: a repo ref plus the issue number being triaged. */
export interface IssueRef extends RepoRef {
  issue_number: number;
}

/** The deterministic outcome of applying a triage classification. */
export interface TriageApplied {
  /** Labels actually applied (after create-if-missing / existing-only fallback). */
  labelsApplied: string[];
  /** Whether a triage comment was posted. */
  commented: boolean;
  /** The posted comment's URL, when one was posted. */
  commentUrl?: string;
  /** Whether the issue was closed. */
  closed: boolean;
}

/**
 * Ensure each label exists in the repo (create-if-missing, idempotent). Returns the
 * subset of `labels` that are safe to APPLY:
 *   - on success / 422 "already exists" → the label is applyable.
 *   - on 403 (label creation denied)    → fall back to existing-labels-only: list
 *     the repo's labels once and keep only those that already exist (reference
 *     behavior — never invent a label the token can't create and the repo lacks).
 *
 * `octokit` carries the bound scoped token; owner/repo come from `ref`.
 */
async function ensureLabels(
  octokit: Octokit,
  ref: IssueRef,
  labels: string[],
): Promise<string[]> {
  let existing: Set<string> | null = null;
  const loadExisting = async (): Promise<Set<string>> => {
    if (existing) return existing;
    const all = await octokit.paginate(octokit.rest.issues.listLabelsForRepo, {
      owner: ref.owner,
      repo: ref.repo,
      per_page: 100,
    });
    existing = new Set(all.map((l) => l.name));
    return existing;
  };

  const applyable: string[] = [];
  for (const name of labels) {
    try {
      await octokit.rest.issues.createLabel({
        owner: ref.owner,
        repo: ref.repo,
        name,
        color: TRIAGE_LABEL_COLORS[name] ?? "ededed",
      });
      applyable.push(name);
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 422) {
        // Already exists — fine, applyable.
        applyable.push(name);
      } else if (status === 403) {
        // Creation denied — fall back to existing-only for THIS and remaining labels.
        const have = await loadExisting();
        if (have.has(name)) applyable.push(name);
      } else {
        throw err;
      }
    }
  }
  return applyable;
}

/**
 * Apply a parsed triage classification to an issue, deterministically.
 *
 * Steps (all over the bound ref + scoped token, none model-selectable):
 *   1. Ensure the canonical labels exist (create-if-missing; existing-only on 403).
 *   2. `issues.addLabels` for the applyable set (idempotent).
 *   3. Post the triage comment, if one was provided (needs-info, duplicate link,
 *      out-of-scope reasoning — the agent's comment body, marker already stripped).
 *   4. Close the issue, if the classification calls for it (duplicate / already-
 *      implemented).
 *
 * `comment` empty/whitespace → no comment posted. `close` false → issue left open.
 */
export async function applyTriageDeterministically(
  octokit: Octokit,
  ref: IssueRef,
  opts: { labels: string[]; comment?: string; close: boolean },
): Promise<TriageApplied> {
  const labelsApplied = opts.labels.length
    ? await ensureLabels(octokit, ref, opts.labels)
    : [];

  if (labelsApplied.length) {
    await octokit.rest.issues.addLabels({
      owner: ref.owner,
      repo: ref.repo,
      issue_number: ref.issue_number,
      labels: labelsApplied,
    });
  }

  let commented = false;
  let commentUrl: string | undefined;
  const body = (opts.comment ?? "").trim();
  if (body) {
    const { data } = await octokit.rest.issues.createComment({
      owner: ref.owner,
      repo: ref.repo,
      issue_number: ref.issue_number,
      body,
    });
    commented = true;
    commentUrl = data.html_url;
  }

  let closed = false;
  if (opts.close) {
    await octokit.rest.issues.update({
      owner: ref.owner,
      repo: ref.repo,
      issue_number: ref.issue_number,
      state: "closed",
    });
    closed = true;
  }

  return { labelsApplied, commented, commentUrl, closed };
}
