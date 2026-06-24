/**
 * `LastLightEvent` — the single internal, normalized event model (spec/04).
 *
 * Phase 6 (design/phase-6-channels.md → "LastLightEvent mapper"): normalization
 * moved OUT of the old `src/connectors/*` and INTO the channel callbacks. Each
 * channel (GitHub here; Slack later) maps its native provider payload into this
 * one Valibot schema; everything downstream (the code-based router, the
 * dispatched workflow `input`) sees only `LastLightEvent`, never a raw provider
 * payload.
 *
 * This file lives at `src/` top-level (NOT under `src/channels/`), so Flue's
 * discovery does NOT treat it as a channel entry (flue-reference §0 / PROGRESS
 * DISCOVERY RULE — only immediate files under `channels/` export a `channel`).
 *
 * SNAPSHOT SEMANTICS (spec/04 invariant): the mapper copies `title`/`body`/
 * `labels`/`authorAssociation` AT EVENT TIME. The dispatched workflow keys off
 * the snapshot in `input` and never re-reads them — a label edited after the
 * webhook fired must not change what the run was admitted to do.
 *
 * `conversationKey` (= `channel.conversationKey(ref)`) replaces the reference's
 * `raw.*` + `triggerId`: the stable id↔ref pair for the reply-gate lookup.
 */
import * as v from "valibot";

/** The normalized event types the router keys on (ported from connectors/types.ts). */
export const EventType = v.picklist([
  "issue.opened",
  "issue.reopened",
  "pr.opened",
  "pr.synchronize",
  "pr.reopened",
  "comment.created",
  // generic chat message (Slack — a later slice; kept so the schema is stable).
  "message",
]);
export type EventType = v.InferOutput<typeof EventType>;

/**
 * The internal normalized event. One schema for every channel; the GitHub
 * channel maps its native delivery into this shape (src/agent-lib/github-mapper.ts).
 */
export const LastLightEvent = v.object({
  /** Dedup id — the provider delivery id (GitHub `deliveryId`). */
  id: v.string(),
  /**
   * The triggering comment's stable id (GitHub `comment.id`), present on
   * `comment.created` events. Distinct from `id`: a webhook redelivery gets a
   * fresh delivery guid, but the comment id is stable — so it's the dedup key
   * the comment workflows (issue-comment / pr-comment) re-invoke against.
   */
  commentId: v.optional(v.union([v.number(), v.string()])),
  source: v.picklist(["github", "slack"]),
  type: EventType,
  /** owner/repo full name (managed-repo allowlist key). */
  repo: v.optional(v.string()),
  owner: v.optional(v.string()),
  repoName: v.optional(v.string()),
  issueNumber: v.optional(v.number()),
  prNumber: v.optional(v.number()),
  sender: v.string(),
  senderIsBot: v.boolean(),
  /** Snapshot — body text at event time. */
  body: v.string(),
  title: v.optional(v.string()),
  labels: v.optional(v.array(v.string())),
  /** OWNER | MEMBER | COLLABORATOR | CONTRIBUTOR | NONE (the maintainer gate). */
  authorAssociation: v.optional(v.string()),
  /** = channel.conversationKey(ref) — the stable thread id for the reply-gate. */
  conversationKey: v.string(),
});
export type LastLightEvent = v.InferOutput<typeof LastLightEvent>;
