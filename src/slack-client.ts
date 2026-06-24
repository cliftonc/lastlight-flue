/**
 * The Slack EGRESS client — the one place this app posts back to Slack.
 *
 * @flue/slack owns INGRESS only (signature verification + the events/commands
 * routes). It exposes no outbound API, so all outbound posting lives here, over
 * the official `@slack/web-api` `WebClient` authenticated with the bot token
 * (`SLACK_BOT_TOKEN` → `config.slack.botToken`).
 *
 * Two surfaces, both used by the egress layer:
 *   - `postMessage` — a NEW message (a chat reply, an approval ping, a fresh
 *     progress surface). Returns the created message `ts` so an in-place
 *     progress surface can edit it later.
 *   - `updateMessage` — edit an existing message in place (`chat.update`), the
 *     notifier's per-phase task-list update.
 *
 * The bot token is closed over the client and NEVER logged. `slackPosterFromConfig`
 * returns `undefined` when no bot token is configured, so callers degrade to a
 * no-op (LIVE Slack egress is INACTIVE until the token is set) instead of throwing.
 */
import { WebClient } from "@slack/web-api";
import { loadConfig } from "./config.ts";

/** A Slack thread location parsed from a canonical conversation key. */
export interface SlackThreadLocation {
  teamId: string;
  channelId: string;
  threadTs: string;
}

/**
 * Parse a canonical Slack conversation key (`slack:v1:<team>:<channel>:<thread>`,
 * the form `@flue/slack`'s `conversationKey()` produces) into its parts. Returns
 * `undefined` for any non-matching string. Standalone (no channel import) so
 * workflows + the egress relay can map a chat/session id back to a postable thread.
 * `threadTs` may contain a `.` (e.g. `1782271839.894679`), so it is the greedy tail.
 */
export function parseSlackConversationKey(key: string): SlackThreadLocation | undefined {
  const m = /^slack:v1:([^:]+):([^:]+):(.+)$/.exec(key);
  if (!m) return undefined;
  return { teamId: m[1]!, channelId: m[2]!, threadTs: m[3]! };
}

/** The minimal outbound surface the egress layer depends on (injectable for tests). */
export interface SlackPoster {
  /**
   * Post a NEW message to `channel` (optionally threaded under `threadTs`).
   * Returns the created message `ts` (used as the in-place-update handle), or
   * `undefined` when Slack returned no ts.
   */
  postMessage(channel: string, text: string, threadTs?: string): Promise<{ ts?: string }>;
  /** Edit an existing message in place (`chat.update`). */
  updateMessage(channel: string, ts: string, text: string): Promise<void>;
  /**
   * Set the assistant "Thinking…" status on a thread (`assistant.threads.setStatus`).
   * `threadTs` MUST be the THREAD ROOT — passing a reply's own ts in an existing
   * thread silently errors and the indicator never shows. `loadingMessages` are the
   * rotating loader lines Slack cycles through. Only renders in the Assistant pane /
   * needs `assistant:write`; callers treat it as best-effort (an empty `status`
   * clears it, and posting a reply also clears it).
   */
  setStatus(
    channel: string,
    threadTs: string,
    status: string,
    loadingMessages?: string[],
  ): Promise<void>;
  /**
   * Add an emoji reaction to a message (`reactions.add`). The fallback "I saw it"
   * acknowledgment when `setStatus` isn't available (a regular channel, no Assistant
   * feature). Optional — fakes may omit it.
   */
  addReaction?(channel: string, timestamp: string, name: string): Promise<void>;
}

/** Build a `SlackPoster` over the official WebClient + a bot token. */
export function createSlackPoster(botToken: string): SlackPoster {
  const web = new WebClient(botToken);
  return {
    async postMessage(channel, text, threadTs) {
      const res = await web.chat.postMessage({
        channel,
        text,
        // Slack threads a reply under `thread_ts`; omitted → posts at the root.
        ...(threadTs ? { thread_ts: threadTs } : {}),
        mrkdwn: true,
      });
      return { ts: typeof res.ts === "string" ? res.ts : undefined };
    },
    async updateMessage(channel, ts, text) {
      await web.chat.update({ channel, ts, text });
    },
    async setStatus(channel, threadTs, status, loadingMessages) {
      await web.assistant.threads.setStatus({
        channel_id: channel,
        thread_ts: threadTs,
        status,
        ...(loadingMessages && loadingMessages.length ? { loading_messages: loadingMessages } : {}),
      });
    },
    async addReaction(channel, timestamp, name) {
      await web.reactions.add({ channel, timestamp, name });
    },
  };
}

/**
 * The production `SlackPoster`, or `undefined` when no bot token is configured
 * (so callers no-op instead of crashing — LIVE egress is inactive until the
 * `SLACK_BOT_TOKEN` is set). Reads the resolved config.
 */
export function slackPosterFromConfig(): SlackPoster | undefined {
  const token = loadConfig().slack?.botToken;
  return token ? createSlackPoster(token) : undefined;
}
