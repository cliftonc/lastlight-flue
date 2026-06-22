import { describe, it, expect, vi } from "vitest";
import type { Octokit } from "octokit";
import {
  renderAckComment,
  postAckCommentDeterministically,
  type PrFixRef,
} from "./pr-fix-post.ts";

// Phase 5 — the pr-fix ack comment is APPLICATION code (never a model tool): the
// owner/repo/PR number come from the bound ref, the comment posts via
// issues.createComment on the PR number. Pure render is golden-tested.

const REF: PrFixRef = { owner: "octocat", repo: "widget", pull_number: 77 };

describe("renderAckComment", () => {
  it("reports the branch + short sha and notes CI re-runs", () => {
    const body = renderAckComment({ branch: "feature/login", sha: "abcdef0123456789" });
    expect(body).toContain("`feature/login`");
    expect(body).toContain("`abcdef012345`"); // 12-char short sha
    expect(body).toContain("CI should re-run");
  });
});

describe("postAckCommentDeterministically", () => {
  it("posts to the BOUND PR ref via issues.createComment (PR number, not model-chosen)", async () => {
    const createComment = vi.fn(async () => ({
      data: { id: 999, html_url: "https://github.com/octocat/widget/pull/77#c-999" },
    }));
    const octokit = {
      rest: { issues: { createComment } },
    } as unknown as Octokit;

    const posted = await postAckCommentDeterministically(octokit, REF, "ack body");

    expect(createComment).toHaveBeenCalledWith({
      owner: "octocat",
      repo: "widget",
      issue_number: 77,
      body: "ack body",
    });
    expect(posted.id).toBe(999);
    expect(posted.html_url).toContain("#c-999");
  });
});
