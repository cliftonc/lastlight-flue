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
  return { invokeWorkflow, router, dispatch, isManagedRepo, dedupe: new DeliveryDedupe() };
}

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
    });
    expect(res).toMatchObject({ status: "accepted", workflow: "issue-triage" });
    expect(h.invokeWorkflow).toHaveBeenCalledTimes(1);
    expect(h.invokeWorkflow).toHaveBeenCalledWith("issue-triage", expect.objectContaining({ issueNumber: 1 }));
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
    const first = await handleDelivery(d, key, { botLogin: BOT, dedupe: h.dedupe, router: h.router, dispatch: h.dispatch, isManagedRepo: h.isManagedRepo });
    const second = await handleDelivery(d, key, { botLogin: BOT, dedupe: h.dedupe, router: h.router, dispatch: h.dispatch, isManagedRepo: h.isManagedRepo });
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
    const res = await handleDelivery(d, key, { botLogin: BOT, dedupe: h.dedupe, router: h.router, dispatch: h.dispatch, isManagedRepo: h.isManagedRepo });
    expect(res.status).toBe("filtered");
    expect(h.invokeWorkflow).not.toHaveBeenCalled();
  });

  it("SCREEN: a bot-authored PR does NOT trigger pr-review", async () => {
    const h = harness();
    const d = delivery("pull_request", {
      action: "opened",
      sender: { login: BOT, type: "Bot" },
      repository: { full_name: "cliftonc/lastlight" },
      pull_request: { number: 4, title: "t", body: "", labels: [], user: { login: BOT } },
    });
    const res = await handleDelivery(d, key, { botLogin: BOT, dedupe: h.dedupe, router: h.router, dispatch: h.dispatch, isManagedRepo: h.isManagedRepo });
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
    const res = await handleDelivery(d, key, { botLogin: BOT, dedupe: h.dedupe, router: h.router, dispatch: h.dispatch, isManagedRepo: h.isManagedRepo });
    expect(res.status).toBe("filtered");
    expect(h.invokeWorkflow).not.toHaveBeenCalled();
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
    });
    expect(res.status).toBe("resume"); // the route decision is resume…
    expect(resumeFake).not.toHaveBeenCalled(); // …but nothing to resolve → no-op
  });
});
