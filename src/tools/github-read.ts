/**
 * Read-only GitHub tools as Flue `defineTool` factories.
 *
 * Reimplements the GET-only subset of the reference's pi-ai-coupled tool layer
 * (`lastlight/src/engine/github-tools.ts`, 354L) as bound Flue tools. The
 * SECURITY SPINE (spec/09-sandbox.md, design/phase-1-shared-core.md): the
 * `owner`, `repo`, and the authenticating `Octokit` (which holds the scoped
 * token) are CLOSED OVER in each factory — they are NEVER model-selectable tool
 * `parameters`. The model only supplies safe payload fields (an issue/PR number,
 * a file path, a search query, pagination). Every `parameters` schema sets
 * `additionalProperties: false` and lists only those safe fields.
 *
 * These factories are shared: both the read-profile chat surface
 * (`github-read.ts` consumers) and the write surface (`github.ts`) compose
 * them so the read layer stays DRY.
 */
import { defineTool, type ToolDefinition } from "@flue/runtime";
import type { Octokit } from "octokit";

/**
 * A repository reference bound into a tool factory at trusted construction
 * time. Closed over in `execute`; never exposed as a model-selectable arg.
 */
export interface RepoRef {
  owner: string;
  repo: string;
}

/** Serialize a handler result for return to the LLM (tools return a string). */
function ok(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

// ---------------------------------------------------------------------------
// Read tool factories. Each closes over (ref, octokit). Model args are SAFE
// payload fields only — no owner/repo/token/installationId.
// ---------------------------------------------------------------------------

export function getRepository(ref: RepoRef, octokit: Octokit): ToolDefinition {
  return defineTool({
    name: "github_get_repository",
    description:
      "Get the bound repository's metadata (default branch, description, topics, visibility).",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      const { data } = await octokit.rest.repos.get({ owner: ref.owner, repo: ref.repo });
      return ok({
        full_name: data.full_name,
        default_branch: data.default_branch,
        description: data.description,
        topics: data.topics ?? [],
        private: data.private,
        open_issues_count: data.open_issues_count,
      });
    },
  });
}

export function getIssue(ref: RepoRef, octokit: Octokit): ToolDefinition {
  return defineTool({
    name: "github_get_issue",
    description: "Get a single issue by number from the bound repository.",
    parameters: {
      type: "object",
      properties: { issue_number: { type: "integer", minimum: 1 } },
      required: ["issue_number"],
      additionalProperties: false,
    },
    async execute(args) {
      const { data } = await octokit.rest.issues.get({
        owner: ref.owner,
        repo: ref.repo,
        issue_number: args.issue_number as number,
      });
      return ok({
        number: data.number,
        title: data.title,
        state: data.state,
        body: data.body,
        labels: (data.labels || []).map((l) => (typeof l === "string" ? l : l.name)),
        html_url: data.html_url,
        author: data.user?.login,
        created_at: data.created_at,
        updated_at: data.updated_at,
      });
    },
  });
}

export function listIssueComments(ref: RepoRef, octokit: Octokit): ToolDefinition {
  return defineTool({
    name: "github_list_issue_comments",
    description: "List comments on an issue or PR in the bound repository (oldest first).",
    parameters: {
      type: "object",
      properties: {
        issue_number: { type: "integer", minimum: 1 },
        per_page: { type: "integer", minimum: 1, maximum: 100 },
      },
      required: ["issue_number"],
      additionalProperties: false,
    },
    async execute(args) {
      const { data } = await octokit.rest.issues.listComments({
        owner: ref.owner,
        repo: ref.repo,
        issue_number: args.issue_number as number,
        per_page: (args.per_page as number | undefined) ?? 30,
      });
      return ok(
        data.map((c) => ({
          id: c.id,
          author: c.user?.login,
          body: c.body,
          created_at: c.created_at,
        })),
      );
    },
  });
}

