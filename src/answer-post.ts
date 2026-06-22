/**
 * Deterministic answer posting + labelling — APPLICATION code, never a model tool.
 *
 * Mirrors `src/issue-comment-post.ts` (the reply poster) and `src/triage-post.ts`
 * (label create-if-missing). The answer AGENT composes a free-form markdown answer;
 * the WORKFLOW (this module, via `src/workflows/answer.ts`) posts it DETERMINISTICALLY
 * over the scoped `issues-write` token AND applies the `question` label. The owner /
 * repo / issue_number / token are CLOSED OVER here — NEVER model-selected (spec/09: a
 * tool's parameters are model-selected inputs, not an authorization boundary). Only
 * the answer BODY flows from the model.
 *
 * The reference (answer.yaml) delivered the answer uniformly: the agent's final
 * message is captured as `answerResult` and posted by the harness via `postComment`;
 * the skill applies only the `question` label. We split the same way — agent text →
 * deterministic comment + label — keeping the createComment / addLabels side effects
 * off the model surface.
 *
 * DEDUP (design Q5.4 — "answer / single-pass workflows must not double-post; add a
 * posted-marker check or app dedup"): a question issue has no triggering-comment id
 * (it is opened, then answered), so the dedup key is the ISSUE itself — every answer
 * carries an invisible HTML-comment marker, and before posting the workflow lists the
 * issue's comments and skips if a bot answer already carries that marker. So a
 * re-`invoke` of a crashed run, or a duplicate webhook delivery, never double-answers
 * the same issue. The author check guards against a human pasting the marker to
 * suppress the bot.
 *
 * The issue is LEFT OPEN (the skill's rule) — a human closes it once satisfied.
 */
import type { Octokit } from "octokit";
import type { RepoRef } from "./tools/github-read.ts";

/** An issue reference: a repo ref plus the issue number being answered. */
export interface AnswerRef extends RepoRef {
  issue_number: number;
}

/** The `question` label the answer workflow applies (reference answer.yaml / skill). */
export const QUESTION_LABEL = "question";
/** The `question` label's color (reference skill: `d876e3`). */
export const QUESTION_LABEL_COLOR = "d876e3";

/** Result of a deterministic answer post. */
export interface PostedAnswer {
  /** Whether an answer was actually posted (false → skipped by the dedup guard). */
  posted: boolean;
  /** The posted comment's id, when one was posted. */
  id?: number;
  /** The posted comment's URL, when one was posted. */
  html_url?: string;
  /** True when the post was skipped because an answer to this issue already exists. */
  deduped?: boolean;
  /** Whether the `question` label was applied. */
  labelled: boolean;
}

/**
 * The invisible dedup marker embedded in every answer, keyed by the ANSWERED issue
 * number. Two answers to the SAME issue carry the same marker → the dedup check finds
 * it and short-circuits. The marker is an HTML comment, so it renders as nothing.
 */
export function answerDedupMarker(issueNumber: number): string {
  return `<!-- lastlight:answer:${issueNumber} -->`;
}

/**
 * Has the bot already answered this issue? Lists the issue's comments once over the
 * bound octokit and looks for OUR dedup marker on a bot-authored comment.
 * owner/repo/issue come from the bound `ref`, never the model. The author check
 * (`botLogin` / `…[bot]`) guards against a human pasting the marker to suppress us.
 */
export async function alreadyAnswered(
  octokit: Octokit,
  ref: AnswerRef,
  botLogin: string,
): Promise<boolean> {
  const marker = answerDedupMarker(ref.issue_number);
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner: ref.owner,
    repo: ref.repo,
    issue_number: ref.issue_number,
    per_page: 100,
  });
  return comments.some((c) => {
    const login = c.user?.login ?? "";
    const isBot = login === botLogin || login.endsWith("[bot]");
    return isBot && (c.body ?? "").includes(marker);
  });
}

/**
 * Apply the `question` label, creating it if missing (idempotent). Swallows a 422
 * ("already exists") and skips silently on 403 (label-creation denied) or any other
 * GitHub error — the answer is the deliverable; the label is best-effort, exactly as
 * the reference skill ("if label creation/adding is denied, skip it"). owner/repo come
 * from the bound `ref`. Returns whether the label was applied.
 */
export async function applyQuestionLabel(
  octokit: Octokit,
  ref: AnswerRef,
): Promise<boolean> {
  try {
    await octokit.rest.issues.createLabel({
      owner: ref.owner,
      repo: ref.repo,
      name: QUESTION_LABEL,
      color: QUESTION_LABEL_COLOR,
    });
  } catch (err) {
    const status = (err as { status?: number }).status;
    // 422 = already exists (fine); 403 = creation denied (skip labelling entirely).
    if (status === 403) return false;
    if (status !== 422) {
      // Unknown error creating the label — labelling is best-effort, don't fail the run.
      return false;
    }
  }
  try {
    await octokit.rest.issues.addLabels({
      owner: ref.owner,
      repo: ref.repo,
      issue_number: ref.issue_number,
      labels: [QUESTION_LABEL],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Deterministically post the agent's answer as an issue comment and apply the
 * `question` label.
 *
 * Steps (all over the bound ref + scoped token, none model-selectable):
 *   1. If a bot answer already carries the issue's dedup marker → SKIP the comment
 *      (dedup), but still ensure the `question` label is applied (idempotent).
 *   2. Otherwise append the (invisible) dedup marker and `issues.createComment`.
 *   3. Apply the `question` label (best-effort; the issue is left OPEN).
 *
 * An empty/whitespace body is treated as "nothing to post" → no comment (but the label
 * is still applied — the router classified this as a question).
 */
export async function postAnswerDeterministically(
  octokit: Octokit,
  ref: AnswerRef,
  body: string,
  opts: { botLogin: string },
): Promise<PostedAnswer> {
  const trimmed = (body ?? "").trim();

  // Dedup — never answer the same issue twice. Label is still ensured below.
  if (await alreadyAnswered(octokit, ref, opts.botLogin)) {
    const labelled = await applyQuestionLabel(octokit, ref);
    return { posted: false, deduped: true, labelled };
  }

  let posted = false;
  let id: number | undefined;
  let html_url: string | undefined;
  if (trimmed) {
    const marker = answerDedupMarker(ref.issue_number);
    const { data } = await octokit.rest.issues.createComment({
      owner: ref.owner,
      repo: ref.repo,
      issue_number: ref.issue_number,
      body: `${trimmed}\n\n${marker}`,
    });
    posted = true;
    id = data.id;
    html_url = data.html_url;
  }

  const labelled = await applyQuestionLabel(octokit, ref);
  return { posted, id, html_url, labelled };
}
