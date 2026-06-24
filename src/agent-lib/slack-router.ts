/**
 * Slack-channel ROUTER — CODE-BASED, deterministic (spec/05, design/phase-6
 * §"Slack channel"). Ported from the reference's messaging routing.
 *
 * Maps a normalized Slack `LastLightEvent` → a `SlackRouteDecision`: by default a
 * Slack DM/mention is a CHAT turn → `dispatch(chatAgent, { id: conversationKey,
 * input })` (the per-thread conversation key IS the durable chat session key). A
 * cheap single-shot classifier (the SAME `classifyComment` seam the GitHub channel
 * uses) can divert a clear command to a workflow (explore/answer/security). NO LLM
 * picks routes deterministically — the classifier only refines an NL message, and
 * CHAT is the safe default (spec/05 invariant: routing is code-based).
 *
 * SLASH COMMANDS (`/approve` `/reject`) are routed by `routeCommand` →
 * `resume(runId, decision)` against the durable build gate (Phase 4). See the
 * command→runId correlation note below (Q6.1).
 *
 * `routeEvent` / `routeCommand` are PURE decision functions; the thin
 * `dispatchRoute` performs the decided admission via INJECTED seams (offline-
 * testable). Lives in `src/agent-lib/` (NOT discovered).
 */
import type { LastLightEvent } from "../events.ts";
import type { RoutableEvent } from "./event-enrich.ts";
import { buildWorkflowInput } from "./workflow-input.ts";
import {
  classifyComment,
  screenForInjection,
  flagPrefix,
  type PromptRunner,
  type ClassificationResult,
  type ScreenResult,
} from "./github-classify.ts";

/** A routing decision — the router performs no side effects; `dispatchRoute` does. */
export type SlackRouteDecision =
  | { action: "chat"; id: string; input: Record<string, unknown> }
  | { action: "workflow"; workflow: string; payload: Record<string, unknown> }
  | { action: "ignore"; reason: string };

/** A pending reply-gate parked on a conversation (the socratic explore loop). */
export interface PendingReplyGate {
  runId: string;
}

/** Deps the Slack event router needs (all injected — fully offline-testable). */
export interface SlackRouterDeps {
  /** Single-shot LLM seam for the classifier + injection screener. */
  run: PromptRunner;
  /** Reply-gate lookup by the thread conversationKey (default: none). */
  pendingReplyGate?: (ev: RoutableEvent) => Promise<PendingReplyGate | null>;
  /** Test hooks to override the classifier/screener directly. */
  classify?: (body: string) => Promise<ClassificationResult>;
  screen?: (body: string) => Promise<ScreenResult>;
}

/**
 * Route a normalized Slack event → a decision.
 *
 * 1. Reply-gate short-circuit (beats classification): a paused socratic explore run
 *    waiting on this thread consumes ANY reply.
 * 2. NL → parallel classify ∥ injection-screen (the only LLM in this path). A clear
 *    build/explore/security command diverts to a workflow; everything else (chat,
 *    question, thanks, ambiguous) is a CHAT turn dispatched to the chat agent on the
 *    per-thread conversation key.
 *
 * The classifier failing (no LLM wired) falls back to CHAT — the safe default — so
 * a Slack thread always at least converses.
 */
export async function routeEvent(
  ev: RoutableEvent,
  deps: SlackRouterDeps,
): Promise<SlackRouteDecision> {
  if (ev.type !== "message") {
    return { action: "ignore", reason: `unhandled slack event type: ${ev.type}` };
  }

  // 1. Reply-gate short-circuit — a paused explore loop on this thread.
  if (deps.pendingReplyGate) {
    const gate = await deps.pendingReplyGate(ev);
    if (gate) {
      return {
        action: "workflow",
        workflow: "explore",
        payload: {
          reply: ev.body,
          sender: ev.sender,
          workflowRunId: gate.runId,
          // triggerId is the durable thread key — NOT a Slack trigger_id (never
          // persist that). The conversationKey is safe + stable across replies.
          triggerId: ev.conversationKey,
          source: "slack",
        },
      };
    }
  }

  // 2. NL → classify ∥ screen (parallel; the only LLM in this path).
  const classify = deps.classify ?? ((body) => classifyComment(deps.run, body));
  const screen = deps.screen ?? ((body) => screenForInjection(deps.run, body));
  const [{ intent }, screened] = await Promise.all([classify(ev.body), screen(ev.body)]);
  const body = screened.flagged ? `${flagPrefix(screened.reason)}${ev.body}` : ev.body;

  // A clear command diverts to a workflow; otherwise CHAT (the safe default). The
  // shared `buildWorkflowInput` maps the enriched event → the workflow's `--input`
  // (runId/owner/repo derived once, identically to the GitHub channel).
  //
  // explore + security-review NEED a concrete repo (the explorer clones it; the scan
  // targets it). A Slack message naming no repo resolves to EXPLORE_DEFAULT_REPO at
  // enrich time; when that's also unset (`resolvedRepo === null`) we DON'T crash the
  // channel — we fall through to CHAT, the safe default, so the thread still converses.
  if (intent === "explore" && ev.resolvedRepo) {
    return { action: "workflow", workflow: "explore", payload: buildWorkflowInput("explore", ev, { body }) };
  }
  if (intent === "security" && ev.resolvedRepo) {
    return {
      action: "workflow",
      workflow: "security-review",
      payload: buildWorkflowInput("security-review", ev),
    };
  }
  if (intent === "question") {
    // answer resolves its own fallback repo internally, so it needs no repo guard.
    return { action: "workflow", workflow: "answer", payload: buildWorkflowInput("answer", ev, { body }) };
  }

  // Default — chat. The per-thread conversation key IS the durable session id.
  // `messageTs` (the triggering message ts) rides along so the admit step can put a
  // 👀 reaction on the user's actual message when the Assistant status isn't available.
  return {
    action: "chat",
    id: ev.conversationKey,
    input: { text: body, sender: ev.sender, source: "slack", messageTs: ev.id },
  };
}

