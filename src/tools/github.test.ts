import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the `octokit` module so NO live GitHub / network is needed. Every test
// here is offline. We capture a single shared mock instance whose `rest.*`
// methods we assert against. `vi.hoisted` lets these be referenced from the
// hoisted `vi.mock` factory.
const { restMock, OctokitMock } = vi.hoisted(() => {
  const restMock = {
    repos: { get: vi.fn(), getContent: vi.fn(), listCommits: vi.fn() },
    issues: {
      get: vi.fn(),
      listComments: vi.fn(),
      listForRepo: vi.fn(),
      createComment: vi.fn(),
      create: vi.fn(),
    },
    pulls: { get: vi.fn(), list: vi.fn(), createReview: vi.fn() },
    reactions: { createForIssueComment: vi.fn(), createForIssue: vi.fn() },
    search: { issuesAndPullRequests: vi.fn(), code: vi.fn() },
  };
  const OctokitMock = vi.fn(() => ({ rest: restMock }));
  return { restMock, OctokitMock };
});

vi.mock("octokit", () => ({ Octokit: OctokitMock }));

import { githubTools } from "./github.ts";
import type { GitAccessProfile } from "../engine/profiles.ts";
import type { ToolDefinition } from "@flue/runtime";

const REF = { owner: "octo", repo: "demo" };
const TOKEN = "ghs_scopedtoken";

function names(tools: ToolDefinition[]): string[] {
  return tools.map((t) => t.name).sort();
}

