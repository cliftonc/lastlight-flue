/**
 * Slack binding for the progress notifier. Owns a single message `ts` and edits
 * it in place via `chat.update` on every `publish()`; `note()` posts a fresh
 * threaded message for moments that deserve a real ping (approval prompts,
 * terminal summary) — `chat.update` itself is silent.
 *
 * Over our `SlackPoster` (`src/slack-client.ts`, the one egress surface):
 * `postMessage(channel, text, threadTs) → { ts? }` and
 * `updateMessage(channel, ts, text)`. The shared renderer emits markdown; this
 * transport converts it to Slack mrkdwn (`markdownToSlackMrkdwn`) first.
 */
import type { SlackPoster } from "../../slack-client.ts";
import { markdownToSlackMrkdwn } from "../mrkdwn.ts";
import type { NotifierTransport } from "../types.ts";

export interface SlackTransportDeps {
  poster: SlackPoster;
  channel: string;
  /** Thread ts to post the status surface / notes under; omit to post at the root. */
  thread?: string;
  /** Existing status-message ts from a resumed run, if any. */
  ts?: string;
  /** Persist the ts the first time it's created (so resume re-attaches). */
  save?: (ts: string) => void;
}

export class SlackTransport implements NotifierTransport {
  /** Slack edits are silent and there's no other signal — so it wants the ping. */
  readonly terminalPing = true;
  private ts?: string;

  constructor(private readonly deps: SlackTransportDeps) {
    this.ts = deps.ts;
  }

  async publish(markdown: string): Promise<void> {
    const { poster, channel, thread } = this.deps;
    const text = markdownToSlackMrkdwn(markdown);
    if (this.ts !== undefined) {
      await poster.updateMessage(channel, this.ts, text);
    } else {
      const res = await poster.postMessage(channel, text, thread);
      if (typeof res.ts === "string") {
        this.ts = res.ts;
        this.deps.save?.(res.ts);
      }
    }
  }

  async note(markdown: string): Promise<void> {
    const { poster, channel, thread } = this.deps;
    await poster.postMessage(channel, markdownToSlackMrkdwn(markdown), thread);
  }
}