// ─── SLASH COMMANDS ────────────────────────────────────────────────────────────

/** A slash-command decision (Q6.1: correlate to the durable build gate's runId). */
export type SlackCommandDecision =
  | { action: "resume"; runId: string; decision: "approve" | "reject"; reason?: string }
  | { action: "ignore"; reason: string };

/**
 * Route a Slack slash command → a decision. `/approve` / `/reject` resolve a paused
 * build gate (Phase-4 durable gate). The command's `text` carries the target — the
 * build `runId` (Q6.1).
 *
 * ⚠ COMMAND→runId CORRELATION (Q6.1, design/phase-6): the preferred design is a
 * per-thread pending-gate lookup by `conversationKey` (mirrors GitHub) rather than
 * the operator typing a runId. That conversation→runId index is NOT yet built (the
 * BuildRunStore is keyed on the app runId with no conversationKey column — Phase-7
 * follow-up). Until then this passes the command `text` through as the runId so an
 * operator CAN drive a resume by id, and `resume()` is a safe no-op for an unknown
 * id. The `gateLookup` seam lets the channel resolve a runId from a key once the
 * index exists. NEVER persist `trigger_id` / `response_url` (handled at the channel).
 */
export async function routeCommand(
  command: string,
  text: string,
  ctx: {
    conversationKey?: string;
    /** Resolve a paused build runId from a conversation key (Phase-7 wiring). */
    gateLookup?: (conversationKey: string) => Promise<string | null>;
  } = {},
): Promise<SlackCommandDecision> {
  const cmd = command.toLowerCase();
  if (cmd !== "/approve" && cmd !== "/reject") {
    return { action: "ignore", reason: `unhandled slash command: ${command}` };
  }
  const decision: "approve" | "reject" = cmd === "/approve" ? "approve" : "reject";

  // Prefer the conversation→runId index when wired; else fall back to the typed text.
  let runId = text.trim();
  if (!runId && ctx.conversationKey && ctx.gateLookup) {
    runId = (await ctx.gateLookup(ctx.conversationKey)) ?? "";
  }
  if (!runId) {
    return { action: "ignore", reason: "no runId for slash command (correlation TODO)" };
  }

  // For /reject, any text after a runId would be a reason — but text IS the runId
  // here, so no separate reason until the conversation-key correlation lands.
  return { action: "resume", runId, decision };
}

/** The admission seams `dispatchRoute` calls to enact an event decision. */
export interface SlackDispatchDeps {
  /** Dispatch the chat agent on the per-thread id (the durable session key). */
  dispatchChat: (id: string, input: Record<string, unknown>) => Promise<void>;
  /** Spawn `flue run <workflow>` (the proven invoker seam) — tests inject a fake. */
  invokeWorkflow: (workflow: string, payload: Record<string, unknown>) => Promise<void>;
}

/**
 * Enact a `SlackRouteDecision`. ADMIT-FAST: chat dispatch / workflow admission is
 * the durable boundary — the heavy work runs in the dispatched agent / spawned
 * `flue run`, so the channel acks Slack well within its 3s budget.
 */
export async function dispatchRoute(
  decision: SlackRouteDecision,
  deps: SlackDispatchDeps,
): Promise<void> {
  switch (decision.action) {
    case "chat":
      await deps.dispatchChat(decision.id, decision.input);
      return;
    case "workflow":
      await deps.invokeWorkflow(decision.workflow, decision.payload);
      return;
    case "ignore":
      return;
  }
}
