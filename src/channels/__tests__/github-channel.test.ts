import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitHubWebhookDelivery } from "@flue/github";
import { handleDelivery } from "../github.ts";
import { BuildRunStore } from "../../build-run-store.ts";
import { DeliveryDedupe } from "../../agent-lib/github-screener.ts";
import type { RouterDeps, DispatchDeps } from "../../agent-lib/github-router.ts";

const BOT = "last-light[bot]";
const key = (ref: { owner: string; repo: string; issueNumber: number }) =>
  `github:${ref.owner}/${ref.repo}#${ref.issueNumber}`;

function delivery(name: string, payload: Record<string, unknown>, id = "d-1"): GitHubWebhookDelivery {
  return { name, payload, deliveryId: id } as unknown as GitHubWebhookDelivery;
}

/** Router/dispatch wiring with NO live LLM, NO real spawn, managed-repo = cliftonc/repo. */
function harness() {
  const invokeWorkflow = vi.fn(async () => {});
  const router: RouterDeps = {
    run: async () => {
      throw new Error("no LLM");
    },
  };
  const dispatch: DispatchDeps = { invokeWorkflow };
  const isManagedRepo = (repo: string | undefined) => repo === "cliftonc/lastlight";
  // Ack seam is injected so tests never mint a live token / hit GitHub.
  const ack = vi.fn(async () => {});
  return { invokeWorkflow, router, dispatch, isManagedRepo, ack, dedupe: new DeliveryDedupe() };
}

/** A no-op ack for inline-opts tests (keeps the live reaction seam out of tests). */
const noopAck = async () => {};

describe("handleDelivery — full webhook pipeline (offline, no side effects)", () => {
  it("issue.opened in a managed repo → invokes issue-triage exactly once", async () => {
    const h = harness();
    const d = delivery("issues", {
      action: "opened",
      sender: { login: "alice" },
      repository: { full_name: "cliftonc/lastlight" },
      issue: { number: 1, title: "t", body: "b", labels: [], author_association: "OWNER" },
    });
    const res = await handleDelivery(d, key, {
      botLogin: BOT,
      dedupe: h.dedupe,
      router: h.router,
      dispatch: h.dispatch,
      isManagedRepo: h.isManagedRepo,
      ack: h.ack,
    });
    expect(res).toMatchObject({ status: "accepted", workflow: "issue-triage" });
    expect(h.invokeWorkflow).toHaveBeenCalledTimes(1);
    expect(h.invokeWorkflow).toHaveBeenCalledWith("issue-triage", expect.objectContaining({ issueNumber: 1 }));
    // ACK: a non-comment admit reacts on the issue itself (no commentId on the event).
    expect(h.ack).toHaveBeenCalledTimes(1);
    expect(h.ack).toHaveBeenCalledWith(expect.objectContaining({ issueNumber: 1, commentId: undefined }));
  });

  it("DEDUPE: a redelivery with the same deliveryId is processed once", async () => {
    const h = harness();
    const d = delivery(
      "issues",
      {
        action: "opened",
        sender: { login: "alice" },
        repository: { full_name: "cliftonc/lastlight" },
        issue: { number: 2, title: "t", body: "b", labels: [], author_association: "OWNER" },
      },
      "same-id",
    );
    const first = await handleDelivery(d, key, { botLogin: BOT, dedupe: h.dedupe, router: h.router, dispatch: h.dispatch, isManagedRepo: h.isManagedRepo, ack: h.ack });
    const second = await handleDelivery(d, key, { botLogin: BOT, dedupe: h.dedupe, router: h.router, dispatch: h.dispatch, isManagedRepo: h.isManagedRepo, ack: h.ack });
    expect(first.status).toBe("accepted");
    expect(second.status).toBe("duplicate");
    expect(h.invokeWorkflow).toHaveBeenCalledTimes(1);
  });

  it("SCREEN: a non-managed repo is filtered (no invoke)", async () => {
    const h = harness();
    const d = delivery("issues", {
      action: "opened",
      sender: { login: "alice" },
      repository: { full_name: "stranger/unmanaged" },
      issue: { number: 3, title: "t", body: "b", labels: [] },
    });
    const res = await handleDelivery(d, key, { botLogin: BOT, dedupe: h.dedupe, router: h.router, dispatch: h.dispatch, isManagedRepo: h.isManagedRepo, ack: h.ack });
    expect(res.status).toBe("filtered");
    expect(h.invokeWorkflow).not.toHaveBeenCalled();
    expect(h.ack).not.toHaveBeenCalled(); // ACK: nothing admitted → no reaction
  });

  it("SCREEN: a bot-authored PR does NOT trigger pr-review", async () => {
    const h = harness();
    const d = delivery("pull_request", {
      action: "opened",
      sender: { login: BOT, type: "Bot" },
      repository: { full_name: "cliftonc/lastlight" },
      pull_request: { number: 4, title: "t", body: "", labels: [], user: { login: BOT } },
    });
    const res = await handleDelivery(d, key, { botLogin: BOT, dedupe: h.dedupe, router: h.router, dispatch: h.dispatch, isManagedRepo: h.isManagedRepo, ack: h.ack });
    expect(res.status).toBe("filtered");
    expect(h.invokeWorkflow).not.toHaveBeenCalled();
  });

  it("ping/unmapped (issues.closed) → filtered, no invoke", async () => {
    const h = harness();
    const d = delivery("issues", {
      action: "closed",
      sender: { login: "alice" },
      repository: { full_name: "cliftonc/lastlight" },
      issue: { number: 5, title: "t", body: "", labels: [] },
    });
    const res = await handleDelivery(d, key, { botLogin: BOT, dedupe: h.dedupe, router: h.router, dispatch: h.dispatch, isManagedRepo: h.isManagedRepo, ack: h.ack });
    expect(res.status).toBe("filtered");
    expect(h.invokeWorkflow).not.toHaveBeenCalled();
  });
});

