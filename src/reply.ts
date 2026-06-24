/**
 * `deliverReply` — the platform-agnostic REPLY layer (the original's
 * `EventEnvelope.reply()`). A workflow composes an answer and delivers it to
 * whatever thread the run ORIGINATED from, without knowing the platform:
 *   - GitHub origin → a comment on the originating issue (`issues.createComment`);
 *   - Slack origin  → a message into the originating thread (the egress `SlackPoster`).
 *
 * This is the seed of the shared GitHub+Slack delivery model (the richer in-place
 * progress notifier is the Phase-2 port). Workflows pass a discriminated
 * `ReplyTarget`; the caller owns building it (the GitHub branch from owner/repo/issue,
 * the Slack branch from a parsed conversation key). The model never holds a write tool
 * — delivery is deterministic workflow code (spec/09 spine).
 */
import type { Octokit } from "octokit";
import type { SlackPoster } from "./slack-client.ts";

/** Where a reply goes — a GitHub issue thread or a Slack thread. */
export type ReplyTarget =
  | {
      kind: "github";
      octokit: Octokit;
      owner: string;
      repo: string;
      issueNumber: number;
    }
  | {
      kind: "slack";
      poster: SlackPoster;
      channel: string;
      /** Thread ts to reply under; omit to post at the channel root. */
      threadTs?: string;
    };

/** The outcome of a delivery (for logging / the workflow result). */
export interface DeliveredReply {
  kind: "github" | "slack";
  /** The created GitHub comment URL, when GitHub. */
  url?: string;
  /** The created Slack message ts, when Slack (the in-place-update handle). */
  ts?: string;
}

/**
 * Deliver `markdown` to the origin thread. GitHub posts a comment and returns its
 * URL; Slack posts to the thread and returns its ts. Both are origin-agnostic to the
 * caller — the workflow just builds the target for its origin.
 */
export async function deliverReply(
  target: ReplyTarget,
  markdown: string,
): Promise<DeliveredReply> {
  if (target.kind === "github") {
    const { data } = await target.octokit.rest.issues.createComment({
      owner: target.owner,
      repo: target.repo,
      issue_number: target.issueNumber,
      body: markdown,
    });
    return { kind: "github", url: data.html_url };
  }
  const res = await target.poster.postMessage(target.channel, markdown, target.threadTs);
  return { kind: "slack", ts: res.ts };
}
