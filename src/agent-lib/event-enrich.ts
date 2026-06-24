/**
 * Event ENRICHMENT — the shared, channel-agnostic step that runs right after MAP
 * and BEFORE ROUTE, for BOTH channels (GitHub + Slack). It stamps the two
 * derivations every downstream consumer used to compute ad-hoc (and inconsistently):
 *
 *   - `resolvedRepo` — the repo to operate on: the event's own repo when it carries
 *     one (GitHub), else the configured workspace default (`EXPLORE_DEFAULT_REPO`)
 *     for repo-less origins (a Slack message naming no repo). One rule, both channels.
 *   - `correlationId` — the stable id that keys a run + its reply/approve gate. It IS
 *     the channel `conversationKey` (`github:owner/repo#123` / `slack:v1:…:thread`):
 *     stable across re-invokes, so it doubles as the workflow `runId` (the resume
 *     contract) and the gate-by-thread lookup key.
 *
 * WHY A SEPARATE STEP (design — "enrich the envelope for both channels"): the routers
 * used to each hand-build workflow payloads, deriving repo/runId differently (and the
 * explore path omitted `runId` entirely → an `action_input_validation` crash). Pushing
 * the parsing AHEAD of the per-workflow split — once, uniformly — means a single source
 * of truth (`buildWorkflowInput`) consumes a fully-resolved event regardless of channel.
 *
 * `RoutableEvent` is a strict superset of `LastLightEvent`, so every existing consumer
 * keeps working; the routers narrow to it to reach the new derived fields.
 */
import type { LastLightEvent } from "../events.ts";

/** A `LastLightEvent` plus the channel-agnostic derivations the routers need. */
export interface RoutableEvent extends LastLightEvent {
  /** The repo to operate on: the event's repo, else the configured default. */
  resolvedRepo: { owner: string; repo: string } | null;
  /** Stable run/gate correlation id (= the channel conversationKey). */
  correlationId: string;
}

/** Parse an `owner/name` repo spec (e.g. `EXPLORE_DEFAULT_REPO`). */
export function parseOwnerRepo(spec?: string): { owner: string; repo: string } | null {
  if (!spec) return null;
  const [owner, repo] = spec.split("/");
  if (!owner || !repo) return null;
  return { owner, repo };
}

/**
 * Enrich a mapped event with `resolvedRepo` + `correlationId`. Pure + deterministic
 * (the only input besides the event is the configured default repo) — safe to call in
 * the channel right after MAP. A GitHub event resolves to its own repo; a repo-less
 * Slack message resolves to `opts.defaultRepo` (or `null` when none is configured —
 * the input builder surfaces a clear error for the workflows that require a repo).
 */
export function enrichEvent(
  ev: LastLightEvent,
  opts: { defaultRepo?: string } = {},
): RoutableEvent {
  const resolvedRepo =
    ev.owner && ev.repoName
      ? { owner: ev.owner, repo: ev.repoName }
      : parseOwnerRepo(opts.defaultRepo);
  return { ...ev, resolvedRepo, correlationId: ev.conversationKey };
}
