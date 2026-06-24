/**
 * The `explore` workflow's phase bodies + the `ExploreDeps` seam (mirrors
 * src/agent-lib/build-phases.ts). The workflow control flow (src/workflows/explore.ts)
 * drives these through the seam; the default factory wires the real agent sessions,
 * the sandbox, the deterministic reply-gate post, and the deterministic publish. Tests
 * pass fakes so the whole loop runs offline.
 *
 * Phase bodies:
 *   read        — explorer agent (web tools + sandbox): clone, read, write context doc.
 *   ask:<round> — explorer agent (web tools): pose ONE clarifying question / READY.
 *   synthesize  — explorer agent (web tools + sandbox, architect model): write the spec.
 *   publish     — DETERMINISTIC (no agent): comment on the issue / open a new issue.
 *
 * SECURITY: the web tools are bound ONLY to the research agents here (gating). The
 * reply-gate question post + the spec publish are deterministic (bound ref + token).
 * All user-authored text is UNTRUSTED-wrapped by the prompt renderers.
 */
import {
  defineAgent,
  type FlueHarness,
  type FlueLogger,
  type ToolDefinition,
} from "@flue/runtime";
import * as v from "valibot";
import { Octokit } from "octokit";
import { GITHUB_PERMISSION_PROFILES, type GitAccessProfile } from "../engine/profiles.ts";
import { configureGitAuth } from "../engine/git-auth.ts";
import { loadConfig } from "../config.ts";
import { dockerSandbox } from "../sandboxes/docker.ts";
import { cloneRepoIntoHarness, BUILD_WORKSPACE } from "./build-sandbox.ts";
import {
  exploreProfile,
  synthesizeProfile,
  EXPLORE_PROFILE_NAME,
  SYNTHESIZE_PROFILE_NAME,
  EXPLORE_CWD,
  type ResearchPhase,
} from "./explore.ts";
import {
  renderExploreReadPrompt,
  renderExploreAskPrompt,
  renderExploreSynthesizePrompt,
} from "./explore-prompts.ts";
import { webTools } from "../tools/web.ts";
import { githubReadTools, type RepoRef } from "../tools/github-read.ts";
import { runPhasePrompt } from "./record-execution.ts";
import { ProgressNotifier } from "../notify/notifier.ts";
import { GitHubTransport } from "../notify/transports/github.ts";
import { SlackTransport } from "../notify/transports/slack.ts";
import { NULL_REPORTER, readNotifierState } from "../notify/state.ts";
import { runDashboardUrl } from "../notify/model.ts";
import type {
  NotifierState,
  NotifierTransport,
  ProgressReporter,
} from "../notify/types.ts";
import { buildExploreModel } from "./explore-notify.ts";
import { slackPosterFromConfig, parseSlackConversationKey } from "../slack-client.ts";
import { postReplyGateQuestion, type ExploreReplyRef } from "../explore-github-post.ts";
import {
  publishSpecDeterministically,
  type PublishRef,
} from "../explore-publish.ts";
import type { ExploreRun } from "../explore-run-store.ts";

/** The `issues-write` profile explore runs under (the only writes are the comment / issue). */
export const EXPLORE_PROFILE: GitAccessProfile = "issues-write";