export function listIssues(ref: RepoRef, octokit: Octokit): ToolDefinition {
  return defineTool({
    name: "github_list_issues",
    description: "List issues (not PRs) on the bound repository.",
    parameters: {
      type: "object",
      properties: {
        state: { type: "string", enum: ["open", "closed", "all"] },
        labels: { type: "string", description: "Comma-separated label names." },
        per_page: { type: "integer", minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
    async execute(args) {
      const { data } = await octokit.rest.issues.listForRepo({
        owner: ref.owner,
        repo: ref.repo,
        state: (args.state as "open" | "closed" | "all" | undefined) ?? "open",
        labels: args.labels as string | undefined,
        per_page: (args.per_page as number | undefined) ?? 30,
      });
      return ok(
        data
          .filter((i) => !i.pull_request)
          .map((i) => ({
            number: i.number,
            title: i.title,
            state: i.state,
            labels: (i.labels || []).map((l) => (typeof l === "string" ? l : l.name)),
            author: i.user?.login,
            updated_at: i.updated_at,
          })),
      );
    },
  });
}

export function getPullRequest(ref: RepoRef, octokit: Octokit): ToolDefinition {
  return defineTool({
    name: "github_get_pull_request",
    description: "Get a single pull request by number from the bound repository.",
    parameters: {
      type: "object",
      properties: { pull_number: { type: "integer", minimum: 1 } },
      required: ["pull_number"],
      additionalProperties: false,
    },
    async execute(args) {
      const { data } = await octokit.rest.pulls.get({
        owner: ref.owner,
        repo: ref.repo,
        pull_number: args.pull_number as number,
      });
      return ok({
        number: data.number,
        title: data.title,
        state: data.state,
        body: data.body,
        head: data.head.ref,
        base: data.base.ref,
        mergeable: data.mergeable,
        draft: data.draft,
        html_url: data.html_url,
        author: data.user?.login,
      });
    },
  });
}

export function getPullRequestDiff(ref: RepoRef, octokit: Octokit): ToolDefinition {
  return defineTool({
    name: "github_get_pull_request_diff",
    description: "Get the unified diff of a pull request in the bound repository.",
    parameters: {
      type: "object",
      properties: { pull_number: { type: "integer", minimum: 1 } },
      required: ["pull_number"],
      additionalProperties: false,
    },
    async execute(args) {
      const { data } = await octokit.rest.pulls.get({
        owner: ref.owner,
        repo: ref.repo,
        pull_number: args.pull_number as number,
        mediaType: { format: "diff" },
      });
      return ok({ diff: data as unknown as string });
    },
  });
}

export function listPullRequests(ref: RepoRef, octokit: Octokit): ToolDefinition {
  return defineTool({
    name: "github_list_pull_requests",
    description: "List pull requests on the bound repository.",
    parameters: {
      type: "object",
      properties: {
        state: { type: "string", enum: ["open", "closed", "all"] },
        per_page: { type: "integer", minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
    async execute(args) {
      const { data } = await octokit.rest.pulls.list({
        owner: ref.owner,
        repo: ref.repo,
        state: (args.state as "open" | "closed" | "all" | undefined) ?? "open",
        per_page: (args.per_page as number | undefined) ?? 30,
      });
      return ok(
        data.map((p) => ({
          number: p.number,
          title: p.title,
          state: p.state,
          draft: p.draft,
          head: p.head.ref,
          base: p.base.ref,
          author: p.user?.login,
          updated_at: p.updated_at,
        })),
      );
    },
  });
}

export function getFileContents(ref: RepoRef, octokit: Octokit): ToolDefinition {
  return defineTool({
    name: "github_get_file_contents",
    description:
      "Read a file (or list a directory) from the bound repository at the given ref (default: default branch).",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1 },
        ref: { type: "string", description: "Branch, tag, or commit SHA." },
      },
      required: ["path"],
      additionalProperties: false,
    },
    async execute(args) {
      const { data } = await octokit.rest.repos.getContent({
        owner: ref.owner,
        repo: ref.repo,
        path: args.path as string,
        ref: args.ref as string | undefined,
      });
      if (Array.isArray(data)) {
        return ok(data.map((d) => ({ name: d.name, type: d.type, size: d.size, path: d.path })));
      }
      if ("content" in data && data.content) {
        const text = Buffer.from(data.content, "base64").toString("utf-8");
        return ok({ path: data.path, size: data.size, encoding: "utf-8", content: text });
      }
      return ok(data);
    },
  });
}

export function listCommits(ref: RepoRef, octokit: Octokit): ToolDefinition {
  return defineTool({
    name: "github_list_commits",
    description:
      "List commits on the bound repository (optionally limited to a branch/SHA or path).",
    parameters: {
      type: "object",
      properties: {
        sha: { type: "string", description: "Branch / commit SHA to start from." },
        path: { type: "string" },
        per_page: { type: "integer", minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
    async execute(args) {
      const { data } = await octokit.rest.repos.listCommits({
        owner: ref.owner,
        repo: ref.repo,
        sha: args.sha as string | undefined,
        path: args.path as string | undefined,
        per_page: (args.per_page as number | undefined) ?? 20,
      });
      return ok(
        data.map((c) => ({
          sha: c.sha,
          message: c.commit.message,
          author: c.commit.author?.name,
          date: c.commit.author?.date,
          html_url: c.html_url,
        })),
      );
    },
  });
}

export function searchIssues(ref: RepoRef, octokit: Octokit): ToolDefinition {
  return defineTool({
    name: "github_search_issues",
    description:
      "Search issues and pull requests in the bound repository with GitHub's search syntax. The `repo:` qualifier is forced to the bound repository.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          minLength: 1,
          description: "Search terms, e.g. 'is:open label:bug'. Do not include a repo: qualifier.",
        },
        per_page: { type: "integer", minimum: 1, maximum: 100 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    async execute(args) {
      // Force the repo scope from the closed-over ref so the model cannot widen
      // the search to other repositories via the query string.
      const q = `repo:${ref.owner}/${ref.repo} ${args.query as string}`;
      const { data } = await octokit.rest.search.issuesAndPullRequests({
        q,
        per_page: (args.per_page as number | undefined) ?? 20,
      });
      return ok({
        total_count: data.total_count,
        items: data.items.map((i) => ({
          number: i.number,
          title: i.title,
          state: i.state,
          html_url: i.html_url,
          repository_url: i.repository_url,
        })),
      });
    },
  });
}

export function searchCode(ref: RepoRef, octokit: Octokit): ToolDefinition {
  return defineTool({
    name: "github_search_code",
    description:
      "Search code in the bound repository using GitHub's code search. The `repo:` qualifier is forced to the bound repository.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          minLength: 1,
          description: "Code search terms, e.g. 'memorystore in:file'. Do not include a repo: qualifier.",
        },
        per_page: { type: "integer", minimum: 1, maximum: 100 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    async execute(args) {
      const q = `repo:${ref.owner}/${ref.repo} ${args.query as string}`;
      const { data } = await octokit.rest.search.code({
        q,
        per_page: (args.per_page as number | undefined) ?? 20,
      });
      return ok({
        total_count: data.total_count,
        items: data.items.map((i) => ({
          path: i.path,
          repository: i.repository.full_name,
          html_url: i.html_url,
        })),
      });
    },
  });
}

/**
 * The full GET-only tool set bound to (ref, octokit). Used for `read`-profile
 * chat/read agents and composed into the write surface so the read layer is
 * defined once.
 */
export function githubReadTools(ref: RepoRef, octokit: Octokit): ToolDefinition[] {
  return [
    getRepository(ref, octokit),
    getIssue(ref, octokit),
    listIssueComments(ref, octokit),
    listIssues(ref, octokit),
    getPullRequest(ref, octokit),
    getPullRequestDiff(ref, octokit),
    listPullRequests(ref, octokit),
    getFileContents(ref, octokit),
    listCommits(ref, octokit),
    searchIssues(ref, octokit),
    searchCode(ref, octokit),
  ];
}