// Phase 6 POLISH — classifier + decline-reply through the full channel pipeline.
describe("handleDelivery — classifier + decline-reply (offline, no live LLM/GitHub)", () => {
  function comment(body: string, association: string, sender = "alice", id = `c-${Math.random()}`): GitHubWebhookDelivery {
    return delivery(
      "issue_comment",
      {
        action: "created",
        sender: { login: sender },
        repository: { full_name: "cliftonc/lastlight" },
        issue: { number: 11, title: "T", pull_request: undefined },
        comment: { body, author_association: association },
      },
      id,
    );
  }

  it("maintainer NL @mention → classified intent routes to the right workflow (fake classifier, no live LLM)", async () => {
    const invokeWorkflow = vi.fn(async () => {});
    const res = await handleDelivery(comment("@last-light can you implement dark mode?", "OWNER"), key, {
      botLogin: BOT,
      // The classifier is INJECTED — a fake returns BUILD; the LLM `run` must never fire.
      router: {
        run: async () => {
          throw new Error("LLM must not be called when classify is injected");
        },
        classify: async () => ({ intent: "build" }),
        screen: async () => ({ flagged: false }),
      },
      dispatch: { invokeWorkflow },
      isManagedRepo: (r) => r === "cliftonc/lastlight",
      ack: noopAck,
    });
    expect(res).toMatchObject({ status: "accepted", workflow: "build" });
    expect(invokeWorkflow).toHaveBeenCalledWith("build", expect.objectContaining({ issue: 11 }));
  });

  it("ACK: a comment admitted to a workflow reacts on the triggering comment (commentId threaded)", async () => {
    const ack = vi.fn(async () => {});
    const d = delivery(
      "issue_comment",
      {
        action: "created",
        sender: { login: "alice" },
        repository: { full_name: "cliftonc/lastlight" },
        issue: { number: 11, title: "T", pull_request: undefined },
        comment: { body: "@last-light what do you think?", author_association: "OWNER", id: 98765 },
      },
      "c-ack",
    );
    const res = await handleDelivery(d, key, {
      botLogin: BOT,
      router: {
        run: async () => { throw new Error("no LLM"); },
        classify: async () => ({ intent: "chat" }),
        screen: async () => ({ flagged: false }),
      },
      dispatch: { invokeWorkflow: vi.fn(async () => {}) },
      isManagedRepo: (r) => r === "cliftonc/lastlight",
      ack,
    });
    expect(res).toMatchObject({ status: "accepted", workflow: "issue-comment" });
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ issueNumber: 11, commentId: 98765 }));
  });

  it("ACK: fires BEFORE the classifier (early, like Slack's defaultAck)", async () => {
    const order: string[] = [];
    const ack = vi.fn(async () => { order.push("ack"); });
    const classify = vi.fn(async () => { order.push("classify"); return { intent: "chat" as const }; });
    const d = delivery(
      "issue_comment",
      {
        action: "created",
        sender: { login: "alice" },
        repository: { full_name: "cliftonc/lastlight" },
        issue: { number: 11, title: "T", pull_request: undefined },
        comment: { body: "@last-light what do you think?", author_association: "OWNER", id: 5 },
      },
      "c-order",
    );
    await handleDelivery(d, key, {
      botLogin: BOT,
      router: { run: async () => { throw new Error("no LLM"); }, classify, screen: async () => ({ flagged: false }) },
      dispatch: { invokeWorkflow: vi.fn(async () => {}) },
      isManagedRepo: (r) => r === "cliftonc/lastlight",
      ack,
    });
    // The 👀 must land before the (slow) classifier runs — not after the route decision.
    expect(order).toEqual(["ack", "classify"]);
  });

  it("ACK: a declined (non-maintainer) @mention does NOT react", async () => {
    const ack = vi.fn(async () => {});
    const res = await handleDelivery(comment("@last-light build me a feature", "NONE", "rando"), key, {
      botLogin: BOT,
      router: { run: async () => { throw new Error("no LLM on a decline"); } },
      dispatch: { invokeWorkflow: vi.fn(async () => {}), reply: vi.fn(async () => {}) },
      isManagedRepo: (r) => r === "cliftonc/lastlight",
      ack,
    });
    expect(res.status).toBe("reply");
    expect(ack).not.toHaveBeenCalled(); // a decline posts a comment; no 👀
  });

  it("explicit @last-light approve bypasses the classifier (LLM never called)", async () => {
    const run = vi.fn(async () => "INTENT: BUILD");
    const resumeGate = vi.fn(async () => {});
    const res = await handleDelivery(comment("@last-light approve", "OWNER"), key, {
      botLogin: BOT,
      router: { run },
      dispatch: { invokeWorkflow: vi.fn(async () => {}), resumeGate },
      isManagedRepo: (r) => r === "cliftonc/lastlight",
      ack: noopAck,
    });
    expect(res.status).toBe("resume");
    expect(run).not.toHaveBeenCalled(); // explicit command → deterministic, no LLM
  });

  it("non-maintainer @mention of a privileged action → posts a decline on the bound ref", async () => {
    const reply = vi.fn<NonNullable<DispatchDeps["reply"]>>(async () => {});
    const invokeWorkflow = vi.fn(async () => {});
    const res = await handleDelivery(comment("@last-light build me a feature", "NONE", "rando"), key, {
      botLogin: BOT,
      router: { run: async () => { throw new Error("no LLM on a decline"); } },
      dispatch: { invokeWorkflow, reply },
      isManagedRepo: (r) => r === "cliftonc/lastlight",
      ack: noopAck,
    });
    expect(res.status).toBe("reply");
    expect(reply).toHaveBeenCalledTimes(1);
    // The reply seam is handed the EVENT (owner/repo/issue bound) + a maintainer-only message.
    const [ev, message] = reply.mock.calls[0]!;
    expect(ev).toMatchObject({ owner: "cliftonc", repoName: "lastlight", issueNumber: 11 });
    expect(message).toMatch(/maintainers/);
    expect(invokeWorkflow).not.toHaveBeenCalled();
  });

  it("SILENT: a bot sender is screened out → no reply, no invoke (no loop)", async () => {
    const reply = vi.fn(async () => {});
    const invokeWorkflow = vi.fn(async () => {});
    const res = await handleDelivery(comment("@last-light build", "NONE", BOT), key, {
      botLogin: BOT,
      router: { run: async () => { throw new Error("no LLM"); } },
      dispatch: { invokeWorkflow, reply },
      isManagedRepo: (r) => r === "cliftonc/lastlight",
      ack: noopAck,
    });
    expect(res.status).toBe("filtered");
    expect(reply).not.toHaveBeenCalled(); // never reply to the bot → no loop
    expect(invokeWorkflow).not.toHaveBeenCalled();
  });

  it("SILENT: a non-managed repo comment → no reply, no invoke", async () => {
    const reply = vi.fn(async () => {});
    const d = delivery("issue_comment", {
      action: "created",
      sender: { login: "rando" },
      repository: { full_name: "stranger/unmanaged" },
      issue: { number: 12, title: "T" },
      comment: { body: "@last-light build", author_association: "NONE" },
    });
    const res = await handleDelivery(d, key, {
      botLogin: BOT,
      router: { run: async () => { throw new Error("no LLM"); } },
      dispatch: { invokeWorkflow: vi.fn(async () => {}), reply },
      isManagedRepo: (r) => r === "cliftonc/lastlight",
      ack: noopAck,
    });
    expect(res.status).toBe("filtered");
    expect(reply).not.toHaveBeenCalled();
  });

  it("SILENT: a comment with NO @mention → ignored, no reply", async () => {
    const reply = vi.fn(async () => {});
    const res = await handleDelivery(comment("just chatting, no mention here", "OWNER"), key, {
      botLogin: BOT,
      router: { run: async () => { throw new Error("no LLM"); } },
      dispatch: { invokeWorkflow: vi.fn(async () => {}), reply },
      isManagedRepo: (r) => r === "cliftonc/lastlight",
      ack: noopAck,
    });
    expect(res.status).toBe("ignore");
    expect(reply).not.toHaveBeenCalled();
  });
});