/** The `explore` workflow input — validated at admission (`defineWorkflow({ input })`). */
export const ExploreInputSchema = v.object({
  /** The APP run id (the reply contract — stable across re-invokes). */
  runId: v.string(),
  owner: v.string(),
  repo: v.string(),
  /** The originating issue number; 0/absent → a Slack-originated run (publish a new issue). */
  issue: v.optional(v.number()),
  /** A stable trigger id for non-GitHub origins (e.g. `slack:team:chan:thread`). */
  triggerId: v.optional(v.string()),
  /**
   * The CHANNEL conversation key this reply gate is parked on — the SAME
   * `conversationKey` a channel computes from an event (Phase 6 gate correlation).
   */
  conversationKey: v.optional(v.string()),
  /** The issue title (untrusted). */
  issueTitle: v.optional(v.string()),
  /** The issue body (untrusted). */
  issueBody: v.optional(v.string()),
  /** The triggering comment / Slack message (untrusted). */
  commentBody: v.optional(v.string()),
  /** Who triggered it (trigger metadata). */
  sender: v.optional(v.string()),
  /** Set on a resumed re-invoke — the parked reply gate (`reply:<round>`). */
  resumedGate: v.optional(v.string()),
  /** Trigger provenance: "webhook" | "cron" | "cli" | "resume" | "boot". */
  triggerType: v.optional(v.string()),
});
export type ExploreInput = v.InferOutput<typeof ExploreInputSchema>;

/**
 * The `explore` COORDINATOR agent (beta.3). It owns a fresh self-terminating Docker
 * sandbox (`dockerSandbox()`) + `cwd: /workspace`; the research phases are SUBAGENT
 * PROFILES (`explore` for read/ask, `synthesize` for the spec) delegated via
 * `session.task({ agent, tools })`. The coordinator declares NO tools — the per-run
 * READ GitHub tools + the GATED web tools are injected per task call (gating stays
 * on the call, never global).
 */
export const exploreAgent = defineAgent(() => ({
  // The coordinator NEVER reasons itself — research phases delegate via
  // `session.task({ agent: <profile> })`, each profile carrying its own model.
  // beta.3 `initializeRootHarness` REQUIRES a model (or `model: false`) on the root
  // agent; omitting it crashes a live `flue run` (same gotcha as `buildAgent`).
  model: false,
  sandbox: dockerSandbox(),
  cwd: EXPLORE_CWD,
  subagents: [exploreProfile, synthesizeProfile],
}));

/**
 * The action-context surface the explore phase bodies + the testable core need: the
 * supplied `harness` (initialized from `exploreAgent`, sandbox attached), the validated
 * `input`, and `log`. Replaces beta.2 `FlueContext<ExploreInput>`.
 */
export interface ExploreRunCtx {
  harness: FlueHarness;
  input: ExploreInput;
  log: FlueLogger;
}

/** The workflow result. */
export type ExploreResult = {
  status: "paused" | "complete" | "failed";
  /** The reply gate the run parked at, when paused. */
  gate?: string;
  /** The published spec URL, when complete. */
  specUrl?: string;
  /** True when publish was skipped because the spec was already published. */
  deduped?: boolean;
  reason?: string;
};

/** A phase's result (the agent's text + any scratch pointer it produced). */
export interface ExplorePhaseResult {
  text: string;
  scratch?: Record<string, string>;
}

/** The reply-gate post result (the posted comment id, for the run record). */
export interface PostedReplyGate {
  commentId?: number;
}

/** The publish result surfaced to the workflow. */
export interface ExplorePublishResult {
  specUrl?: string;
  deduped?: boolean;
}

/**
 * The injectable seam. The default factory wires the real implementations; tests pass
 * fakes so the whole loop runs with no live model / web / GitHub.
 */
export interface ExploreDeps {
  /** Run a research phase (read / ask:<round> / synthesize) → its text. */
  runPhase(
    ctx: ExploreRunCtx,
    run: ExploreRun,
    phase: string,
  ): Promise<ExplorePhaseResult>;
  /** True if the ask phase's output signals READY (enough signal — advance). */
  isReady(text: string): boolean;
  /** Deterministically post the reply-gate question (bound ref + token). */
  postQuestion(
    ctx: ExploreRunCtx,
    run: ExploreRun,
    round: number,
    question: string,
  ): Promise<PostedReplyGate>;
  /** Deterministically publish the synthesized spec (bound ref + token). */
  publish(ctx: ExploreRunCtx, run: ExploreRun): Promise<ExplorePublishResult>;
  /**
   * Phase 8 egress — build, SEED (start), and return the in-place progress
   * reporter for this run: a {@link ProgressReporter} fanning the per-phase
   * checklist to the originating GitHub issue (when issue-scoped) and/or a Slack
   * thread (when the run carries a Slack conversation). `save` persists the
   * in-place-update handles into the run record so a RESUMED run re-attaches to
   * the SAME surface. Optional + best-effort: omitted (tests) → the control flow
   * uses {@link NULL_REPORTER} and the durable spine is unchanged.
   */
  makeReporter?(
    ctx: ExploreRunCtx,
    run: ExploreRun,
    save: (patch: NotifierState) => void,
  ): Promise<ProgressReporter>;
}

