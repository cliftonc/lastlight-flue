/**
 * Pure helpers for building and mutating a {@link ProgressModel}'s step list.
 * All functions are immutable — they return new arrays/objects and never
 * mutate their inputs, so the notifier can re-render from a fresh snapshot.
 *
 * Ported from ~/work/lastlight/src/notify/model.ts. The reference derived the
 * initial checklist from a declarative `AgentWorkflowDefinition.phases`; Flue
 * workflows are IMPERATIVE (`defineWorkflow` + an explicit `run()` control
 * flow), so there is no such schema. Instead each workflow hands its static
 * phase list to {@link stepsFromPhases}/{@link buildProgressModel} as a
 * {@link PhaseSpec}[] — the same phase names the run-store keys `phasesDone` /
 * `shouldRunPhase` on, so the checklist and the durable cursor stay aligned.
 */
import type { ProgressModel, ProgressStep, StepStatus } from "./types.ts";

/** One checklist phase: a stable `key` (= the workflow's phase name) + a label. */
export interface PhaseSpec {
  /** Stable step key — the phase name the run-store tracks in `phasesDone`. */
  key: string;
  /** Human label; falls back to a title-cased `key` when omitted. */
  label?: string;
}

/** Human label for a phase — falls back to a title-cased key. */
function phaseLabel(phase: PhaseSpec): string {
  if (phase.label) return phase.label;
  return phase.key
    .split(/[_\-]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * Build the initial checklist from a workflow's static phase list. Any phase
 * whose key is in `completed` is seeded as `done` (used when re-attaching to an
 * in-flight run after an approval-gate pause/restart — `phasesDone` from the
 * run record is passed straight through).
 */
export function stepsFromPhases(
  phases: readonly PhaseSpec[],
  completed: ReadonlySet<string> = new Set(),
): ProgressStep[] {
  return phases.map((p) => ({
    key: p.key,
    label: phaseLabel(p),
    status: (completed.has(p.key) ? "done" : "pending") as StepStatus,
  }));
}

export interface ProgressModelInput {
  workflowName: string;
  /** Issue/PR number, when the run is issue-scoped. */
  number?: number;
  issueTitle?: string;
  owner?: string;
  repo?: string;
  branch?: string;
  /** Phases already finished (resume re-seeding) — seeded as `done`. */
  completed?: ReadonlySet<string>;
  /**
   * Deep link to the live run on the admin dashboard. Rendered as a meta line
   * so the GitHub comment (and Slack message) carries a "watch it run" link.
   * Built with {@link runDashboardUrl}; omitted when no public URL is configured.
   */
  runUrl?: string;
}

/**
 * Admin-dashboard deep link for a single workflow run. Shared by the notifier
 * (the in-place checklist's meta line) so the GitHub/Slack surfaces both carry
 * a "watch it run" link. Returns `undefined` when `publicUrl` is unset (so the
 * meta line is simply omitted).
 */
export function runDashboardUrl(
  publicUrl: string | undefined,
  runId: string,
  workflowName: string,
): string | undefined {
  if (!publicUrl) return undefined;
  const base = publicUrl.replace(/\/+$/, "");
  return `${base}/admin/?run=${encodeURIComponent(runId)}&tab=runs&wf=${encodeURIComponent(workflowName)}`;
}

/**
 * Build the full {@link ProgressModel} for a run. The heading scopes to the
 * issue/PR number when present (else the workflow name); a branch link + an
 * optional live-run link form the meta lines.
 */
export function buildProgressModel(
  phases: readonly PhaseSpec[],
  input: ProgressModelInput,
): ProgressModel {
  const titleScope = input.number !== undefined ? `#${input.number}` : input.workflowName;
  const meta: string[] = [];
  if (input.owner && input.repo && input.branch) {
    meta.push(
      `Branch: [\`${input.branch}\`](https://github.com/${input.owner}/${input.repo}/tree/${input.branch})`,
    );
  }
  if (input.runUrl) {
    meta.push(`Live run: [watch on the dashboard](${input.runUrl})`);
  }
  return {
    title: `${input.workflowName} for ${titleScope}`,
    subtitle: input.issueTitle || undefined,
    meta: meta.length > 0 ? meta : undefined,
    steps: stepsFromPhases(phases, input.completed ?? new Set()),
  };
}

/** Return a copy of `steps` with `key`'s status (and optional detail) updated. */
export function setStep(
  steps: ProgressStep[],
  key: string,
  status: StepStatus,
  detail?: string,
): ProgressStep[] {
  let found = false;
  const next = steps.map((s) => {
    if (s.key !== key) return s;
    found = true;
    // Preserve an existing detail when the caller doesn't supply a new one.
    return { ...s, status, detail: detail ?? s.detail };
  });
  // Unknown key → append so a stray transition still shows up rather than
  // silently vanishing.
  if (!found) next.push({ key, label: key, status, detail });
  return next;
}

/**
 * Insert `entry` before the step keyed `beforeKey`. If the key already exists
 * it's updated in place; if `beforeKey` is omitted or not found, `entry` is
 * appended. Used for loop iterations (re-review / fix cycles) that should sit
 * just above the terminal step.
 */
export function upsertBefore(
  steps: ProgressStep[],
  entry: ProgressStep,
  beforeKey?: string,
): ProgressStep[] {
  if (steps.some((s) => s.key === entry.key)) {
    return steps.map((s) => (s.key === entry.key ? { ...s, ...entry } : s));
  }
  const idx = beforeKey ? steps.findIndex((s) => s.key === beforeKey) : -1;
  if (idx < 0) return [...steps, entry];
  return [...steps.slice(0, idx), entry, ...steps.slice(idx)];
}
