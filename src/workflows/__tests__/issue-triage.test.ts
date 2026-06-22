import { describe, it, expect, vi } from "vitest";
import type { FlueContext } from "@flue/runtime";
import type { Octokit } from "octokit";
import {
  runIssueTriage,
  type IssueTriageDeps,
  type IssueTriageInput,
  type IssueContext,
} from "../issue-triage.ts";
import {
  applyTriageDeterministically,
  type IssueRef,
  type TriageApplied,
} from "../../triage-post.ts";

function fakeCtx(payload: IssueTriageInput): FlueContext<IssueTriageInput> {
  return {
    id: "test-run",
    payload,
    env: {},
    req: undefined,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    init: vi.fn(async () => {
      throw new Error("init must not be called — runTriage is injected in tests");
    }),
  } as unknown as FlueContext<IssueTriageInput>;
}

const ISSUE: IssueContext = {
  title: "App crashes on startup",
  body: "Steps: run `app`, see a stack trace.",
  author: "reporter",
  labels: [],
  comments: [],
};

function fakeDeps(opts: { output: string; issue?: IssueContext }) {
  const mintToken = vi.fn(async () => "ghs_fake_issues_write_token");
  const makeOctokit = vi.fn(() => ({}) as unknown as Octokit);
  const fetchIssue = vi.fn(async () => opts.issue ?? ISSUE);
  let issueSeen: IssueContext | undefined;
  const runTriage = vi.fn(
    async (
      _ctx: FlueContext<IssueTriageInput>,
      _ref: IssueRef,
      _octokit: Octokit,
      issue: IssueContext,
    ) => {
      issueSeen = issue;
      return opts.output;
    },
  );
  const apply = vi.fn(
    async (
      _octokit: Octokit,
      _ref: IssueRef,
      o: { labels: string[]; comment?: string; close: boolean },
    ): Promise<TriageApplied> => ({
      labelsApplied: o.labels,
      commented: !!o.comment,
      commentUrl: o.comment ? "https://gh/comment/1" : undefined,
      closed: o.close,
    }),
  );
  const deps: IssueTriageDeps = { mintToken, makeOctokit, fetchIssue, runTriage, apply };
  return { deps, mintToken, makeOctokit, fetchIssue, runTriage, apply, issueSeen: () => issueSeen };
}

const INPUT: IssueTriageInput = { owner: "cliftonc", repo: "drizzle-cube", issueNumber: 42 };

describe("runIssueTriage — full flow over injected deps (no live model / GitHub)", () => {
  it("bug/ready-for-agent → mints issues-write token, parses, applies the mapped labels", async () => {
    const { deps, mintToken, apply } = fakeDeps({
      output: "Fully specified.\nCLASSIFICATION: category=bug state=ready-for-agent",
    });
    const res = await runIssueTriage(fakeCtx(INPUT), deps);

    expect(mintToken).toHaveBeenCalledWith(INPUT);
    expect(res.classification.category).toBe("bug");
    expect(res.classification.state).toBe("ready-for-agent");
    expect(res.viaFallback).toBe(false);
    expect(res.labelsApplied).toEqual(["bug", "ready-for-agent"]);

    // The applier got the BOUND ref (owner/repo/issue NOT model-selectable).
    expect(apply).toHaveBeenCalledWith(
      expect.anything(),
      { owner: "cliftonc", repo: "drizzle-cube", issue_number: 42 },
      expect.objectContaining({ labels: ["bug", "ready-for-agent"], close: false }),
    );
  });

  it("needs-info → applies labels AND posts the pre-marker comment body", async () => {
    const { deps, apply } = fakeDeps({
      output:
        "## Triage Notes\n\nNeed a repro.\n\nCLASSIFICATION: category=bug state=needs-info",
    });
    const res = await runIssueTriage(fakeCtx(INPUT), deps);
    expect(res.labelsApplied).toEqual(["bug", "needs-info"]);
    expect(res.commented).toBe(true);
    expect(apply).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ comment: "## Triage Notes\n\nNeed a repro." }),
    );
  });

  it("duplicate + close → adds duplicate label and closes", async () => {
    const { deps, apply } = fakeDeps({
      output:
        "Duplicate of #10.\nCLASSIFICATION: category=bug state=wontfix duplicate close",
    });
    const res = await runIssueTriage(fakeCtx(INPUT), deps);
    expect(res.labelsApplied).toEqual(["bug", "wontfix", "duplicate"]);
    expect(res.closed).toBe(true);
    expect(apply).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ close: true }),
    );
  });

  it("question → applies the question label only, no state", async () => {
    const { deps } = fakeDeps({ output: "CLASSIFICATION: category=question" });
    const res = await runIssueTriage(fakeCtx(INPUT), deps);
    expect(res.labelsApplied).toEqual(["question"]);
    expect(res.classification.state).toBeUndefined();
  });

  it("missing marker → viaFallback true, logs a warning, still applies needs-triage", async () => {
    const ctx = fakeCtx(INPUT);
    const { deps } = fakeDeps({ output: "I forgot the marker." });
    const res = await runIssueTriage(ctx, deps);
    expect(res.viaFallback).toBe(true);
    expect(res.labelsApplied).toEqual(["bug", "needs-triage"]);
    expect(ctx.log.warn).toHaveBeenCalled();
  });

  it("the agent receives the fetched issue context (deterministic fetch, not a model tool)", async () => {
    const t = fakeDeps({ output: "CLASSIFICATION: category=bug state=needs-triage" });
    await runIssueTriage(fakeCtx(INPUT), t.deps);
    expect(t.fetchIssue).toHaveBeenCalled();
    expect(t.issueSeen()).toEqual(ISSUE);
  });
});

