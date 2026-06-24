/**
 * Slack chat "thinking…" indicator — a faithful port of the original lastlight
 * `SlackConnector.showTyping`/`clearTyping` (`src/connectors/slack/connector.ts`).
 *
 * The instant a chat turn is admitted, show a live indicator; clear it when the
 * turn finishes. Two tiers, best-effort throughout (it must never disturb dispatch):
 *
 *  1. `assistant.threads.setStatus` — the native "Thinking…" status with rotating
 *     loader messages. `thread_ts` MUST be the THREAD ROOT (the conversation key's
 *     thread ts) — passing a reply's own ts in an existing thread silently errors
 *     and nothing shows. Renders in the Assistant pane / needs `assistant:write`.
 *  2. Fallback — when the Assistant API isn't available (a regular channel), a 👀
 *     reaction on the user's ACTUAL message, so an in-thread reply still gets a
 *     visible acknowledgment. Mirrors the original's behavior exactly.
 */
import type { SlackPoster } from "../slack-client.ts";
import { parseSlackConversationKey } from "../slack-client.ts";

/** Rotating loader lines Slack cycles through under the status (ported verbatim). */
export const THINKING_MESSAGES = [
  "Thinking...",
  "Pondering the cosmos...",
  "Consulting the codebase...",
  "Rummaging through repos...",
  "Brewing a response...",
  "Crunching context...",
  "Reading between the lines...",
  "Warming up the neurons...",
  "Assembling thoughts...",
  "Almost there...",
];

/**
 * Show the "Thinking…" indicator for a chat turn, addressed by the canonical
 * conversation key (`slack:v1:<team>:<channel>:<thread>` → channel + thread root).
 * Tries `setStatus` (Assistant pane); on any failure falls back to a 👀 reaction
 * on the triggering message (`messageTs`), so an in-thread reply in a regular
 * channel still shows acknowledgment. Best-effort — swallows every error.
 */
export async function showSlackThinking(
  poster: SlackPoster,
  conversationKey: string,
  messageTs?: string,
): Promise<void> {
  const loc = parseSlackConversationKey(conversationKey);
  if (!loc) return;
  try {
    // thread_ts MUST be the thread root — the conversation key's thread ts is it.
    await poster.setStatus(loc.channelId, loc.threadTs, "Thinking...", THINKING_MESSAGES);
  } catch {
    // Assistant API not available (e.g. a regular channel) → 👀 on the user's message.
    if (messageTs && poster.addReaction) {
      try {
        await poster.addReaction(loc.channelId, messageTs, "eyes");
      } catch {
        /* best-effort — reaction may already exist / be invalid. */
      }
    }
  }
}

/**
 * Clear the "Thinking…" status once the turn ends (best-effort). Posting the reply
 * already clears it in the Assistant pane; this is the explicit backstop. The 👀
 * fallback reaction is intentionally left in place (it acknowledges the message was
 * seen), matching the original's `clearTyping`.
 */
export async function clearSlackThinking(
  poster: SlackPoster,
  conversationKey: string,
): Promise<void> {
  const loc = parseSlackConversationKey(conversationKey);
  if (!loc) return;
  try {
    await poster.setStatus(loc.channelId, loc.threadTs, "");
  } catch {
    /* best-effort — status clears on its own. */
  }
}
