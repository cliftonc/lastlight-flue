/**
 * Phase 8 egress — the `explore` workflow's progress-notifier glue (PURE: no
 * GitHub/Slack/token here, so it stays offline-testable and free of an import
 * cycle with explore-phases.ts; the live transport construction lives in
 * `explore-phases.ts`'s `makeExploreReporter`).
 *
 * The explore checklist: the fixed spine (research → synthesize → publish) plus
 * DYNAMIC clarify rows (`ask:N`) the Socratic loop inserts before `synthesize`
 * as rounds run. On a RESUME the seed model re-attaches the ask rows already in
 * `phasesDone` so the checklist keeps its conversation history.
 */
import type { ExploreRun } from "../explore-run-store.ts";
import { buildProgressModel, type PhaseSpec } from "../notify/model.ts";
import type { ProgressModel, ProgressStep, StepStatus } from "../notify/types.ts";

/** The fixed explore spine (the dynamic `ask:N` rows are inserted before `synthesize`). */
export const EXPLORE_PHASES: readonly PhaseSpec[] = [
  { key: "read", label: "Research" },
  { key: "synthesize", label: "Synthesize" },
  { key: "publish", label: "Publish" },
];

/** The checklist row a Socratic `ask:N` round renders as. */
export function askRow(phase: string, status: StepStatus): ProgressStep {
  const m = phase.match(/^ask:(\d+)$/);
  const round = m ? Number(m[1]) + 1 : undefined;
  return { key: phase, label: round ? `Clarify (round ${round})` : phase, status };
}

/** The `ask:N` phase keys present in a run's `phasesDone`, in round order. */
function doneAskPhases(run: ExploreRun): string[] {
  return Object.keys(run.phasesDone)
    .filter((k) => /^ask:\d+$/.test(k))
    .sort((a, b) => Number(a.split(":")[1]) - Number(b.split(":")[1]));
}

/**
 * Build the seed {@link ProgressModel} for an explore run. Static spine phases in
 * `phasesDone` seed as `done`; any `ask:N` rounds already finished are inserted
 * (as `done`) before the `synthesize` row so a resumed run's checklist keeps its
 * Socratic history.
 */
export function buildExploreModel(run: ExploreRun, opts: { runUrl?: string } = {}): ProgressModel {
  const completed = new Set(EXPLORE_PHASES.map((p) => p.key).filter((k) => run.phasesDone[k]));
  const model = buildProgressModel(EXPLORE_PHASES, {
    workflowName: "explore",
    number: run.issue > 0 ? run.issue : undefined,
    owner: run.owner,
    repo: run.repo,
    completed,
    runUrl: opts.runUrl,
  });
  // Re-insert finished ask rows before the synthesize row (resume history).
  const synthIdx = model.steps.findIndex((s) => s.key === "synthesize");
  const askRows = doneAskPhases(run).map((p) => askRow(p, "done"));
  if (askRows.length > 0 && synthIdx >= 0) {
    model.steps = [...model.steps.slice(0, synthIdx), ...askRows, ...model.steps.slice(synthIdx)];
  }
  return model;
}
