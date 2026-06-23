import { StatsStore, type ExecutionRow } from '../stats-store.ts';

// ── Last Light on Flue · execution-usage recorder (Phase 7 · slice 2) ─────────
//
// The shared seam that turns a `session.prompt(...)` response into a per-phase
// stats row (`src/stats-store.ts` `executions`). A workflow phase calls
// `runPhasePrompt(session, prompt, { runId, workflow, phase })` instead of
// `session.prompt(prompt)` (or, if it already holds the response, calls
// `recordExecution(rec, response)` directly). Two HARD properties (build-loop
// constraints):
//
//   • NON-FATAL: a stats-write failure NEVER breaks a run — every write is
//     wrapped + swallowed (logged, not thrown). The prompt result is returned
//     regardless of whether recording succeeded.
//   • TEST-INERT: recording is a NO-OP unless a recorder is actively wired. The
//     default recorder is null UNDER VITEST (so an unrelated workflow test never
//     writes a real `executions` row), and tests that DO assert recording inject
//     a fake via `setExecutionRecorder`. In production the default lazily opens
//     the on-disk stats-store.

/** The injectable sink: receives a fully-formed `executions` row. */
export interface ExecutionRecorder {
  record(row: ExecutionRow): void;
}

/** Identity of the prompt call being recorded (everything except usage/model). */
export interface PhaseRecordCtx {
  /** App runId (the build/explore run id) or chat thread key. */
  runId: string;
  /** Workflow name (`build`, `pr-review`, …). */
  workflow: string;
  /** Phase / session name within the workflow. */
  phase: string;
}

/** The usage-bearing shape of a `session.prompt` response (flue-reference §0). */
export interface PromptUsageResponse {
  text: string;
  usage?: {
    input?: number;
    output?: number;
    totalTokens?: number;
    cost?: { total?: number };
  };
  model?: { provider?: string; id?: string };
}

const defaultStorePath = () =>
  process.env.LASTLIGHT_STATS_STORE ?? './.data/stats-store.db';

// The active recorder. `undefined` = not yet resolved; `null` = explicitly off
// (test-inert). A test injects a fake via setExecutionRecorder; production
// resolves the lazy on-disk recorder on first use.
let activeRecorder: ExecutionRecorder | null | undefined;

/**
 * Inject the recorder seam. Tests pass a fake (assert the recorded row) or
 * `null` (force inert). Returns the previous recorder so a test can restore it.
 */
export function setExecutionRecorder(
  rec: ExecutionRecorder | null,
): ExecutionRecorder | null | undefined {
  const prev = activeRecorder;
  activeRecorder = rec;
  return prev;
}

/** Lazily build the production recorder (opens the on-disk stats-store per write,
 *  cheap sqlite; the phase paths are low-frequency). Inert under VITEST. */
function resolveRecorder(): ExecutionRecorder | null {
  if (activeRecorder !== undefined) return activeRecorder;
  // TEST-INERT: never write a real stats row during a test unless one was
  // explicitly injected above (which sets activeRecorder, short-circuiting here).
  if (process.env.VITEST) {
    activeRecorder = null;
    return null;
  }
  activeRecorder = {
    record(row: ExecutionRow): void {
      const store = new StatsStore(defaultStorePath());
      try {
        store.record(row);
      } finally {
        store.close();
      }
    },
  };
  return activeRecorder;
}

/** Map a prompt response's usage/model + the phase identity → an `ExecutionRow`. */
export function toExecutionRow(
  rec: PhaseRecordCtx,
  res: PromptUsageResponse,
): ExecutionRow {
  const u = res.usage ?? {};
  const model = res.model
    ? [res.model.provider, res.model.id].filter(Boolean).join('/')
    : '';
  return {
    runId: rec.runId,
    workflow: rec.workflow,
    phase: rec.phase,
    model,
    inputTokens: u.input ?? 0,
    outputTokens: u.output ?? 0,
    totalTokens: u.totalTokens ?? (u.input ?? 0) + (u.output ?? 0),
    costTotal: u.cost?.total ?? 0,
  };
}

/**
 * Record a phase's prompt usage — NON-FATAL + TEST-INERT (see header). Never
 * throws; a write error is logged + swallowed so a stats failure can't break a
 * run. A no-op when no recorder is wired (the inert default under tests).
 */
export function recordExecution(rec: PhaseRecordCtx, res: PromptUsageResponse): void {
  try {
    const recorder = resolveRecorder();
    if (!recorder) return;
    recorder.record(toExecutionRow(rec, res));
  } catch (err) {
    // NON-FATAL: a stats-write failure must never break a run.
    console.error('[stats] recordExecution failed (non-fatal):', err);
  }
}

/**
 * The shared phase-prompt seam: run `session.prompt(prompt, opts?)`, record its
 * usage (non-fatal), and return the full response. Workflow phases adopt this in
 * place of a bare `session.prompt` to get cost/token stats for free.
 */
export async function runPhasePrompt<T extends PromptUsageResponse>(
  session: { prompt(text: string, opts?: unknown): Promise<T> },
  prompt: string,
  rec: PhaseRecordCtx,
  opts?: unknown,
): Promise<T> {
  const res = await session.prompt(prompt, opts);
  recordExecution(rec, res);
  return res;
}
