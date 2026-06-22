import { describe, it, expect, vi } from "vitest";
import type { Octokit } from "octokit";
import type { FlueContext } from "@flue/runtime";
import {
  runPostGateComment,
  runOpenPullRequest,
  type GatePostDeps,
  type OpenPrDeps,
  type BuildInput,
} from "../build-phases.ts";
import type { BuildRun } from "../../build-run-store.ts";

// Phase 4 — the deterministic side-effect phase WIRING (gate ask + open-PR) over
// injected deps + a mocked octokit. The pure renderers + the bound-ref security are
// covered in build-github-post.test.ts; here we assert the phase glue: mint → render
// → post/open, with owner/repo/issue/head/base bound to the run, never model-chosen.

const RUN: BuildRun = {
  id: "cliftonc/widget#42",
  owner: "cliftonc",
  repo: "widget",
  issue: 42,
  branch: "lastlight/42",
  taskId: "widget-42-build",
  phasesDone: {},
  scratch: {},
  pendingGate: null,
  reviewerCycle: 1,
  restartCount: 0,
  status: "active",
  failReason: null,
};

function ctx(): FlueContext<BuildInput> {
  return {
    payload: { runId: RUN.id, owner: RUN.owner, repo: RUN.repo, issue: RUN.issue },
    log: { info() {}, warn() {}, error() {} },
  } as unknown as FlueContext<BuildInput>;
}

describe("runPostGateComment — mint → render → post the bound issue comment", () => {
  it("post_architect: posts the plan ask to the bound issue, returns the comment id", async () => {
    const createComment = vi.fn(async () => ({ data: { id: 8001, html_url: "https://gh/c/8001" } }));
    const octokit = { rest: { issues: { createComment } } } as unknown as Octokit;
    const deps: GatePostDeps = { mintToken: async () => "ghs_gate", makeOctokit: () => octokit };

    const res = await runPostGateComment(ctx(), RUN, "post_architect", deps);
    expect(res.commentId).toBe(8001);
    const call = (createComment.mock.calls[0] as unknown[])[0] as { owner: string; repo: string; issue_number: number; body: string };
    expect(call.owner).toBe("cliftonc");
    expect(call.repo).toBe("widget");
    expect(call.issue_number).toBe(42);
    expect(call.body).toContain("architect-plan.md");
    expect(call.body).toContain("@last-light approve");
  });

  it("post_reviewer:1: surfaces the verdict artifact + cycle", async () => {
    const createComment = vi.fn(async () => ({ data: { id: 8002, html_url: "https://gh/c/8002" } }));
    const octokit = { rest: { issues: { createComment } } } as unknown as Octokit;
    const deps: GatePostDeps = { mintToken: async () => "ghs_gate", makeOctokit: () => octokit };

    await runPostGateComment(ctx(), RUN, "post_reviewer:1", deps);
    const body = ((createComment.mock.calls[0] as unknown[])[0] as { body: string }).body;
    expect(body).toContain("reviewer-verdict.md");
    expect(body).toContain("cycle 1");
  });
});

describe("runOpenPullRequest — mint → default-branch → render → idempotent open", () => {
  function octokitWith(opts: { existing?: Array<{ number: number; html_url: string }> } = {}) {
    const reposGet = vi.fn(async () => ({ data: { default_branch: "main" } }));
    const pullsList = vi.fn(async () => ({ data: opts.existing ?? [] }));
    const pullsCreate = vi.fn(async () => ({ data: { number: 314, html_url: "https://gh/pull/314" } }));
    const octokit = {
      rest: { repos: { get: reposGet }, pulls: { list: pullsList, create: pullsCreate } },
    } as unknown as Octokit;
    return { octokit, reposGet, pullsList, pullsCreate };
  }

  it("opens a PR head=branch base=default-branch with a rendered body (approved → no note)", async () => {
    const { octokit, pullsCreate } = octokitWith();
    const run = { ...RUN, scratch: { "verdict:0": "VERDICT: APPROVED" } };
    const deps: OpenPrDeps = { mintToken: async () => "ghs_pr", makeOctokit: () => octokit };

    const res = await runOpenPullRequest(ctx(), run, deps);
    expect(res).toEqual({ html_url: "https://gh/pull/314", number: 314 });
    const call = (pullsCreate.mock.calls[0] as unknown[])[0] as { head: string; base: string; title: string; body: string };
    expect(call.head).toBe("lastlight/42");
    expect(call.base).toBe("main");
    expect(call.body).toContain("Closes #42");
    expect(call.body).not.toContain("unresolved reviewer issues");
  });

  it("idempotent: an already-open PR for the branch is reused, NOT double-opened", async () => {
    const { octokit, pullsCreate } = octokitWith({
      existing: [{ number: 99, html_url: "https://gh/pull/99" }],
    });
    const deps: OpenPrDeps = { mintToken: async () => "ghs_pr", makeOctokit: () => octokit };
    const res = await runOpenPullRequest(ctx(), RUN, deps);
    expect(pullsCreate).not.toHaveBeenCalled();
    expect(res).toEqual({ html_url: "https://gh/pull/99", number: 99 });
  });

  it("not-approved last verdict → the PR body notes unresolved issues + cycle count", async () => {
    const { octokit, pullsCreate } = octokitWith();
    const run = { ...RUN, reviewerCycle: 2, scratch: { "verdict:1": "VERDICT: REQUEST_CHANGES" } };
    const deps: OpenPrDeps = { mintToken: async () => "ghs_pr", makeOctokit: () => octokit };
    await runOpenPullRequest(ctx(), run, deps);
    const body = ((pullsCreate.mock.calls[0] as unknown[])[0] as { body: string }).body;
    expect(body).toContain("unresolved reviewer issues after 2 fix cycle");
  });
});
