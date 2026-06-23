import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ThreadsStore, parseThreadKey } from './threads-store.ts';

// Phase 7 final slice — the app-owned `messaging_threads` grouping table:
// UPSERT (insert-then-bump), blob-free list, getThread, migration-safe on a fresh
// AND an older db, key parsing for both channels.

let dir: string;
let store: ThreadsStore;

const SLACK_KEY = 'slack:v1:T1:C2:1700000000.0001';
const GH_KEY = 'github:v1:owner:cliftonc:repo:widget:issue:42';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'threads-'));
  store = new ThreadsStore(join(dir, 't.db'));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('parseThreadKey', () => {
  it('parses a Slack conversationKey → channel + thread coords', () => {
    expect(parseThreadKey(SLACK_KEY)).toEqual({
      channel: 'slack',
      meta: { teamId: 'T1', channelId: 'C2', threadTs: '1700000000.0001' },
    });
  });

  it('parses a GitHub conversationKey → channel + repo + issue', () => {
    expect(parseThreadKey(GH_KEY)).toEqual({
      channel: 'github',
      meta: { repo: 'cliftonc/widget', issueNumber: 42 },
    });
  });

  it('falls back to a delimited owner/repo slug, defaulting channel to slack', () => {
    const { channel, meta } = parseThreadKey('chat:cliftonc/widget#7');
    expect(channel).toBe('slack');
    expect(meta.repo).toBe('cliftonc/widget');
  });

  it('never throws on an unrecognised key', () => {
    expect(() => parseThreadKey('garbage')).not.toThrow();
    expect(parseThreadKey('garbage')).toEqual({ channel: 'slack', meta: {} });
  });
});

describe('ThreadsStore.recordActivity — UPSERT insert-then-bump', () => {
  it('inserts on first sight (count=1, created==last_activity)', () => {
    store.recordActivity(SLACK_KEY, { now: '2026-06-23T10:00:00.000Z' });
    const t = store.getThread(SLACK_KEY);
    expect(t).not.toBeNull();
    expect(t!.channel).toBe('slack');
    expect(t!.messageCount).toBe(1);
    expect(t!.createdAt).toBe('2026-06-23T10:00:00.000Z');
    expect(t!.lastActivityAt).toBe('2026-06-23T10:00:00.000Z');
    expect(t!.meta).toEqual({ teamId: 'T1', channelId: 'C2', threadTs: '1700000000.0001' });
  });

  it('bumps last_activity + count on subsequent sightings (created unchanged)', () => {
    store.recordActivity(SLACK_KEY, { now: '2026-06-23T10:00:00.000Z' });
    store.recordActivity(SLACK_KEY, { now: '2026-06-23T10:05:00.000Z' });
    store.recordActivity(SLACK_KEY, { now: '2026-06-23T10:10:00.000Z' });
    const t = store.getThread(SLACK_KEY)!;
    expect(t.messageCount).toBe(3);
    expect(t.createdAt).toBe('2026-06-23T10:00:00.000Z');
    expect(t.lastActivityAt).toBe('2026-06-23T10:10:00.000Z');
  });

  it('derives channel/repo from a GitHub key when not supplied', () => {
    store.recordActivity(GH_KEY);
    const t = store.getThread(GH_KEY)!;
    expect(t.channel).toBe('github');
    expect(t.repo).toBe('cliftonc/widget');
    expect(t.meta.issueNumber).toBe(42);
  });

  it('getThread returns null for an unknown id', () => {
    expect(store.getThread('nope')).toBeNull();
  });
});

describe('ThreadsStore.listThreads — blob-free, newest-activity-first', () => {
  it('orders by last_activity desc and carries no blob columns', () => {
    store.recordActivity('slack:v1:T:C:1', { now: '2026-06-23T10:00:00.000Z' });
    store.recordActivity('slack:v1:T:C:2', { now: '2026-06-23T11:00:00.000Z' });
    store.recordActivity('slack:v1:T:C:1', { now: '2026-06-23T12:00:00.000Z' }); // bumps #1 ahead
    const { threads } = store.listThreads();
    expect(threads.map((t) => t.instanceId)).toEqual([
      'slack:v1:T:C:1',
      'slack:v1:T:C:2',
    ]);
    // Blob-free: the row shape is only grouping metadata (no transcript content).
    expect(Object.keys(threads[0]!).sort()).toEqual(
      [
        'channel',
        'createdAt',
        'instanceId',
        'lastActivityAt',
        'messageCount',
        'meta',
        'repo',
        'title',
      ].sort(),
    );
  });

  it('paginates via an opaque cursor', () => {
    for (let i = 0; i < 5; i++) {
      store.recordActivity(`slack:v1:T:C:${i}`, {
        now: `2026-06-23T10:0${i}:00.000Z`,
      });
    }
    const first = store.listThreads({ limit: 2 });
    expect(first.threads).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = store.listThreads({ limit: 2, cursor: first.nextCursor! });
    expect(second.threads).toHaveLength(2);
    // No overlap between pages.
    const ids = new Set(first.threads.map((t) => t.instanceId));
    expect(second.threads.every((t) => !ids.has(t.instanceId))).toBe(true);
  });

  it('returns an empty page on a fresh db', () => {
    expect(store.listThreads()).toEqual({ threads: [], nextCursor: null });
  });
});

describe('ThreadsStore migration-safety', () => {
  it('is a no-op CREATE IF NOT EXISTS on a fresh db', () => {
    const s2 = new ThreadsStore(join(dir, 't2.db'));
    expect(() => s2.recordActivity(SLACK_KEY)).not.toThrow();
    s2.close();
  });

  it('reopens an existing db without dropping data (additive schema)', () => {
    store.recordActivity(SLACK_KEY, { now: '2026-06-23T10:00:00.000Z' });
    store.close();
    const reopened = new ThreadsStore(join(dir, 't.db'));
    expect(reopened.getThread(SLACK_KEY)!.messageCount).toBe(1);
    reopened.close();
  });

  it('tolerates an OLDER db missing newer columns (forward migration)', () => {
    // Simulate a pre-existing table created by an earlier build (no `title`).
    const raw = new DatabaseSync(join(dir, 'old.db'));
    raw.exec(`
      CREATE TABLE messaging_threads (
        instance_id      TEXT PRIMARY KEY,
        channel          TEXT NOT NULL DEFAULT '',
        repo             TEXT,
        meta             TEXT,
        created_at       TEXT NOT NULL DEFAULT '',
        last_activity_at TEXT NOT NULL DEFAULT '',
        message_count    INTEGER NOT NULL DEFAULT 0
      );
    `);
    raw.close();
    // Opening with the current store must not throw (CREATE IF NOT EXISTS skips an
    // existing table; we never narrow columns) and reads/writes still work on the
    // pre-existing columns.
    const s = new ThreadsStore(join(dir, 'old.db'));
    expect(() => s.recordActivity(SLACK_KEY)).not.toThrow();
    expect(s.getThread(SLACK_KEY)!.messageCount).toBe(1);
    s.close();
  });
});