// ---------------------------------------------------------------------------
// Deterministic poster security tests (mirrors github-post.ts): the BOUND ref is
// never model-selectable, the right octokit methods are called, no token leak.
// ---------------------------------------------------------------------------
describe("applyTriageDeterministically — bound ref, correct mocked octokit calls", () => {
  const REF: IssueRef = { owner: "cliftonc", repo: "drizzle-cube", issue_number: 42 };

  function fakeOctokit() {
    const createLabel = vi.fn(async () => ({}));
    const addLabels = vi.fn(async () => ({ data: [] }));
    const createComment = vi.fn(async () => ({ data: { html_url: "https://gh/comment/9" } }));
    const update = vi.fn(async () => ({ data: {} }));
    const listLabelsForRepo = vi.fn();
    const paginate = vi.fn(async () => [] as { name: string }[]);
    const octokit = {
      rest: {
        issues: { createLabel, addLabels, createComment, update, listLabelsForRepo },
      },
      paginate,
    } as unknown as Octokit;
    return { octokit, createLabel, addLabels, createComment, update, paginate };
  }

  it("ensures labels exist (createLabel) then addLabels with the BOUND ref", async () => {
    const o = fakeOctokit();
    const res = await applyTriageDeterministically(o.octokit, REF, {
      labels: ["bug", "ready-for-agent"],
      close: false,
    });
    expect(o.createLabel).toHaveBeenCalledTimes(2);
    // addLabels was called with owner/repo/issue_number from the BOUND ref only.
    expect(o.addLabels).toHaveBeenCalledWith({
      owner: "cliftonc",
      repo: "drizzle-cube",
      issue_number: 42,
      labels: ["bug", "ready-for-agent"],
    });
    expect(res.labelsApplied).toEqual(["bug", "ready-for-agent"]);
    expect(res.commented).toBe(false);
    expect(res.closed).toBe(false);
  });

  it("422 'already exists' on createLabel → label still applyable", async () => {
    const o = fakeOctokit();
    o.createLabel.mockRejectedValueOnce(Object.assign(new Error("exists"), { status: 422 }));
    await applyTriageDeterministically(o.octokit, REF, { labels: ["bug"], close: false });
    expect(o.addLabels).toHaveBeenCalledWith(
      expect.objectContaining({ labels: ["bug"] }),
    );
  });

  it("403 on createLabel → existing-only fallback (drops a label the repo lacks)", async () => {
    const o = fakeOctokit();
    o.createLabel.mockRejectedValue(Object.assign(new Error("denied"), { status: 403 }));
    o.paginate.mockResolvedValue([{ name: "bug" }]); // repo already has `bug`, not the state label
    const res = await applyTriageDeterministically(o.octokit, REF, {
      labels: ["bug", "ready-for-agent"],
      close: false,
    });
    expect(res.labelsApplied).toEqual(["bug"]);
    expect(o.addLabels).toHaveBeenCalledWith(
      expect.objectContaining({ labels: ["bug"] }),
    );
  });

  it("posts a comment (createComment, bound ref) and closes (issues.update state=closed)", async () => {
    const o = fakeOctokit();
    const res = await applyTriageDeterministically(o.octokit, REF, {
      labels: ["bug", "wontfix", "duplicate"],
      comment: "Duplicate of #10.",
      close: true,
    });
    expect(o.createComment).toHaveBeenCalledWith({
      owner: "cliftonc",
      repo: "drizzle-cube",
      issue_number: 42,
      body: "Duplicate of #10.",
    });
    expect(o.update).toHaveBeenCalledWith({
      owner: "cliftonc",
      repo: "drizzle-cube",
      issue_number: 42,
      state: "closed",
    });
    expect(res.commented).toBe(true);
    expect(res.closed).toBe(true);
  });

  it("empty/whitespace comment → no comment posted", async () => {
    const o = fakeOctokit();
    const res = await applyTriageDeterministically(o.octokit, REF, {
      labels: ["question"],
      comment: "   ",
      close: false,
    });
    expect(o.createComment).not.toHaveBeenCalled();
    expect(res.commented).toBe(false);
  });
});
