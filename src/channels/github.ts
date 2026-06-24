/**
 * GitHub CHANNEL — native, verified webhook ingress (Phase 6, design/phase-6).
 *
 * THE discovered channel entry: Flue discovers every IMMEDIATE file under
 * `src/channels/` as a channel (flue-reference §0 / PROGRESS DISCOVERY RULE) and
 * publishes its named `channel` export at `/channels/github/webhook`. This file is
 * the THIN shell — the screener, the LastLightEvent mapper, the code-based router,
 * and the classifier/screener live in NON-discovered `src/agent-lib/*` helpers and
 * are imported here (so a phantom-entry crash is impossible and they're unit-tested
 * in nested `__tests__/`).
 *
 * Replaces the old `src/connectors/github-webhook.ts` + the standalone router:
 *   @flue/github owns HMAC verification (over the EXACT delivered bytes),
 *   JSON-only ingress, and the `ping` handshake — so this callback never re-checks
 *   the signature (verified before it runs).
 *
 * THE PIPELINE (design/phase-6 §"GitHub channel — the router lives here"):
 *   webhook({ delivery }) →
 *     (a) DEDUPE on delivery.deliveryId (the channel does NOT dedupe — app owns it);
 *     (b) SCREEN — ignored-action / bot self-loop / bot-authored-PR / managed-repo
 *         allowlist (deterministic policy, src/agent-lib/github-screener.ts);
 *     (c) MAP    — native delivery → LastLightEvent (src/agent-lib/github-mapper.ts);
 *     (d) ROUTE  — code-based classifier → workflow + payload (github-router.ts);
 *     (e) INVOKE — admit-fast via the proven spawn-`flue run` path (src/crons.ts's
 *         `defaultCronInvoker`) / dispatch / resume, then return 2xx (<10s).
 *
 * 🚨 NO LIVE SIDE EFFECTS in tests: `handleDelivery` takes injected seams so a test
 * exercises screen→map→route→invoke with NO real spawn, NO real GitHub, NO LLM.
 * The default seams (production) spawn `flue run` exactly like crons/resume.
 */
import { createGitHubChannel, type GitHubChannel, type GitHubWebhookDelivery, type GitHubIssueRef } from "@flue/github";
import { getRuntimeConfig, loadConfig } from "../config.ts";
import { defaultCronInvoker } from "../crons.ts";
import { BuildRunStore } from "../build-run-store.ts";
import { ExploreRunStore } from "../explore-run-store.ts";
import { resume as resumeBuild } from "../resume.ts";
import { screenDelivery, DeliveryDedupe } from "../agent-lib/github-screener.ts";
import { toLastLightEvent } from "../agent-lib/github-mapper.ts";
import { enrichEvent } from "../agent-lib/event-enrich.ts";
import { createClassifierRunner } from "../agent-lib/classify-llm.ts";
import { postDeclineReply } from "../agent-lib/github-decline-reply.ts";
import { postAckReaction } from "../agent-lib/github-ack-reaction.ts";
import {
  routeEvent,
  willActOn,
  dispatchRoute,
  type RouterDeps,
  type DispatchDeps,
  type PendingReplyGate,
} from "../agent-lib/github-router.ts";
import type { LastLightEvent } from "../events.ts";

/** Resolve the loaded config (botLogin / webhookSecret) lazily. */
function cfg() {
  return getRuntimeConfig() ?? loadConfig();
}

/**
 * The HMAC secret for `createGitHubChannel`. PRODUCTION provides it via
 * `WEBHOOK_SECRET` (secrets/.env); @flue/github rejects an empty secret at
 * construction. So that merely IMPORTING this module offline (unit tests, a
 * `flue build` without secrets) does not throw at module-eval, fall back to a
 * non-empty PLACEHOLDER when the env secret is absent. The placeholder can never
 * verify a real GitHub HMAC, so no unsigned/forged delivery is admitted — it only
 * keeps construction from crashing when no secret is configured. A loud warning
 * fires so a misconfigured deploy is obvious. The real secret is NEVER logged.
 */
function webhookSecret(): string {
  const secret = process.env.WEBHOOK_SECRET || cfg().webhookSecret;
  if (secret) return secret;
  if (process.env.NODE_ENV === "production") {
    throw new Error("WEBHOOK_SECRET is required in production for the GitHub channel");
  }
  console.warn(
    "[channels/github] WEBHOOK_SECRET not set — using an offline placeholder " +
      "(no real GitHub delivery will verify). Set WEBHOOK_SECRET for live ingress.",
  );
  return "offline-placeholder-no-real-delivery-verifies";
}

