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

  // ── Phase 6: conversation→runId gate correlation ───────────────────────────
  describe('conversation key gate correlation', () => {
    const CONV = 'github:v1:owner:o:repo:r:issue:7';

    it('setConversationKey + findPausedRunByConversation resolves the paused run', () => {
      store.getOrCreate('x', seed);
      store.setConversationKey('x', CONV);
      store.setPending('x', 'post_architect');
      expect(store.get('x')!.conversationKey).toBe(CONV);
      expect(store.findPausedRunByConversation(CONV)).toBe('x');
    });

    it('no paused run on a conversation → undefined (clean no-op)', () => {
      store.getOrCreate('x', seed);
      store.setConversationKey('x', CONV); // active, not yet paused
      expect(store.findPausedRunByConversation(CONV)).toBeUndefined();
      expect(store.findPausedRunByConversation('github:v1:owner:o:repo:r:issue:99')).toBeUndefined();
    });

    it('a resolved/terminal run is NOT returned (resume cleared the gate)', () => {
      store.getOrCreate('x', seed);
      store.setConversationKey('x', CONV);
      store.setPending('x', 'post_architect');
      // clearPending (resume) → status active, gate null → no longer matched.
      store.clearPending('x');
      expect(store.findPausedRunByConversation(CONV)).toBeUndefined();
      // a completed run with the key set is also never matched.
      store.setPending('x', 'post_architect');
      store.complete('x');
      expect(store.findPausedRunByConversation(CONV)).toBeUndefined();
    });

    it('setConversationKey ignores null/empty (a CLI run leaves the column null)', () => {
      store.getOrCreate('x', seed);
      store.setConversationKey('x', undefined);
      store.setConversationKey('x', '');
      store.setPending('x', 'post_architect');
      expect(store.get('x')!.conversationKey).toBeNull();
      expect(store.findPausedRunByConversation('')).toBeUndefined();
    });

    it('migration-safe: a db CREATEd without conversation_key gains it (existing rows null)', () => {
      // Build an "old-shaped" db: the original schema WITHOUT conversation_key.
      const oldPath = join(dir, 'old.db');
      const { DatabaseSync } = require('node:sqlite');
      const raw = new DatabaseSync(oldPath);
      raw.exec(`
        CREATE TABLE build_runs (
          id TEXT PRIMARY KEY, owner TEXT, repo TEXT, issue INTEGER, branch TEXT,
          task_id TEXT, phases_done TEXT NOT NULL DEFAULT '{}',
          scratch TEXT NOT NULL DEFAULT '{}', pending_gate TEXT,
          reviewer_cycle INTEGER NOT NULL DEFAULT 0, restart_count INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'active', fail_reason TEXT );
      `);
      raw.prepare("INSERT INTO build_runs (id, status, pending_gate) VALUES ('legacy','paused','post_architect')").run();
      raw.close();

      // Opening with the current store ADDs the column; the legacy row reads null.
      const migrated = new BuildRunStore(oldPath);
      try {
        expect(migrated.get('legacy')!.conversationKey).toBeNull();
        expect(migrated.findPausedRunByConversation('any')).toBeUndefined();
        // And the new correlation works on the migrated db.
        migrated.getOrCreate('y', seed);
        migrated.setConversationKey('y', CONV);
        migrated.setPending('y', 'post_architect');
        expect(migrated.findPausedRunByConversation(CONV)).toBe('y');
      } finally {
        migrated.close();
      }
    });
  });
});
