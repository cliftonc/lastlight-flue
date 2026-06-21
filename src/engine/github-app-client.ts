import { createAppAuth } from "@octokit/auth-app";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Octokit } from "octokit";

/**
 * Credentials for minting a GitHub App-authenticated Octokit. The App PEM is
 * read from disk (never passed as an env value) and only the `repo-write`
 * profile path supplies one — see `spec/09-sandbox.md` (PEM wall).
 */
export interface GitHubAppClientConfig {
  appId: string;
  privateKeyPath: string;
  installationId: string;
}

/**
 * Build an Octokit authenticated as a GitHub App installation. Ported ~verbatim
 * from the reference harness (`src/engine/github-app-client.ts`). Used by the
 * deterministic harness `GitHubClient`, NOT by model-facing agent tools (those
 * get a pre-minted, downscoped installation token closed over in a factory).
 */
export function githubAppClient(config: GitHubAppClientConfig): Octokit {
  const privateKey = readFileSync(resolve(config.privateKeyPath), "utf-8");
  return new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: config.appId,
      privateKey,
      installationId: config.installationId,
    },
  });
}
