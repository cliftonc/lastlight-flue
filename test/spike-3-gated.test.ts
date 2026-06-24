import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runGated } from '../src/workflows/gated.ts';
import type { RunRecord } from '../src/run-store.ts';

// Phase 0 · Spike 3 acceptance — durable HITL gate.
//
// The gate is application-owned (Flue has no suspend primitive and does not
// checkpoint workflows). These tests prove: an initial invoke pauses with `pending`
// persisted; a later RE-INVOKE (a fresh RunStore reading the on-disk record — the
// restart) resumes past the gate; and step2's external side effect runs EXACTLY
// ONCE even when the resume is invoked repeatedly (idempotency via the run record).
//
// The in-process tests exercise the durability invariant fast and for free (each
// run() opens/closes its own store, so disk is the only handoff). The full
// cross-process proof through `flue run` (3 separate OS processes) is gated on
// RUN_FLUE_CLI=1 so the default suite stays fast — it was verified manually and is
// recorded in PROGRESS.md / MIGRATION.md.

const exec = promisify(execFile);

let dir: string;

function readRun(id: string): RunRecord | undefined {
  const db = new DatabaseSync(join(dir, 'run-store.db'));
  try {
    return db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRecord | undefined;
  } finally {
    db.close();
  }
}

function readArtifact(id: string): string[] {
  const path = join(dir, 'artifacts', `${id}.log`);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter((l) => l.length > 0);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'spike3-'));
  process.env.LASTLIGHT_RUNSTORE = join(dir, 'run-store.db');
  process.env.LASTLIGHT_ARTIFACTS = join(dir, 'artifacts');
});

afterEach(() => {
  delete process.env.LASTLIGHT_RUNSTORE;
  delete process.env.LASTLIGHT_ARTIFACTS;
  rmSync(dir, { recursive: true, force: true });
});

// beta.3: the gated workflow's testable core `runGated(input)` takes the input
// directly (the workflow `run({ input })` just forwards it). `ctx` returns the input;
// `run` is the core.
const run = runGated;
const ctx = (payload: { runId: string; resumed?: boolean }) => payload;

describe('spike-3 durable gate (in-process)', () => {
  it('pauses at the gate on the initial invoke', async () => {
    const out = (await run(ctx({ runId: 'r1' }))) as { paused?: boolean; gate?: string };
    expect(out.paused).toBe(true);
    expect(out.gate).toBe('gate-1');

    const rec = readRun('r1')!;
    expect(rec.step1_done).toBe(1);
    expect(rec.step2_done).toBe(0);
    expect(rec.pending_gate).toBe('gate-1');
    expect(rec.status).toBe('pending');
    // step1 side effect happened once; step2 has not run.
    expect(readArtifact('r1')).toEqual(['step1']);
  });

  it('resumes past the gate and runs step2 exactly once across re-invokes', async () => {
    await run(ctx({ runId: 'r2' })); // pause
    const resumed = (await run(ctx({ runId: 'r2', resumed: true }))) as { done?: boolean };
    expect(resumed.done).toBe(true);

    // Resume again (duplicate signal / boot re-invoke): step2 must NOT repeat.
    const again = (await run(ctx({ runId: 'r2', resumed: true }))) as { restartCount?: number };
    expect(again.restartCount).toBe(2);

    const rec = readRun('r2')!;
    expect(rec.step1_done).toBe(1);
    expect(rec.step2_done).toBe(1);
    expect(rec.status).toBe('done');
    expect(rec.pending_gate).toBeNull();
    // EXACTLY-ONCE: one step1, one step2 — no duplicate side effects.
    expect(readArtifact('r2')).toEqual(['step1', 'step2']);
  });

  it('keeps separate runs isolated by app runId', async () => {
    await run(ctx({ runId: 'a' }));
    await run(ctx({ runId: 'b' }));
    await run(ctx({ runId: 'a', resumed: true }));
    expect(readRun('a')!.status).toBe('done');
    expect(readRun('b')!.status).toBe('pending');
    expect(readArtifact('a')).toEqual(['step1', 'step2']);
    expect(readArtifact('b')).toEqual(['step1']);
  });
});

// Full cross-process proof: 3 separate `flue run` processes. Heavier (rebuilds each
// time), so opt-in. Proven manually 2026-06-21 — see PROGRESS.md.
describe.skipIf(process.env.RUN_FLUE_CLI !== '1')('spike-3 durable gate (flue run, cross-process)', () => {
  it('pause → resume(restart) → resume-again with exactly-once step2', async () => {
    const env = { ...process.env, LASTLIGHT_RUNSTORE: join(dir, 'run-store.db'), LASTLIGHT_ARTIFACTS: join(dir, 'artifacts') };
    const flue = (payload: string) => exec('pnpm', ['exec', 'flue', 'run', 'gated', '--payload', payload], { env, timeout: 120_000 });

    const p1 = await flue('{"runId":"x"}');
    expect(p1.stdout).toContain('"paused": true');
    await flue('{"runId":"x","resumed":true}'); // restart + resume
    await flue('{"runId":"x","resumed":true}'); // duplicate

    expect(readArtifact('x')).toEqual(['step1', 'step2']);
    expect(readRun('x')!.status).toBe('done');
  }, 300_000);
});
