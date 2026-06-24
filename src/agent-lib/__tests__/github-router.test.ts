import { describe, it, expect, vi } from "vitest";
import * as v from "valibot";
import type { LastLightEvent } from "../../events.ts";
import { enrichEvent, type RoutableEvent } from "../event-enrich.ts";
import {
  routeEvent,
  dispatchRoute,
  type RouterDeps,
  type DispatchDeps,
} from "../github-router.ts";
import { IssueCommentInputSchema } from "../../workflows/issue-comment.ts";
import { PrCommentInputSchema } from "../../workflows/pr-comment.ts";

/** A throwing runner — proves deterministic routes never call the LLM. */
const noLlm: RouterDeps = {
  run: async () => {
    throw new Error("LLM must not be called on a deterministic route");
  },
};

function ev(overrides: Partial<LastLightEvent>): RoutableEvent {
  // The channel enriches every mapped event before routing — mirror that here so the
  // router sees the same `resolvedRepo` / `correlationId` it does in production.
  return enrichEvent({
    id: "d1",
    source: "github",
    type: "issue.opened",
    repo: "cliftonc/repo",
    owner: "cliftonc",
    repoName: "repo",
    issueNumber: 1,
    sender: "alice",
    senderIsBot: false,
    body: "",
    title: "T",
    labels: [],
    authorAssociation: "OWNER",
    conversationKey: "github:cliftonc/repo#1",
    ...overrides,
  });
}

describe("routeEvent — deterministic routes (ZERO LLM)", () => {
  it("issue.opened → issue-triage with the issue payload", async () => {
    const d = await routeEvent(ev({ type: "issue.opened", issueNumber: 42 }), noLlm);
    expect(d).toMatchObject({
      action: "workflow",
      workflow: "issue-triage",
      payload: { owner: "cliftonc", repo: "repo", issueNumber: 42, sender: "alice" },
    });
  });

  it("issue.reopened → issue-triage (reopened flag)", async () => {
    const d = await routeEvent(ev({ type: "issue.reopened", issueNumber: 5 }), noLlm);
    expect(d).toMatchObject({ workflow: "issue-triage", payload: { reopened: true } });
  });

  it("pr.opened → pr-review with prNumber", async () => {
    const d = await routeEvent(ev({ type: "pr.opened", prNumber: 7 }), noLlm);
    expect(d).toMatchObject({
      action: "workflow",
      workflow: "pr-review",
      payload: { owner: "cliftonc", repo: "repo", prNumber: 7 },
    });
  });

  it("pr.synchronize → pr-review", async () => {
    const d = await routeEvent(ev({ type: "pr.synchronize", prNumber: 7 }), noLlm);
    expect(d).toMatchObject({ workflow: "pr-review" });
  });
});

