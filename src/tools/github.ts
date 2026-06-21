/**
 * GitHub agent tools as Flue `defineTool` factories, bound to a run's
 * (repo ref, scoped installation token, GitAccessProfile).
 *
 * Replaces the retired `mcp-github-app` stdio MCP server (Flue MCP is HTTP-only;
 * see spec/flue-reference.md §4 and design/phase-1-shared-core.md). The decision
 * recorded there: reimplement the GitHub actions as bound `defineTool` factories
 * so the credential + repo/owner are CLOSED OVER, not model-selected.
 *
 * SECURITY MODEL (non-negotiable, spec/09-sandbox.md + design):
 *   - The scoped token, owner, repo, and any GitHub IDs are baked into each
 *     tool's `execute` closure. They are NEVER model-selectable `parameters`.
 *   - The model only supplies safe payload fields: a comment `body`, a reaction
 *     `content` enum, a review event/body, an issue title/body. Every schema is
 *     `additionalProperties: false` and exposes only those fields.
 *   - Profile gating is DEFENSE IN DEPTH beside the token scope: write tools are
 *     only constructed when the `GitAccessProfile` permits them, so a read-scoped
 *     agent literally has no mutating tool to call (matching the downscoped
 *     token, which would 403 anyway).
 *
 * Repo-write CODE mutation is intentionally NOT a tool here — it happens via the
 * sandbox git CLI under container isolation (spec/09), not a model-callable tool.
 */
import { defineTool, type ToolDefinition } from "@flue/runtime";
import { Octokit } from "octokit";
import type { GitAccessProfile } from "../engine/profiles.ts";
import { githubReadTools, type RepoRef } from "./github-read.ts";

export type { RepoRef } from "./github-read.ts";

/** GitHub reaction emoji values accepted by the reactions API. */
const REACTION_CONTENTS = [
  "+1",
  "-1",
  "laugh",
  "confused",
  "heart",
  "hooray",
  "rocket",
  "eyes",
] as const;
type ReactionContent = (typeof REACTION_CONTENTS)[number];

function ok(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

// ---------------------------------------------------------------------------
// Write tool factories. Each closes over (ref, octokit) — owner/repo/token are
// never model args. Model supplies only the safe payload (body / content / etc).
// ---------------------------------------------------------------------------

/** `issues-write`+ : add a comment to an issue or PR. */
export function commentOnIssue(ref: RepoRef, octokit: Octokit): ToolDefinition {
  return defineTool({
    name: "github_comment_on_issue",
    description: "Post a new comment on an issue or pull request in the bound repository.",
    parameters: {
      type: "object",
      properties: {
        issue_number: { type: "integer", minimum: 1 },
        body: { type: "string", minLength: 1 },
      },
      required: ["issue_number", "body"],
      additionalProperties: false,
    },
    async execute(args) {
      const { data } = await octokit.rest.issues.createComment({
        owner: ref.owner,
        repo: ref.repo,
        issue_number: args.issue_number as number,
        body: args.body as string,
      });
      return ok({ id: data.id, html_url: data.html_url });
    },
  });
}

/** `issues-write`+ : react to an existing issue comment. */
export function reactToComment(ref: RepoRef, octokit: Octokit): ToolDefinition {
  return defineTool({
    name: "github_react_to_comment",
    description: "Add an emoji reaction to an issue/PR comment in the bound repository.",
    parameters: {
      type: "object",
      properties: {
        comment_id: { type: "integer", minimum: 1 },
        content: { type: "string", enum: [...REACTION_CONTENTS] },
      },
      required: ["comment_id", "content"],
      additionalProperties: false,
    },
    async execute(args) {
      const { data } = await octokit.rest.reactions.createForIssueComment({
        owner: ref.owner,
        repo: ref.repo,
        comment_id: args.comment_id as number,
        content: args.content as ReactionContent,
      });
      return ok({ id: data.id, content: data.content });
    },
  });
}

/** `issues-write`+ : react to an issue or PR itself. */
export function reactToIssue(ref: RepoRef, octokit: Octokit): ToolDefinition {
  return defineTool({
    name: "github_react_to_issue",
    description: "Add an emoji reaction to an issue or pull request in the bound repository.",
    parameters: {
      type: "object",
      properties: {
        issue_number: { type: "integer", minimum: 1 },
        content: { type: "string", enum: [...REACTION_CONTENTS] },
      },
      required: ["issue_number", "content"],
      additionalProperties: false,
    },
    async execute(args) {
      const { data } = await octokit.rest.reactions.createForIssue({
        owner: ref.owner,
        repo: ref.repo,
        issue_number: args.issue_number as number,
        content: args.content as ReactionContent,
      });
      return ok({ id: data.id, content: data.content });
    },
  });
}

/** `issues-write`+ : open a new issue. */
export function createIssue(ref: RepoRef, octokit: Octokit): ToolDefinition {
  return defineTool({
    name: "github_create_issue",
    description: "Open a new issue in the bound repository.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", minLength: 1 },
        body: { type: "string" },
        labels: { type: "array", items: { type: "string" } },
      },
      required: ["title"],
      additionalProperties: false,
    },
    async execute(args) {
      const { data } = await octokit.rest.issues.create({
        owner: ref.owner,
        repo: ref.repo,
        title: args.title as string,
        body: args.body as string | undefined,
        labels: args.labels as string[] | undefined,
      });
      return ok({ number: data.number, html_url: data.html_url });
    },
  });
}

