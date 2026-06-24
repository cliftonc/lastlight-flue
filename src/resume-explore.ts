/**
 * Phase 5 — resumeExplore(runId, reply): fold the human's answer into the Socratic
 * transcript + re-invoke idempotently.
 *
 * THE REPLY-GATE RESUME. It is the SAME re-invoke mechanism as build's `resume`
 * (src/resume.ts): a workflow is re-entered by re-RUNNING it, and the on-disk app run
 * record's phasesDone + socraticIter make it land just past the gate. The ONE
 * difference from build's APPROVE/REJECT gate: the human supplies an ANSWER, not a
 * decision — so resumeExplore APPENDS the answer to `scratch.socratic.qa` BEFORE the
 * re-invoke, then re-runs explore with `resumedGate='reply:<round>'`. The ask phase of
 * the same round sees the folded reply, and the loop either asks again or goes READY.
 *
 * This lives in a SEPARATE module from build's `resume` so the build approve/reject
 * contract is untouched (the prompt's "don't break build's resume cleanly" rule): the
 * explore reply is a fundamentally different resolver (text, not a binary decision), so
 * it gets its own typed entry over the explore run-store.
 *
 * The re-invoker is an INJECTED seam (`reinvoke`) so this is testable offline: tests
 * pass an in-process fake that calls runExplore() directly; production defaults to
 * in-process `invokeFlueRun('explore', {…resumedGate})` (beta.3's `invoke`; beta.2 had
 * none, so this used to spawn `flue run`). Fire-and-forget — the run record is the truth.
 */
import { ExploreRunStore } from "./explore-run-store.ts";
import type { ExploreInput, ExploreResult } from "./agent-lib/explore-phases.ts";
import { invokeFlueRun } from "./agent-lib/invoke-flue-run.ts";

/** Re-invoke the explore workflow for an app runId, carrying the parked reply gate. */
export type ExploreReinvoker = (input: ExploreInput) => Promise<ExploreResult | void>;

export interface ResumeExploreOptions {
  storePath?: string;
  /** The re-invoke seam (default = spawn `flue run explore`). Tests inject a fake. */
  reinvoke?: ExploreReinvoker;
}

const defaultStorePath = () =>
  process.env.LASTLIGHT_EXPLORE_RUNSTORE ?? "./.data/explore-run-store.db";

/** Default production re-invoker: in-process `invoke('explore', { …gate })` (fire-and-forget). */
function defaultReinvoke(input: ExploreInput): ExploreReinvoker {
  return async () => {
    await invokeFlueRun("explore", input);
  };
}

/** Build the re-invoke input from a paused run + its parked gate. */
function reinvokeInput(
  run: { id: string; owner: string; repo: string; issue: number; triggerId: string; pendingGate: string | null },
  triggerType: string,
): ExploreInput {
  return {
    runId: run.id,
    owner: run.owner,
    repo: run.repo,
    issue: run.issue,
    triggerId: run.triggerId,
    resumedGate: run.pendingGate ?? "reply:0",
    triggerType,
  };
}

/**
 * Resume an explore parked at a reply gate, folding the human's answer into the
 * Socratic transcript and re-invoking past the gate.
 *
 * @param runId the APP run id (the reply contract — stable across re-invokes).
 * @param reply the human's answer text (untrusted — wrapped when it reaches the agent).
 */
export async function resumeExplore(
  runId: string,
  reply: string,
  opts: ResumeExploreOptions = {},
): Promise<ExploreResult> {
  const store = new ExploreRunStore(opts.storePath ?? defaultStorePath());
  try {
    const run = store.get(runId);
    if (!run) return { status: "failed", reason: `resumeExplore: unknown runId ${runId}` };

    // Idempotent guards: a reply against a non-paused / terminal run is a no-op.
    if (run.status === "complete") return { status: "complete", specUrl: run.scratch.specUrl };
    if (run.status === "failed") return { status: "failed", reason: run.failReason ?? undefined };
    if (run.pendingGate === null) {
      // Already resumed (a duplicate reply raced past). No-op, report state.
      return { status: run.status === "paused" ? "paused" : "complete" };
    }

    // Fold the human's answer into the Socratic transcript BEFORE re-invoking, so the
    // re-entered ask round sees it. Empty replies still re-invoke (the human may just
    // be saying "go ahead") — the ask prompt handles "we're done"/empty.
    if (reply && reply.trim()) {
      store.appendSocraticTurn(runId, { answer: reply });
    }

    const input = reinvokeInput(run, "resume");
    const reinvoke = opts.reinvoke ?? defaultReinvoke(input);
    const result = await reinvoke(input);

    const after = store.get(runId)!;
    return (
      (result as ExploreResult | undefined) ?? {
        status:
          after.status === "failed"
            ? "failed"
            : after.status === "complete"
              ? "complete"
              : "paused",
        specUrl: after.scratch.specUrl,
        reason: after.failReason ?? undefined,
      }
    );
  } finally {
    store.close();
  }
}

/**
 * Boot-time orphan recovery for explore: re-invoke every `status='active'` run (NOT
 * `paused` — those await a human reply). The breaker in runExplore caps the loop.
 */
export async function recoverOrphanExploreRuns(
  opts: ResumeExploreOptions = {},
): Promise<string[]> {
  const store = new ExploreRunStore(opts.storePath ?? defaultStorePath());
  const recovered: string[] = [];
  try {
    for (const run of store.listActive()) {
      const input = reinvokeInput(run, "boot");
      const reinvoke = opts.reinvoke ?? defaultReinvoke(input);
      await reinvoke(input);
      recovered.push(run.id);
    }
    return recovered;
  } finally {
    store.close();
  }
}
