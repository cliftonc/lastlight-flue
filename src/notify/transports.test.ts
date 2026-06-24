import { describe, it, expect, vi } from "vitest";
import type { Octokit } from "octokit";
import { GitHubTransport } from "./transports/github.ts";
import { SlackTransport } from "./transports/slack.ts";
import type { SlackPoster } from "../slack-client.ts";

describe("GitHubTransport", () => {
  it("creates the comment on first publish (storing the id) then edits it", async () => {
    const createComment = vi.fn(async () => ({ data: { id: 555 } }));
    const updateComment = vi.fn(async () => ({ data: {} }));
    const octokit = { rest: { issues: { createComment, updateComment } } } as unknown as Octokit;
    const saved: number[] = [];

    const t = new GitHubTransport({
      octokit, owner: "o", repo: "r", issueNumber: 7, save: (id) => saved.push(id),
    });

    await t.publish("first");
    await t.publish("second");

    expect(createComment).toHaveBeenCalledTimes(1);
    expect(createComment).toHaveBeenCalledWith({ owner: "o", repo: "r", issue_number: 7, body: "first" });
    expect(updateComment).toHaveBeenCalledTimes(1);
    expect(updateComment).toHaveBeenCalledWith({ owner: "o", repo: "r", comment_id: 555, body: "second" });
    expect(saved).toEqual([555]);
  });

  it("re-attaches to an existing comment id (resume) and only edits", async () => {
    const createComment = vi.fn(async () => ({ data: { id: 999 } }));
    const updateComment = vi.fn(async () => ({ data: {} }));
    const octokit = { rest: { issues: { createComment, updateComment } } } as unknown as Octokit;

    const t = new GitHubTransport({ octokit, owner: "o", repo: "r", issueNumber: 7, commentId: 42 });
    await t.publish("edit me");

    expect(createComment).not.toHaveBeenCalled();
    expect(updateComment).toHaveBeenCalledWith({ owner: "o", repo: "r", comment_id: 42, body: "edit me" });
  });

  it("note always posts a fresh comment", async () => {
    const createComment = vi.fn(async () => ({ data: { id: 1 } }));
    const octokit = {
      rest: { issues: { createComment, updateComment: vi.fn() } },
    } as unknown as Octokit;
    const t = new GitHubTransport({ octokit, owner: "o", repo: "r", issueNumber: 7, commentId: 42 });
    await t.note("ping");
    expect(createComment).toHaveBeenCalledWith({ owner: "o", repo: "r", issue_number: 7, body: "ping" });
  });
});

describe("SlackTransport", () => {
  it("posts the message on first publish (storing the ts) then updates it", async () => {
    const postMessage = vi.fn(async () => ({ ts: "111.222" }));
    const updateMessage = vi.fn(async () => {});
    const poster: SlackPoster = { postMessage, updateMessage, setStatus: vi.fn(async () => {}) };
    const saved: string[] = [];

    const t = new SlackTransport({
      poster, channel: "C", thread: "T", save: (ts) => saved.push(ts),
    });

    await t.publish("first");
    await t.publish("second");

    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith("C", "first", "T");
    expect(updateMessage).toHaveBeenCalledTimes(1);
    expect(updateMessage).toHaveBeenCalledWith("C", "111.222", "second");
    expect(saved).toEqual(["111.222"]);
  });

  it("converts markdown to Slack mrkdwn before posting", async () => {
    const sent: string[] = [];
    const poster: SlackPoster = {
      async postMessage(_channel, text) {
        sent.push(text);
        return { ts: "1.2" };
      },
      async updateMessage() {},
      async setStatus() {},
    };
    const t = new SlackTransport({ poster, channel: "C", thread: "T" });
    await t.publish("### 🤖 build for #1\n\n- ✅ **Guardrails** — [plan](https://x/y)");
    const body = sent[0]!;
    expect(body).toContain("*🤖 build for #1*"); // heading → bold
    expect(body).toContain("*Guardrails*"); // **bold** → *bold*
    expect(body).toContain("<https://x/y|plan>"); // link → mrkdwn link
  });

  it("wants a terminal ping (silent edits, no other signal) unlike GitHub", () => {
    const slack = new SlackTransport({ poster: {} as unknown as SlackPoster, channel: "C", thread: "T" });
    const gh = new GitHubTransport({ octokit: {} as unknown as Octokit, owner: "o", repo: "r", issueNumber: 1 });
    expect(slack.terminalPing).toBe(true);
    expect(gh.terminalPing).toBeFalsy();
  });

  it("re-attaches to an existing ts (resume) and only updates", async () => {
    const postMessage = vi.fn(async () => ({ ts: "x" }));
    const updateMessage = vi.fn(async () => {});
    const poster: SlackPoster = { postMessage, updateMessage, setStatus: vi.fn(async () => {}) };

    const t = new SlackTransport({ poster, channel: "C", thread: "T", ts: "900.1" });
    await t.publish("edit");

    expect(postMessage).not.toHaveBeenCalled();
    expect(updateMessage).toHaveBeenCalledWith("C", "900.1", "edit");
  });
});
