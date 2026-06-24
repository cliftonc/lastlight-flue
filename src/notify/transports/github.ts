/**
 * GitHub binding for the progress notifier. Owns a single comment id and edits
 * it in place on every `publish()`; `note()` posts a fresh comment for moments
 * that deserve a real notification (approval prompts, terminal summary).
 *
 * Over Octokit (not the reference's `GitHubClient`): the SAME call shapes as
 * `src/build-github-post.ts` / `src/reply.ts` — `issues.createComment` /
 * `issues.updateComment`. The owner/repo/issue are CLOSED OVER the bound deps,
 * NEVER model-selected (the Phase-3/9 deterministic-side-effect spine).
 */
import type { Octokit } from "octokit";
import type { NotifierTransport } from "../types.ts";

export interface GitHubTransportDeps {
  /** Authenticated with the scoped repo/issues-write token (bound, never model-chosen). */
  octokit: Octokit;
  owner: string;
  repo: string;
  issueNumber: number;
  /** Existing status-comment id from a resumed run, if any. */
  commentId?: number;
  /** Persist the comment id the first time it's created (so resume re-attaches). */
  save?: (commentId: number) => void;
}

export class GitHubTransport implements NotifierTransport {
  /** No terminal ping — the finished checklist + the PR-opened event suffice. */
  readonly terminalPing = false;
  private commentId?: number;

  constructor(private readonly deps: GitHubTransportDeps) {
    this.commentId = deps.commentId;
  }

  async publish(markdown: string): Promise<void> {
    const { octokit, owner, repo, issueNumber } = this.deps;
    if (this.commentId !== undefined) {
      await octokit.rest.issues.updateComment({
        owner,
        repo,
        comment_id: this.commentId,
        body: markdown,
      });
    } else {
      const { data } = await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: issueNumber,
        body: markdown,
      });
      this.commentId = data.id;
      this.deps.save?.(data.id);
    }
  }

  async note(markdown: string): Promise<void> {
    const { octokit, owner, repo, issueNumber } = this.deps;
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: issueNumber,
      body: markdown,
    });
  }
}
