import { describe, it, expect } from "vitest";
import type { GitHubWebhookDelivery } from "@flue/github";
import { toLastLightEvent } from "../github-mapper.ts";

const key = (ref: { owner: string; repo: string; issueNumber: number }) =>
  `github:${ref.owner}/${ref.repo}#${ref.issueNumber}`;

function delivery(name: string, payload: Record<string, unknown>, id = "del-1"): GitHubWebhookDelivery {
  return { name, payload, deliveryId: id } as unknown as GitHubWebhookDelivery;
}

describe("toLastLightEvent — native GitHub delivery → LastLightEvent", () => {
  it("maps issues.opened, snapshotting title/body/labels/association", () => {
    const d = delivery("issues", {
      action: "opened",
      sender: { login: "alice" },
      repository: { full_name: "cliftonc/repo" },
      issue: {
        number: 42,
        title: "Add CSV export",
        body: "We need CSV.",
        labels: [{ name: "enhancement" }, { name: "feature" }],
        author_association: "OWNER",
      },
    });
    const ev = toLastLightEvent(d, key);
    expect(ev).toMatchObject({
      id: "del-1",
      source: "github",
      type: "issue.opened",
      repo: "cliftonc/repo",
      owner: "cliftonc",
      repoName: "repo",
      issueNumber: 42,
      sender: "alice",
      senderIsBot: false,
      title: "Add CSV export",
      body: "We need CSV.",
      labels: ["enhancement", "feature"],
      authorAssociation: "OWNER",
      conversationKey: "github:cliftonc/repo#42",
    });
  });

  it("maps pull_request.opened → pr.opened with prNumber", () => {
    const d = delivery("pull_request", {
      action: "opened",
      sender: { login: "bob" },
      repository: { full_name: "cliftonc/repo" },
      pull_request: { number: 7, title: "Fix bug", body: "patch", labels: [], author_association: "MEMBER" },
    });
    const ev = toLastLightEvent(d, key)!;
    expect(ev.type).toBe("pr.opened");
    expect(ev.prNumber).toBe(7);
    expect(ev.issueNumber).toBe(7); // PRs reuse their issue number
    expect(ev.conversationKey).toBe("github:cliftonc/repo#7");
  });

  it("maps pull_request.synchronize → pr.synchronize", () => {
    const d = delivery("pull_request", {
      action: "synchronize",
      sender: { login: "bob" },
      repository: { full_name: "cliftonc/repo" },
      pull_request: { number: 7, title: "t", body: "", labels: [] },
    });
    expect(toLastLightEvent(d, key)!.type).toBe("pr.synchronize");
  });

  it("maps issue_comment.created (@bot command), carrying parent issue labels", () => {
    const d = delivery("issue_comment", {
      action: "created",
      sender: { login: "carol" },
      repository: { full_name: "cliftonc/repo" },
      issue: { number: 99, title: "Security Review", labels: [{ name: "security-scan" }] },
      comment: { body: "@last-light build this", author_association: "COLLABORATOR" },
    });
    const ev = toLastLightEvent(d, key)!;
    expect(ev.type).toBe("comment.created");
    expect(ev.issueNumber).toBe(99);
    expect(ev.body).toBe("@last-light build this");
    expect(ev.labels).toEqual(["security-scan"]);
    expect(ev.authorAssociation).toBe("COLLABORATOR");
    expect(ev.prNumber).toBeUndefined();
  });

  it("flags a comment on a PR (issue.pull_request present) with prNumber", () => {
    const d = delivery("issue_comment", {
      action: "created",
      sender: { login: "carol" },
      repository: { full_name: "cliftonc/repo" },
      issue: { number: 12, title: "t", labels: [], pull_request: { url: "x" } },
      comment: { body: "@last-light review", author_association: "OWNER" },
    });
    const ev = toLastLightEvent(d, key)!;
    expect(ev.prNumber).toBe(12);
  });

  it("returns null for an unmapped event/action (e.g. issues.closed)", () => {
    const d = delivery("issues", {
      action: "closed",
      sender: { login: "alice" },
      repository: { full_name: "cliftonc/repo" },
      issue: { number: 1, title: "t", labels: [] },
    });
    expect(toLastLightEvent(d, key)).toBeNull();
  });
});
