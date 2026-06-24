/**
 * Persisting {@link NotifierState} (the in-place-update handles) in the
 * build/explore run-store `scratch` so a RESUMED run re-attaches to the SAME
 * GitHub comment / Slack message instead of creating a duplicate surface.
 *
 * `scratch` is a flat `Record<string,string>` of POINTERS (spec/10 split rule),
 * so the handles live under stable `notifier:*` keys — mirroring how
 * `build-phases.ts` records gate-comment ids (`gateComment:<gate>`).
 *
 * Also exports {@link NULL_REPORTER}: a no-op {@link ProgressReporter} used when
 * no transports apply (a CLI run, or a missing token) — the egress notifier is
 * strictly best-effort and must NEVER break the durable control-flow spine.
 */
import type { NotifierState, ProgressReporter } from "./types.ts";

/** The `scratch` keys the notifier handles persist under (one per `NotifierState` field). */
export const NOTIFIER_SCRATCH_KEYS = {
  githubCommentId: "notifier:githubCommentId",
  slackTs: "notifier:slackTs",
  slackChannel: "notifier:slackChannel",
  slackThread: "notifier:slackThread",
} as const;

/** Read the persisted in-place-update handles out of a run record's `scratch`. */
export function readNotifierState(scratch: Record<string, string>): NotifierState {
  const state: NotifierState = {};
  const id = scratch[NOTIFIER_SCRATCH_KEYS.githubCommentId];
  if (id !== undefined && /^\d+$/.test(id)) state.githubCommentId = Number(id);
  const ts = scratch[NOTIFIER_SCRATCH_KEYS.slackTs];
  if (ts) state.slackTs = ts;
  const channel = scratch[NOTIFIER_SCRATCH_KEYS.slackChannel];
  if (channel) state.slackChannel = channel;
  const thread = scratch[NOTIFIER_SCRATCH_KEYS.slackThread];
  if (thread) state.slackThread = thread;
  return state;
}

/** Serialize a `NotifierState` patch into the `scratch` entries to merge (string values only). */
export function notifierStatePatch(patch: NotifierState): Record<string, string> {
  const out: Record<string, string> = {};
  if (patch.githubCommentId !== undefined) {
    out[NOTIFIER_SCRATCH_KEYS.githubCommentId] = String(patch.githubCommentId);
  }
  if (patch.slackTs !== undefined) out[NOTIFIER_SCRATCH_KEYS.slackTs] = patch.slackTs;
  if (patch.slackChannel !== undefined) out[NOTIFIER_SCRATCH_KEYS.slackChannel] = patch.slackChannel;
  if (patch.slackThread !== undefined) out[NOTIFIER_SCRATCH_KEYS.slackThread] = patch.slackThread;
  return out;
}

/** A no-op reporter — every method resolves immediately. Used when no surface applies. */
export const NULL_REPORTER: ProgressReporter = {
  async start() {},
  async step() {},
  async insertStep() {},
  async note() {},
  async noteTerminal() {},
};
