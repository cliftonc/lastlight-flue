import { describe, it, expect, vi } from "vitest";
import type { Octokit } from "octokit";
import { deliverReply } from "./reply.ts";
import { parseSlackConversationKey, type SlackPoster } from "./slack-client.ts";

describe("deliverReply — GitHub origin", () => {
  it("posts a comment on the bound issue and returns its URL", async () => {
    const createComment = vi.fn(async () => ({ data: { html_url: "https://gh/c/1" } }));
    const octokit = { rest: { issues: { createComment } } } as unknown as Octokit;

    const res = await deliverReply(
      { kind: "github", octokit, owner: "cliftonc", repo: "drizzle-cube", issueNumber: 42 },
      "the answer",
    );

    expect(res).toEqual({ kind: "github", url: "https://gh/c/1" });
    expect(createComment).toHaveBeenCalledWith({
      owner: "cliftonc",
      repo: "drizzle-cube",
      issue_number: 42,
      body: "the answer",
    });
  });
});

describe("deliverReply — Slack origin", () => {
  it("posts into the thread via the poster and returns the ts", async () => {
    const posts: Array<{ channel: string; text: string; threadTs?: string }> = [];
    const poster: SlackPoster = {
      async postMessage(channel, text, threadTs) {
        posts.push({ channel, text, threadTs });
        return { ts: "1700000000.000200" };
      },
      async updateMessage() {},
      async setStatus() {},
    };

    const res = await deliverReply(
      { kind: "slack", poster, channel: "C123", threadTs: "1782271839.894679" },
      "the answer",
    );

    expect(res).toEqual({ kind: "slack", ts: "1700000000.000200" });
    expect(posts).toEqual([
      { channel: "C123", text: "the answer", threadTs: "1782271839.894679" },
    ]);
  });
});

describe("parseSlackConversationKey", () => {
  it("parses a canonical key (thread ts with a dot)", () => {
    expect(parseSlackConversationKey("slack:v1:T0A3:D0AQ:1782271839.894679")).toEqual({
      teamId: "T0A3",
      channelId: "D0AQ",
      threadTs: "1782271839.894679",
    });
  });
  it("returns undefined for a non-slack / malformed key", () => {
    expect(parseSlackConversationKey("github:cliftonc/repo#7")).toBeUndefined();
    expect(parseSlackConversationKey("slack:v1:onlyone")).toBeUndefined();
  });
});