/** Detect the READY marker the ask phase emits to end the Socratic loop. */
export function isReadyMarker(text: string): boolean {
  // The ask prompt outputs the literal word READY on its own line when it's done.
  return /(^|\n)\s*READY\s*(\n|$)/.test(text ?? "");
}

/** Mint an issues-write token downscoped to the target repo via the ported git-auth. */
async function mintIssuesWriteToken(input: ExploreInput): Promise<string> {
  const cfg = loadConfig();
  if (!cfg.githubApp) {
    throw new Error(
      "explore: GitHub App not configured (GITHUB_APP_ID / _PRIVATE_KEY_PATH / _INSTALLATION_ID). Cannot mint an issues-write token.",
    );
  }
  const { token } = await configureGitAuth({
    appId: cfg.githubApp.appId,
    privateKeyPath: cfg.githubApp.privateKeyPath,
    installationId: cfg.githubApp.installationId,
    botName: cfg.botLogin.replace(/\[bot\]$/, ""),
    repositories: [input.repo],
    permissions: GITHUB_PERMISSION_PROFILES[EXPLORE_PROFILE],
  });
  return token;
}

/** The build working-branch name explore uses for its sandbox checkout (read-only). */
function exploreBranch(run: ExploreRun): string {
  return `lastlight/explore-${run.issue || run.id.replace(/[^a-z0-9]+/gi, "-")}`;
}

/** The coordinator session name explore phases delegate their subagent tasks from. */
/**
 * Per-phase session name — labels the dashboard pipeline node by phase (`read`,
 * `ask-0`, `synthesize`, …) instead of one opaque shared `explore` session +
 * anonymous `task:explore:<uuid>` children. Colons → dashes so the derived
 * `task:<session>:<uuid>` stays unambiguous. Phases share the coordinator harness
 * (the /workspace checkout persists); only the session thread differs. (Mirrors
 * build's `phaseSession`.)
 */
function explorePhaseSession(phase: string): string {
  return phase.replace(/:/g, "-");
}

/** Harnesses whose /workspace already holds the cloned checkout (clone-once-per-invocation). */
const clonedExploreHarnesses = new WeakSet<FlueHarness>();

/**
 * Clone the repo into the coordinator harness's `/workspace` ONCE per invocation
 * (guarded by harness identity). explore is READ-ONLY — it never pushes — so the
 * tokenized remote is SCRUBBED after clone (`scrubRemote`).
 */
async function ensureExploreCheckout(
  harness: FlueHarness,
  run: ExploreRun,
  token: string,
): Promise<void> {
  if (clonedExploreHarnesses.has(harness)) return;
  await cloneRepoIntoHarness(
    harness,
    { owner: run.owner, repo: run.repo, branch: exploreBranch(run), scrubRemote: true },
    token,
  );
  clonedExploreHarnesses.add(harness);
}

/**
 * Run one research phase: mint → ensure the shared checkout → delegate a SUBAGENT TASK
 * over the right profile (`explore` for read/ask, `synthesize` for the spec). The
 * per-run READ GitHub tools + the GATED web tools are injected for THIS call only
 * (gating stays on the call, never global) — owner/repo/token never model-selectable.
 */
