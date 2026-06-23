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
import type { FlueContext } from "@flue/runtime";
import { Octokit } from "octokit";
import { GITHUB_PERMISSION_PROFILES, type GitAccessProfile } from "../engine/profiles.ts";
import { configureGitAuth } from "../engine/git-auth.ts";
import { loadConfig } from "../config.ts";
import { withBuildSandbox } from "./build-sandbox.ts";
import {
  createExploreAgent,
  EXPLORE_TASK_KEY,
  SYNTHESIZE_TASK_KEY,
  type ResearchPhase,
} from "./explore.ts";
import {
  renderExploreReadPrompt,
  renderExploreAskPrompt,
  renderExploreSynthesizePrompt,
} from "./explore-prompts.ts";
import { postReplyGateQuestion, type ExploreReplyRef } from "../explore-github-post.ts";
import {
  publishSpecDeterministically,
  type PublishRef,
} from "../explore-publish.ts";
import type { ExploreRun } from "../explore-run-store.ts";
import type { RepoRef } from "../tools/github-read.ts";

/** The `issues-write` profile explore runs under (the only writes are the comment / issue). */
export const EXPLORE_PROFILE: GitAccessProfile = "issues-write";

/** The workflow input payload (identifies the idea + how/where to publish the spec). */
export type ExploreInput = {
  /** The APP run id (the reply contract — stable across re-invokes). */
  runId: string;
  owner: string;
  repo: string;
  /** The originating issue number; 0/absent → a Slack-originated run (publish a new issue). */
  issue?: number;
  /** A stable trigger id for non-GitHub origins (e.g. `slack:team:chan:thread`). */
  triggerId?: string;
  /**
   * The CHANNEL conversation key this reply gate is parked on — the SAME
   * `conversationKey` a channel computes from an event (Phase 6 gate correlation).
   * Recorded on the run record at a reply-gate pause so a channel reply on that
   * conversation resolves THIS run. When triggered from a channel this equals
   * `triggerId` (the channels pass `triggerId: ev.conversationKey`).
   */
  conversationKey?: string;
  /** The issue title (untrusted). */
  issueTitle?: string;
  /** The issue body (untrusted). */
  issueBody?: string;
  /** The triggering comment / Slack message (untrusted). */
  commentBody?: string;
  /** Who triggered it (trigger metadata). */
  sender?: string;
  /** Set on a resumed re-invoke — the parked reply gate (`reply:<round>`). */
  resumedGate?: string;
  /** Trigger provenance: "webhook" | "cron" | "cli" | "resume" | "boot". */
  triggerType?: string;
};

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
    ctx: FlueContext<ExploreInput>,
    run: ExploreRun,
    phase: string,
  ): Promise<ExplorePhaseResult>;
  /** True if the ask phase's output signals READY (enough signal — advance). */
  isReady(text: string): boolean;
  /** Deterministically post the reply-gate question (bound ref + token). */
  postQuestion(
    ctx: FlueContext<ExploreInput>,
    run: ExploreRun,
    round: number,
    question: string,
  ): Promise<PostedReplyGate>;
  /** Deterministically publish the synthesized spec (bound ref + token). */
  publish(ctx: FlueContext<ExploreInput>, run: ExploreRun): Promise<ExplorePublishResult>;
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

/** Run one research phase: mint → clone → session over the explorer agent. */
async function runResearchPhase(
  ctx: FlueContext<ExploreInput>,
  run: ExploreRun,
  phase: string,
): Promise<ExplorePhaseResult> {
  const input = ctx.payload;
  const ref: RepoRef = { owner: run.owner, repo: run.repo };
  const token = await mintIssuesWriteToken(input);
  const octokit = new Octokit({ auth: token });

  const phaseKind: ResearchPhase = phase.startsWith("ask")
    ? "ask"
    : phase === "synthesize"
      ? "synthesize"
      : "read";
  const taskKey = phaseKind === "synthesize" ? SYNTHESIZE_TASK_KEY : EXPLORE_TASK_KEY;

  return withBuildSandbox(
    { owner: run.owner, repo: run.repo, branch: exploreBranch(run) },
    token,
    async (sandbox) => {
      const agent = createExploreAgent(ref, octokit, { taskKey, sandbox, withWebTools: true });
      // Distinct harness NAME per phase. Flue allows each harness name to be
      // initialized once per workflow invocation; explore's first invocation
      // runs `read` then `ask:0` before the reply gate (2 inits), so the default
      // 'default' name would collide ("init() has already been called"). The
      // phase string (`read`/`ask:0`/`synthesize`) is unique within a run.
      const harness = await ctx.init(agent, { name: phase });
      const session = await harness.session(phase);
      const prompt = renderPhasePrompt(input, run, phase);
      const res = await session.prompt(prompt);
      return { text: res.text };
    },
  );
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
  ctx: FlueContext<ExploreInput>,
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
  const token = await mintIssuesWriteToken(ctx.payload);
  const octokit = new Octokit({ auth: token });
  const ref: ExploreReplyRef = { owner: run.owner, repo: run.repo, issue_number: run.issue };
  const posted = await postReplyGateQuestion(octokit, ref, question);
  return { commentId: posted.id };
}

/** Deterministically publish the synthesized spec (comment on the issue / new issue). */
async function publishDeterministically(
  ctx: FlueContext<ExploreInput>,
  run: ExploreRun,
): Promise<ExplorePublishResult> {
  const cfg = loadConfig();
  const token = await mintIssuesWriteToken(ctx.payload);
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

/** Default production dependencies. */
export function defaultExploreDeps(): ExploreDeps {
  return {
    runPhase: runResearchPhase,
    isReady: isReadyMarker,
    postQuestion: postQuestionDeterministically,
    publish: publishDeterministically,
  };
}
