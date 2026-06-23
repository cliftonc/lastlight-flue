/**
 * Slack-channel SCREENER — deterministic admission policy (spec/03, design/phase-6
 * §"Slack channel" `events()` filter block). Ported from the reference's
 * `src/connectors/slack/connector.ts` + `messaging/base.ts` filtering.
 *
 * Pure functions over the native `@slack/types` `SlackEvent` union; NO LLM, NO side
 * effects. These are the security/policy gates that run inside the channel callback
 * BEFORE any agent is dispatched or workflow invoked:
 *   - bot / self filtering — drop messages with `bot_id`, `subtype` (edits/joins/
 *     deletes), or no real user → no reply-to-self loop, no noise.
 *   - SLACK_ALLOWED_USERS allowlist — only configured users may drive the bot
 *     (empty allowlist = allow all, matching the reference connector's semantics).
 *   - dedupe on the Slack Events API `event_id` — Slack RETRIES on a non-2xx
 *     (`@flue/slack` does NOT deduplicate, like @flue/github), so the app owns it.
 *
 * Lives in `src/agent-lib/` (NOT discovered) — imported by `src/channels/slack.ts`.
 */
import type { SlackEvent } from "@flue/slack";

/** Narrow read of the common, loosely-typed fields off a native SlackEvent. */
function asRecord(event: SlackEvent): Record<string, any> {
  return event as unknown as Record<string, any>;
}

/** The event kinds the channel acts on (a DM/channel message or an explicit mention). */
export function isMessageLike(event: SlackEvent): boolean {
  return event.type === "message" || event.type === "app_mention";
}

/**
 * Bot / self / non-standard filter (reference connector parity):
 *   - `bot_id` set → a bot (incl. our own) wrote it → drop (no self-loop).
 *   - `subtype` set → an edit/delete/join/channel-event, not a fresh user message.
 *   - missing `user` or `text` → nothing to act on.
 * `app_mention` events have no `subtype`; a plain `message` with a subtype is noise.
 */
export function isBotOrNonUserMessage(event: SlackEvent): boolean {
  const e = asRecord(event);
  if (e.bot_id) return true;
  if (event.type === "message" && e.subtype) return true;
  if (!e.user || !e.text) return true;
  return false;
}

/** The user id that authored the event (for the allowlist + sender identity). */
export function userOf(event: SlackEvent): string | undefined {
  return asRecord(event).user;
}

/**
 * SLACK_ALLOWED_USERS gate. An EMPTY allowlist allows everyone (the reference
 * `MessagingConnector.handleIncomingMessage` semantics: the check only fires when
 * `allowedUsers.length > 0`). A non-empty allowlist drops any user not in it.
 */
export function isAllowedUser(userId: string | undefined, allowedUsers: readonly string[]): boolean {
  if (allowedUsers.length === 0) return true;
  return !!userId && allowedUsers.includes(userId);
}

/** The deterministic screen verdict — drop or allow, with a reason for logging. */
export type SlackScreenVerdict = { allow: false; reason: string } | { allow: true };

/**
 * Run the full deterministic admission screen over a native Slack event.
 * Order mirrors the reference connector: message-kind → bot/self/non-user →
 * allowlist. Dedupe (on `event_id`) is applied separately at the channel via
 * `SlackEventDedupe` (the envelope id is not on the inner event).
 */
export function screenEvent(
  event: SlackEvent,
  allowedUsers: readonly string[],
): SlackScreenVerdict {
  if (!isMessageLike(event)) {
    return { allow: false, reason: `ignored event type=${event.type}` };
  }
  if (isBotOrNonUserMessage(event)) {
    return { allow: false, reason: "bot/self/non-user message" };
  }
  if (!isAllowedUser(userOf(event), allowedUsers)) {
    return { allow: false, reason: `user not allowlisted: ${userOf(event)}` };
  }
  return { allow: true };
}

/**
 * In-memory dedupe on the Slack Events API `event_id`. Slack retries delivery on a
 * non-2xx, reusing the same `event_id`; `@flue/slack` does NOT deduplicate (app
 * owns it, same as @flue/github). A bounded LRU set makes re-processing a no-op.
 * (A durable store is the Phase-7 follow-up — mirrors `DeliveryDedupe`.)
 */
export class SlackEventDedupe {
  private readonly seen = new Set<string>();
  private readonly order: string[] = [];
  constructor(private readonly max = 5000) {}

  /** Returns true the FIRST time this id is seen; false on every repeat. */
  admit(eventId: string): boolean {
    if (this.seen.has(eventId)) return false;
    this.seen.add(eventId);
    this.order.push(eventId);
    if (this.order.length > this.max) {
      const evicted = this.order.shift()!;
      this.seen.delete(evicted);
    }
    return true;
  }
}
