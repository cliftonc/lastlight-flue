import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { FlueContext } from '@flue/runtime';
import { RunStore } from '../run-store.ts';

// Phase 0 · Spike 3 — durable HITL (the resume proof).
//
// Flue has NO suspend/await-approval primitive and does NOT checkpoint workflow
// TypeScript, so the gate is 100% application-owned:
//   step1 → write `pending` to the run record → RETURN (the function ends here).
// An external signal later RE-INVOKES this workflow with `resumed: true`; because
// each invocation runs `run()` from the top, the run record's done-flags reproduce
// `shouldRunPhase` and skip the already-completed, side-effecting step1. step2 then
// runs exactly once. This survives a process kill+restart because the run record is
// on disk (run-store.ts) — a brand-new process re-invokes and continues.
//
// Pure TypeScript on purpose: this proves the durability primitive deterministically
// and for free (no model call). Real workflows (Phase 3+) call init()/session inside
// the same control flow.

interface GatedInput {
  /** APP run id — a stable caller-owned key, distinct from Flue's per-run id. */
  runId: string;
  /** Set by the resume signal to advance past the gate. */
  resumed?: boolean;
}

// Read lazily so each process (and each test) can point at its own paths.
const storePath = () => process.env.LASTLIGHT_RUNSTORE ?? './.data/run-store.db';
const artifactDir = () => process.env.LASTLIGHT_ARTIFACTS ?? './.data/artifacts';

/** A stand-in external side effect (e.g. a commit/PR/comment) — must happen once. */
function sideEffect(runId: string, marker: string): void {
  const path = `${artifactDir()}/${runId}.log`;
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${marker}\n`);
}

export async function run({ payload }: FlueContext<GatedInput>) {
  const store = new RunStore(storePath());
  try {
    const appRunId = payload.runId;
    store.getOrCreate(appRunId);

    // STEP 1 — guarded so a re-invocation never repeats the side effect.
    if (!store.get(appRunId)!.step1_done) {
      sideEffect(appRunId, 'step1');
      store.markStep1(appRunId);
    }

    // GATE — first pass suspends: persist `pending` and END the function.
    if (!payload.resumed) {
      store.setPending(appRunId, 'gate-1');
      return { appRunId, paused: true, gate: 'gate-1', step1Done: true };
    }

    // RESUMED past the gate (idempotent re-invoke).
    store.clearPending(appRunId); // increments restart_count
    if (!store.get(appRunId)!.step2_done) {
      sideEffect(appRunId, 'step2');
      store.markStep2(appRunId);
    }
    store.setStatus(appRunId, 'done');

    const final = store.get(appRunId)!;
    return {
      appRunId,
      done: true,
      step1Done: final.step1_done === 1,
      step2Done: final.step2_done === 1,
      restartCount: final.restart_count,
    };
  } finally {
    store.close();
  }
}