// Phase 6 — CONVERSATION→runId GATE CORRELATION: an @last-light approve/reject on a
// conversation with a paused build run resolves the runId and resumes; no paused run
// is a clean no-op. The convKey here is the test `key()` serializer (the channel's
// conversationKey(ref)) — the SAME string the gate-pause path recorded on the run.
describe("github channel — @approve/@reject gate correlation (offline, no resume side effect)", () => {
  let dir: string;
  let store: BuildRunStore;
  const convKey = key({ owner: "cliftonc", repo: "lastlight", issueNumber: 7 });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ghc-"));
    store = new BuildRunStore(join(dir, "b.db"));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Production-shaped resumeGate: convKey → findPausedRunByConversation → fake resume. */
  function dispatchWithGateLookup(resumeFake: (runId: string, d: "approve" | "reject") => void): DispatchDeps {
    return {
      invokeWorkflow: vi.fn(async () => {}),
      resumeGate: async (conversationKey, decision) => {
        const runId = store.findPausedRunByConversation(conversationKey);
        if (!runId) return; // clean no-op
        resumeFake(runId, decision);
      },
    };
  }

  function comment(body: string): GitHubWebhookDelivery {
    return delivery("issue_comment", {
      action: "created",
      sender: { login: "maintainer" },
      repository: { full_name: "cliftonc/lastlight" },
      issue: { number: 7, title: "t", pull_request: undefined },
      comment: { body, author_association: "OWNER" },
    }, `cmt-${Math.random()}`);
  }

  it("@last-light approve on a conversation with a paused run → resumes that runId (approve)", async () => {
    store.getOrCreate("build-run-7", { owner: "cliftonc", repo: "lastlight", issue: 7, branch: "b", taskId: "t" });
    store.setConversationKey("build-run-7", convKey);
    store.setPending("build-run-7", "post_architect");

    const resumeFake = vi.fn();
    const res = await handleDelivery(comment("@last-light approve"), key, {
      botLogin: BOT,
      router: { run: async () => { throw new Error("no LLM"); } },
      dispatch: dispatchWithGateLookup(resumeFake),
      isManagedRepo: (r) => r === "cliftonc/lastlight",
      ack: noopAck,
    });
    expect(res.status).toBe("resume");
    expect(resumeFake).toHaveBeenCalledWith("build-run-7", "approve");
  });

  it("@last-light reject on a conversation with a paused run → resumes that runId (reject)", async () => {
    store.getOrCreate("build-run-7", { owner: "cliftonc", repo: "lastlight", issue: 7, branch: "b", taskId: "t" });
    store.setConversationKey("build-run-7", convKey);
    store.setPending("build-run-7", "post_architect");

    const resumeFake = vi.fn();
    await handleDelivery(comment("@last-light reject not yet"), key, {
      botLogin: BOT,
      router: { run: async () => { throw new Error("no LLM"); } },
      dispatch: dispatchWithGateLookup(resumeFake),
      isManagedRepo: (r) => r === "cliftonc/lastlight",
      ack: noopAck,
    });
    expect(resumeFake).toHaveBeenCalledWith("build-run-7", "reject");
  });

  it("@last-light approve with NO paused run on the conversation → clean no-op (no resume)", async () => {
    // A run exists but is NOT paused on this conversation.
    const resumeFake = vi.fn();
    const res = await handleDelivery(comment("@last-light approve"), key, {
      botLogin: BOT,
      router: { run: async () => { throw new Error("no LLM"); } },
      dispatch: dispatchWithGateLookup(resumeFake),
      isManagedRepo: (r) => r === "cliftonc/lastlight",
      ack: noopAck,
    });
    expect(res.status).toBe("resume"); // the route decision is resume…
    expect(resumeFake).not.toHaveBeenCalled(); // …but nothing to resolve → no-op
  });
});
