import { ThreadsStore, type ThreadChannel, type ThreadMeta } from '../threads-store.ts';

// ── Last Light on Flue · messaging-thread recorder seam (Phase 7 · final) ─────
//
// The shared seam that records a chat thread the FIRST time a message routes to
// the chat agent, and bumps its activity on every subsequent turn. The channel's
// chat-dispatch path (`dispatchChat(id, input)` — `id` IS the conversationKey =
// the chat-agent instanceId) calls `recordThreadActivity(id, { channel, meta })`
// right before/after dispatching, so the dashboard can LIST chat threads (which
// otherwise only render by id, never grouped — the `agentIds:[]` stub) alongside
// workflow runs. Two HARD properties (build-loop constraints), mirroring the
// stats recorder (`record-execution.ts`):
//
//   • NON-FATAL: a thread-write failure NEVER breaks the channel — every write is
//     wrapped + swallowed (logged, not thrown). The chat dispatch proceeds
//     regardless of whether recording succeeded.
//   • TEST-INERT: recording is a NO-OP unless a recorder is actively wired. The
//     default recorder is null UNDER VITEST (so a channel test never writes a real
//     `messaging_threads` row), and tests that DO assert recording inject a fake
//     via `setThreadRecorder`. In production the default lazily opens the on-disk
//     threads-store.

/** Identity of a thread activity event (the conversationKey + derived coords). */
export interface ThreadActivity {
  /** instanceId == conversationKey == the chat-agent dispatch id. */
  instanceId: string;
  /** Origin channel (derived from the key when omitted). */
  channel?: ThreadChannel;
  /** Parsed channel/thread coordinates (derived from the key when omitted). */
  meta?: ThreadMeta;
  /** Optional human title for the thread row. */
  title?: string;
}

/** The injectable sink: receives a thread activity event. */
export interface ThreadRecorder {
  record(activity: ThreadActivity): void;
}

const defaultStorePath = () =>
  process.env.LASTLIGHT_THREADS_STORE ?? './.data/threads-store.db';

// The active recorder. `undefined` = not yet resolved; `null` = explicitly off
// (test-inert). A test injects a fake via setThreadRecorder; production resolves
// the lazy on-disk recorder on first use.
let activeRecorder: ThreadRecorder | null | undefined;

/**
 * Inject the recorder seam. Tests pass a fake (assert the recorded thread) or
 * `null` (force inert). Returns the previous recorder so a test can restore it.
 */
export function setThreadRecorder(
  rec: ThreadRecorder | null,
): ThreadRecorder | null | undefined {
  const prev = activeRecorder;
  activeRecorder = rec;
  return prev;
}

/** Lazily build the production recorder (opens the on-disk threads-store per
 *  write, cheap sqlite; chat dispatch is low-frequency). Inert under VITEST. */
function resolveRecorder(): ThreadRecorder | null {
  if (activeRecorder !== undefined) return activeRecorder;
  // TEST-INERT: never write a real thread row during a test unless one was
  // explicitly injected above (which sets activeRecorder, short-circuiting here).
  if (process.env.VITEST) {
    activeRecorder = null;
    return null;
  }
  activeRecorder = {
    record(activity: ThreadActivity): void {
      const store = new ThreadsStore(defaultStorePath());
      try {
        store.recordActivity(activity.instanceId, {
          channel: activity.channel,
          meta: activity.meta,
          title: activity.title,
        });
      } finally {
        store.close();
      }
    },
  };
  return activeRecorder;
}

/**
 * Record chat-thread activity — NON-FATAL + TEST-INERT (see header). Never
 * throws; a write error is logged + swallowed so a thread-grouping failure can't
 * break the channel. A no-op when no recorder is wired (the inert default under
 * tests). `channel`/`meta` are derived from the key by the store when omitted.
 */
export function recordThreadActivity(
  instanceId: string,
  opts: { channel?: ThreadChannel; meta?: ThreadMeta; title?: string } = {},
): void {
  try {
    const recorder = resolveRecorder();
    if (!recorder) return;
    recorder.record({ instanceId, ...opts });
  } catch (err) {
    // NON-FATAL: a thread-write failure must never break the channel.
    console.error('[threads] recordThreadActivity failed (non-fatal):', err);
  }
}
