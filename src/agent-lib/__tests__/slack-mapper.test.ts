import { describe, it, expect } from "vitest";
import type { SlackEvent, SlackThreadRef } from "@flue/slack";
import { toLastLightEvent, stripMention, threadRefOf } from "../slack-mapper.ts";

const key = (ref: SlackThreadRef) => `slack:${ref.teamId}:${ref.channelId}:${ref.threadTs}`;

describe("slack mapper — stripMention", () => {
  it("strips a leading bot mention", () => {
    expect(stripMention("<@U_BOT> hello there")).toBe("hello there");
  });
  it("strips an inline mention and collapses whitespace", () => {
    expect(stripMention("hey <@U_BOT>  what's up")).toBe("hey what's up");
  });
  it("leaves un-mentioned text alone", () => {
    expect(stripMention("just a plain message")).toBe("just a plain message");
  });
});

describe("slack mapper — threadRefOf (per-thread conversation key)", () => {
  it("anchors on thread_ts for a reply in an existing thread", () => {
    const ref = threadRefOf(
      { type: "message", channel: "C9", ts: "200.5", thread_ts: "100.1" } as unknown as SlackEvent,
      "T1",
    );
    expect(ref).toEqual({ teamId: "T1", channelId: "C9", threadTs: "100.1" });
  });
  it("anchors on the message ts for a fresh top-level message", () => {
    const ref = threadRefOf(
      { type: "app_mention", channel: "C9", ts: "200.5" } as unknown as SlackEvent,
      "T1",
    );
    expect(ref).toEqual({ teamId: "T1", channelId: "C9", threadTs: "200.5" });
  });
});

describe("slack mapper — toLastLightEvent", () => {
  it("maps an app_mention → message LastLightEvent with thread conversationKey", () => {
    const ev = toLastLightEvent(
      { type: "app_mention", user: "U_ALICE", text: "<@U_BOT> what does the repo do?", channel: "C9", ts: "300.7" } as unknown as SlackEvent,
      "T1",
      key,
    );
    expect(ev).not.toBeNull();
    expect(ev!).toMatchObject({
      source: "slack",
      type: "message",
      sender: "U_ALICE",
      senderIsBot: false,
      body: "what does the repo do?",
      conversationKey: "slack:T1:C9:300.7",
    });
  });

  it("uses thread_ts as the conversation key for an in-thread reply", () => {
    const ev = toLastLightEvent(
      { type: "message", user: "U_BOB", text: "follow-up", channel: "C9", ts: "400.2", thread_ts: "300.7" } as unknown as SlackEvent,
      "T1",
      key,
    );
    expect(ev!.conversationKey).toBe("slack:T1:C9:300.7");
    expect(ev!.body).toBe("follow-up");
  });

  it("returns null when there is no actionable text after stripping", () => {
    const ev = toLastLightEvent(
      { type: "app_mention", user: "U_ALICE", text: "<@U_BOT>", channel: "C9", ts: "1.0" } as unknown as SlackEvent,
      "T1",
      key,
    );
    expect(ev).toBeNull();
  });
});