function byName(tools: ToolDefinition[], name: string): ToolDefinition {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool not found: ${name}`);
  return t;
}

/** Walk a JSON-Schema parameters object collecting every declared property key. */
function allPropertyKeys(schema: unknown): string[] {
  const keys: string[] = [];
  // Walk a valibot schema tree: object schemas carry `.entries`, arrays `.item`,
  // wrappers (optional/nullable/etc.) `.wrapped`. Collect every declared key.
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    if (obj.entries && typeof obj.entries === "object") {
      keys.push(...Object.keys(obj.entries as Record<string, unknown>));
      for (const v of Object.values(obj.entries as Record<string, unknown>)) visit(v);
    }
    if (obj.item) visit(obj.item);
    if (obj.wrapped) visit(obj.wrapped);
  };
  visit(schema);
  return keys;
}

const READ_TOOLS = [
  "github_get_repository",
  "github_get_issue",
  "github_list_issue_comments",
  "github_list_issues",
  "github_get_pull_request",
  "github_get_pull_request_diff",
  "github_list_pull_requests",
  "github_get_file_contents",
  "github_list_commits",
  "github_search_issues",
  "github_search_code",
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("githubTools — profile gating (which tool names exist)", () => {
  it("read profile → read tools only, no write tools", () => {
    const tools = githubTools(REF, TOKEN, "read");
    expect(names(tools)).toEqual([...READ_TOOLS].sort());
    expect(tools.some((t) => t.name.includes("comment_on") || t.name.includes("create"))).toBe(
      false,
    );
  });

  it("issues-write profile → read + comment/react/createIssue, NO createReview", () => {
    const tools = githubTools(REF, TOKEN, "issues-write");
    const ns = names(tools);
    expect(ns).toContain("github_comment_on_issue");
    expect(ns).toContain("github_react_to_comment");
    expect(ns).toContain("github_react_to_issue");
    expect(ns).toContain("github_create_issue");
    expect(ns).not.toContain("github_create_review");
    // still includes the full read surface
    for (const r of READ_TOOLS) expect(ns).toContain(r);
  });

  it("review-write profile → adds createReview on top of issues-write surface", () => {
    const tools = githubTools(REF, TOKEN, "review-write");
    const ns = names(tools);
    expect(ns).toContain("github_create_review");
    expect(ns).toContain("github_comment_on_issue");
  });

  it("repo-write profile → same model-tool surface as review-write (code mutation is via the sandbox, not a tool)", () => {
    const review = names(githubTools(REF, TOKEN, "review-write"));
    const repo = names(githubTools(REF, TOKEN, "repo-write"));
    expect(repo).toEqual(review);
  });

  it("each higher profile is a superset of the lower one", () => {
    const order: GitAccessProfile[] = ["read", "issues-write", "review-write", "repo-write"];
    let prev: string[] = [];
    for (const p of order) {
      const cur = names(githubTools(REF, TOKEN, p));
      for (const n of prev) expect(cur).toContain(n);
      prev = cur;
    }
  });
});

describe("SECURITY: token/owner/repo/ids are never model-selectable parameters", () => {
  const FORBIDDEN = [
    "owner",
    "repo",
    "token",
    "auth",
    "installationId",
    "installation_id",
    "appId",
    "app_id",
    "privateKey",
    "private_key",
  ];

  it("no tool exposes a forbidden parameter (closed-over ref/token, not model-selectable)", () => {
    // repo-write has the widest surface — covers all tools.
    const tools = githubTools(REF, TOKEN, "repo-write");
    expect(tools.length).toBeGreaterThan(0);
    for (const t of tools) {
      // The valibot input schema declares ONLY the safe model-supplied fields; the
      // bound owner/repo/token are closed over, never declared as input entries.
      const keys = allPropertyKeys(t.input);
      for (const f of FORBIDDEN) {
        expect(keys, `${t.name} must not expose '${f}'`).not.toContain(f);
      }
    }
  });

  it("the bound token is passed to Octokit's constructor, not exposed to the model", () => {
    githubTools(REF, TOKEN, "read");
    expect(OctokitMock).toHaveBeenCalledWith({ auth: TOKEN });
  });
});

describe("execute uses the closed-over ref/token, not model args", () => {
  it("getIssue calls octokit with the bound owner/repo and only the model-supplied issue_number", async () => {
    restMock.issues.get.mockResolvedValue({
      data: { number: 7, title: "t", state: "open", body: "b", labels: [], user: { login: "u" } },
    });
    const tools = githubTools(REF, TOKEN, "read");
    const res = await byName(tools, "github_get_issue").run({ input: { issue_number: 7 } });
    expect(restMock.issues.get).toHaveBeenCalledWith({
      owner: "octo",
      repo: "demo",
      issue_number: 7,
    });
    expect((res as { number: number }).number).toBe(7);
  });

  it("commentOnIssue posts with bound owner/repo and the model body", async () => {
    restMock.issues.createComment.mockResolvedValue({
      data: { id: 42, html_url: "https://x/42" },
    });
    const tools = githubTools(REF, TOKEN, "issues-write");
    const res = await byName(tools, "github_comment_on_issue").run({
      input: {
        issue_number: 3,
        body: "hello",
      },
    });
    expect(restMock.issues.createComment).toHaveBeenCalledWith({
      owner: "octo",
      repo: "demo",
      issue_number: 3,
      body: "hello",
    });
    expect((res as { id: number }).id).toBe(42);
  });

  it("createReview submits with bound owner/repo and the model event/body", async () => {
    restMock.pulls.createReview.mockResolvedValue({
      data: { id: 9, state: "APPROVED", html_url: "https://x/9" },
    });
    const tools = githubTools(REF, TOKEN, "review-write");
    await byName(tools, "github_create_review").run({
      input: {
        pull_number: 5,
        event: "APPROVE",
        body: "lgtm",
      },
    });
    expect(restMock.pulls.createReview).toHaveBeenCalledWith({
      owner: "octo",
      repo: "demo",
      pull_number: 5,
      event: "APPROVE",
      body: "lgtm",
    });
  });

  it("searchIssues forces the repo scope from the bound ref (model cannot widen it)", async () => {
    restMock.search.issuesAndPullRequests.mockResolvedValue({
      data: { total_count: 0, items: [] },
    });
    const tools = githubTools(REF, TOKEN, "read");
    await byName(tools, "github_search_issues").run({ input: { query: "is:open" } });
    expect(restMock.search.issuesAndPullRequests).toHaveBeenCalledWith({
      q: "repo:octo/demo is:open",
      per_page: 20,
    });
  });
});
