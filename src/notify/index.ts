/**
 * Shared progress-notifier module (Phase 8 egress). Renders workflow progress
 * as a single in-place "task list" surface (one GitHub comment + one Slack
 * message edited as phases run) instead of a comment per phase. The content
 * model and renderer are platform-agnostic; GitHub/Slack live behind transports.
 */
export type {
  StepStatus,
  ProgressStep,
  ProgressModel,
  ProgressReporter,
  NotifierTransport,
  NotifierState,
} from "./types.ts";
export { ProgressNotifier } from "./notifier.ts";
export {
  NULL_REPORTER,
  readNotifierState,
  notifierStatePatch,
  NOTIFIER_SCRATCH_KEYS,
} from "./state.ts";
export { renderProgress, collapseDetail, STATUS_EMOJI } from "./render.ts";
export { markdownToSlackMrkdwn } from "./mrkdwn.ts";
export {
  stepsFromPhases,
  setStep,
  upsertBefore,
  buildProgressModel,
  runDashboardUrl,
} from "./model.ts";
export type { ProgressModelInput, PhaseSpec } from "./model.ts";
export { GitHubTransport } from "./transports/github.ts";
export type { GitHubTransportDeps } from "./transports/github.ts";
export { SlackTransport } from "./transports/slack.ts";
export type { SlackTransportDeps } from "./transports/slack.ts";
