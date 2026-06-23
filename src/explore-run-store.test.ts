import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExploreRunStore } from './explore-run-store.ts';

// Phase 6 — conversation→runId gate correlation for the explore REPLY gate. The
// store mirrors BuildRunStore: a paused reply-gate run carries the channel
// conversation key; a channel reply on that conversation resolves the run. The
// legacy `triggerId` (the channels passed `triggerId: ev.conversationKey`) is ALSO
// matched so either correlation path resolves the same paused run.

let dir: string;
let store: ExploreRunStore;
const seed = { owner: 'o', repo: 'r', issue: 7, triggerId: 'o/r#7' };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ers-'));
  store = new ExploreRunStore(join(dir, 'e.db'));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('ExploreRunStore conversation key gate correlation', () => {
  const CONV = 'github:v1:owner:o:repo:r:issue:7';

  it('setConversationKey + findPausedRunByConversation resolves the paused run', () => {
    store.getOrCreate('x', { ...seed, triggerId: '' });
    store.setConversationKey('x', CONV);
    store.setPending('x', 'reply:0');
    expect(store.get('x')!.conversationKey).toBe(CONV);
    expect(store.findPausedRunByConversation(CONV)).toBe('x');
  });

  it('also resolves by the legacy triggerId (the channels pass it as the key)', () => {
    store.getOrCreate('x', seed); // triggerId = 'o/r#7', no conversation_key set
    store.setPending('x', 'reply:0');
    expect(store.findPausedRunByConversation('o/r#7')).toBe('x');
  });

  it('no paused reply gate → undefined (clean no-op)', () => {
    store.getOrCreate('x', { ...seed, triggerId: '' });
    store.setConversationKey('x', CONV); // active, not paused
    expect(store.findPausedRunByConversation(CONV)).toBeUndefined();
    expect(store.findPausedRunByConversation('nope')).toBeUndefined();
  });

  it('a resolved/terminal reply gate is NOT returned', () => {
    store.getOrCreate('x', { ...seed, triggerId: '' });
    store.setConversationKey('x', CONV);
    store.setPending('x', 'reply:0');
    store.clearPending('x'); // resumed → active, gate null
    expect(store.findPausedRunByConversation(CONV)).toBeUndefined();
    store.setPending('x', 'reply:1');
    store.complete('x');
    expect(store.findPausedRunByConversation(CONV)).toBeUndefined();
  });

  it('migration-safe: a db CREATEd without conversation_key gains it (existing rows null)', () => {
    const oldPath = join(dir, 'old.db');
    const { DatabaseSync } = require('node:sqlite');
    const raw = new DatabaseSync(oldPath);
    raw.exec(`
      CREATE TABLE explore_runs (
        id TEXT PRIMARY KEY, owner TEXT, repo TEXT, issue INTEGER, trigger_id TEXT,
        phases_done TEXT NOT NULL DEFAULT '{}', scratch TEXT NOT NULL DEFAULT '{}',
        socratic TEXT NOT NULL DEFAULT '{"qa":"","ready":false}',
        socratic_iter INTEGER NOT NULL DEFAULT 0, pending_gate TEXT,
        restart_count INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active',
        fail_reason TEXT );
    `);
    raw.prepare("INSERT INTO explore_runs (id, trigger_id, status, pending_gate) VALUES ('legacy','o/r#7','paused','reply:0')").run();
    raw.close();

    const migrated = new ExploreRunStore(oldPath);
    try {
      expect(migrated.get('legacy')!.conversationKey).toBeNull();
      // legacy reply-gate still resolves via its triggerId even with no conv key.
      expect(migrated.findPausedRunByConversation('o/r#7')).toBe('legacy');
      // and the new channel-key correlation works on the migrated db.
      migrated.getOrCreate('y', { ...seed, triggerId: '' });
      migrated.setConversationKey('y', CONV);
      migrated.setPending('y', 'reply:0');
      expect(migrated.findPausedRunByConversation(CONV)).toBe('y');
    } finally {
      migrated.close();
    }
  });
});
