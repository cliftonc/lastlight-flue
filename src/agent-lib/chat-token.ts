/**
 * Mint a READ-scoped Octokit for the chat agent's thread.
 *
 * Chat is READ-ONLY on the world (spec/11). When a thread's `id` names a repo,
 * the chat agent binds the GET-only `github_*` tools to it — but ONLY ever with
 * the narrowest GitHub App scope: the `read` profile
 * (contents/issues/pull_requests/metadata = READ; see
 * `GITHUB_PERMISSION_PROFILES.read`). So even the bound Octokit cannot write,
 * defence-in-depth behind the read-only tool set.
 *
 * Lives in `src/agent-lib/` (NOT `src/agents/`) so it is not a phantom discovered
 * agent. Kept separate from `src/agents/chat.ts` so the token mint can be wired in
 * the discovered shell while the pure config builder stays in `chat.ts`.
 *
 * GRACEFUL when unconfigured: no GitHub App configured, or no repo parseable from
 * the id → returns `undefined`. The chat agent then has no github tools but still
 * converses. It NEVER falls back to a write-scoped or App-wide client.
 *
 * DI: `deps` (config loader, token minter, octokit factory) are injectable so the
 * mint can be unit-tested with NO live GitHub. Production uses `defaultMintDeps()`.
 */
import { Octokit } from "octokit";
import { GITHUB_PERMISSION_PROFILES } from "../engine/profiles.ts";
import { configureGitAuth } from "../engine/git-auth.ts";
import { loadConfig, type LastLightConfig } from "../config.ts";
import { parseChatThread } from "./chat.ts";
import type { RepoRef } from "../tools/github-read.ts";

/** A read-scoped Octokit bound to the thread's repo. */
export interface BoundReadOctokit extends RepoRef {
  octokit: Octokit;
}

/** Injectable seams so the mint runs fully offline in tests. */
export interface MintReadDeps {
  loadConfig(): LastLightConfig;
  /** Mint a read-scoped installation token for the given repo. */
  mintReadToken(cfg: LastLightConfig, repo: RepoRef): Promise<string>;
  makeOctokit(token: string): Octokit;
}

/** Mint a `read`-profile installation token downscoped to the repo. */
async function mintReadToken(
  cfg: LastLightConfig,
  repo: RepoRef,
): Promise<string> {
  const app = cfg.githubApp!;
  const { token } = await configureGitAuth({
    appId: app.appId,
    privateKeyPath: app.privateKeyPath,
    installationId: app.installationId,
    botName: cfg.botLogin.replace(/\[bot\]$/, ""),
    repositories: [repo.repo],
    permissions: GITHUB_PERMISSION_PROFILES.read,
  });
  return token;
}

/** The real production dependencies. */
export function defaultMintDeps(): MintReadDeps {
  return {
    loadConfig,
    mintReadToken,
    makeOctokit: (token) => new Octokit({ auth: token }),
  };
}

/**
 * Parse the repo from the thread `id` and mint a `read`-profile Octokit for it.
 * Returns `undefined` when there is no repo in the id or no GitHub App config —
 * never an unscoped/write client.
 */
export async function mintReadOctokitFor(
  id: string,
  deps: MintReadDeps = defaultMintDeps(),
): Promise<BoundReadOctokit | undefined> {
  const { repo } = parseChatThread(id);
  if (!repo) return undefined;

  const cfg = deps.loadConfig();
  if (!cfg.githubApp) return undefined;

  const token = await deps.mintReadToken(cfg, repo);
  return { owner: repo.owner, repo: repo.repo, octokit: deps.makeOctokit(token) };
}
