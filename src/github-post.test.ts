import { describe, it, expect, vi } from "vitest";
import type { Octokit } from "octokit";
import {
  mapVerdictToEvent,
  extractReviewBody,
  selfAuthored,
  postReviewDeterministically,
  type PrRef,
} from "./github-post.ts";

const REF: PrRef = { owner: "cliftonc", repo: "drizzle-cube", pull_number: 941 };
const BOT = "last-light[bot]";

describe("mapVerdictToEvent — verdict → review event", () => {
  it("APPROVED → APPROVE on a non-self PR", () => {
    expect(mapVerdictToEvent("APPROVED", { selfAuthored: false })).toBe("APPROVE");
  });
  it("REQUEST_CHANGES → REQUEST_CHANGES on a non-self PR", () => {
    expect(mapVerdictToEvent("REQUEST_CHANGES", { selfAuthored: false })).toBe(
      "REQUEST_CHANGES",
    );
  });
  it("bot's own PR → COMMENT regardless of an APPROVED verdict", () => {
    expect(mapVerdictToEvent("APPROVED", { selfAuthored: true })).toBe("COMMENT");
  });
  it("bot's own PR → COMMENT regardless of a REQUEST_CHANGES verdict", () => {
    expect(mapVerdictToEvent("REQUEST_CHANGES", { selfAuthored: true })).toBe("COMMENT");
  });
});

describe("extractReviewBody — strip the marker, keep the body", () => {
  it("removes exactly the VERDICT line and trims", () => {
    const out = "VERDICT: APPROVED\n\nLooks great. Ship it.\n";
    expect(extractReviewBody(out)).toBe("Looks great. Ship it.");
  });
  it("removes a REQUEST_CHANGES marker too, preserving the rest", () => {
    const out = "VERDICT: REQUEST_CHANGES\n## Findings\n- bug at a.ts:10";
    expect(extractReviewBody(out)).toBe("## Findings\n- bug at a.ts:10");
  });
  it("preserves prose that merely mentions 'approved' elsewhere", () => {
    const out = "VERDICT: APPROVED\n\nThe author already approved their own change.";
    expect(extractReviewBody(out)).toBe("The author already approved their own change.");
  });
  it("returns the whole text trimmed when no marker is present", () => {
    const out = "  no marker here  ";
    expect(extractReviewBody(out)).toBe("no marker here");
  });
  it("only strips the FIRST marker line if (pathologically) two appear", () => {
    const out = "VERDICT: APPROVED\nbody\nVERDICT: REQUEST_CHANGES";
    expect(extractReviewBody(out)).toBe("body\nVERDICT: REQUEST_CHANGES");
  });
});

function fakeOctokit() {
  const createReview = vi.fn(async () => ({
    data: { id: 5001, state: "APPROVED", html_url: "https://gh/review/5001" },
  }));
  const createComment = vi.fn(async () => ({
    data: { id: 7001, html_url: "https://gh/comment/7001" },
  }));
  const pullsGet = vi.fn(async () => ({ data: { user: { login: BOT } } }));
  const octokit = {
    rest: {
      pulls: { createReview, get: pullsGet },
      issues: { createComment },
    },
  } as unknown as Octokit;
  return { octokit, createReview, createComment, pullsGet };
}

describe("selfAuthored — bot-author detection over the bound token", () => {
  it("true when the PR author login equals the bot login", async () => {
    const { octokit, pullsGet } = fakeOctokit();
    await expect(selfAuthored(octokit, REF, BOT)).resolves.toBe(true);
    // owner/repo/pull_number come from the bound ref, never a model arg.
    expect(pullsGet).toHaveBeenCalledWith({
      owner: "cliftonc",
      repo: "drizzle-cube",
      pull_number: 941,
    });
  });
  it("false for a human-authored PR", async () => {
    const { octokit, pullsGet } = fakeOctokit();
    pullsGet.mockResolvedValueOnce({ data: { user: { login: "alice" } } });
    await expect(selfAuthored(octokit, REF, BOT)).resolves.toBe(false);
  });
});

describe("postReviewDeterministically — calls the right mocked method with the bound ref", () => {
  it("APPROVE → octokit.pulls.createReview with the bound ref (never model-chosen)", async () => {
    const { octokit, createReview, createComment } = fakeOctokit();
    const res = await postReviewDeterministically(octokit, REF, "APPROVE", "lgtm", {
      selfAuthored: false,
    });
    expect(createReview).toHaveBeenCalledWith({
      owner: "cliftonc",
      repo: "drizzle-cube",
      pull_number: 941,
      event: "APPROVE",
      body: "lgtm",
    });
    expect(createComment).not.toHaveBeenCalled();
    expect(res).toMatchObject({ kind: "review", id: 5001, html_url: "https://gh/review/5001" });
  });

  it("REQUEST_CHANGES → createReview with that event", async () => {
    const { octokit, createReview } = fakeOctokit();
    await postReviewDeterministically(octokit, REF, "REQUEST_CHANGES", "fix it", {
      selfAuthored: false,
    });
    expect(createReview).toHaveBeenCalledWith(
      expect.objectContaining({ event: "REQUEST_CHANGES", pull_number: 941 }),
    );
  });

  it("COMMENT on a non-self PR → a formal COMMENT review (createReview, not a comment)", async () => {
    const { octokit, createReview, createComment } = fakeOctokit();
    await postReviewDeterministically(octokit, REF, "COMMENT", "fyi", {
      selfAuthored: false,
    });
    expect(createReview).toHaveBeenCalledWith(
      expect.objectContaining({ event: "COMMENT", pull_number: 941 }),
    );
    expect(createComment).not.toHaveBeenCalled();
  });

  it("SELF-authored PR → issue-comment FALLBACK (createComment, never createReview)", async () => {
    const { octokit, createReview, createComment } = fakeOctokit();
    const res = await postReviewDeterministically(octokit, REF, "COMMENT", "self note", {
      selfAuthored: true,
    });
    expect(createComment).toHaveBeenCalledWith({
      owner: "cliftonc",
      repo: "drizzle-cube",
      issue_number: 941, // PRs are issues for the comments API
      body: "self note",
    });
    expect(createReview).not.toHaveBeenCalled();
    expect(res).toMatchObject({ kind: "comment", id: 7001 });
  });
});
