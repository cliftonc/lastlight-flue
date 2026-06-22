/**
 * Deterministic pr-fix ack comment — APPLICATION code, never a model tool.
 *
 * The `pr-fix` workflow's agent ENDS at committing the fix in-sandbox; the workflow
 * pushes the PR head branch deterministically, then OPTIONALLY posts a short ack
 * comment on the PR ("Fix pushed to `<branch>`") — mirroring the reference
 * pr-fix.yaml `messages.on_success`. As with every other side effect in this
 * codebase (github-post.ts / triage-post.ts / issue-comment-post.ts), the
 * owner/repo/PR number + token are CLOSED OVER the bound ref, NEVER model-selectable
 * (spec/09). A PR is an issue for the comments API, so we post via
 * `issues.createComment` on the PR number.
 */
import type { Octokit } from "octokit";
import type { RepoRef } from "./tools/github-read.ts";

/** A pr-fix target: the repo ref + the PR number the fix lands on. */
export interface PrFixRef extends RepoRef {
  pull_number: number;
}

/** Result of posting the ack comment. */
export interface PostedAck {
  id: number;
  html_url: string;
}

/**
 * Render the ack comment body (pure → golden-testable). Reports the branch the fix
 * was pushed to and the commit sha so the maintainer can audit it. CI re-runs on the
 * push automatically.
 */
export function renderAckComment(opts: { branch: string; sha: string }): string {
  return [
    `**Fix pushed** to \`${opts.branch}\` (\`${opts.sha.slice(0, 12)}\`).`,
    "",
    "CI should re-run automatically. Review the new commit and re-request changes if anything is still off.",
  ].join("\n");
}

/**
 * Deterministically post the pr-fix ack comment on the bound PR. The `octokit` is
 * authenticated with the scoped `repo-write` token; owner/repo/pull_number come from
 * the bound `ref`, NEVER the model.
 */
export async function postAckCommentDeterministically(
  octokit: Octokit,
  ref: PrFixRef,
  body: string,
): Promise<PostedAck> {
  const { data } = await octokit.rest.issues.createComment({
    owner: ref.owner,
    repo: ref.repo,
    issue_number: ref.pull_number, // a PR is an issue for the comments API
    body,
  });
  return { id: data.id, html_url: data.html_url };
}