async function runResearchPhase(
  ctx: ExploreRunCtx,
  run: ExploreRun,
  phase: string,
): Promise<ExplorePhaseResult> {
  const input = ctx.input;
  const ref: RepoRef = { owner: run.owner, repo: run.repo };
  const token = await mintIssuesWriteToken(input);
  const octokit = new Octokit({ auth: token });

  const phaseKind: ResearchPhase = phase.startsWith("ask")
    ? "ask"
    : phase === "synthesize"
      ? "synthesize"
      : "read";
  const profileName = phaseKind === "synthesize" ? SYNTHESIZE_PROFILE_NAME : EXPLORE_PROFILE_NAME;

  await ensureExploreCheckout(ctx.harness, run, token);
  const session = await ctx.harness.session(explorePhaseSession(phase));
  const prompt = renderPhasePrompt(input, run, phase);
  const tools: ToolDefinition[] = [...githubReadTools(ref, octokit), ...webTools()];
  const taskRunner = {
    prompt: (text: string, opts?: unknown) =>
      session.task(text, { ...((opts as object | undefined) ?? {}), agent: profileName }),
  };
  const res = await runPhasePrompt(taskRunner as never, prompt, {
    runId: run.id,
    workflow: "explore",
    phase,
  }, { tools });
  return { text: res.text };
}

/** Render the right prompt for a research phase (untrusted-wrapping in the renderers). */
function renderPhasePrompt(input: ExploreInput, run: ExploreRun, phase: string): string {
  const base = {
    owner: run.owner,
    repo: run.repo,
    issueNumber: run.issue || undefined,
    triggerId: run.triggerId,
    sender: input.sender,
  };
  if (phase === "read") {
    return renderExploreReadPrompt({
      ...base,
      issueTitle: input.issueTitle,
      issueBody: input.issueBody,
      commentBody: input.commentBody,
    });
  }
  if (phase === "synthesize") {
    return renderExploreSynthesizePrompt({
      ...base,
      baseline: run.scratch.baseline,
      socraticQa: run.socratic.qa,
    });
  }
  // ask:<round>
  const round = Number(phase.split(":")[1] ?? 0);
  return renderExploreAskPrompt({
    ...base,
    iteration: round + 1,
    maxIterations: 8,
    baseline: run.scratch.baseline,
    socraticQa: run.socratic.qa,
  });
}

/** Deterministically post the reply-gate question to the originating issue. */
async function postQuestionDeterministically(
  ctx: ExploreRunCtx,
  run: ExploreRun,
  _round: number,
  question: string,
): Promise<PostedReplyGate> {
  // GitHub-originated → comment on the issue. Slack-originated → TODO(phase-6/channels)
  // post to the originating thread; until channels land we no-op for Slack origins so
  // the gate still pauses (the run record holds the question for re-publish).
  if (!run.issue || run.issue <= 0) {
    ctx.log.info("explore: reply-gate question (Slack origin) — channel post deferred", {
      runId: run.id,
    });
    return {};
  }
  const token = await mintIssuesWriteToken(ctx.input);
  const octokit = new Octokit({ auth: token });
  const ref: ExploreReplyRef = { owner: run.owner, repo: run.repo, issue_number: run.issue };
  const posted = await postReplyGateQuestion(octokit, ref, question);
  return { commentId: posted.id };
}

