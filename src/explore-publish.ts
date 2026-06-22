/**
 * Deterministic spec publishing for `explore` — APPLICATION code, never a model tool.
 *
 * Mirrors src/answer-post.ts / src/github-post.ts: the synthesize AGENT writes the spec
 * to a file; the WORKFLOW (src/workflows/explore.ts, via this module) PUBLISHES it
 * DETERMINISTICALLY over the scoped token. Publishing is an authorization boundary
 * (spec/09 — a tool's parameters are model-selected inputs, not an auth boundary), so
 * the destination (owner / repo / issue) and the token are CLOSED OVER here, NEVER
 * model-chosen. Only the spec BODY flows from the model.
 *
 * Two destinations, decided deterministically by the trigger origin (reference
 * explore-publish.md, but executed in trusted code, not by the model):
 *   - GitHub-originated (an issue number is set) → a COMMENT on that issue.
 *   - Slack-originated (no issue number) → a NEW issue in the configured destination
 *     repo, with a trailer crediting the originating thread.
 *
 * DEDUP (design Q5.4 — single-pass / resumable workflows must not double-publish): the
 * comment path embeds an invisible HTML-comment marker keyed by the run id and skips if
 * a bot comment already carries it. The new-issue path is guarded at the workflow layer
 * by the `publish` phase being in `phasesDone` (a re-invoke after publish skips it); we
 * additionally record the published URL in the run record so a re-invoke that lost the
 * phase flag can short-circuit.
 */
import type { Octokit } from "octokit";
import type { RepoRef } from "./tools/github-read.ts";

/** A publish destination ref: the repo + (optional) originating issue number. */
export interface PublishRef extends RepoRef {
  /** The originating issue number; 0/absent → publish as a NEW issue. */
  issue_number?: number;
}

/** Result of a deterministic publish. */
export interface PublishedSpec {
  /** Whether anything was actually published (false → skipped by the dedup guard). */
  published: boolean;
  /** "comment" (on an existing issue) | "issue" (a new issue was created). */
  kind?: "comment" | "issue";
  /** The published comment / issue URL. */
  html_url?: string;
  /** The new issue number, when one was created. */
  issue_number?: number;
  /** True when the publish was skipped because this run already published. */
  deduped?: boolean;
}

/** The invisible dedup marker embedded in a published comment, keyed by run id. */
export function publishDedupMarker(runId: string): string {
  return `<!-- lastlight:explore-spec:${runId} -->`;
}

/** Has the bot already published this run's spec as a comment on the issue? */
export async function alreadyPublished(
  octokit: Octokit,
  ref: Required<Pick<PublishRef, "owner" | "repo">> & { issue_number: number },
  runId: string,
  botLogin: string,
): Promise<boolean> {
  const marker = publishDedupMarker(runId);
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner: ref.owner,
    repo: ref.repo,
    issue_number: ref.issue_number,
    per_page: 100,
  });
  return comments.some((c) => {
    const login = c.user?.login ?? "";
    const isBot = login === botLogin || login.endsWith("[bot]");
    return isBot && (c.body ?? "").includes(marker);
  });
}

/** Derive a concise issue title from the spec's first markdown heading (or a default). */
export function specTitle(spec: string): string {
  const m = spec.match(/^#\s+(.+)$/m);
  const raw = (m?.[1] ?? "Explore spec").trim();
  return raw.length > 120 ? `${raw.slice(0, 117)}...` : raw;
}

/**
 * Publish the synthesized spec deterministically.
 *
 *   GitHub-originated (ref.issue_number set) → comment on the issue (dedup-guarded).
 *   Slack-originated (no issue_number)       → new issue in (ref.owner/ref.repo)
 *                                              (the workflow resolves the default repo).
 *
 * owner/repo/issue come from the bound `ref`, never the model. An empty spec is treated
 * as "nothing to publish".
 */
export async function publishSpecDeterministically(
  octokit: Octokit,
  ref: PublishRef,
  spec: string,
  opts: { runId: string; botLogin: string; sourceTrailer?: string },
): Promise<PublishedSpec> {
  const trimmed = (spec ?? "").trim();
  if (!trimmed) return { published: false };

  // GitHub-originated → comment on the existing issue.
  if (ref.issue_number && ref.issue_number > 0) {
    const issueRef = { owner: ref.owner, repo: ref.repo, issue_number: ref.issue_number };
    if (await alreadyPublished(octokit, issueRef, opts.runId, opts.botLogin)) {
      return { published: false, deduped: true, kind: "comment" };
    }
    const marker = publishDedupMarker(opts.runId);
    const { data } = await octokit.rest.issues.createComment({
      ...issueRef,
      body: `${trimmed}\n\n${marker}`,
    });
    return { published: true, kind: "comment", html_url: data.html_url };
  }

  // Slack-originated → a NEW issue in the configured destination repo.
  const trailer = opts.sourceTrailer ? `\n\n---\n${opts.sourceTrailer}` : "";
  const marker = publishDedupMarker(opts.runId);
  const { data } = await octokit.rest.issues.create({
    owner: ref.owner,
    repo: ref.repo,
    title: specTitle(trimmed),
    body: `${trimmed}${trailer}\n\n${marker}`,
  });
  return {
    published: true,
    kind: "issue",
    html_url: data.html_url,
    issue_number: data.number,
  };
}