// One process-lifetime dedupe ring (the application owns dedup; @flue/github
// docs: "does not deduplicate `deliveryId`"). Module-scoped so redeliveries
// within a process boot are idempotent. (Durable dedup = Phase-7 follow-up.)
const dedupe = new DeliveryDedupe();

/**
 * Default reply-gate lookup: a paused socratic explore run on THIS issue thread
 * consumes the comment as its next reply. Matches the explore-run-store's existing
 * `triggerId` format (`${owner}/${repo}#${issue}`) — reused, NOT modified.
 */
function defaultPendingReplyGate(storePath?: string) {
  return async (ev: LastLightEvent): Promise<PendingReplyGate | null> => {
    if (!ev.owner || !ev.repoName || !ev.issueNumber) return null;
    const store = new ExploreRunStore(
      storePath ?? process.env.LASTLIGHT_EXPLORE_RUNSTORE ?? "./.data/explore-run-store.db",
    );
    try {
      // Resolve the paused explore reply-gate on this conversation. The store matches
      // the channel conversationKey OR the legacy `owner/repo#issue` triggerId, so a
      // run parked under either correlation path is found (Phase 6 gate correlation).
      const byConvKey = store.findPausedRunByConversation(ev.conversationKey);
      if (byConvKey) return { runId: byConvKey };
      const byTriggerId = store.findPausedRunByConversation(
        `${ev.owner}/${ev.repoName}#${ev.issueNumber}`,
      );
      return byTriggerId ? { runId: byTriggerId } : null;
    } catch {
      // Fail-open: a missing store / read error must not block the webhook.
      return null;
    } finally {
      store.close();
    }
  };
}

/**
 * Resolve a paused BUILD run from a conversation key (Phase 6 gate correlation).
 * The GitHub router passes `ev.conversationKey` as the `resume` decision's `runId`;
 * this maps it to the actual app runId of the run parked at a gate on that issue/PR.
 * Returns null (→ a clean no-op) when no paused run is on the conversation.
 */
function defaultGateLookup(storePath?: string) {
  return (conversationKey: string): string | undefined => {
    const store = new BuildRunStore(
      storePath ?? process.env.LASTLIGHT_BUILD_RUNSTORE ?? "./.data/build-run-store.db",
    );
    try {
      return store.findPausedRunByConversation(conversationKey);
    } catch {
      return undefined; // fail-open: a missing store must not error the webhook.
    } finally {
      store.close();
    }
  };
}

