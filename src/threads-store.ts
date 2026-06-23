import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// ── Last Light on Flue · messaging-thread grouping (Phase 7 · final slice) ────
//
// The application-owned `messaging_threads` table (spec/10 / design/phase-7
// §"messaging-thread grouping for the chat view (conversationKey ↔ agent
// instanceId)"). A chat thread is a durable chat-agent instance whose `instanceId`
// IS the channel `conversationKey` (the dispatch `id` — flue-reference Q7.2). The
// transcript itself lives in Flue's `EventStreamStore` (`agentStreamPath('chat',
// instanceId)`), so this table carries NO message blobs — only the GROUPING /
// listing metadata the dashboard needs to LIST chat sessions alongside workflow
// runs (channel, repo, last activity, message count). It mirrors the reference's
// `messaging_sessions` row (lastlight/src/connectors/messaging/session-manager.ts)
// minus the Agent-SDK columns Flue makes redundant (`agent_session_id` → the Flue
// agent stream; the message bodies → `messaging_messages` → EventStreamStore).
//
// Raw sqlite, app-owned, mirroring build-run-store.ts / stats-store.ts:
//   • additive-only schema (CREATE IF NOT EXISTS), migration-safe on a fresh OR an
//     older db; blob-free; WAL so the dashboard poll never blocks the writer;
//   • UPSERT on first sight (insert), bump last_activity/count on subsequent —
//     keyed on the `instance_id` (= conversationKey) PRIMARY KEY.

/** A messaging platform a chat thread originated from. */
export type ThreadChannel = 'slack' | 'github';

/** Thread metadata parsed from the conversationKey (channel/repo/thread coords). */
export interface ThreadMeta {
  /** Slack: the team id. GitHub: undefined. */
  teamId?: string;
  /** Slack: the channel id. GitHub: undefined. */
  channelId?: string;
  /** Slack: the thread ts. GitHub: undefined. */
  threadTs?: string;
  /** owner/repo full name when the key encodes one (github, or a repo-bound chat). */
  repo?: string;
  /** GitHub: the issue/PR number the thread is bound to. */
  issueNumber?: number;
}

/** A de-serialized thread row (the list/detail shape; blob-free). */
export interface MessagingThread {
  /** instanceId == conversationKey == the chat-agent dispatch id (the PK). */
  instanceId: string;
  channel: ThreadChannel;
  repo: string | null;
  /** Parsed channel/thread coordinates (JSON column). */
  meta: ThreadMeta;
  title: string | null;
  createdAt: string;
  lastActivityAt: string;
  messageCount: number;
}

interface ThreadSqlRow {
  instance_id: string;
  channel: string;
  repo: string | null;
  meta: string | null;
  title: string | null;
  created_at: string;
  last_activity_at: string;
  message_count: number;
}

/**
 * Parse a channel `conversationKey` into `{ channel, meta }`. Recognises the two
 * canonical key shapes the channels emit (verified against the installed
 * `@flue/slack` / `@flue/github` `conversationKey(ref)`):
 *   - Slack:  `slack:v1:<teamId>:<channelId>:<threadTs>`
 *   - GitHub: `github:v1:owner:<owner>:repo:<repo>:issue:<N>`
 * A best-effort fallback (an `owner/repo` slug → repo) keeps an unrecognised key
 * from being dropped; the channel still defaults to slack (the chat-dispatch path
 * is Slack-only today). NEVER throws — recording must be non-fatal.
 */
