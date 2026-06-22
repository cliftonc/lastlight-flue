import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FlueContext } from '@flue/runtime';
import { runBuild } from '../build.ts';
import { BuildRunStore } from '../../build-run-store.ts';
import { resume, recoverOrphanRuns } from '../../resume.ts';
import {
  type BuildInput,
  type BuildDeps,
  type BuildResult,
  defaultBuildDeps,
} from '../../agent-lib/build-phases.ts';

// Phase 4 — durable build CONTROL FLOW tests (offline; NO live model / GitHub).
//
// Mirrors Spike-3's rigor: a real BuildRunStore on a TEMP sqlite db + a fake
// BuildDeps that RECORDS every phase/PR call, so we can assert: the gate pauses +
// persists `pending` + returns; a resume re-invoke continues; reject terminalizes;
// every phase runs EXACTLY ONCE across re-invokes (idempotency via phasesDone); the
// restart breaker caps at 3; and the GOLDEN phase-sequence order.

let dir: string;
let store: BuildRunStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'build-phase4-'));
  store = new BuildRunStore(join(dir, 'build.db'));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const INPUT: Omit<BuildInput, 'resumedGate'> = {
  runId: 'cliftonc/repo#42',
  owner: 'cliftonc',
  repo: 'repo',
  issue: 42,
};

function ctx(input: BuildInput): FlueContext<BuildInput> {
  return { payload: input, log: { info() {}, warn() {}, error() {} } } as unknown as FlueContext<BuildInput>;
}

/**
 * A fake BuildDeps recording the ordered list of phases run + gate asks + PRs.
 * `verdicts` maps a reviewer phase name → the canned VERDICT text it returns
 * (default APPROVED so the loop ends after one cycle). `gates` toggles which gates
 * fire (positive-enable).
 */
function recordingDeps(opts: {
  verdicts?: Record<string, string>;
  gates?: { post_architect?: boolean; post_reviewer?: boolean };
} = {}) {
  const phases: string[] = [];
  const gateAsks: string[] = [];
  const prOpens: string[] = [];
  const gates = { post_architect: true, post_reviewer: false, ...opts.gates };
  const deps: BuildDeps = {
    async runPhase(_c, _r, name) {
      phases.push(name);
      if (name.startsWith('reviewer:')) {
        return { text: opts.verdicts?.[name] ?? 'VERDICT: APPROVED\n\nLGTM.' };
      }
      return { text: 'ok' };
    },
    async postGateComment(_c, _r, gate) {
      gateAsks.push(gate);
    },
    async openPullRequest(_c, r) {
      prOpens.push(r.id);
      return { html_url: `https://gh/pr/${r.issue}` };
    },
    gateEnabled: (g) => gates[g],
    parseVerdict: defaultBuildDeps().parseVerdict,
  };
  return { deps, phases, gateAsks, prOpens };
}

