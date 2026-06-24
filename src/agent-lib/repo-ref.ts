/**
 * Resolve which repo a NL message (a Slack question with no GitHub issue) is about.
 *
 * Ported from the reference classifier's repo extraction: pull an `owner/repo`
 * reference out of the message, VALIDATE it against the managed-repo allowlist (the
 * model never widens scope to an unmanaged repo), and fall back to a configured
 * default when none is named. Returns `undefined` only when nothing is named AND no
 * fallback is configured — the caller then answers without repo context.
 *
 * Pure + deterministic (no LLM): a plain extractor the workflow runs over the
 * already-classified question. The allowlist + fallback are config, not model input.
 */

/** A resolved repository reference. */
export interface OwnerRepo {
  owner: string;
  repo: string;
}

/** Split an `owner/repo` string; `undefined` if not exactly two non-empty parts. */
export function parseOwnerRepo(spec: string | undefined): OwnerRepo | undefined {
  if (!spec) return undefined;
  const parts = spec.trim().split("/");
  if (parts.length !== 2) return undefined;
  const [owner, repo] = parts;
  if (!owner || !repo) return undefined;
  return { owner, repo };
}

/** Matches bare `owner/repo` tokens (GitHub-legal chars), e.g. `cliftonc/drizzle-cube`. */
const REPO_TOKEN_RE = /\b([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9._-]+)\b/g;

/** Lowercased `owner/repo` for allowlist comparison. */
const norm = (owner: string, repo: string): string => `${owner}/${repo}`.toLowerCase();

/**
 * Resolve the repo a message targets:
 *   1. the FIRST `owner/repo` token in the text that is on the managed allowlist;
 *   2. else the configured `fallback` (when on the allowlist, or the allowlist is empty);
 *   3. else `undefined`.
 *
 * A named-but-UNMANAGED repo is ignored (never silently scoped to it) and the
 * fallback applies — mirroring the reference's `unmanagedRepoReply` guard, but
 * degrading to the default instead of rejecting outright.
 */
export function resolveRepoFromText(
  text: string,
  opts: { managedRepos: readonly string[]; fallback?: string },
): OwnerRepo | undefined {
  const allow = new Set(opts.managedRepos.map((r) => r.toLowerCase()));

  for (const m of text.matchAll(REPO_TOKEN_RE)) {
    const owner = m[1]!;
    const repo = m[2]!;
    // An empty allowlist means "no restriction" — accept the first named token.
    if (allow.size === 0 || allow.has(norm(owner, repo))) {
      return { owner, repo };
    }
  }

  const fallback = parseOwnerRepo(opts.fallback);
  if (fallback && (allow.size === 0 || allow.has(norm(fallback.owner, fallback.repo)))) {
    return fallback;
  }
  return undefined;
}
