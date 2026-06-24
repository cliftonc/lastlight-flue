import { describe, it, expect, vi } from "vitest";
import type { Octokit } from "octokit";
import { postAckReaction, type AckReactionDeps } from "../github-ack-reaction.ts";
import type { LastLightEvent } from "../../events.ts";

const fakeOctokit = {} as Octokit;

function deps(overrides: Partial<AckReactionDeps> = {}) {
  return {
    mintToken: vi.fn(async (_repo: string) => "scoped-token"),
    makeOctokit: vi.fn((_token: string) => fakeOctokit),
    reactToComment: vi.fn(async () => {}),
    reactToIssue: vi.fn(async () => {}),
    ...overrides,
  } satisfies AckReactionDeps;
}

function ev(overrides: Partial<LastLightEvent> = {}): LastLightEvent {
  return {
    id: "d1",
    source: "github",
    type: "comment.created",
    repo: "cliftonc/repo",
    owner: "cliftonc",
    repoName: "repo",
    issueNumber: 7,
    sender: "alice",
    senderIsBot: false,
    body: "hi",
    conversationKey: "github:cliftonc/repo#7",
    ...overrides,
  };
}

describe("postAckReaction", () => {
  it("reacts on the triggering comment when commentId is present", async () => {
    const d = deps();
    const res = await postAckReaction(ev({ commentId: 12345 }), d);
    expect(res).toEqual({ reacted: true });
    expect(d.mintToken).toHaveBeenCalledWith("repo"); // short repo NAME, not the slug
    expect(d.reactToComment).toHaveBeenCalledWith(fakeOctokit, { owner: "cliftonc", repo: "repo" }, 12345);
    expect(d.reactToIssue).not.toHaveBeenCalled();
  });

  it("falls back to reacting on the issue/PR when there is no comment", async () => {
    const d = deps();
    const res = await postAckReaction(ev({ type: "issue.opened", commentId: undefined }), d);
    expect(res).toEqual({ reacted: true });
    expect(d.reactToIssue).toHaveBeenCalledWith(fakeOctokit, { owner: "cliftonc", repo: "repo" }, 7);
    expect(d.reactToComment).not.toHaveBeenCalled();
  });

  it("coerces a numeric-string commentId, but a non-numeric one falls back to the issue", async () => {
    const numeric = deps();
    await postAckReaction(ev({ commentId: "555" }), numeric);
    expect(numeric.reactToComment).toHaveBeenCalledWith(fakeOctokit, expect.anything(), 555);

    const bogus = deps();
    await postAckReaction(ev({ commentId: "not-a-number" }), bogus);
    expect(bogus.reactToComment).not.toHaveBeenCalled();
    expect(bogus.reactToIssue).toHaveBeenCalledWith(fakeOctokit, expect.anything(), 7);
  });

  it("no-ops (no token mint) when there is neither a comment nor an issue number", async () => {
    const d = deps();
    const res = await postAckReaction(ev({ commentId: undefined, issueNumber: undefined }), d);
    expect(res).toEqual({ reacted: false });
    expect(d.mintToken).not.toHaveBeenCalled();
    expect(d.reactToComment).not.toHaveBeenCalled();
    expect(d.reactToIssue).not.toHaveBeenCalled();
  });

  it("no-ops when owner/repo are missing (a repo-less event)", async () => {
    const d = deps();
    const res = await postAckReaction(ev({ owner: undefined, repoName: undefined }), d);
    expect(res).toEqual({ reacted: false });
    expect(d.mintToken).not.toHaveBeenCalled();
  });

  it("mints the token scoped to the event's short repo name before reacting", async () => {
    const d = deps();
    await postAckReaction(ev({ commentId: 1, repo: "acme/widget", owner: "acme", repoName: "widget" }), d);
    expect(d.mintToken).toHaveBeenCalledWith("widget"); // short name, not "acme/widget"
    expect(d.makeOctokit).toHaveBeenCalledWith("scoped-token");
  });
});
