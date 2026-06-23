import { describe, it, expect } from "vitest";
import type { GitHubWebhookDelivery } from "@flue/github";
import {
  screenDelivery,
  DeliveryDedupe,
  isMaintainer,
  hasBotMention,
  IGNORED_ACTIONS,
} from "../github-screener.ts";

const BOT = "last-light[bot]";
const MANAGED = (repo: string | undefined) => repo === "cliftonc/managed";

/** Build a minimal native delivery for a given event name + payload. */
function delivery(name: string, payload: Record<string, unknown>, id = "d-1"): GitHubWebhookDelivery {
  return { name, payload, deliveryId: id } as unknown as GitHubWebhookDelivery;
}

const human = { login: "alice", type: "User" };
const bot = { login: BOT, type: "Bot" };
const repoManaged = { full_name: "cliftonc/managed" };
const repoOther = { full_name: "someone/other" };

describe("screenDelivery — deterministic admission policy", () => {
  it("allows a managed-repo issue opened by a human", () => {
    const d = delivery("issues", { action: "opened", sender: human, repository: repoManaged });
    expect(screenDelivery(d, BOT, MANAGED)).toEqual({ allow: true });
  });

  it("drops a non-managed repo (allowlist)", () => {
    const d = delivery("issues", { action: "opened", sender: human, repository: repoOther });
    const v = screenDelivery(d, BOT, MANAGED);
    expect(v.allow).toBe(false);
    expect((v as any).reason).toMatch(/not managed/);
  });

  it("drops a bot sender — no self-loop", () => {
    const d = delivery("issue_comment", { action: "created", sender: bot, repository: repoManaged });
    const v = screenDelivery(d, BOT, MANAGED);
    expect(v.allow).toBe(false);
    expect((v as any).reason).toMatch(/bot sender/);
  });

  it("drops a [bot]-suffixed sender even with type User", () => {
    const d = delivery("issue_comment", {
      action: "created",
      sender: { login: "renovate[bot]", type: "User" },
      repository: repoManaged,
    });
    expect(screenDelivery(d, BOT, MANAGED).allow).toBe(false);
  });

  it("lets a bot SENDER through for PR-attention (re-review signal) on a human PR", () => {
    const d = delivery("pull_request", {
      action: "synchronize",
      sender: bot,
      pull_request: { number: 7, user: { login: "alice" } },
      repository: repoManaged,
    });
    expect(screenDelivery(d, BOT, MANAGED)).toEqual({ allow: true });
  });

  it("drops a PR the bot AUTHORED (self-review 422 guard)", () => {
    const d = delivery("pull_request", {
      action: "opened",
      sender: bot,
      pull_request: { number: 8, user: { login: BOT } },
      repository: repoManaged,
    });
    const v = screenDelivery(d, BOT, MANAGED);
    expect(v.allow).toBe(false);
    expect((v as any).reason).toMatch(/self-review/);
  });

  it("drops ignored actions (labeled/edited/closed/…)", () => {
    for (const action of ["labeled", "edited", "closed", "assigned"]) {
      expect(IGNORED_ACTIONS.has(action)).toBe(true);
      const d = delivery("issues", { action, sender: human, repository: repoManaged });
      expect(screenDelivery(d, BOT, MANAGED).allow).toBe(false);
    }
  });
});

describe("maintainer gate", () => {
  it("admits OWNER/MEMBER/COLLABORATOR, rejects CONTRIBUTOR/NONE", () => {
    expect(isMaintainer("OWNER")).toBe(true);
    expect(isMaintainer("MEMBER")).toBe(true);
    expect(isMaintainer("COLLABORATOR")).toBe(true);
    expect(isMaintainer("CONTRIBUTOR")).toBe(false);
    expect(isMaintainer("NONE")).toBe(false);
    expect(isMaintainer(undefined)).toBe(false);
  });
});

describe("bot mention", () => {
  it("matches @last-light case-insensitively", () => {
    expect(hasBotMention("hey @last-light build this")).toBe(true);
    expect(hasBotMention("@LAST-LIGHT approve")).toBe(true);
    expect(hasBotMention("thanks, fixed it")).toBe(false);
  });
});

describe("DeliveryDedupe — same deliveryId processed once", () => {
  it("admits the first time, rejects repeats (idempotent redelivery)", () => {
    const ring = new DeliveryDedupe();
    expect(ring.admit("abc")).toBe(true);
    expect(ring.admit("abc")).toBe(false);
    expect(ring.admit("abc")).toBe(false);
    expect(ring.admit("def")).toBe(true);
  });

  it("evicts the oldest beyond capacity (re-admits an evicted id)", () => {
    const ring = new DeliveryDedupe(2);
    expect(ring.admit("a")).toBe(true); // ring: a
    expect(ring.admit("b")).toBe(true); // ring: a,b
    expect(ring.admit("c")).toBe(true); // len 3>2 → evict a; ring: b,c
    expect(ring.admit("a")).toBe(true); // a was evicted → admitted again; evict b; ring: c,a
    expect(ring.admit("c")).toBe(false); // c still in the ring
    expect(ring.admit("b")).toBe(true); // b was evicted → admitted again
  });
});