/** Deterministically publish the synthesized spec (comment on the issue / new issue). */
async function publishDeterministically(
  ctx: ExploreRunCtx,
  run: ExploreRun,
): Promise<ExplorePublishResult> {
  const cfg = loadConfig();
  const token = await mintIssuesWriteToken(ctx.input);
  const octokit = new Octokit({ auth: token });

  // GitHub-originated → publish to the originating repo/issue. Slack-originated → the
  // configured destination repo (EXPLORE_DEFAULT_REPO), as a new issue.
  let ref: PublishRef;
  if (run.issue && run.issue > 0) {
    ref = { owner: run.owner, repo: run.repo, issue_number: run.issue };
  } else {
    const dest = parseOwnerRepo(cfg.exploreDefaultRepo);
    if (!dest) {
      throw new Error(
        "explore: Slack-originated run has no destination — set EXPLORE_DEFAULT_REPO (owner/name) to publish the spec as a new issue.",
      );
    }
    ref = { owner: dest.owner, repo: dest.repo };
  }
  const result = await publishSpecDeterministically(octokit, ref, run.scratch.spec ?? "", {
    runId: run.id,
    botLogin: cfg.botLogin,
    sourceTrailer:
      run.issue && run.issue > 0 ? undefined : `Originated from a Slack thread (\`${run.triggerId}\`).`,
  });
  return { specUrl: result.html_url, deduped: result.deduped };
}

/** Parse an `owner/name` destination spec. */
function parseOwnerRepo(spec?: string): { owner: string; repo: string } | undefined {
  if (!spec) return undefined;
  const [owner, repo] = spec.split("/");
  if (!owner || !repo) return undefined;
  return { owner, repo };
}

/**
 * Build + seed the live progress reporter for an explore run (Phase 8 egress,
 * best-effort). Posts (and edits in place) ONE GitHub status comment on the
 * originating issue (when issue-scoped) and/or ONE Slack message when the run
 * carries a Slack conversation (`conversationKey` / `triggerId`) + a bot token.
 * The in-place-update handles are read from / persisted to the run record's
 * scratch (via `save`) so a RESUMED run re-attaches. A failed token mint or
 * transport degrades to {@link NULL_REPORTER}, never the durable spine.
 */
export async function makeExploreReporter(
  ctx: ExploreRunCtx,
  run: ExploreRun,
  save: (patch: NotifierState) => void,
): Promise<ProgressReporter> {
  const cfg = loadConfig();
  const transports: NotifierTransport[] = [];
  const state = readNotifierState(run.scratch);

  // GitHub surface — only when the run is issue-scoped (a Slack-origin run has no
  // originating issue until publish opens one). A token-mint failure just drops it.
  if (run.issue > 0) {
    try {
      const token = await mintIssuesWriteToken(ctx.input);
      const octokit = new Octokit({ auth: token });
      transports.push(
        new GitHubTransport({
          octokit,
          owner: run.owner,
          repo: run.repo,
          issueNumber: run.issue,
          commentId: state.githubCommentId,
          save: (commentId) => save({ githubCommentId: commentId }),
        }),
      );
    } catch (err: unknown) {
      ctx.log.warn("explore: notifier GitHub transport unavailable (continuing)", {
        runId: run.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Slack mirror — when the run carries a Slack conversation (the channels pass
  // `triggerId: ev.conversationKey`) AND a bot token is configured.
  const slackKey = run.conversationKey ?? ctx.input.conversationKey ?? run.triggerId;
  const loc = slackKey ? parseSlackConversationKey(slackKey) : undefined;
  const poster = loc ? slackPosterFromConfig() : undefined;
  if (loc && poster) {
    transports.push(
      new SlackTransport({
        poster,
        channel: loc.channelId,
        thread: loc.threadTs,
        ts: state.slackTs,
        save: (ts) => save({ slackTs: ts, slackChannel: loc.channelId, slackThread: loc.threadTs }),
      }),
    );
  }

  if (transports.length === 0) return NULL_REPORTER;
  const reporter = new ProgressNotifier(transports);
  const runUrl = runDashboardUrl(cfg.publicUrl, run.id, "explore");
  await reporter.start(buildExploreModel(run, { runUrl }));
  return reporter;
}

/** Default production dependencies. */
export function defaultExploreDeps(): ExploreDeps {
  return {
    runPhase: runResearchPhase,
    isReady: isReadyMarker,
    postQuestion: postQuestionDeterministically,
    publish: publishDeterministically,
    makeReporter: makeExploreReporter,
  };
}
