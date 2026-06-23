/**
 * Slack CHANNEL — native, verified HTTP Events API ingress (Phase 6, design/phase-6).
 *
 * THE discovered channel entry: Flue discovers every IMMEDIATE file under
 * `src/channels/` as a channel (flue-reference §0 / PROGRESS DISCOVERY RULE) and
 * publishes its named `channel` export's routes — here `/channels/slack/events`
 * and `/channels/slack/commands`. This file is the THIN shell — the screener, the
 * LastLightEvent mapper, and the code-based router live in NON-discovered
 * `src/agent-lib/slack-*` helpers, imported here (so a phantom-entry crash is
 * impossible and they're unit-tested in nested `__tests__/`).
 *
 * Replaces the reference's Socket-Mode `src/connectors/slack/connector.ts` +
 * `messaging/*`: @flue/slack owns exact-byte signature + timestamp verification and
 * the URL-verification handshake — so these callbacks never re-check the signature.
 * TRANSPORT CHANGE (logged): Socket Mode → HTTP Events API.
 *
 * THE PIPELINE (design/phase-6 §"Slack channel"):
 *   events({ payload }) →
 *     (a) only `event_callback` envelopes; DEDUPE on payload.event_id (the channel
 *         does NOT dedupe — app owns it, mirrors @flue/github);
 *     (b) SCREEN — bot/self/non-user filter + SLACK_ALLOWED_USERS allowlist
 *         (deterministic, src/agent-lib/slack-screener.ts);
 *     (c) MAP    — native SlackEvent → LastLightEvent + thread conversationKey
 *         (src/agent-lib/slack-mapper.ts);
 *     (d) ROUTE  — code-based (slack-router.ts): default CHAT (dispatch the chat
 *         agent on the thread key) / a clear command → workflow;
 *     (e) ADMIT  — dispatch(chat) / spawn `flue run`, then ack (<3s).
 *   commands({ payload }) → /approve /reject → resume(runId, decision) (the durable
 *     build gate). NEVER persist payload.trigger_id / payload.response_url.
 *
 * 🚨 NO LIVE SIDE EFFECTS in tests: `handleEvent` / `handleCommand` take injected
 * seams so a test exercises screen→map→route→dispatch with NO real dispatch, NO
 * real spawn, NO real Slack, NO LLM. The default seams (production) dispatch the
 * chat agent / spawn `flue run` / `resume` exactly like the other surfaces.
 *
 * ⚠ LIVE SLACK IS DEFERRED until `SLACK_SIGNING_SECRET` is set. Without it the
 * channel CONSTRUCTS with a non-empty placeholder (so the server boots + `flue
 * build` passes), but no real signed Slack request will verify — that is expected
 * and correct. Set SLACK_SIGNING_SECRET to activate live ingress.
 */
import { createSlackChannel, type SlackChannel, type SlackThreadRef } from "@flue/slack";
import { dispatch } from "@flue/runtime";
import chatAgent from "../agents/chat.ts";
import { getRuntimeConfig, loadConfig } from "../config.ts";
import { defaultCronInvoker } from "../crons.ts";
import { ExploreRunStore } from "../explore-run-store.ts";
import { resume as resumeBuild } from "../resume.ts";
import { screenEvent, SlackEventDedupe } from "../agent-lib/slack-screener.ts";
import { toLastLightEvent } from "../agent-lib/slack-mapper.ts";
import {
  routeEvent,
  routeCommand,
  dispatchRoute,
  type SlackRouterDeps,
  type SlackDispatchDeps,
  type PendingReplyGate,
} from "../agent-lib/slack-router.ts";
import type { LastLightEvent } from "../events.ts";

/** Resolve the loaded config (Slack allowlist) lazily. */
function cfg() {
  return getRuntimeConfig() ?? loadConfig();
}

/** The SLACK_ALLOWED_USERS allowlist (empty = allow all, reference parity). */
function allowedUsers(): readonly string[] {
  return cfg().slack?.allowedUsers ?? [];
}

