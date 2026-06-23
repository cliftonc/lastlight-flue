/**
 * Managed-repo allowlist helpers (ported from `~/work/lastlight/src/managed-repos.ts`).
 *
 * The GitHub App may be installed on more repos than we operate on; we only act on
 * the explicit allowlist (`config.managedRepos`). The GitHub channel screener drops
 * any delivery whose `repository.full_name` is not managed (spec/03).
 *
 * Lives at `src/` top-level (NOT discovered). Reads the loaded runtime config.
 */
import { getRuntimeConfig, loadConfig } from "./config.ts";

/** The managed-repo allowlist (`owner/repo` slugs) from the loaded config. */
export function getManagedRepos(): string[] {
  return (getRuntimeConfig() ?? loadConfig()).managedRepos;
}

/** Is `repoFullName` (`owner/repo`) in the managed-repo allowlist? */
export function isManagedRepo(repoFullName: string | undefined): boolean {
  if (!repoFullName) return false;
  return getManagedRepos().includes(repoFullName);
}