describe('build — durable control flow + post_architect gate', () => {
  it('pauses at post_architect: persists pending, posts the ask once, returns', async () => {
    const t = recordingDeps();
    const res = await runBuild(ctx({ ...INPUT }), store, t.deps);

    expect(res.status).toBe('paused');
    expect(res.gate).toBe('post_architect');
    // guardrails + architect ran; nothing past the gate.
    expect(t.phases).toEqual(['guardrails', 'architect']);
    expect(t.gateAsks).toEqual(['post_architect']);
    expect(t.prOpens).toEqual([]);

    const rec = store.get(INPUT.runId)!;
    expect(rec.pendingGate).toBe('post_architect');
    expect(rec.status).toBe('paused');
    expect(rec.phasesDone).toMatchObject({ guardrails: true, architect: true });
    expect(rec.phasesDone.executor).toBeUndefined();
  });

  it('re-invoke without approval re-pauses idempotently — does NOT re-run done phases or re-post the ask', async () => {
    const t = recordingDeps();
    await runBuild(ctx({ ...INPUT }), store, t.deps); // pause
    // A bare re-invoke (no resumedGate) lands back at the gate.
    const res = await runBuild(ctx({ ...INPUT }), store, t.deps);

    expect(res.status).toBe('paused');
    // guardrails/architect ran ONCE total; the ask posted ONCE total.
    expect(t.phases).toEqual(['guardrails', 'architect']);
    expect(t.gateAsks).toEqual(['post_architect']);
  });

  it('approve resume continues past the gate and opens the PR exactly once', async () => {
    const t = recordingDeps();
    await runBuild(ctx({ ...INPUT }), store, t.deps); // pause at post_architect

    const result = await resume(INPUT.runId, 'approve', {
      storePath: join(dir, 'build.db'),
      reinvoke: (input) => runBuild(ctx(input), store, t.deps),
    });

    expect(result.status).toBe('complete');
    expect(result.prUrl).toBe('https://gh/pr/42');
    // Full sequence ran, each phase once; PR opened once.
    expect(t.phases).toEqual([
      'guardrails',
      'architect',
      'executor',
      'reviewer:0',
    ]);
    expect(t.prOpens).toEqual([INPUT.runId]);

    const rec = store.get(INPUT.runId)!;
    expect(rec.status).toBe('complete');
    expect(rec.pendingGate).toBeNull();
  });

  it('reject terminalizes the run (failed) with NO re-invoke', async () => {
    const t = recordingDeps();
    let reinvoked = 0;
    await runBuild(ctx({ ...INPUT }), store, t.deps); // pause

    const result = await resume(INPUT.runId, 'reject', {
      storePath: join(dir, 'build.db'),
      reinvoke: async () => {
        reinvoked++;
      },
    });

    expect(result.status).toBe('failed');
    expect(result.reason).toBe('rejected');
    expect(reinvoked).toBe(0);
    expect(store.get(INPUT.runId)!.status).toBe('failed');
  });

  it('a disabled post_architect gate does NOT pause (positive-enable)', async () => {
    const t = recordingDeps({ gates: { post_architect: false } });
    const res = await runBuild(ctx({ ...INPUT }), store, t.deps);

    expect(res.status).toBe('complete');
    expect(t.gateAsks).toEqual([]); // never asked
    expect(t.phases).toEqual(['guardrails', 'architect', 'executor', 'reviewer:0']);
    expect(t.prOpens).toEqual([INPUT.runId]);
  });
});

describe('build — GOLDEN phase-sequence order', () => {
  it('a normal (no-gate) run executes phases in the exact golden order', async () => {
    const t = recordingDeps({ gates: { post_architect: false } });
    await runBuild(ctx({ ...INPUT }), store, t.deps);
    expect(t.phases).toEqual(['guardrails', 'architect', 'executor', 'reviewer:0']);
  });

  it('a run with a fix cycle executes reviewer→fix→recheck→reviewer in golden order', async () => {
    // reviewer:0 requests changes → fix:0 → recheck:0 → reviewer:1 approves.
    const t = recordingDeps({
      gates: { post_architect: false, post_reviewer: false },
      verdicts: {
        'reviewer:0': 'VERDICT: REQUEST_CHANGES\n\nFix the null deref.',
        'reviewer:1': 'VERDICT: APPROVED\n\nResolved.',
      },
    });
    await runBuild(ctx({ ...INPUT }), store, t.deps);
    expect(t.phases).toEqual([
      'guardrails',
      'architect',
      'executor',
      'reviewer:0',
      'fix:0',
      'recheck:0',
      'reviewer:1',
    ]);
  });

  it('a GATED run resumed across re-invokes yields the SAME golden order as a normal run', async () => {
    const t = recordingDeps({ gates: { post_architect: true } });
    await runBuild(ctx({ ...INPUT }), store, t.deps); // pause @ post_architect
    await resume(INPUT.runId, 'approve', {
      storePath: join(dir, 'build.db'),
      reinvoke: (input) => runBuild(ctx(input), store, t.deps),
    });
    // Identical executed order to the ungated run — the gate is transparent to it.
    expect(t.phases).toEqual(['guardrails', 'architect', 'executor', 'reviewer:0']);
  });
});

