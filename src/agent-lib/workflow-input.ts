/**
 * `buildWorkflowInput` — the SINGLE, channel-agnostic mapper from an enriched event
 * (`RoutableEvent`) to a workflow's validated `--input`, shared by BOTH the GitHub
 * and Slack routers.
 *
 * WHY THIS EXISTS (design — "unify the input builder for both channels"): the routers
 * used to hand-build each workflow `payload` inline, per channel. Those payloads
 * drifted from the workflow input schemas — most visibly `explore`, which REQUIRES
 * `runId`/`owner`/`repo` but received `{reply,sender,triggerId,source}` from Slack
 * (and a `runId`-less payload from GitHub), so admission failed with
 * `action_input_validation`. Centralizing the mapping HERE — fed by the
 * already-resolved `resolvedRepo` + `correlationId` (see event-enrich.ts) — means one
 * place to keep in sync with the input schemas, and identical behavior across channels.
 *
 * SAFETY RE: SUPERSET FIELDS — every workflow input schema is a loose `v.object`
 * (verified: no `strictObject`/`looseObject` in src/workflows), so Flue's admission
 * validation IGNORES unknown keys. The common projection below can therefore carry a
 * superset (e.g. both `issue` and `issueNumber`, `runId` everywhere) and each
 * workflow keeps exactly the fields its schema declares.
 *
 * SCOPE — covers the workflows reachable from BOTH channels (`explore`, `answer`,
 * `security-review`). The GitHub-only deterministic routes (issue-triage, pr-review,
 * pr-fix, issue-comment, pr-comment, security-feedback) keep their bespoke
 * GitHub-shaped payloads in github-router.ts; they were never cross-channel and
 * carry workflow-specific fields (fixRequest, commentId, …) outside this projection.
 */
import type { RoutableEvent } from "./event-enrich.ts";

/** Per-call knobs the routers thread in (the screened body, a trigger provenance). */
export interface BuildWorkflowInputOpts {
  /**
   * The EFFECTIVE message text — the (possibly injection-flag-prefixed) comment /
   * Slack message the router screened. Defaults to the raw event body.
   */
  body?: string;
  /** Trigger provenance the workflow records (`comment` | `resume` | `boot` | …). */
  triggerType?: string;
}

/** The cross-channel workflows this builder maps (others stay GitHub-bespoke). */
export type SharedWorkflow = "explore" | "answer" | "security-review";

/** Assert a repo was resolved for a workflow that cannot run without one. */
function requireRepo(
  workflow: string,
  repo: { owner: string; repo: string } | null,
): { owner: string; repo: string } {
  if (!repo) {
    throw new Error(
      `${workflow}: no repository to operate on — the event carries no repo and no ` +
        `workspace default is configured. Set EXPLORE_DEFAULT_REPO=owner/name.`,
    );
  }
  return repo;
}

/**
 * Map an enriched event → a workflow's `--input`. The `common` projection supplies the
 * envelope-derived fields every workflow shares (sender, source, the conversation key,
 * and the stable `runId`/`triggerId` = `correlationId`); the per-workflow arms add the
 * fields that workflow's schema reads.
 */
export function buildWorkflowInput(
  workflow: SharedWorkflow,
  ev: RoutableEvent,
  opts: BuildWorkflowInputOpts = {},
): Record<string, unknown> {
  const body = opts.body ?? ev.body;
  const repo = ev.resolvedRepo;

  // Envelope-derived fields shared across the workflows. `runId === triggerId ===
  // correlationId` is the resume/gate contract — stable across re-invokes.
  const common: Record<string, unknown> = {
    sender: ev.sender,
    source: ev.source,
    conversationKey: ev.conversationKey,
    triggerId: ev.correlationId,
    runId: ev.correlationId,
    ...(opts.triggerType ? { triggerType: opts.triggerType } : {}),
  };

  switch (workflow) {
    case "explore": {
      // Repo is REQUIRED (the explorer clones + reads it). A GitHub comment carries
      // `issueNumber` (publish back to that issue); a Slack message has none → `issue`
      // is absent, which the explore workflow reads as a Slack origin (publish a new
      // issue to EXPLORE_DEFAULT_REPO). `commentBody` is the triggering message.
      const r = requireRepo(workflow, repo);
      return {
        ...common,
        owner: r.owner,
        repo: r.repo,
        issue: ev.issueNumber,
        issueTitle: ev.title,
        commentBody: body,
      };
    }
    case "answer": {
      // Repo is OPTIONAL — a Slack question naming no repo is answered against the
      // workspace default inside the workflow (`fallbackRepo`). `question` IS the body.
      return {
        ...common,
        owner: repo?.owner,
        repo: repo?.repo,
        issueNumber: ev.issueNumber,
        question: body,
      };
    }
    case "security-review": {
      // A repo security scan needs a concrete repo.
      const r = requireRepo(workflow, repo);
      return { ...common, owner: r.owner, repo: r.repo };
    }
  }
}
