import { describe, it, expect, vi } from "vitest";
import type { GitHubWebhookDelivery } from "@flue/github";
import { handleDelivery } from "../github.ts";
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
