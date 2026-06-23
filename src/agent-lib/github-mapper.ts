/**
 * GitHub delivery → `LastLightEvent` mapper (spec/04).
 *
 * Ported from `src/connectors/github-webhook.ts` `normalize()`. Maps a native,
 * already-screened GitHub webhook delivery into the single internal event model.
 * Pure: no side effects, no LLM. Returns `null` for an event/action combo that
 * doesn't map to a routed type (the channel callback then no-ops with a 200).
 *
 * SNAPSHOT (spec/04): `title`/`body`/`labels`/`authorAssociation` are copied AT
 * EVENT TIME — the dispatched workflow keys off this snapshot and never re-reads.
 *
 * `conversationKey` is produced by the channel's `conversationKey(ref)` (the stable
 * id↔ref pair) and injected here, so the mapper has no dependency on the channel
 * instance (avoids the construct-time channel↔helper cycle; flue-reference §0).
 *
 * Lives in `src/agent-lib/` (NOT discovered).
 */
import type { GitHubWebhookDelivery, GitHubIssueRef } from "@flue/github";
import type { EventType, LastLightEvent } from "../events.ts";

/** Make a conversation key from an issue ref (= channel.conversationKey). */
export type ConversationKeyFn = (ref: GitHubIssueRef) => string;

function labelsOf(node: any): string[] {
  return (node?.labels || []).map((l: any) => l?.name).filter(Boolean);
}

/**
 * Map a screened native delivery → `LastLightEvent`, or `null` if unmapped.
 *
 * `conversationKey` is the channel's serializer (injected). The owner/repo are
 * split from `repository.full_name`; PRs reuse their issue number for the
 * conversation key (matches GitHubIssueRef semantics).
 */
export function toLastLightEvent(
  delivery: GitHubWebhookDelivery,
  conversationKey: ConversationKeyFn,
): LastLightEvent | null {
  const payload = delivery.payload as unknown as Record<string, any>;
  const action: string | undefined = payload.action;
  const repo: string | undefined = payload.repository?.full_name;
  const sender: string = payload.sender?.login || "unknown";
  const parts = (repo || "/").split("/");
  const owner = parts[0] ?? "";
  const repoName = parts[1] ?? "";

  let type: EventType | null = null;
  let issueNumber: number | undefined;
  let prNumber: number | undefined;
  let body = "";
  let title = "";
  let labels: string[] = [];
  let authorAssociation: string | undefined;

  switch (delivery.name) {
    case "issues":
      issueNumber = payload.issue?.number;
      body = payload.issue?.body || "";
      title = payload.issue?.title || "";
      labels = labelsOf(payload.issue);
      authorAssociation = payload.issue?.author_association;
      if (action === "opened") type = "issue.opened";
      else if (action === "reopened") type = "issue.reopened";
      break;

    case "pull_request":
      prNumber = payload.pull_request?.number;
      issueNumber = prNumber; // PRs are issues too (shared number space).
      body = payload.pull_request?.body || "";
      title = payload.pull_request?.title || "";
      labels = labelsOf(payload.pull_request);
      authorAssociation = payload.pull_request?.author_association;
      if (action === "opened") type = "pr.opened";
      else if (action === "synchronize") type = "pr.synchronize";
      else if (action === "reopened") type = "pr.reopened";
      break;

    case "issue_comment":
      issueNumber = payload.issue?.number;
      body = payload.comment?.body || "";
      title = payload.issue?.title || "";
      // Carry the parent issue's labels (the security-scan-summary divert keys on them).
      labels = labelsOf(payload.issue);
      authorAssociation = payload.comment?.author_association;
      if (action === "created") type = "comment.created";
      if (payload.issue?.pull_request) prNumber = issueNumber; // comment is on a PR.
      break;
  }

  if (!type) return null;

  const ref: GitHubIssueRef = { owner, repo: repoName, issueNumber: issueNumber ?? 0 };

  return {
    id: delivery.deliveryId,
    source: "github",
    type,
    repo,
    owner,
    repoName,
    issueNumber,
    prNumber,
    sender,
    senderIsBot: false, // bots already filtered by the screener.
    body,
    title,
    labels,
    authorAssociation,
    conversationKey: conversationKey(ref),
  };
}
