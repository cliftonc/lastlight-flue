/**
 * Slack event → `LastLightEvent` mapper (spec/04, design/phase-6 §"Slack channel").
 *
 * Ported from the reference's `src/connectors/messaging/base.ts` envelope build.
 * Maps a native, already-screened Slack `message`/`app_mention` event into the
 * single internal event model. Pure: no side effects, no LLM.
 *
 * SNAPSHOT (spec/04): `body` is the message text AT EVENT TIME (mention stripped) —
 * the dispatched chat agent / workflow keys off this snapshot and never re-reads.
 *
 * `conversationKey` is produced by the channel's `conversationKey(ref)` (the stable
 * Slack thread id↔ref pair: `{ teamId, channelId, threadTs }`) and INJECTED here,
 * so the mapper has no dependency on the channel instance (avoids the construct-time
 * channel↔helper cycle; flue-reference §0). The thread key IS the durable per-thread
 * chat session key (one Slack thread = one continuous agent session).
 *
 * Lives in `src/agent-lib/` (NOT discovered).
 */
import type { SlackEvent, SlackThreadRef } from "@flue/slack";
import type { LastLightEvent } from "../events.ts";

/** Make a conversation key from a Slack thread ref (= channel.conversationKey). */
export type SlackConversationKeyFn = (ref: SlackThreadRef) => string;

/** Narrow read of the loosely-typed fields off a native SlackEvent. */
function asRecord(event: SlackEvent): Record<string, any> {
  return event as unknown as Record<string, any>;
}

/**
 * Strip a leading/inline Slack `<@U…>` bot mention from message text. Slack
 * `app_mention` text always contains the bot mention; a channel `message` may too.
 * Mirrors the reference `MessagingConnector.stripBotMention` (generic `<@id>` form).
 */
export function stripMention(text: string): string {
  return text.replace(/<@[A-Z0-9_]+>/gi, " ").replace(/\s+/g, " ").trim();
}

/**
 * The canonical Slack thread ref for an event. For a reply inside an existing
 * thread this anchors on `thread_ts`; for a fresh top-level message/mention it
 * anchors on the message's own `ts` (which becomes the thread root) — matching the
 * reference connector's `replyThreadId = threadId || messageId`.
 */
export function threadRefOf(event: SlackEvent, teamId: string): SlackThreadRef {
  const e = asRecord(event);
  return {
    teamId,
    channelId: e.channel,
    threadTs: e.thread_ts || e.ts,
  };
}

/**
 * Map a screened native Slack event → `LastLightEvent`, or `null` if it lacks the
 * fields to act on. The mention is stripped from `body`; `conversationKey` is the
 * channel's serializer over the thread ref (injected).
 *
 * @param teamId        the Events API envelope `team_id` (the inner event has none).
 * @param conversationKey the channel's `conversationKey(ref)` serializer.
 */
export function toLastLightEvent(
  event: SlackEvent,
  teamId: string,
  conversationKey: SlackConversationKeyFn,
): LastLightEvent | null {
  const e = asRecord(event);
  const user: string | undefined = e.user;
  const rawText: string = e.text || "";
  if (!user || !rawText) return null;

  const body = stripMention(rawText);
  if (!body) return null;

  const ref = threadRefOf(event, teamId);

  return {
    // The inner Slack message ts is the per-message id; the channel dedupes on the
    // Events API `event_id` (passed separately), so this `id` is the message ts.
    id: e.ts || ref.threadTs,
    source: "slack",
    type: "message",
    sender: user,
    senderIsBot: false, // bots already filtered by the screener.
    body,
    conversationKey: conversationKey(ref),
  };
}
