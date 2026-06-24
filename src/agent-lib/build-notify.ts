/**
 * Phase 8 egress — the `build` workflow's progress-notifier glue (PURE: no
 * GitHub/Slack/token here, so it stays offline-testable and free of an import
 * cycle with build-phases.ts; the live transport construction lives in
 * `build-phases.ts`'s `makeBuildReporter`).
 *
 * The build checklist surfaced in the in-place GitHub comment / Slack message:
 * the fixed spine (guardrails → architect → executor → PR) plus DYNAMIC
 * reviewer-loop rows (reviewer:N / fix:N / recheck:N) the control flow inserts
 * just above the PR row as cycles run. On a RESUME the seed model re-attaches
 * the rows already in `phasesDone` so the checklist doesn't lose its history.
 */
import type { BuildRun } from "../build-run-store.ts";
import { buildProgressModel, type PhaseSpec } from "../notify/model.ts";
import type { ProgressModel, ProgressStep, StepStatus } from "../notify/types.ts";

/** The fixed build spine (the dynamic reviewer-loop rows are inserted before `pr`). */
export const BUILD_PHASES: readonly PhaseSpec[] = [
  { key: "guardrails", label: "Guardrails" },
  { key: "architect", label: "Architect" },
  { key: "executor", label: "Executor" },
  { key: "pr", label: "Pull request" },
];

/** The checklist row a reviewer-loop phase (`reviewer:N` / `fix:N` / `recheck:N`) renders as. */
export function reviewerLoopRow(phase: string, status: StepStatus): ProgressStep {
  const m = phase.match(/^(reviewer|fix|recheck):(\d+)$/);
  if (!m) return { key: phase, label: phase, status };
  const kind = m[1]!;
  const cycle = Number(m[2]) + 1;
  const label =
    kind === "reviewer" ? `Review (cycle ${cycle})`
    : kind === "fix" ? `Fix (cycle ${cycle})`
    : `Re-review (cycle ${cycle})`;
  return { key: phase, label, status };
}

/** The reviewer-loop phase keys present in a run's `phasesDone`, in cycle order. */
function doneReviewerLoopPhases(run: BuildRun): string[] {
  return Object.keys(run.phasesDone)
    .filter((k) => /^(reviewer|fix|recheck):\d+$/.test(k))
    .sort((a, b) => {
      const [ka, na] = a.split(":");
      const [kb, nb] = b.split(":");
      // Order by cycle first, then reviewer < fix < recheck within a cycle.
      const order: Record<string, number> = { reviewer: 0, fix: 1, recheck: 2 };
      return Number(na) - Number(nb) || (order[ka!] ?? 9) - (order[kb!] ?? 9);
    });
}

/**
 * Build the seed {@link ProgressModel} for a build run. Static spine phases in
 * `phasesDone` seed as `done`; any reviewer-loop rows already finished are
 * inserted (as `done`) before the `pr` row so a resumed run's checklist keeps
 * its cycle history.
 */
export function buildBuildModel(run: BuildRun, opts: { runUrl?: string } = {}): ProgressModel {
  const completed = new Set(BUILD_PHASES.map((p) => p.key).filter((k) => run.phasesDone[k]));
  const model = buildProgressModel(BUILD_PHASES, {
    workflowName: "build",
    number: run.issue,
    issueTitle: undefined,
    owner: run.owner,
    repo: run.repo,
    branch: run.branch,
    completed,
    runUrl: opts.runUrl,
  });
  // Re-insert finished reviewer-loop rows before the terminal PR row (resume history).
  const prIdx = model.steps.findIndex((s) => s.key === "pr");
  const loopRows = doneReviewerLoopPhases(run).map((p) => reviewerLoopRow(p, "done"));
  if (loopRows.length > 0 && prIdx >= 0) {
    model.steps = [...model.steps.slice(0, prIdx), ...loopRows, ...model.steps.slice(prIdx)];
  }
  return model;
}
