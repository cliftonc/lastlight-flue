/**
 * ACK-REACTION poster — the GitHub equivalent of Slack's `defaultAck` "Thinking…"
 * indicator (design: Slack live status §1). When the channel admits a delivery to a
 * workflow (or a gate resume), it reacts 👀 on the triggering surface so the user
 * sees the bot picked the work up — instantly, before the (slower) `flue run` spawn.
 *
 * TARGET: react on the triggering COMMENT (`reactions.createForIssueComment`) when
 * the event carries a `commentId` (a `comment.created` delivery); otherwise react on
 * the issue/PR itself (`reactions.createForIssue`) — e.g. `issue.opened` → triage,
 * `pr.opened` → review, where there is no comment to mark.
 *
 * SECURITY SPINE (spec/09): owner/repo + the scoped `issues-write` token are CLOSED
 * OVER here — NEVER model-selectable. The reaction `content` is the fixed literal
 * "eyes" (not model output, not a model tool — distinct from the `github_react_*`
 * write tools in src/tools/github.ts, which an agent may call mid-run). Token never
 * logged.
 *
 * Lives in `src/agent-lib/` (NOT discovered). Every external effect (token mint,
 * Octokit factory, the reaction call) is behind an injected dep so it's offline-
 * testable — NO live GitHub / NO token mint in tests. Mirrors github-decline-reply.ts.
 */
import { Octokit } from "octokit";
import { loadConfig } from "../config.ts";
import { configureGitAuth } from "../engine/git-auth.ts";
import { GITHUB_PERMISSION_PROFILES, type GitAccessProfile } from "../engine/profiles.ts";
import type { RepoRef } from "../tools/github-read.ts";
import type { LastLightEvent } from "../events.ts";

/** Reactions write under the `issues-write` profile (same as the react-* tools). */
export const ACK_PROFILE: GitAccessProfile = "issues-write";

/** Injected effects so the poster is fully offline-testable. */
export interface AckReactionDeps {
  /** Mint an `issues-write` token downscoped to the target repo. */
  mintToken: (repo: string) => Promise<string>;
  /** Build an Octokit authenticated with the scoped token. */
  makeOctokit: (token: string) => Octokit;
  /** React 👀 on a specific issue/PR comment. */
  reactToComment: (octokit: Octokit, ref: RepoRef, commentId: number) => Promise<void>;
  /** React 👀 on the issue/PR itself (no triggering comment). */
  reactToIssue: (octokit: Octokit, ref: RepoRef, issueNumber: number) => Promise<void>;
}

/** Mint an issues-write token downscoped to the repo (mirrors decline-reply). */
async function defaultMintToken(repo: string): Promise<string> {
  const cfg = loadConfig();
  if (!cfg.githubApp) {
    throw new Error(
      "ack-reaction: GitHub App not configured (GITHUB_APP_ID / _PRIVATE_KEY_PATH / _INSTALLATION_ID). Cannot mint an issues-write token.",
    );
  }
  const { token } = await configureGitAuth({
    appId: cfg.githubApp.appId,
    privateKeyPath: cfg.githubApp.privateKeyPath,
    installationId: cfg.githubApp.installationId,
    botName: cfg.botLogin.replace(/\[bot\]$/, ""),
    repositories: [repo],
    permissions: GITHUB_PERMISSION_PROFILES[ACK_PROFILE],
  });
  return token;
}

/** Default deps (production): real token mint + Octokit + the two reaction calls. */
export function defaultAckReactionDeps(): AckReactionDeps {
  return {
    mintToken: defaultMintToken,
    makeOctokit: (token) => new Octokit({ auth: token }),
    reactToComment: async (octokit, ref, commentId) => {
      await octokit.rest.reactions.createForIssueComment({
        owner: ref.owner,
        repo: ref.repo,
        comment_id: commentId,
        content: "eyes",
      });
    },
    reactToIssue: async (octokit, ref, issueNumber) => {
      await octokit.rest.reactions.createForIssue({
        owner: ref.owner,
        repo: ref.repo,
        issue_number: issueNumber,
        content: "eyes",
      });
    },
  };
}

/**
 * React 👀 on the triggering comment (preferred) or the issue/PR. Mints a scoped
 * token, builds the Octokit, and reacts. A no-op (`{ reacted: false }`) when the
 * event lacks both a usable comment id and an issue number (nothing to react to).
 * GitHub's reactions API is idempotent on (actor, content), so a redelivery / re-
 * invoke re-reacting is harmless — no dedup marker needed.
 */
export async function postAckReaction(
  ev: LastLightEvent,
  deps: AckReactionDeps = defaultAckReactionDeps(),
): Promise<{ reacted: boolean }> {
  if (!ev.owner || !ev.repoName) return { reacted: false };
  const ref: RepoRef = { owner: ev.owner, repo: ev.repoName };

  // `commentId` is a number|string union (channel-agnostic); the GitHub reactions
  // API takes a numeric id. Coerce + validate so a non-numeric value falls through
  // to the issue-level reaction rather than throwing.
  const commentId = ev.commentId !== undefined ? Number(ev.commentId) : NaN;
  const hasComment = Number.isInteger(commentId) && commentId > 0;

  if (!hasComment && !ev.issueNumber) return { reacted: false };

  // GitHub's create-installation-token API scopes by repository NAME ("lastlight"),
  // NOT the full "owner/lastlight" slug — passing the slug 422s ("repository does not
  // exist or is not accessible"). `ev.repoName` is the short name (the router's
  // `target()` and every workflow mint use it for exactly this reason).
  const token = await deps.mintToken(ref.repo);
  const octokit = deps.makeOctokit(token);

  if (hasComment) {
    await deps.reactToComment(octokit, ref, commentId);
  } else {
    await deps.reactToIssue(octokit, ref, ev.issueNumber!);
  }
  return { reacted: true };
}