export function parseThreadKey(key: string): { channel: ThreadChannel; meta: ThreadMeta } {
  const slack = /^slack:v1:([^:]+):([^:]+):([^:]+)$/.exec(key);
  if (slack) {
    return {
      channel: 'slack',
      meta: {
        teamId: safeDecode(slack[1]),
        channelId: safeDecode(slack[2]),
        threadTs: safeDecode(slack[3]),
      },
    };
  }
  const gh = /^github:v1:owner:([^:]+):repo:([^:]+):issue:([1-9]\d*)$/.exec(key);
  if (gh) {
    const owner = safeDecode(gh[1]);
    const repo = safeDecode(gh[2]);
    return {
      channel: 'github',
      meta: { repo: `${owner}/${repo}`, issueNumber: Number(gh[3]) },
    };
  }
  // Fallback: pull a bare owner/repo slug if present (a repo-bound chat key), and
  // pick the channel from a leading scheme token. Default channel = slack.
  const channel: ThreadChannel = key.startsWith('github') ? 'github' : 'slack';
  const slug = /(?:^|[:|/\s])([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)/.exec(key);
  const repo = slug ? `${slug[1]}/${slug[2]!.replace(/#.*$/, '')}` : undefined;
  return { channel, meta: repo ? { repo } : {} };
}

function safeDecode(s: string | undefined): string | undefined {
  if (s == null) return undefined;
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export class ThreadsStore {
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    // WAL keeps the dashboard 5s poll (reader) from blocking the writer.
    this.db.exec('PRAGMA journal_mode = WAL;');
    // Additive-only schema (spec/10): never drop/narrow a column. Blob-free —
    // the message bodies live in Flue's EventStreamStore, not here.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messaging_threads (
        instance_id      TEXT PRIMARY KEY,
        channel          TEXT NOT NULL DEFAULT '',
        repo             TEXT,
        meta             TEXT,
        title            TEXT,
        created_at       TEXT NOT NULL DEFAULT '',
        last_activity_at TEXT NOT NULL DEFAULT '',
        message_count    INTEGER NOT NULL DEFAULT 0
      );
    `);
    // Forward-migrate an OLDER table that predates a column (spec/10 "idempotent
    // ALTER"): CREATE IF NOT EXISTS leaves an existing table untouched, so add any
    // newer columns additively. Guarded against re-run (skip when already present)
    // so it's a no-op on a fresh or current db.
    this.ensureColumn('meta', 'TEXT');
    this.ensureColumn('title', 'TEXT');
    // Indexed by the list axes (channel filter / recency ordering).
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS idx_threads_channel ON messaging_threads(channel);',
    );
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS idx_threads_activity ON messaging_threads(last_activity_at);',
    );
  }

  /** Additively add a column if the (possibly older) table lacks it. Idempotent. */
  private ensureColumn(name: string, type: string): void {
    const cols = this.db
      .prepare('PRAGMA table_info(messaging_threads)')
      .all() as unknown as Array<{ name: string }>;
    if (!cols.some((c) => c.name === name)) {
      this.db.exec(`ALTER TABLE messaging_threads ADD COLUMN ${name} ${type};`);
    }
  }

  /**
   * Record activity on a thread. UPSERT: INSERT on first sight (created_at =
   * last_activity_at = now, message_count = 1), bump last_activity_at +
   * message_count on every subsequent sighting. `channel`/`meta` are derived from
   * the key when not supplied. Idempotent on schema; never narrows a row.
   */
  recordActivity(
    instanceId: string,
    opts: { channel?: ThreadChannel; meta?: ThreadMeta; title?: string; now?: string } = {},
  ): void {
    const parsed = parseThreadKey(instanceId);
    const channel = opts.channel ?? parsed.channel;
    const meta = opts.meta ?? parsed.meta;
    const repo = meta.repo ?? null;
    const now = opts.now ?? new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO messaging_threads
           (instance_id, channel, repo, meta, title, created_at, last_activity_at, message_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT(instance_id) DO UPDATE SET
           last_activity_at = excluded.last_activity_at,
           message_count    = message_count + 1,
           -- backfill channel/repo/meta/title only if they were never set.
           channel = CASE WHEN messaging_threads.channel = '' THEN excluded.channel ELSE messaging_threads.channel END,
           repo    = COALESCE(messaging_threads.repo, excluded.repo),
           meta    = COALESCE(messaging_threads.meta, excluded.meta),
           title   = COALESCE(messaging_threads.title, excluded.title)`,
      )
      .run(instanceId, channel, repo, JSON.stringify(meta), opts.title ?? null, now, now);
  }

  /** Read one thread by instanceId (= conversationKey), or null. */
  getThread(instanceId: string): MessagingThread | null {
    const row = this.db
      .prepare('SELECT * FROM messaging_threads WHERE instance_id = ?')
      .get(instanceId) as unknown as ThreadSqlRow | undefined;
    return row ? this.hydrate(row) : null;
  }

  /**
   * List threads newest-activity-first, blob-free. `cursor` is an opaque
   * `last_activity_at|instance_id` pair (keyset pagination); `limit` defaults to
   * 200 (capped 1000).
   */
  listThreads(opts: { limit?: number; cursor?: string } = {}): {
    threads: MessagingThread[];
    nextCursor: string | null;
  } {
    const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
    const cursor = decodeCursor(opts.cursor);
    let rows: ThreadSqlRow[];
    if (cursor) {
      rows = this.db
        .prepare(
          `SELECT * FROM messaging_threads
             WHERE (last_activity_at < ?)
                OR (last_activity_at = ? AND instance_id < ?)
             ORDER BY last_activity_at DESC, instance_id DESC
             LIMIT ?`,
        )
        .all(cursor.lastActivityAt, cursor.lastActivityAt, cursor.instanceId, limit + 1) as unknown as ThreadSqlRow[];
    } else {
      rows = this.db
        .prepare(
          `SELECT * FROM messaging_threads
             ORDER BY last_activity_at DESC, instance_id DESC
             LIMIT ?`,
        )
        .all(limit + 1) as unknown as ThreadSqlRow[];
    }
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last ? encodeCursor(last.last_activity_at, last.instance_id) : null;
    return { threads: page.map((r) => this.hydrate(r)), nextCursor };
  }

  private hydrate(r: ThreadSqlRow): MessagingThread {
    let meta: ThreadMeta = {};
    if (r.meta) {
      try {
        meta = JSON.parse(r.meta) as ThreadMeta;
      } catch {
        meta = {};
      }
    }
    return {
      instanceId: r.instance_id,
      channel: (r.channel || 'slack') as ThreadChannel,
      repo: r.repo,
      meta,
      title: r.title,
      createdAt: r.created_at,
      lastActivityAt: r.last_activity_at,
      messageCount: r.message_count,
    };
  }

  close(): void {
    if (this.closed) return; // idempotent — double-close is a no-op
    this.closed = true;
    this.db.close();
  }
}

function encodeCursor(lastActivityAt: string, instanceId: string): string {
  return Buffer.from(`${lastActivityAt} ${instanceId}`, 'utf8').toString('base64url');
}

function decodeCursor(
  cursor: string | undefined,
): { lastActivityAt: string; instanceId: string } | null {
  if (!cursor) return null;
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const i = raw.indexOf(' ');
    if (i < 0) return null;
    return { lastActivityAt: raw.slice(0, i), instanceId: raw.slice(i + 1) };
  } catch {
    return null;
  }
}