/** `review-write` : submit a PR review (approve / request changes / comment). */
export function createReview(ref: RepoRef, octokit: Octokit): ToolDefinition {
  return defineTool({
    name: "github_create_review",
    description:
      "Submit a review on a pull request in the bound repository (APPROVE / REQUEST_CHANGES / COMMENT).",
    parameters: {
      type: "object",
      properties: {
        pull_number: { type: "integer", minimum: 1 },
        event: { type: "string", enum: ["APPROVE", "REQUEST_CHANGES", "COMMENT"] },
        body: { type: "string" },
      },
      required: ["pull_number", "event"],
      additionalProperties: false,
    },
    async execute(args) {
      const { data } = await octokit.rest.pulls.createReview({
        owner: ref.owner,
        repo: ref.repo,
        pull_number: args.pull_number as number,
        event: args.event as "APPROVE" | "REQUEST_CHANGES" | "COMMENT",
        body: args.body as string | undefined,
      });
      return ok({ id: data.id, state: data.state, html_url: data.html_url });
    },
  });
}

/**
 * Build the GitHub tool set for one run, bound to its repo, scoped token, and
 * permission profile.
 *
 * - READ tools are always included.
 * - WRITE tools are pushed only when `profile` permits (defense in depth beside
 *   the downscoped token):
 *     `read`          → read only
 *     `issues-write`  → + comment / react / createIssue
 *     `review-write`  → + createReview
 *     `repo-write`    → same model-tool surface as review-write; code mutation
 *                       happens via the sandbox git CLI, not a tool.
 *
 * The `token` is the per-run downscoped GitHub App installation token (minted by
 * `engine/git-auth.ts`); it is closed over in the built Octokit, never a tool
 * argument.
 */
export function githubTools(
  ref: RepoRef,
  token: string,
  profile: GitAccessProfile,
): ToolDefinition[] {
  const octokit = new Octokit({ auth: token });
  const tools: ToolDefinition[] = githubReadTools(ref, octokit);

  if (profile !== "read") {
    tools.push(
      commentOnIssue(ref, octokit),
      reactToComment(ref, octokit),
      reactToIssue(ref, octokit),
      createIssue(ref, octokit),
    );
  }

  if (profile === "review-write" || profile === "repo-write") {
    tools.push(createReview(ref, octokit));
  }

  return tools;
}
