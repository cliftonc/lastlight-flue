import { describe, it, expect, afterEach } from 'vitest';
import type { Octokit } from 'octokit';
import type { FlueHarness } from '@flue/runtime';
import {
  runArchitectPhase,
  type ArchitectPhaseDeps,
  type BuildRunCtx,
} from '../build-phases.ts';
import type { BuildRun } from '../../build-run-store.ts';
import {
  runPhasePrompt,
  setExecutionRecorder,
} from '../record-execution.ts';
import type { ExecutionRow } from '../../stats-store.ts';

// Phase 7 slice 2 — a build phase records a per-phase `executions` stats row from
// its prompt usage. Exercised through `runArchitectPhase` with the sandbox/token
// seams stubbed and the session runner following the SAME contract the real
// `runArchitectSession` does (runPhasePrompt with the architect identity) — so the
// assertion is that a phase, run end-to-end, lands the right stats row, offline.

const RUN: BuildRun = {
  id: 'cliftonc/widget#42',
  owner: 'cliftonc',
  repo: 'widget',
  issue: 42,
  branch: 'lastlight/42',
  taskId: 'widget-42-build',
  phasesDone: {},
  scratch: {},
  pendingGate: null,
  reviewerCycle: 1,
  restartCount: 0,
  status: 'active',
  failReason: null,
};

function ctx(): BuildRunCtx {
  return {
    harness: { name: 'default' } as unknown as FlueHarness,
    input: { runId: RUN.id, owner: RUN.owner, repo: RUN.repo, issue: RUN.issue },
    log: { info() {}, warn() {}, error() {} },
  };
}

afterEach(() => {
  setExecutionRecorder(null);
});

describe('build phase records an execution stats row', () => {
  it('runArchitectPhase records a build/architect row with the prompt usage', async () => {
    const rows: ExecutionRow[] = [];
    setExecutionRecorder({ record: (row) => rows.push(row) });

    // A fake session returning canned usage (the PromptResponse shape, flue-ref §0).
    const session = {
      prompt: async () => ({
        text: 'PLAN: do the thing',
        usage: { input: 800, output: 150, totalTokens: 950, cost: { total: 1.25 } },
        model: { provider: 'openai', id: 'gpt-x' },
      }),
    };

    const deps: ArchitectPhaseDeps = {
      mintToken: async () => 'ghs_token',
      makeOctokit: () => ({} as unknown as Octokit),
      // The clone-into-harness seam is a no-op offline (no real Docker / git).
      ensureCheckout: async () => {},
      // Follows the real runArchitectSession contract: runPhasePrompt with the
      // architect identity (runId from ctx.input, workflow 'build', phase 'architect').
      runArchitectSession: async (c) => {
        const res = await runPhasePrompt(session, 'prompt', {
          runId: c.input.runId,
          workflow: 'build',
          phase: 'architect',
        });
        return res.text;
      },
    };

    const out = await runArchitectPhase(ctx(), RUN, deps);
    expect(out.text).toContain('PLAN');

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual<ExecutionRow>({
      runId: 'cliftonc/widget#42',
      workflow: 'build',
      phase: 'architect',
      model: 'openai/gpt-x',
      inputTokens: 800,
      outputTokens: 150,
      totalTokens: 950,
      costTotal: 1.25,
    });
  });

  it('is inert: no recorder wired → the phase still completes, no write', async () => {
    setExecutionRecorder(null);
    const session = { prompt: async () => ({ text: 'PLAN', usage: undefined, model: undefined }) };
    const deps: ArchitectPhaseDeps = {
      mintToken: async () => 'ghs_token',
      makeOctokit: () => ({} as unknown as Octokit),
      ensureCheckout: async () => {},
      runArchitectSession: async (c) =>
        (await runPhasePrompt(session, 'p', { runId: c.input.runId, workflow: 'build', phase: 'architect' })).text,
    };
    await expect(runArchitectPhase(ctx(), RUN, deps)).resolves.toMatchObject({ text: 'PLAN' });
  });
});