/**
 * The signing secret for `createSlackChannel`. PRODUCTION provides it via
 * `SLACK_SIGNING_SECRET` (secrets/.env); @flue/slack THROWS on an empty secret at
 * construction. So that merely IMPORTING this module offline (unit tests, a `flue
 * build` without the secret) does not throw at module-eval, fall back to a
 * non-empty PLACEHOLDER when the env secret is absent. The placeholder can never
 * verify a real Slack signature, so no forged request is admitted — it only keeps
 * construction (and the server boot) from crashing when no secret is configured.
 * LIVE SLACK IS INACTIVE until the real secret is set. The secret is NEVER logged.
 */
function signingSecret(): string {
  const secret = process.env.SLACK_SIGNING_SECRET;
  if (secret) return secret;
  if (process.env.NODE_ENV === "production") {
    throw new Error("SLACK_SIGNING_SECRET is required in production for the Slack channel");
  }
  console.warn(
    "[channels/slack] SLACK_SIGNING_SECRET not set — using an offline placeholder " +
      "(LIVE Slack is INACTIVE; no real Slack request will verify). " +
      "Set SLACK_SIGNING_SECRET to activate live ingress.",
  );
  return "offline-placeholder-no-real-slack-verifies";
}

// One process-lifetime dedupe ring on the Events API `event_id` (the application
// owns dedup; @flue/slack does not). Durable dedup = Phase-7 follow-up.
const dedupe = new SlackEventDedupe();

/**
 * Default reply-gate lookup: a paused socratic explore run on THIS thread consumes
 * the message as its next reply. Keyed on the thread conversationKey (the durable
 * thread id), mirroring the explore-run-store's `triggerId`. (The store currently
 * keys GitHub triggers; a Slack thread→runId index is the Phase-7 follow-up — until
 * then this returns null for Slack threads and chat handles the turn.)
 */
function defaultPendingReplyGate(storePath?: string) {
  return async (ev: LastLightEvent): Promise<PendingReplyGate | null> => {
    const store = new ExploreRunStore(
      storePath ?? process.env.LASTLIGHT_EXPLORE_RUNSTORE ?? "./data/explore-run-store.db",
    );
    try {
      const match = store.listPaused().find((r) => r.triggerId === ev.conversationKey);
      return match ? { runId: match.id } : null;
    } catch {
      // Fail-open: a missing store / read error must not block the channel.
      return null;
    } finally {
      store.close();
    }
  };
}

/** Production dispatch seams: dispatch the chat agent, spawn `flue run` workflows. */
function defaultDispatchDeps(): SlackDispatchDeps {
  return {
    dispatchChat: async (id, input) => {
      // The chat agent's instance == the thread; `id` IS the durable session key.
      await dispatch(chatAgent, { id, input });
    },
    invokeWorkflow: defaultCronInvoker,
  };
}

/**
 * The full Slack-event pipeline, with every external effect behind an injected seam.
 * Returns a small JSON status (the channel turns it into a 2xx JSON ack).
 */
export async function handleEvent(
  event: import("@flue/slack").SlackEvent,
  teamId: string,
  eventId: string,
  conversationKey: (ref: SlackThreadRef) => string,
  opts: {
    allowedUsers?: readonly string[];
    dedupe?: SlackEventDedupe;
    router?: SlackRouterDeps;
    dispatch?: SlackDispatchDeps;
  } = {},
): Promise<{ status: string; reason?: string; workflow?: string }> {
  const ring = opts.dedupe ?? dedupe;

  // (a) DEDUPE — a Slack retry reuses the event_id → process once.
  if (!ring.admit(eventId)) {
    return { status: "duplicate", reason: eventId };
  }

  // (b) SCREEN — bot/self/non-user filter + allowlist.
  const verdict = screenEvent(event, opts.allowedUsers ?? allowedUsers());
  if (!verdict.allow) return { status: "filtered", reason: verdict.reason };

  // (c) MAP — native SlackEvent → LastLightEvent (or null if unmapped).
  const ev = toLastLightEvent(event, teamId, conversationKey);
  if (!ev) return { status: "filtered", reason: "unmapped event" };

  // (d) ROUTE — code-based; default chat, clear command → workflow.
  const routerDeps: SlackRouterDeps = opts.router ?? {
    run: defaultPromptRunner(),
    pendingReplyGate: defaultPendingReplyGate(),
  };
  const decision = await routeEvent(ev, routerDeps);

  // (e) ADMIT — dispatch chat / spawn `flue run`, then ack (<3s).
  const dispatchDeps = opts.dispatch ?? defaultDispatchDeps();
  await dispatchRoute(decision, dispatchDeps);

  return decision.action === "workflow"
    ? { status: "accepted", workflow: decision.workflow }
    : { status: decision.action };
}

