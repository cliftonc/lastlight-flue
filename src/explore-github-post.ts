/**
 * Deterministic REPLY-GATE question posting for `explore` — APPLICATION code, never a
 * model tool.
 *
 * The ask AGENT composes the clarifying question; the WORKFLOW (src/workflows/
 * explore.ts) posts it DETERMINISTICALLY over the scoped token so the human can answer
 * in the thread. Like every other side effect in this codebase (github-post.ts /
 * answer-post.ts) the destination (owner / repo / issue) + token are CLOSED OVER —
 * never model-chosen (spec/09). Only the question BODY flows from the model.
 *
 * The posted question carries the reply-gate INVITATION (reference explore.yaml
 * `gate_message`) so the human knows to just reply in the thread. A re-pause at the
 * SAME round is idempotent at the workflow layer (the gate only posts when the round's
 * question hasn't already been posted — tracked in the run-record scratch), so this
 * poster is a pure side effect and need not dedup itself.
 *
 * Slack-originated runs post the question to the originating thread via the channel
 * layer (Phase 6); until channels land the GitHub-issue path is the live one and the
 * Slack path is a clearly-marked TODO seam in the workflow.
 */
import type { Octokit } from "octokit";
import type { RepoRef } from "./tools/github-read.ts";

/** An issue reference for the reply-gate comment. */
export interface ExploreReplyRef extends RepoRef {
  issue_number: number;
}

/** The reply-gate invitation appended under the agent's question (reference gate_message). */
export const REPLY_GATE_INVITATION =
  "_Just reply to this thread with your answers — no need to @mention me. I'll keep going until we have enough to write this up._\n" +
  "_Say `we're done` at any point to jump straight to the spec draft._";

/** Result of posting a reply-gate question. */
export interface PostedQuestion {
  id?: number;
  html_url?: string;
}

/** Render the full reply-gate comment body (the question + the invitation). */
export function renderReplyGateComment(question: string): string {
  return `${(question ?? "").trim()}\n\n${REPLY_GATE_INVITATION}`;
}

/**
 * Post the reply-gate question as a comment on the originating issue. owner/repo/issue
 * are bound (never model-chosen); only the question text flows from the model.
 */
export async function postReplyGateQuestion(
  octokit: Octokit,
  ref: ExploreReplyRef,
  question: string,
): Promise<PostedQuestion> {
  const { data } = await octokit.rest.issues.createComment({
    owner: ref.owner,
    repo: ref.repo,
    issue_number: ref.issue_number,
    body: renderReplyGateComment(question),
  });
  return { id: data.id, html_url: data.html_url };
}
