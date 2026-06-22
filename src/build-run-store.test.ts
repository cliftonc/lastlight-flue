import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BuildRunStore, MAX_RESTART_RESUMES } from './build-run-store.ts';

// Phase 4 — the application-owned build run record. Survives a fresh store instance
// reading the same on-disk db (the restart substrate). Pointers-only `scratch`
// (spec/10 split rule); phasesDone idempotency keys; the restart breaker counter.

let dir: string;
let store: BuildRunStore;
const seed = { owner: 'o', repo: 'r', issue: 7, branch: 'b', taskId: 't' };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'brs-'));
  store = new BuildRunStore(join(dir, 'b.db'));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('BuildRunStore', () => {
  it('getOrCreate is first-writer-wins idempotent on the app runId', () => {
    const a = store.getOrCreate('x', seed);
    const b = store.getOrCreate('x', { ...seed, issue: 999 }); // ignored second write
    expect(a.id).toBe('x');
    expect(b.issue).toBe(7);
    expect(b.status).toBe('active');
  });

  it('phasesDone drives shouldRunPhase; scratch merges pointers', () => {
    const run = store.getOrCreate('x', seed);
    expect(store.shouldRunPhase(run, 'architect')).toBe(true);
    store.markPhaseDone('x', 'architect', { plan: '.lastlight/plan.md' });
    const after = store.get('x')!;
    expect(store.shouldRunPhase(after, 'architect')).toBe(false);
    expect(after.scratch.plan).toBe('.lastlight/plan.md');
  });

  it('a fresh store instance reads the on-disk record (restart durability)', () => {
    store.getOrCreate('x', seed);
    store.markPhaseDone('x', 'guardrails');
    store.setPending('x', 'post_architect');
    store.close();

    const reopened = new BuildRunStore(join(dir, 'b.db'));
    try {
      const rec = reopened.get('x')!;
      expect(rec.phasesDone.guardrails).toBe(true);
      expect(rec.pendingGate).toBe('post_architect');
      expect(rec.status).toBe('paused');
    } finally {
      reopened.close();
    }
  });

  it('bumpRestart increments and reports the new value; breaker cap exposed', () => {
    store.getOrCreate('x', seed);
    expect(store.bumpRestart('x')).toBe(1);
    expect(store.bumpRestart('x')).toBe(2);
    expect(MAX_RESTART_RESUMES).toBe(3);
  });

  it('listActive returns active runs but not paused/complete/failed', () => {
    store.getOrCreate('a', seed);
    store.getOrCreate('p', seed);
    store.setPending('p', 'post_architect');
    store.getOrCreate('c', seed);
    store.complete('c');
    expect(store.listActive().map((r) => r.id)).toEqual(['a']);
  });
});