describe('build — post_reviewer gate (mid-loop pause/resume)', () => {
  it('pauses at post_reviewer:0 on REQUEST_CHANGES, then resumes into the same cycle', async () => {
    const t = recordingDeps({
      gates: { post_architect: false, post_reviewer: true },
      verdicts: {
        'reviewer:0': 'VERDICT: REQUEST_CHANGES\n\nNeeds work.',
        'reviewer:1': 'VERDICT: APPROVED\n\nGood now.',
      },
    });
    const paused = await runBuild(ctx({ ...INPUT }), store, t.deps);
    expect(paused.status).toBe('paused');
    expect(paused.gate).toBe('post_reviewer:0');
    expect(t.phases).toEqual(['guardrails', 'architect', 'executor', 'reviewer:0']);
    expect(store.get(INPUT.runId)!.reviewerCycle).toBe(0);

    const done = await resume(INPUT.runId, 'approve', {
      storePath: join(dir, 'build.db'),
      reinvoke: (input) => runBuild(ctx(input), store, t.deps),
    });
    expect(done.status).toBe('complete');
    // fix:0/recheck:0 ran after resume, then reviewer:1 approved. reviewer:0 ran ONCE.
    expect(t.phases).toEqual([
      'guardrails',
      'architect',
      'executor',
      'reviewer:0',
      'fix:0',
      'recheck:0',
      'reviewer:1',
    ]);
  });
});

describe('build — boot orphan recovery', () => {
  it('recoverOrphanRuns re-invokes active (not paused) runs', async () => {
    // An active run mid-flight (not at a gate) should be re-invoked on boot.
    store.getOrCreate('active-run', { owner: 'o', repo: 'r', issue: 1, branch: 'b', taskId: 't' });
    // A paused run must be LEFT ALONE (awaiting a human).
    store.getOrCreate('paused-run', { owner: 'o', repo: 'r', issue: 2, branch: 'b', taskId: 't' });
    store.setPending('paused-run', 'post_architect');

    const reinvoked: string[] = [];
    const recovered = await recoverOrphanRuns({
      storePath: join(dir, 'build.db'),
      reinvoke: async (input) => {
        reinvoked.push(input.runId);
      },
    });
    expect(recovered).toEqual(['active-run']);
    expect(reinvoked).toEqual(['active-run']);
  });
});

describe('build — idempotency: phases run EXACTLY ONCE across many re-invokes', () => {
  it('duplicate approve signals do not re-run phases or re-open the PR', async () => {
    const t = recordingDeps();
    await runBuild(ctx({ ...INPUT }), store, t.deps); // pause
    const reinvoke = (input: BuildInput) => runBuild(ctx(input), store, t.deps);
    const o = { storePath: join(dir, 'build.db'), reinvoke };

    await resume(INPUT.runId, 'approve', o); // completes
    await resume(INPUT.runId, 'approve', o); // duplicate — no-op
    await resume(INPUT.runId, 'approve', o); // duplicate — no-op

    // Each side-effecting phase happened exactly once.
    const count = (p: string) => t.phases.filter((x) => x === p).length;
    expect(count('guardrails')).toBe(1);
    expect(count('architect')).toBe(1);
    expect(count('executor')).toBe(1);
    expect(count('reviewer:0')).toBe(1);
    expect(t.prOpens).toEqual([INPUT.runId]); // PR opened once
  });
});

describe('build — restart-count breaker caps at 3', () => {
  it('the 4th resume re-invoke terminalizes the run as failed', async () => {
    // Model a crash-loop: a run that keeps getting re-invoked (resumedGate set) but
    // never finishes (we re-park it at the gate before each attempt). Every re-invoke
    // bumps restart_count; once it exceeds the cap (3) runBuild must terminalize the
    // run as `failed` and refuse to proceed — NOT re-run any phase.
    const t = recordingDeps();
    await runBuild(ctx({ ...INPUT }), store, t.deps); // initial pause, restart=0
    const phasesAfterPause = t.phases.length;

    let last: BuildResult | undefined;
    const statuses: string[] = [];
    for (let attempt = 1; attempt <= 4; attempt++) {
      // Re-park at the gate so the run is always 'active' + pending for this attempt
      // (simulates the run never completing across crashes/resumes).
      store.setPending(INPUT.runId, 'post_architect');
      last = await runBuild(
        ctx({ ...INPUT, resumedGate: 'post_architect' }),
        store,
        t.deps,
      );
      statuses.push(last.status);
    }

    // Attempts 1-3 (restart_count 1,2,3) proceed; attempt 4 (restart_count 4 > 3) fails.
    expect(statuses).toEqual(['complete', 'complete', 'complete', 'failed']);
    const rec = store.get(INPUT.runId)!;
    expect(rec.restartCount).toBe(4);
    expect(rec.status).toBe('failed');
    expect(rec.failReason).toContain('restart-breaker');
    // No phase re-ran on the breaker trip (all already done by phasesDone).
    expect(t.phases.length).toBe(phasesAfterPause + 2); // executor + reviewer:0, once
  });
});
