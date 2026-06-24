import { describe, it, expect, vi } from "vitest";
import type { FlueObservation, FlueEventContext } from "@flue/runtime";
import type { SlackThreadRef } from "@flue/slack";
import {
  relayObservation,
  lastAssistantText,
  CHAT_AGENT_NAME,
  type SlackChatRelayDeps,
} from "../slack-chat-relay.ts";

// Phase 1 — the Slack chat-reply relay core, offline (no live Flue/Slack). Asserts:
// only a finished CHAT turn on a `slack:` thread posts; the reply text is the last
// assistant message; non-chat / non-slack / empty turns are ignored; posts are
// best-effort (a thrown post is swallowed).

const SLACK_ID = "slack:v1:T0A3NDH:D0AQVVB:1782271839.894679";
const REF: SlackThreadRef = {
  teamId: "T0A3NDH",
  channelId: "D0AQVVB",
  threadTs: "1782271839.894679",
};

/** A fake observation + ctx. `type`/`agentName`/`id`/`messages` drive the relay. */
function obs(type: string, messages?: unknown[]): FlueObservation {
  return { type, messages } as unknown as FlueObservation;
}
function ctxOf(agentName: string | undefined, id: string): FlueEventContext {
  return { agentName, id } as unknown as FlueEventContext;
}

function makeDeps(over: Partial<SlackChatRelayDeps> = {}) {
  const posts: Array<{ channel: string; text: string; threadTs?: string }> = [];
  const deps: SlackChatRelayDeps = {
    parseKey: (id) => (id.startsWith("slack:") ? REF : undefined),
    post: async (channel, text, threadTs) => {
      posts.push({ channel, text, threadTs });
    },
    log: { info() {}, warn() {} },
    ...over,
  };
  return { deps, posts };
}

const assistant = (text: string) => ({ role: "assistant", content: text });
const userMsg = (text: string) => ({ role: "user", content: text });

describe("relay — clears the assistant thinking status when the turn ends", () => {
  it("clears after posting a reply", async () => {
    const cleared: Array<{ channel: string; threadTs: string }> = [];
    const { deps, posts } = makeDeps({
      clearStatus: async (channel, threadTs) => { cleared.push({ channel, threadTs }); },
    });
    await relayObservation(obs("agent_end", [assistant("the answer")]), ctxOf(CHAT_AGENT_NAME, SLACK_ID), deps);
    expect(posts).toHaveLength(1);
    expect(cleared).toEqual([{ channel: REF.channelId, threadTs: REF.threadTs }]);
  });

  it("clears even on an empty/tool-only turn that posts nothing", async () => {
    const cleared: Array<{ channel: string; threadTs: string }> = [];
    const { deps, posts } = makeDeps({
      clearStatus: async (channel, threadTs) => { cleared.push({ channel, threadTs }); },
    });
    await relayObservation(obs("agent_end", [userMsg("hi")]), ctxOf(CHAT_AGENT_NAME, SLACK_ID), deps);
    expect(posts).toHaveLength(0);
    expect(cleared).toEqual([{ channel: REF.channelId, threadTs: REF.threadTs }]);
  });

  it("swallows a clearStatus failure (best-effort)", async () => {
    const { deps } = makeDeps({ clearStatus: async () => { throw new Error("boom"); } });
    await expect(
      relayObservation(obs("agent_end", [assistant("hi")]), ctxOf(CHAT_AGENT_NAME, SLACK_ID), deps),
    ).resolves.toBeUndefined();
  });
});

describe("lastAssistantText", () => {
  it("returns the last assistant message text (string content)", () => {
    expect(lastAssistantText([userMsg("hi"), assistant("first"), assistant("final")])).toBe(
      "final",
    );
  });
  it("extracts text from block-array content + ignores tool_use blocks", () => {
    const msg = {
      role: "assistant",
      content: [
        { type: "text", text: "the answer" },
        { type: "tool_use", id: "t1", name: "github_read", input: {} },
      ],
    };
    expect(lastAssistantText([msg])).toBe("the answer");
  });
  it("skips a trailing pure tool_use assistant turn and finds the prior text", () => {
    const toolOnly = { role: "assistant", content: [{ type: "tool_use", id: "t", name: "x" }] };
    expect(lastAssistantText([assistant("real reply"), toolOnly])).toBe("real reply");
  });
  it("returns empty when there is no assistant text", () => {
    expect(lastAssistantText([userMsg("hi")])).toBe("");
    expect(lastAssistantText(undefined)).toBe("");
  });
});

describe("relayObservation — only a finished CHAT turn on a slack: thread posts", () => {
  it("posts the last assistant text to the parsed channel + thread", async () => {
    const { deps, posts } = makeDeps();
    await relayObservation(obs("agent_end", [userMsg("q"), assistant("hello there")]), ctxOf(CHAT_AGENT_NAME, SLACK_ID), deps);
    expect(posts).toEqual([{ channel: "D0AQVVB", text: "hello there", threadTs: "1782271839.894679" }]);
  });

  it("ignores non-agent_end events", async () => {
    const { deps, posts } = makeDeps();
    await relayObservation(obs("turn_start"), ctxOf(CHAT_AGENT_NAME, SLACK_ID), deps);
    await relayObservation(obs("message_end", [assistant("x")]), ctxOf(CHAT_AGENT_NAME, SLACK_ID), deps);
    expect(posts).toEqual([]);
  });

  it("ignores turns from a non-chat agent", async () => {
    const { deps, posts } = makeDeps();
    await relayObservation(obs("agent_end", [assistant("x")]), ctxOf("triage", SLACK_ID), deps);
    expect(posts).toEqual([]);
  });

  it("ignores non-slack instance ids (e.g. github-originated chat)", async () => {
    const { deps, posts } = makeDeps();
    await relayObservation(obs("agent_end", [assistant("x")]), ctxOf(CHAT_AGENT_NAME, "github:cliftonc/repo#7"), deps);
    expect(posts).toEqual([]);
  });

  it("does not post an empty (pure tool-call) turn", async () => {
    const { deps, posts } = makeDeps();
    const toolOnly = { role: "assistant", content: [{ type: "tool_use", id: "t", name: "x" }] };
    await relayObservation(obs("agent_end", [toolOnly]), ctxOf(CHAT_AGENT_NAME, SLACK_ID), deps);
    expect(posts).toEqual([]);
  });

  it("omits thread_ts when the key's thread segment is not a ts (channel-root)", async () => {
    const rootRef: SlackThreadRef = { teamId: "T", channelId: "C123", threadTs: "C123" };
    const { deps, posts } = makeDeps({ parseKey: () => rootRef });
    await relayObservation(obs("agent_end", [assistant("hi")]), ctxOf(CHAT_AGENT_NAME, SLACK_ID), deps);
    expect(posts).toEqual([{ channel: "C123", text: "hi", threadTs: undefined }]);
  });

  it("swallows a post failure (best-effort, never throws back into Flue)", async () => {
    const warn = vi.fn();
    const { deps } = makeDeps({
      post: async () => {
        throw new Error("slack 500");
      },
      log: { info() {}, warn },
    });
    await expect(
      relayObservation(obs("agent_end", [assistant("hi")]), ctxOf(CHAT_AGENT_NAME, SLACK_ID), deps),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it("ignores an unparseable slack key (parseKey throws)", async () => {
    const { deps, posts } = makeDeps({
      parseKey: () => {
        throw new Error("invalid key");
      },
    });
    await relayObservation(obs("agent_end", [assistant("hi")]), ctxOf(CHAT_AGENT_NAME, SLACK_ID), deps);
    expect(posts).toEqual([]);
  });
});
