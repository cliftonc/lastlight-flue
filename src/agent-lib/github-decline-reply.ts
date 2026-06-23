/**
 * DECLINE-REPLY poster — the router-emitted GitHub reply (Phase 6, design/phase-6
 * §"GitHub channel — the router lives here": `replyDecline(ev)`).
 *
 * WHEN: `routeEvent` returns `{ action: "reply", message }` — a NON-MAINTAINER
 * @mentioned the bot to trigger a privileged action (build/explore/etc.). The
 * reference replies directly from the connector with a brief explanation rather
 * than running an agent (its `dispatcher.ts` → `envelope.reply(route.message)`).
 * This is the Flue port of that path.
 *
 * REPLY vs SILENT (matches the reference):
 *   - REPLY  → a non-maintainer @mention of the bot (a human asking for a privileged
 *     action they're not authorized for) — they get a courteous decline so they know
 *     why nothing happened.
 *   - SILENT → everything the SCREENER / router drops as `ignore`: a non-managed repo,
 *     a bot/self sender, an ignored action, a comment with NO @mention. Those never
 *     reach this helper (the router returns `ignore`, the dispatcher no-ops). So a
 *     bot can never be replied to → NO reply loop.
 *
 * SECURITY SPINE (spec/09): owner/repo/issue_number + the scoped `issues-write`
 * token are CLOSED OVER here — NEVER model-selectable. The decline MESSAGE is a
 * deterministic, router-composed string (NOT model output, NOT a model tool). The
 * existing `postIssueReplyDeterministically` enforces the bot-loop floor + a dedup
 * marker keyed by the triggering event, so a duplicate delivery / re-invoke never
 * double-replies. Token never logged.
 *
 * Lives in `src/agent-lib/` (NOT discovered). Every external effect (token mint,
 * Octokit factory, the post) is behind an injected dep so it's offline-testable —
 * NO live GitHub / NO token mint in tests.
 */
import { Octokit } from "octokit";
import { loadConfig } from "../config.ts";
import { configureGitAuth } from "../engine/git-auth.ts";
import { GITHUB_PERMISSION_PROFILES, type GitAccessProfile } from "../engine/profiles.ts";
import { postIssueReplyDeterministically, type PostedReply } from "../issue-comment-post.ts";
import type { LastLightEvent } from "../events.ts";

/** The decline always runs under the `issues-write` profile (it only comments). */
export const DECLINE_PROFILE: GitAccessProfile = "issues-write";

/** Injected effects so the poster is fully offline-testable. */
export interface DeclineReplyDeps {
  /** Mint an `issues-write` token downscoped to the target repo. */
  mintToken: (repo: string) => Promise<string>;
  /** Build an Octokit authenticated with the scoped token. */
  makeOctokit: (token: string) => Octokit;
  /** Deterministic post (bot-loop floor + dedup marker; never model-selectable). */
  post: (octokit: Octokit, ev: LastLightEvent, message: string, botLogin: string) => Promise<PostedReply>;
  /** The bot's own login (the bot-loop / dedup author check). */
  botLogin: string;
}

/** Mint an issues-write token downscoped to the repo (mirrors issue-comment). */
async function defaultMintToken(repo: string): Promise<string> {
  const cfg = loadConfig();
  if (!cfg.githubApp) {
    throw new Error(
      "decline-reply: GitHub App not configured (GITHUB_APP_ID / _PRIVATE_KEY_PATH / _INSTALLATION_ID). Cannot mint an issues-write token.",
    );
  }
  const { token } = await configureGitAuth({
    appId: cfg.githubApp.appId,
    privateKeyPath: cfg.githubApp.privateKeyPath,
    installationId: cfg.githubApp.installationId,
    botName: cfg.botLogin.replace(/\[bot\]$/, ""),
    repositories: [repo],
    permissions: GITHUB_PERMISSION_PROFILES[DECLINE_PROFILE],
  });
  return token;
}

/** The default deterministic post — reuses the issue-comment poster (dedup + bot floor). */
function defaultPost(octokit: Octokit, ev: LastLightEvent, message: string, botLogin: string): Promise<PostedReply> {
  return postIssueReplyDeterministically(
    octokit,
    { owner: ev.owner!, repo: ev.repoName!, issue_number: ev.issueNumber! },
    message,
    {
      // Dedup is keyed by the triggering comment so a redelivery / re-invoke never
      // double-declines. `conversationKey` is the stable per-issue id (the comment
      // id isn't carried on the event); a second decline on the same thread dedups.
      triggerCommentId: `decline:${ev.conversationKey}`,
      sender: ev.sender,
      botLogin,
    },
  );
}

/** Default deps (production): real token mint + Octokit + the deterministic poster. */
export function defaultDeclineReplyDeps(): DeclineReplyDeps {
  return {
    mintToken: defaultMintToken,
    makeOctokit: (token) => new Octokit({ auth: token }),
    post: defaultPost,
    botLogin: loadConfig().botLogin,
  };
}

/**
 * Post the router-emitted decline reply on the triggering issue/PR. Mints a scoped
 * token, builds the Octokit, and posts deterministically. A no-op (returns
 * `{ posted: false }`) when the event lacks an issue target (nothing to reply to).
 */
export async function postDeclineReply(
  ev: LastLightEvent,
  message: string,
  deps: DeclineReplyDeps = defaultDeclineReplyDeps(),
): Promise<PostedReply> {
  if (!ev.owner || !ev.repoName || !ev.issueNumber) return { posted: false };
  const token = await deps.mintToken(ev.repo ?? `${ev.owner}/${ev.repoName}`);
  const octokit = deps.makeOctokit(token);
  return deps.post(octokit, ev, message, deps.botLogin);
}
