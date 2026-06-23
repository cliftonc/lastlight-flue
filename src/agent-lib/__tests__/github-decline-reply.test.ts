import { describe, it, expect, vi } from "vitest";
import { postDeclineReply, type DeclineReplyDeps } from "../github-decline-reply.ts";
import type { LastLightEvent } from "../../events.ts";
import type { PostedReply } from "../../issue-comment-post.ts";

const BOT = "last-light[bot]";

function ev(overrides: Partial<LastLightEvent> = {}): LastLightEvent {
  return {
    id: "d1",
    source: "github",
    type: "comment.created",
    repo: "cliftonc/repo",
    owner: "cliftonc",
    repoName: "repo",
    issueNumber: 9,
    sender: "stranger",
    senderIsBot: false,
    body: "@last-light build me a feature",
    title: "T",
    labels: [],
    authorAssociation: "NONE",
    conversationKey: "github:cliftonc/repo#9",
    ...overrides,
  };
}

/** Deps with every external effect mocked — NO token mint, NO Octokit, NO live GitHub. */
function deps(overrides: Partial<DeclineReplyDeps> = {}) {
  const post = vi.fn<DeclineReplyDeps["post"]>(async () => ({ posted: true, id: 100 }));
  const mintToken = vi.fn(async () => "scoped-token");
  const makeOctokit = vi.fn(() => ({}) as any);
  return {
    deps: { mintToken, makeOctokit, post, botLogin: BOT, ...overrides } as DeclineReplyDeps,
    post,
    mintToken,
    makeOctokit,
  };
}

describe("postDeclineReply — router-emitted decline (offline, mocked GitHub)", () => {
  it("posts the decline on the triggering issue over a scoped issues-write token", async () => {
    const { deps: d, post, mintToken } = deps();
    const res = await postDeclineReply(ev(), "only maintainers can do that", d);
    expect(res).toMatchObject({ posted: true });
    expect(mintToken).toHaveBeenCalledWith("cliftonc/repo"); // downscoped to the repo
    expect(post).toHaveBeenCalledTimes(1);
    const [, passedEv, message, botLogin] = post.mock.calls[0]!;
    expect(passedEv).toMatchObject({ owner: "cliftonc", repoName: "repo", issueNumber: 9 });
    expect(message).toBe("only maintainers can do that");
    expect(botLogin).toBe(BOT);
  });

  it("derives owner/name when ev.repo is absent", async () => {
    const { deps: d, mintToken } = deps();
    await postDeclineReply(ev({ repo: undefined }), "nope", d);
    expect(mintToken).toHaveBeenCalledWith("cliftonc/repo");
  });

  it("NO reply (silent) when the event has no issue target", async () => {
    const { deps: d, post, mintToken } = deps();
    const res = await postDeclineReply(ev({ issueNumber: undefined }), "msg", d);
    expect(res).toEqual({ posted: false });
    expect(post).not.toHaveBeenCalled();
    expect(mintToken).not.toHaveBeenCalled();
  });

  it("the poster's bot-loop floor / dedup is honored (a deduped post returns posted:false)", async () => {
    const { deps: d } = deps({ post: vi.fn<DeclineReplyDeps["post"]>(async () => ({ posted: false, deduped: true })) });
    const res = await postDeclineReply(ev(), "msg", d);
    expect(res).toMatchObject({ posted: false, deduped: true });
  });
});
