/**
 * Deterministic issue-comment reply posting — APPLICATION code, never a model tool.
 *
 * Mirrors `src/github-post.ts` (pr-review) and `src/triage-post.ts` (issue-triage):
 * the issue-comment AGENT composes a free-form markdown reply; the WORKFLOW (this
 * module, via `src/workflows/issue-comment.ts`) posts it DETERMINISTICALLY over the
 * scoped `issues-write` token. The owner / repo / issue_number / token are CLOSED
 * OVER here — NEVER model-selected (spec/09: a tool's parameters are model-selected
 * inputs, not an authorization boundary, so the side effect stays off the model's
 * surface). Only the reply BODY flows from the model.
 *
 * DEDUP (design Q5.4 — "answer / single-pass workflows must not double-post; add a
 * posted-marker check or app dedup"): every reply carries an invisible HTML-comment
 * marker keyed by the TRIGGERING comment id. Before posting, the workflow lists the
 * issue's existing comments and skips if a bot reply already carries that marker —
 * so a re-`invoke` of a crashed run, or a duplicate webhook delivery, never double-
 * replies to the same comment. The reference dedups at the trigger-id/run-store
 * layer (Phase 7 here); this marker is the workflow-local equivalent until then.
 *
 * BOT-LOOP (spec/04/05): the reference filters bot SENDERS at the webhook connector
 * (Phase 6 here, not yet ported), so the bot never re-triggers itself. Defensively,
 * `isBotSender` lets the workflow drop a self-authored trigger too — a second floor
 * against the infinite reply→trigger→reply loop.
 */
import type { Octokit } from "octokit";
import type { RepoRef } from "./tools/github-read.ts";

/** An issue (or PR) reference: a repo ref plus the issue/PR number. */
export interface IssueCommentRef extends RepoRef {
  issue_number: number;
}

/** Result of a deterministic reply post. */
export interface PostedReply {
  /** Whether a reply was actually posted (false → skipped by the dedup guard). */
  posted: boolean;
  /** The posted comment's id, when one was posted. */
  id?: number;
  /** The posted comment's URL, when one was posted. */
  html_url?: string;
  /** True when the post was skipped because a reply to this trigger already exists. */
  deduped?: boolean;
}

/**
 * The invisible dedup marker embedded in every reply, keyed by the TRIGGERING comment
 * id (the comment the bot was @mentioned in). Two replies to the SAME trigger carry
 * the same marker → the dedup check finds it and short-circuits. The marker is an
 * HTML comment, so it renders as nothing in the GitHub UI.
 */
export function replyDedupMarker(triggerCommentId: number | string): string {
  return `<!-- lastlight:reply-to:${triggerCommentId} -->`;
}

/**
 * Decide whether the triggering sender is the bot itself — the bot-loop floor.
 * A GitHub App authors comments as `<app-slug>[bot]`; matching either the configured
 * `botLogin` or any `…[bot]` login drops a self-authored trigger before we reply.
 */
export function isBotSender(sender: string | undefined, botLogin: string): boolean {
  if (!sender) return false;
  return sender === botLogin || sender.endsWith("[bot]");
}

/**
 * Has the bot already replied to this triggering comment? Lists the issue's comments
 * once over the bound octokit and looks for OUR dedup marker on a bot-authored
 * comment. owner/repo/issue come from the bound `ref`, never the model.
 *
 * The author check (`botLogin` / `…[bot]`) guards against a human pasting the marker
 * into a comment to suppress the bot — only a bot-authored comment counts as "already
 * replied".
 */
export async function alreadyReplied(
  octokit: Octokit,
  ref: IssueCommentRef,
  triggerCommentId: number | string,
  botLogin: string,
): Promise<boolean> {
  const marker = replyDedupMarker(triggerCommentId);
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
 * Deterministically post the agent's reply as an issue comment.
 *
 * Steps (all over the bound ref + scoped token, none model-selectable):
 *   1. If the triggering sender is the bot → SKIP (bot-loop floor).
 *   2. If a bot reply already carries the trigger's dedup marker → SKIP (dedup).
 *   3. Otherwise append the (invisible) dedup marker and `issues.createComment`.
 *
 * An empty/whitespace body is treated as "nothing to say" → no comment posted.
 */
export async function postIssueReplyDeterministically(
  octokit: Octokit,
  ref: IssueCommentRef,
  body: string,
  opts: {
    triggerCommentId: number | string;
    sender?: string;
    botLogin: string;
  },
): Promise<PostedReply> {
  // 1. Bot-loop floor — never reply to the bot's own comment.
  if (isBotSender(opts.sender, opts.botLogin)) {
    return { posted: false };
  }

  const trimmed = (body ?? "").trim();
  if (!trimmed) return { posted: false };

  // 2. Dedup — never reply twice to the same triggering comment.
  if (await alreadyReplied(octokit, ref, opts.triggerCommentId, opts.botLogin)) {
    return { posted: false, deduped: true };
  }

  // 3. Post, embedding the invisible dedup marker.
  const marker = replyDedupMarker(opts.triggerCommentId);
  const { data } = await octokit.rest.issues.createComment({
    owner: ref.owner,
    repo: ref.repo,
    issue_number: ref.issue_number,
    body: `${trimmed}\n\n${marker}`,
  });
  return { posted: true, id: data.id, html_url: data.html_url };
}
