import { describe, it, expect, vi } from "vitest";
import type { SlackPoster } from "./slack-client.ts";
import {
  showSlackThinking,
  clearSlackThinking,
  THINKING_MESSAGES,
} from "./agent-lib/slack-thinking.ts";

const KEY = "slack:v1:T0A3:C0AQ:1782271839.894679"; // thread root = 1782271839.894679

function poster(over: Partial<SlackPoster> = {}): SlackPoster {
  return {
    async postMessage() { return {}; },
    async updateMessage() {},
    async setStatus() {},
    async addReaction() {},
    ...over,
  };
}

describe("showSlackThinking", () => {
  it("sets the assistant status on the THREAD ROOT with the rotating loaders", async () => {
    const setStatus = vi.fn(async () => {});
    const addReaction = vi.fn(async () => {});
    await showSlackThinking(poster({ setStatus, addReaction }), KEY, "1782271900.000100");
    expect(setStatus).toHaveBeenCalledWith("C0AQ", "1782271839.894679", "Thinking...", THINKING_MESSAGES);
    expect(addReaction).not.toHaveBeenCalled(); // status worked → no fallback
  });

  it("falls back to a 👀 reaction on the user's message when setStatus errors", async () => {
    const setStatus = vi.fn(async () => { throw new Error("not_in_assistant_thread"); });
    const addReaction = vi.fn(async () => {});
    await showSlackThinking(poster({ setStatus, addReaction }), KEY, "1782271900.000100");
    expect(addReaction).toHaveBeenCalledWith("C0AQ", "1782271900.000100", "eyes");
  });

  it("swallows everything when setStatus errors and there's no message ts", async () => {
    const setStatus = vi.fn(async () => { throw new Error("nope"); });
    const addReaction = vi.fn(async () => {});
    await expect(
      showSlackThinking(poster({ setStatus, addReaction }), KEY),
    ).resolves.toBeUndefined();
    expect(addReaction).not.toHaveBeenCalled();
  });

  it("no-ops for a non-Slack / malformed key", async () => {
    const setStatus = vi.fn(async () => {});
    await showSlackThinking(poster({ setStatus }), "github:cliftonc/repo#7", "1.2");
    expect(setStatus).not.toHaveBeenCalled();
  });
});

describe("clearSlackThinking", () => {
  it("clears the status with an empty string on the thread root", async () => {
    const setStatus = vi.fn(async () => {});
    await clearSlackThinking(poster({ setStatus }), KEY);
    expect(setStatus).toHaveBeenCalledWith("C0AQ", "1782271839.894679", "");
  });

  it("swallows a clear failure", async () => {
    const setStatus = vi.fn(async () => { throw new Error("boom"); });
    await expect(clearSlackThinking(poster({ setStatus }), KEY)).resolves.toBeUndefined();
  });
});
