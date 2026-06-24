/**
 * Slack CHAT-REPLY relay — delivers the chat agent's answer back to the Slack thread.
 *
 * The Slack channel ADMITS a DM/mention by `dispatch(chatAgent, { id, input })`
 * (fire-and-forget, durable, ordered per thread). `dispatch` returns only a receipt —
 * NOT the reply — so nothing was posting the agent's answer back. This relay closes
 * that gap WITHOUT giving the (read-only, spec/11) chat agent any write tool: it
 * subscribes to Flue's `observe(...)` event stream and, when a CHAT agent turn on a
 * `slack:` thread finishes (`agent_end`), posts the final assistant text to the
 * originating thread over the egress `SlackPoster`. owner of the post is the workflow/
 * app code (deterministic egress), never the model.
 *
 * Correlation is by the agent INSTANCE id, which IS the Slack conversation key
 * (`slack:v1:<team>:<channel>:<thread>`) the channel dispatched with — so
 * `parseConversationKey` recovers the channel + thread to post to. GitHub-originated
 * chat (`github:`/other ids) is ignored here; only `slack:` threads relay to Slack.
 */
import { observe, type FlueObservation, type FlueEventContext } from "@flue/runtime";
import type { SlackThreadRef } from "@flue/slack";

/** The agent name (file `src/agents/chat.ts` → discovered as `chat`). */
export const CHAT_AGENT_NAME = "chat";

/** A Slack message ts looks like `1782271839.894679`; a channel id does not. */
const TS_RE = /^\d+\.\d+$/;

/** Injectable seams so the relay core is unit-testable with no live Flue/Slack. */
export interface SlackChatRelayDeps {
  /** Parse the agent instance id → Slack thread ref; `undefined` if not a Slack key. */
  parseKey(id: string): SlackThreadRef | undefined;
  /** Post the reply to the thread (channel + optional thread ts). */
  post(channel: string, text: string, threadTs?: string): Promise<void>;
  /**
   * Clear the assistant "is thinking…" status once the turn ends (best-effort).
   * Posting the reply already clears it in the Assistant pane; this also covers a
   * tool-only / empty turn that posts nothing. Omitted → no status handling.
   */
  clearStatus?(channel: string, threadTs: string): Promise<void>;
  log?: { info(msg: string, meta?: unknown): void; warn(msg: string, meta?: unknown): void };
}

/** A message in an `agent_end` turn (pi-agent-core `AgentMessage`, defensively typed). */
interface TurnMessage {
  role?: string;
  content?: unknown;
}

/** Extract plain text from a message's `content` (string | text/other blocks). */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (b): b is { type?: string; text?: string } =>
          typeof b === "object" && b !== null && (b as { type?: string }).type === "text",
      )
      .map((b) => b.text ?? "")
      .join("");
  }
  return "";
}

/** The LAST assistant message's text in a finished turn (the reply), trimmed. */
export function lastAssistantText(messages: readonly TurnMessage[] | undefined): string {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "assistant") {
      const t = textOf(m.content).trim();
      if (t) return t;
    }
  }
  return "";
}

/**
 * Handle ONE observation. NON-FATAL: a post failure is logged, never thrown (it must
 * not disturb Flue's event delivery). Ignores everything except a finished CHAT turn
 * on a `slack:` thread.
 */
export async function relayObservation(
  observation: FlueObservation,
  ctx: FlueEventContext,
  deps: SlackChatRelayDeps,
): Promise<void> {
  if (observation.type !== "agent_end") return;
  if (ctx.agentName !== CHAT_AGENT_NAME) return;
  const id = ctx.id;
  if (typeof id !== "string" || !id.startsWith("slack:")) return;

  let ref: SlackThreadRef | undefined;
  try {
    ref = deps.parseKey(id);
  } catch {
    ref = undefined; // not a canonical key — nothing to post to
  }
  if (!ref) return;

  const text = lastAssistantText(
    (observation as { messages?: TurnMessage[] }).messages,
  );
  if (!text) {
    // A pure tool-call / empty turn — nothing to say, but end the thinking status.
    await clearStatus(deps, ref);
    return;
  }

  const threadTs = TS_RE.test(ref.threadTs) ? ref.threadTs : undefined;
  try {
    await deps.post(ref.channelId, text, threadTs);
    deps.log?.info("[slack-relay] posted chat reply", { channel: ref.channelId });
  } catch (err) {
    deps.log?.warn("[slack-relay] post failed", { reason: String(err) });
  }
  // Clear the "is thinking…" status now the turn has ended (the post above already
  // clears it in the Assistant pane; this is the explicit, best-effort backstop).
  await clearStatus(deps, ref);
}

/** Best-effort: clear the assistant status for this thread, swallowing any error. */
async function clearStatus(deps: SlackChatRelayDeps, ref: SlackThreadRef): Promise<void> {
  if (!deps.clearStatus) return;
  await deps.clearStatus(ref.channelId, ref.threadTs).catch(() => {});
}

/**
 * Register the relay on Flue's live event stream. Returns the unsubscribe fn. Each
 * observation is handled best-effort (errors swallowed) so the subscriber never
 * throws back into Flue's emit path.
 */
export function startSlackChatRelay(deps: SlackChatRelayDeps): () => void {
  return observe((observation, ctx) => {
    void relayObservation(observation, ctx, deps).catch((err) => {
      deps.log?.warn("[slack-relay] handler error", { reason: String(err) });
    });
  });
}
