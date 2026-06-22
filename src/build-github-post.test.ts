import { describe, it, expect, vi } from "vitest";
import type { Octokit } from "octokit";
import {
  renderGateComment,
  postGateCommentDeterministically,
  renderPrBody,
  renderPrTitle,
  defaultBranchOf,
  openPullRequestDeterministically,
} from "./build-github-post.ts";
import type { RepoRef } from "./tools/github-read.ts";

// Phase 4 — the DETERMINISTIC build side-effects (gate ask + open-PR). Mirrors
// github-post.test.ts: pure renderers are golden-tested; the API calls are asserted
// over a mocked octokit with owner/repo/issue/head/base CLOSED OVER the bound ref —
// NEVER model-selectable.

const REF: RepoRef = { owner: "cliftonc", repo: "widget" };

describe("renderGateComment — the approval-gate ask body (golden)", () => {
  it("post_architect surfaces the plan + approve/reject commands", () => {
    const body = renderGateComment({
      gate: "post_architect",
      branch: "lastlight/42",
      artifactPath: ".lastlight/issue-42/architect-plan.md",
    });
    expect(body).toContain("Architect analysis complete");
    expect(body).toContain("`lastlight/42`");
    expect(body).toContain(".lastlight/issue-42/architect-plan.md");
    expect(body).toContain("@last-light approve");
    expect(body).toContain("@last-light reject");
  });

  it("post_reviewer surfaces the verdict + cycle", () => {
    const body = renderGateComment({
      gate: "post_reviewer:1",
      branch: "lastlight/42",
      artifactPath: ".lastlight/issue-42/reviewer-verdict.md",
      cycle: 1,
    });
    expect(body).toContain("REQUEST_CHANGES");
    expect(body).toContain("cycle 1");
    expect(body).toContain("reviewer-verdict.md");
    expect(body).toContain("@last-light approve");
  });
});

describe("renderPrTitle / renderPrBody — the PR contract (golden)", () => {
  it("renders Closes + sections + only-present doc links + approved (no note)", () => {
    const body = renderPrBody({
      issue: 42,
      branch: "lastlight/42",
      links: {
        owner: "cliftonc",
        repo: "widget",
        branch: "lastlight/42",
        issueDir: ".lastlight/issue-42",
        files: ["architect-plan.md", "executor-summary.md"], // guardrails/verdict absent
      },
      approved: true,
      cycles: 1,
    });
    expect(body).toContain("Closes #42");
    expect(body).toContain("## Summary");
    expect(body).toContain("## Planning and execution docs");
    expect(body).toContain("## Test results");
    // Present artifacts are linked with full branch URLs; absent ones omitted.
    expect(body).toContain(
      "[Architect plan](https://github.com/cliftonc/widget/blob/lastlight%2F42/.lastlight/issue-42/architect-plan.md)",
    );
    expect(body).toContain("[Executor summary]");
    expect(body).not.toContain("[Guardrails report]");
    expect(body).not.toContain("[Reviewer verdict]");
    // Approved → no unresolved-issues note.
    expect(body).not.toContain("unresolved reviewer issues");
  });

  it("appends the unresolved-issues note + cycle count when NOT approved", () => {
    const body = renderPrBody({
      issue: 7,
      branch: "lastlight/7",
      links: { owner: "o", repo: "r", branch: "lastlight/7", issueDir: ".lastlight/issue-7", files: [] },
      approved: false,
      cycles: 2,
    });
    expect(body).toContain("unresolved reviewer issues after 2 fix cycle");
  });

  it("renders a title that references the issue + branch", () => {
    expect(renderPrTitle(42, "lastlight/42")).toBe("Build #42 (lastlight/42)");
  });
});

function fakeOctokit() {
  const createComment = vi.fn(async () => ({
    data: { id: 8001, html_url: "https://gh/issues/42#issuecomment-8001" },
  }));
  const reposGet = vi.fn(async () => ({ data: { default_branch: "main" } }));
  const pullsList = vi.fn(async () => ({ data: [] as Array<{ number: number; html_url: string }> }));
  const pullsCreate = vi.fn(async () => ({
    data: { number: 314, html_url: "https://gh/widget/pull/314" },
  }));
  const octokit = {
    rest: {
      issues: { createComment },
      repos: { get: reposGet },
      pulls: { list: pullsList, create: pullsCreate },
    },
  } as unknown as Octokit;
  return { octokit, createComment, reposGet, pullsList, pullsCreate };
}

describe("postGateCommentDeterministically — bound ref, never model-chosen", () => {
  it("posts an issue comment with owner/repo/issue_number from the bound ref", async () => {
    const { octokit, createComment } = fakeOctokit();
    const res = await postGateCommentDeterministically(octokit, REF, 42, "the ask");
    expect(createComment).toHaveBeenCalledWith({
      owner: "cliftonc",
      repo: "widget",
      issue_number: 42,
      body: "the ask",
    });
    expect(res).toEqual({ id: 8001, html_url: "https://gh/issues/42#issuecomment-8001" });
  });
});

describe("openPullRequestDeterministically — bound ref + idempotent", () => {
  it("creates a PR head=branch base=default-branch with the bound ref when none open", async () => {
    const { octokit, pullsList, pullsCreate } = fakeOctokit();
    const res = await openPullRequestDeterministically(octokit, REF, {
      branch: "lastlight/42",
      base: "main",
      title: "Build #42",
      body: "body",
    });
    // Checked for an existing open PR scoped to owner:branch (the bound head).
    expect(pullsList).toHaveBeenCalledWith({
      owner: "cliftonc",
      repo: "widget",
      state: "open",
      head: "cliftonc:lastlight/42",
    });
    expect(pullsCreate).toHaveBeenCalledWith({
      owner: "cliftonc",
      repo: "widget",
      head: "lastlight/42",
      base: "main",
      title: "Build #42",
      body: "body",
    });
    expect(res).toEqual({ number: 314, html_url: "https://gh/widget/pull/314", reused: false });
  });

  it("REUSES an already-open PR for the branch — does NOT double-open (idempotent)", async () => {
    const { octokit, pullsList, pullsCreate } = fakeOctokit();
    pullsList.mockResolvedValueOnce({
      data: [{ number: 99, html_url: "https://gh/widget/pull/99" }],
    });
    const res = await openPullRequestDeterministically(octokit, REF, {
      branch: "lastlight/42",
      base: "main",
      title: "t",
      body: "b",
    });
    expect(pullsCreate).not.toHaveBeenCalled();
    expect(res).toEqual({ number: 99, html_url: "https://gh/widget/pull/99", reused: true });
  });

  it("defaultBranchOf reads the bound repo's default_branch over the scoped token", async () => {
    const { octokit, reposGet } = fakeOctokit();
    await expect(defaultBranchOf(octokit, REF)).resolves.toBe("main");
    expect(reposGet).toHaveBeenCalledWith({ owner: "cliftonc", repo: "widget" });
  });
});
