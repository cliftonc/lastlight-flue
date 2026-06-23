import { describe, it, expect } from "vitest";
import type { SlackEvent } from "@flue/slack";
import { screenEvent, isAllowedUser, SlackEventDedupe } from "../slack-screener.ts";

const ALLOW = ["U_ALICE", "U_BOB"];

function msg(over: Record<string, unknown> = {}): SlackEvent {
  return { type: "message", user: "U_ALICE", text: "hi", channel: "C1", ts: "1.0", ...over } as unknown as SlackEvent;
}
function mention(over: Record<string, unknown> = {}): SlackEvent {
  return { type: "app_mention", user: "U_ALICE", text: "<@U_BOT> hi", channel: "C1", ts: "1.0", ...over } as unknown as SlackEvent;
}

describe("slack screener — allowlist", () => {
  it("allows an allowlisted user", () => {
    expect(screenEvent(msg({ user: "U_ALICE" }), ALLOW)).toEqual({ allow: true });
  });

  it("drops a non-allowlisted user", () => {
    const v = screenEvent(msg({ user: "U_EVE" }), ALLOW);
    expect(v.allow).toBe(false);
  });

  it("empty allowlist allows everyone (reference parity)", () => {
    expect(isAllowedUser("U_ANYONE", [])).toBe(true);
    expect(screenEvent(msg({ user: "U_ANYONE" }), [])).toEqual({ allow: true });
  });
});

describe("slack screener — bot/self/non-user filtering (no loop)", () => {
  it("drops a message with bot_id (self / any bot)", () => {
    const v = screenEvent(msg({ bot_id: "B123", user: "U_ALICE" }), ALLOW);
    expect(v).toEqual({ allow: false, reason: "bot/self/non-user message" });
  });

  it("drops a message subtype (edit/delete/join noise)", () => {
    const v = screenEvent(msg({ subtype: "message_changed" }), ALLOW);
    expect(v.allow).toBe(false);
  });

  it("drops a message with no user or no text", () => {
    expect(screenEvent(msg({ user: undefined }), ALLOW).allow).toBe(false);
    expect(screenEvent(msg({ text: "" }), ALLOW).allow).toBe(false);
  });

  it("drops a non-message event type", () => {
    const v = screenEvent({ type: "reaction_added", user: "U_ALICE" } as unknown as SlackEvent, ALLOW);
    expect(v.allow).toBe(false);
  });

  it("allows an app_mention from an allowlisted user (no subtype gate)", () => {
    expect(screenEvent(mention(), ALLOW)).toEqual({ allow: true });
  });
});

describe("slack screener — dedupe on event_id", () => {
  it("admits an event_id once; repeats are dropped", () => {
    const d = new SlackEventDedupe();
    expect(d.admit("Ev1")).toBe(true);
    expect(d.admit("Ev1")).toBe(false);
    expect(d.admit("Ev2")).toBe(true);
  });

  it("evicts oldest beyond the bound", () => {
    const d = new SlackEventDedupe(2);
    d.admit("a");
    d.admit("b");
    d.admit("c"); // evicts a
    expect(d.admit("a")).toBe(true); // a re-admitted (was evicted)
    expect(d.admit("b")).toBe(true); // b also evicted by c then a
  });
});