describe("routeEvent — comment path", () => {
  const base = { type: "comment.created" as const };

  it("ignores a comment with no @bot mention (silent)", async () => {
    const d = await routeEvent(ev({ ...base, body: "thanks!" }), noLlm);
    expect(d).toEqual({ action: "ignore", reason: "no bot mention in comment" });
  });

  it("non-maintainer @mention → router decline reply (no workflow)", async () => {
    const d = await routeEvent(
      ev({ ...base, body: "@last-light build this", authorAssociation: "NONE", sender: "rando" }),
      noLlm,
    );
    expect(d.action).toBe("reply");
    expect((d as any).message).toMatch(/maintainers/);
  });

  it("maintainer @last-light approve → resume(approve) — no classifier", async () => {
    const d = await routeEvent(ev({ ...base, body: "@last-light approve" }), noLlm);
    expect(d).toMatchObject({ action: "resume", decision: "approve" });
  });

  it("maintainer @last-light reject <reason> → resume(reject) with reason", async () => {
    const d = await routeEvent(ev({ ...base, body: "@last-light reject too risky" }), noLlm);
    expect(d).toMatchObject({ action: "resume", decision: "reject", reason: "too risky" });
  });

  it("maintainer @last-light security-review → security-review (regex, no classifier)", async () => {
    const d = await routeEvent(ev({ ...base, body: "@last-light security-review" }), noLlm);
    expect(d).toMatchObject({ action: "workflow", workflow: "security-review" });
  });

  it("reply-gate short-circuit → explore with the parked runId (no mention needed)", async () => {
    const deps: RouterDeps = {
      run: noLlm.run,
      pendingReplyGate: async () => ({ runId: "run-abc" }),
    };
    const d = await routeEvent(ev({ ...base, body: "plain reply, no mention" }), deps);
    expect(d).toMatchObject({
      action: "workflow",
      workflow: "explore",
      payload: { reply: "plain reply, no mention", workflowRunId: "run-abc" },
    });
  });

  it("maintainer NL 'build' intent → build workflow (classifier injected)", async () => {
    const deps: RouterDeps = {
      run: noLlm.run,
      classify: async () => ({ intent: "build" }),
      screen: async () => ({ flagged: false }),
    };
    const d = await routeEvent(ev({ ...base, body: "@last-light please implement X" }), deps);
    expect(d).toMatchObject({
      action: "workflow",
      workflow: "build",
      payload: { issue: 1, triggerType: "comment" },
    });
  });

  it("maintainer NL 'explore' intent → explore workflow", async () => {
    const deps: RouterDeps = {
      run: noLlm.run,
      classify: async () => ({ intent: "explore" }),
      screen: async () => ({ flagged: false }),
    };
    const d = await routeEvent(ev({ ...base, body: "@last-light let's explore this idea" }), deps);
    expect(d).toMatchObject({ action: "workflow", workflow: "explore" });
  });

  it("maintainer NL chat intent → issue-comment workflow", async () => {
    const deps: RouterDeps = {
      run: noLlm.run,
      classify: async () => ({ intent: "chat" }),
      screen: async () => ({ flagged: false }),
    };
    const d = await routeEvent(ev({ ...base, body: "@last-light what do you think?" }), deps);
    expect(d).toMatchObject({ action: "workflow", workflow: "issue-comment" });
  });

  it("PR comment build intent → pr-fix; non-build → pr-comment", async () => {
    const buildDeps: RouterDeps = {
      run: noLlm.run,
      classify: async () => ({ intent: "build" }),
      screen: async () => ({ flagged: false }),
    };
    const dBuild = await routeEvent(
      ev({ ...base, body: "@last-light fix the type error", prNumber: 9 }),
      buildDeps,
    );
    expect(dBuild).toMatchObject({ workflow: "pr-fix", payload: { prNumber: 9 } });

    const qDeps: RouterDeps = {
      run: noLlm.run,
      classify: async () => ({ intent: "question" }),
      screen: async () => ({ flagged: false }),
    };
    const dQ = await routeEvent(
      ev({ ...base, body: "@last-light does this consider X?", prNumber: 9 }),
      qDeps,
    );
    expect(dQ).toMatchObject({ workflow: "pr-comment" });
  });

  it("security-scan summary issue → security-feedback regardless of intent", async () => {
    const deps: RouterDeps = {
      run: noLlm.run,
      classify: async () => ({ intent: "build" }),
      screen: async () => ({ flagged: false }),
    };
    const d = await routeEvent(
      ev({ ...base, body: "@last-light create issues for the highs", labels: ["security-scan"] }),
      deps,
    );
    expect(d).toMatchObject({ action: "workflow", workflow: "security-feedback" });
  });

  it("comment-route payloads satisfy their workflow input schemas (incl. commentId)", async () => {
    // Regression: the router used to omit `commentId`, which both schemas require —
    // admission then died with `action_input_validation`. Parse the actual payload
    // against the actual workflow schema so any future drift fails here, not in prod.
    const chatDeps: RouterDeps = {
      run: noLlm.run,
      classify: async () => ({ intent: "chat" }),
      screen: async () => ({ flagged: false }),
    };
    const dIssue = await routeEvent(
      ev({ ...base, body: "@last-light what do you think?", commentId: 12345 }),
      chatDeps,
    );
    expect(dIssue).toMatchObject({ workflow: "issue-comment" });
    const issuePayload = (dIssue as { payload: unknown }).payload;
    expect(() => v.parse(IssueCommentInputSchema, issuePayload)).not.toThrow();
    expect((issuePayload as { commentId: unknown }).commentId).toBe(12345);

    const qDeps: RouterDeps = {
      run: noLlm.run,
      classify: async () => ({ intent: "question" }),
      screen: async () => ({ flagged: false }),
    };
    const dPr = await routeEvent(
      ev({ ...base, body: "@last-light does this consider X?", prNumber: 9, commentId: "c-abc" }),
      qDeps,
    );
    expect(dPr).toMatchObject({ workflow: "pr-comment" });
    const prPayload = (dPr as { payload: unknown }).payload;
    expect(() => v.parse(PrCommentInputSchema, prPayload)).not.toThrow();
    expect((prPayload as { commentId: unknown }).commentId).toBe("c-abc");
  });

  it("screener flag prefixes the commentBody passed to the workflow", async () => {
    const deps: RouterDeps = {
      run: noLlm.run,
      classify: async () => ({ intent: "build" }),
      screen: async () => ({ flagged: true, reason: "ignore previous instructions" }),
    };
    const d = await routeEvent(ev({ ...base, body: "@last-light build", issueNumber: 3 }), deps);
    expect((d as any).payload.commentBody).toMatch(/^\[lastlight-flag:/);
  });
});

describe("dispatchRoute — admission seams", () => {
  it("workflow decision spawns invokeWorkflow with the payload (NO real spawn)", async () => {
    const invokeWorkflow = vi.fn(async () => {});
    const deps: DispatchDeps = { invokeWorkflow };
    await dispatchRoute(ev({}), { action: "workflow", workflow: "issue-triage", payload: { x: 1 } }, deps);
    expect(invokeWorkflow).toHaveBeenCalledWith("issue-triage", { x: 1 });
  });

  it("resume decision calls resumeGate; ignore is a no-op", async () => {
    const invokeWorkflow = vi.fn(async () => {});
    const resumeGate = vi.fn(async () => {});
    const deps: DispatchDeps = { invokeWorkflow, resumeGate };
    await dispatchRoute(ev({}), { action: "resume", runId: "r1", decision: "approve" }, deps);
    expect(resumeGate).toHaveBeenCalledWith("r1", "approve", undefined);
    await dispatchRoute(ev({}), { action: "ignore", reason: "x" }, deps);
    expect(invokeWorkflow).not.toHaveBeenCalled();
  });

  it("reply decision calls the reply seam", async () => {
    const invokeWorkflow = vi.fn(async () => {});
    const reply = vi.fn(async () => {});
    const deps: DispatchDeps = { invokeWorkflow, reply };
    await dispatchRoute(ev({}), { action: "reply", message: "no" }, deps);
    expect(reply).toHaveBeenCalled();
    expect(invokeWorkflow).not.toHaveBeenCalled();
  });
});