/** Production dispatch seams: spawn `flue run` (crons/resume path), resume gates. */
function defaultDispatchDeps(gateLookup = defaultGateLookup()): DispatchDeps {
  return {
    invokeWorkflow: defaultCronInvoker,
    resumeGate: async (conversationKey, decision) => {
      // The build durable gate (Phase 4 + Phase 6 correlation): the router passes the
      // CONVERSATION key; resolve it to the paused run's app runId, then approve
      // (re-invoke) / reject (terminalize). No paused run on the conversation → a
      // clean no-op (a stray @approve with nothing to resolve does nothing).
      const runId = gateLookup(conversationKey);
      if (!runId) return;
      await resumeBuild(runId, decision);
    },
    reply: async (ev, message) => {
      // DECLINE-REPLY (Phase 6): the router decided to decline (a non-maintainer
      // @mentioned the bot to trigger a privileged action). Post the brief
      // deterministic explanation over a SCOPED issues-write token, with owner/repo/
      // issue CLOSED OVER (never model-selectable; the deterministic-post spine).
      // Bot/self senders never reach here (the screener drops bot senders, and
      // `routeEvent` only emits `reply` on a non-maintainer human @mention), so no
      // reply loop. A missing GitHub App / post error is swallowed — a failed
      // courtesy reply must not 500 the webhook.
      try {
        await postDeclineReply(ev, message);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[channels/github] decline-reply failed: ${msg}`);
      }
    },
  };
}

/**
 * The full webhook pipeline, with every external effect behind an injected seam.
 * Returns a small JSON status (the channel turns it into a 2xx JSON response).
 */
export async function handleDelivery(
  delivery: GitHubWebhookDelivery,
  conversationKey: (ref: GitHubIssueRef) => string,
  opts: {
    botLogin?: string;
    dedupe?: DeliveryDedupe;
    router?: RouterDeps;
    dispatch?: DispatchDeps;
    /** Managed-repo predicate (default: config-backed). Injected in tests. */
    isManagedRepo?: (repo: string | undefined) => boolean;
    /** Ack seam: react 👀 on an admitted event (default: live reaction). Injected in tests. */
    ack?: (ev: LastLightEvent) => Promise<void>;
  } = {},
): Promise<{ status: string; reason?: string; workflow?: string }> {
  const botLogin = opts.botLogin ?? cfg().botLogin;
  const ring = opts.dedupe ?? dedupe;

  // (a) DEDUPE — a manual redelivery reuses the deliveryId → process once.
  if (!ring.admit(delivery.deliveryId)) {
    return { status: "duplicate", reason: delivery.deliveryId };
  }

  // (b) SCREEN — deterministic policy (ignored-action / bot / allowlist).
  const verdict = screenDelivery(delivery, botLogin, opts.isManagedRepo);
  if (!verdict.allow) return { status: "filtered", reason: verdict.reason };

  // (c) MAP — native delivery → LastLightEvent (or null if unmapped).
  const mapped = toLastLightEvent(delivery, conversationKey);
  if (!mapped) return { status: "filtered", reason: "unmapped event" };

  // (c′) ENRICH — stamp `resolvedRepo` + `correlationId` ahead of the route split,
  //      so the shared input builder sees a fully-resolved event (event-enrich.ts).
  const ev = enrichEvent(mapped, { defaultRepo: cfg().exploreDefaultRepo });

  // (c″) ACK — react 👀 as EARLY as possible: right after enrich, BEFORE the (slow,
  //      LLM) classifier and the blocking `flue run`. The GitHub analogue of Slack's
  //      defaultAck "Thinking…". Gated by a cheap deterministic predicate (no LLM,
  //      no gate lookup) so we react only to events we'll act on — structural issue/
  //      PR events and maintainer @mentions — never an unrelated comment or one we'll
  //      decline. Best-effort: a failed reaction must never block admission.
  if (willActOn(ev)) {
    const ack = opts.ack ?? defaultAck;
    await ack(ev);
  }

  // (d) ROUTE — code-based classifier → workflow + payload.
  const routerDeps: RouterDeps = opts.router ?? {
    run: defaultPromptRunner(),
    pendingReplyGate: defaultPendingReplyGate(),
  };
  const decision = await routeEvent(ev, routerDeps);

  // (e) INVOKE — admit-fast (spawn `flue run` / resume / reply), return 2xx.
  const dispatch = opts.dispatch ?? defaultDispatchDeps();
  await dispatchRoute(ev, decision, dispatch);

  return decision.action === "workflow"
    ? { status: "accepted", workflow: decision.workflow }
    : { status: decision.action };
}

/**
 * Production single-shot LLM runner for the classifier/screener: a small no-tools
 * chat call to the `resolveModel('classifier')` provider (`createClassifierRunner`,
 * shared with the Slack channel). It runs ONLY on maintainer @mention NL comments
 * (deterministic routes never reach it). If the model is unreachable (no API key /
 * upstream error) it throws — the classifier catches and defaults to CHAT (the safe
 * fallback), the screener fails open — so a model outage degrades, never crashes.
 */
function defaultPromptRunner() {
  return createClassifierRunner();
}

/**
 * Production ack: react 👀 on the admitted event over a SCOPED issues-write token
 * (owner/repo closed over; the "eyes" content is a fixed literal — never model-
 * selectable). Best-effort: a missing GitHub App / reaction error is swallowed so a
 * failed courtesy reaction never 500s the webhook (mirrors the decline-reply seam).
 */
async function defaultAck(ev: LastLightEvent): Promise<void> {
  try {
    await postAckReaction(ev);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[channels/github] ack reaction failed: ${msg}`);
  }
}

/**
 * THE discovered channel. @flue/github verifies the HMAC over exact bytes, answers
 * `ping` internally, and rejects non-JSON BEFORE this callback runs. Published at
 * `/channels/github/webhook` (relative to the `flue()` mount).
 */
export const channel: GitHubChannel = createGitHubChannel({
  webhookSecret: webhookSecret(),
  async webhook({ delivery }): Promise<{ status: string; reason?: string; workflow?: string }> {
    // `channel` is in scope by the time this deferred callback runs (the channel↔
    // helper cycle is fine — bindings are read in deferred callbacks; flue-ref §0).
    return handleDelivery(delivery, (ref) => channel.conversationKey(ref));
  },
});