/**
 * The full slash-command pipeline (/approve /reject → resume the durable build
 * gate). NEVER reads/persists `payload.trigger_id` / `payload.response_url`.
 */
export async function handleCommand(
  command: string,
  text: string,
  conversationKey: string,
  opts: {
    resumeGate?: (runId: string, decision: "approve" | "reject", reason?: string) => Promise<void>;
    gateLookup?: (conversationKey: string) => Promise<string | null>;
  } = {},
): Promise<{ status: string; reason?: string }> {
  const decision = await routeCommand(command, text, {
    conversationKey,
    gateLookup: opts.gateLookup,
  });
  if (decision.action === "ignore") return { status: "ignored", reason: decision.reason };

  const resumeGate =
    opts.resumeGate ??
    (async (runId, d) => {
      // The build durable gate (Phase 4): approve re-invokes, reject terminalizes.
      // resume() is a safe no-op for an unknown runId.
      await resumeBuild(runId, d);
    });
  await resumeGate(decision.runId, decision.decision, decision.reason);
  return { status: "resumed", reason: decision.decision };
}

/**
 * Production single-shot LLM runner for the classifier/screener. Wiring a no-tools
 * classifier agent + session.prompt is the Phase-6 follow-up (shared with the
 * GitHub channel). Until then it fails CLOSED by throwing — the classifier catches
 * and defaults to CHAT (the safe default), and the screener fails open (unflagged).
 */
function defaultPromptRunner() {
  return async (): Promise<string> => {
    // TODO(phase-6/classifier-llm): build a no-tools classifier agent
    // (resolveModel('classifier')) + session.prompt and return its text.
    throw new Error("classifier LLM not wired (phase-6 follow-up)");
  };
}

/**
 * THE discovered channel. @flue/slack verifies the signature over exact bytes +
 * the timestamp, answers `url_verification` internally, and rejects unsigned
 * requests BEFORE these callbacks run. Publishes `/channels/slack/events` and
 * `/channels/slack/commands` (relative to the `flue()` mount).
 */
export const channel: SlackChannel = createSlackChannel({
  signingSecret: signingSecret(),
  async events({ payload }) {
    // Only act on real event callbacks (ignore app_rate_limited + others).
    if (payload.type !== "event_callback") return { status: "ignored", reason: "non-event_callback" };
    // `channel` is in scope by the time this deferred callback runs (the channel↔
    // helper cycle is fine — bindings are read in deferred callbacks; flue-ref §0).
    return handleEvent(payload.event, payload.team_id, payload.event_id, (ref) =>
      channel.conversationKey(ref),
    );
  },
  async commands({ payload }) {
    // NEVER persist payload.trigger_id / payload.response_url — short-lived (spec).
    // Derive the thread conversationKey for the (Phase-7) gate-by-thread lookup.
    const conversationKey = channel.conversationKey({
      teamId: payload.team_id,
      channelId: payload.channel_id,
      // A slash command has no thread ts; the channel root keys the gate lookup.
      threadTs: payload.channel_id,
    });
    return handleCommand(payload.command, payload.text, conversationKey);
  },
});
