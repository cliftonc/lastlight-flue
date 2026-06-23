// ── Last Light on Flue · admin chat-session seam (Phase 7 · SSE slice) ────────
//
// The CHAT-SESSION surface backing `/admin/api/chat-sessions*` — the in-process
// chat skill's threads. It is the chat-only counterpart to `SessionReader`
// (src/admin/session-reader.ts): same blob-free LIST + transcript-READ shape,
// but the LIST comes from the app-owned `messaging_threads` table (ThreadsStore,
// projected via `toChatSessionMeta`) and every transcript read targets the
// chat-agent event stream (`agentStreamPath('chat', instanceId)`), NOT a
// workflow-run stream.
//
// Why a SEPARATE seam rather than reusing `SessionReader`: the reference mounts
// the SAME five session endpoints under two prefixes (`/sessions` +
// `/chat-sessions`) over two different `SessionSource`s. Here the two sources
// differ in their LIST origin (runs+threads merged vs. threads only) and their
// default transcript `kind` (run vs. agent). Modelling chat as its own reader
// keeps the run reader untouched (HARD CONSTRAINT: do not break it) and lets the
// routes pick the right transcript path per surface. Both readers expose the
// identical method shape so the SSE route helpers (session-stream.ts) work
// against either via a thin `SessionSource` structural type.

import {
  toChatSessionMeta,
  type SessionMeta,
  type SessionReader,
  type ThreadLister,
  type TranscriptReadResult,
  streamPathForAgent,
} from './session-reader.ts';

/**
 * The minimal Flue `EventStreamStore` surface the chat reader needs — only the
 * read + existence probe over the chat-agent stream path. Mirrors the shape
 * `createDefaultSessionReader` connects to (src/db.ts adapter), so the default
 * export can share the same `connect()`.
 */
export interface ChatEventStreamStoreLike {
  readEvents(
    path: string,
    opts?: { offset?: string; limit?: number },
  ): Promise<{
    events: Array<{ data: unknown; offset: string }>;
    nextOffset: string;
    upToDate: boolean;
  }>;
  getStreamMeta(path: string): Promise<{ nextOffset: string } | null>;
}

/**
 * The chat-session data seam the `/admin/api/chat-sessions*` routes mount over.
 * Structurally a `SessionReader` (so the SSE route helpers are reader-agnostic),
 * but its `listSessions` enumerates CHAT THREADS and `readTranscript` always
 * reads the chat-agent stream. Injected so the routes test OFFLINE with a fake;
 * the default wires the real ThreadsStore + Flue `EventStreamStore`.
 */
export type ChatSessionReader = SessionReader;

interface ChatStoresLike {
  eventStreamStore: ChatEventStreamStoreLike;
}

export interface DefaultChatSessionReaderOptions {
  /**
   * The app-owned chat-thread grouping source (`messaging_threads`). Drives the
   * blob-free chat-session LIST. A function form opens the on-disk store lazily
   * (so tests run offline); a missing/failing source degrades to an empty list,
   * never an error.
   */
  threadLister?: ThreadLister | (() => ThreadLister);
  /** Override the store-connector (tests). Default: connect `src/db.ts`. */
  connect?: () => Promise<ChatStoresLike>;
  /** Agent name for the chat-agent stream path. Defaults to `'chat'`. */
  agentName?: string;
}

/**
 * The production chat-session reader. Lists chat threads from the ThreadsStore
 * and reads each thread's transcript from the chat-agent event stream. Mirrors
 * `createDefaultSessionReader`'s lazy-connect + non-fatal thread-list pattern.
 */
export function createDefaultChatSessionReader(
  opts: DefaultChatSessionReaderOptions = {},
): ChatSessionReader {
  const agentName = opts.agentName ?? 'chat';
  let storesPromise: Promise<ChatStoresLike> | null = null;

  const resolveThreadLister = (): ThreadLister | null => {
    const tl = opts.threadLister;
    if (!tl) return null;
    return typeof tl === 'function' ? tl() : tl;
  };

  const listChat = (listOpts?: { limit?: number; cursor?: string }): {
    sessions: SessionMeta[];
    nextCursor: string | null;
  } => {
    try {
      const lister = resolveThreadLister();
      if (!lister) return { sessions: [], nextCursor: null };
      const res = lister.listThreads({ limit: listOpts?.limit, cursor: listOpts?.cursor });
      const sessions = res.threads
        .map(toChatSessionMeta)
        .sort(
          (a, b) =>
            (b.last_message_at ?? b.started_at) - (a.last_message_at ?? a.started_at),
        );
      return { sessions, nextCursor: res.nextCursor };
    } catch (err) {
      // NON-FATAL: a thread-list failure degrades to an empty list, never errors.
      console.error('[chat-sessions] thread list failed (non-fatal):', err);
      return { sessions: [], nextCursor: null };
    }
  };

  const connect = async (): Promise<ChatStoresLike> => {
    if (!storesPromise) {
      storesPromise = (
        opts.connect
          ? Promise.resolve(opts.connect())
          : import('../db.ts').then((m) => {
              const adapter = m.default as {
                connect: () => ChatStoresLike | Promise<ChatStoresLike>;
              };
              return adapter.connect();
            })
      ).catch((err) => {
        storesPromise = null;
        throw err;
      });
    }
    return storesPromise;
  };

  return {
    async listSessions(listOpts) {
      const { sessions, nextCursor } = listChat(listOpts);
      return { sessions, nextCursor };
    },
    async exists(id) {
      // A chat session exists when its chat-agent stream has any events OR the
      // thread is known to the lister. Probe the stream first (authoritative for
      // a transcript read); fall back to the thread list.
      try {
        const stores = await connect();
        const meta = await stores.eventStreamStore.getStreamMeta(
          streamPathForAgent(agentName, id),
        );
        if (meta) return true;
      } catch {
        // connect/probe failure → fall through to the thread-list check.
      }
      const lister = resolveThreadLister();
      if (!lister) return false;
      try {
        const res = lister.listThreads({ limit: 1000 });
        return res.threads.some((t) => t.instanceId === id);
      } catch {
        return false;
      }
    },
    async readTranscript(id, readOpts): Promise<TranscriptReadResult> {
      const stores = await connect();
      // Chat transcripts ALWAYS read the chat-agent stream — the `kind` opt is
      // accepted for structural compatibility but the path is fixed to agent.
      const path = streamPathForAgent(readOpts?.agentName ?? agentName, id);
      const res = await stores.eventStreamStore.readEvents(path, {
        offset: readOpts?.offset ?? '-1',
        limit: readOpts?.limit,
      });
      return {
        events: res.events,
        nextOffset: res.nextOffset,
        upToDate: res.upToDate,
      };
    },
  };
}
