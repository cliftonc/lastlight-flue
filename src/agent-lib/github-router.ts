/**
 * GitHub-channel ROUTER — CODE-BASED, deterministic (spec/05).
 *
 * Ported from the reference's `src/engine/router.ts`. Maps a normalized
 * `LastLightEvent` → a `RouteDecision`: which WORKFLOW to invoke (or chat agent
 * to dispatch, or router-emitted reply, or ignore) + the payload. NO LLM picks
 * the workflow (spec/05 invariant). The ONLY LLM calls are the cheap, parallel
 * classifier + injection screener, and ONLY on maintainer @mention NL comments.
 *
 * The router is a PURE decision function (`routeEvent`) plus a thin `dispatchRoute`
 * that performs the decided admission via INJECTED seams:
 *   - `invokeWorkflow(workflow, payload)` — the proven spawn-`flue run` path
 *     (src/crons.ts / src/resume.ts), defaulted at the channel; tests inject a fake.
 *   - `dispatchChat(input)`               — the chat-agent admission seam.
 *   - `reply(ev, message)`                — router-emitted GitHub reply (decline).
 *   - `classify` / `screen`               — the parallel NL classifier + screener.
 *   - `pendingReplyGate(ev)`              — the reply-gate short-circuit lookup.
 *
 * Lives in `src/agent-lib/` (NOT discovered). Imported by `src/channels/github.ts`.
 */
import type { LastLightEvent } from "../events.ts";
import { isMaintainer, hasBotMention } from "./github-screener.ts";
import {
  classifyComment,
  screenForInjection,
  flagPrefix,
  type PromptRunner,
  type ClassificationResult,
  type ScreenResult,
} from "./github-classify.ts";

/** The split-out owner/repo + ids a workflow payload needs. */
function target(ev: LastLightEvent) {
  return {
    owner: ev.owner!,
    repo: ev.repoName!,
    repoFullName: ev.repo,
    sender: ev.sender,
    conversationKey: ev.conversationKey,
  };
}

/** A routing decision — the router performs no side effects; `dispatchRoute` does. */
export type RouteDecision =
  | { action: "workflow"; workflow: string; payload: Record<string, unknown> }
  | { action: "chat"; payload: Record<string, unknown> }
  | { action: "resume"; runId: string; decision: "approve" | "reject"; reason?: string }
  | { action: "reply"; message: string }
  | { action: "ignore"; reason: string };

/** A pending reply-gate parked on a conversation (the socratic explore loop). */
export interface PendingReplyGate {
  runId: string;
}

/** Deps the router needs (all injected — fully offline-testable). */
export interface RouterDeps {
  /** Single-shot LLM seam for the classifier + screener (NL comments only). */
  run: PromptRunner;
  /** Reply-gate lookup by conversationKey (default: none → no short-circuit). */
  pendingReplyGate?: (ev: LastLightEvent) => Promise<PendingReplyGate | null>;
  /** Test hooks to override the classifier/screener directly. */
  classify?: (body: string, ctx?: { issueTitle?: string; isPullRequest?: boolean }) => Promise<ClassificationResult>;
  screen?: (body: string) => Promise<ScreenResult>;
}

const APPROVE_RE = /@last-light\s+approve\b/i;
const REJECT_RE = /@last-light\s+reject\b(.*)/i;

/** Decline reply for a non-maintainer who @mentions the bot (spec/05). */
function declineMessage(sender: string): string {
  return (
    `Thanks for the report, @${sender}! ` +
    `I only act on requests from repository maintainers — a maintainer ` +
    `(owner / member / collaborator) needs to mention me to trigger a build.`
  );
}

/**
 * Route a normalized event → a decision. Deterministic for issue/PR events (NO
 * LLM); the comment path adds: reply-gate short-circuit → mention gate → maintainer
 * gate → approve/reject regex → security-review regex → parallel classify∥screen →
 * intent dispatch. Pure-ish: the only effects are the injected LLM/gate lookups.
 */
export async function routeEvent(
  ev: LastLightEvent,
  deps: RouterDeps,
): Promise<RouteDecision> {
  const t = target(ev);

  switch (ev.type) {
    // ── DETERMINISTIC ROUTES — zero LLM (spec/05 invariant) ──────────────────
    case "issue.opened":
    case "issue.reopened":
      return {
        action: "workflow",
        workflow: "issue-triage",
        payload: {
          owner: t.owner,
          repo: t.repo,
          issueNumber: ev.issueNumber,
          title: ev.title,
          body: ev.body,
          sender: ev.sender,
          labels: ev.labels,
          reopened: ev.type === "issue.reopened" || undefined,
        },
      };

    case "pr.opened":
    case "pr.synchronize":
    case "pr.reopened":
      return {
        action: "workflow",
        workflow: "pr-review",
        payload: {
          owner: t.owner,
          repo: t.repo,
          prNumber: ev.prNumber,
          title: ev.title,
          body: ev.body,
          sender: ev.sender,
          labels: ev.labels,
        },
      };

    // ── COMMENT PATH ─────────────────────────────────────────────────────────
    case "comment.created": {
      // 1. Reply-gate short-circuit (beats mention/maintainer parsing): a paused
      //    socratic explore run waiting on this thread consumes ANY reply.
      if (deps.pendingReplyGate) {
        const gate = await deps.pendingReplyGate(ev);
        if (gate) {
          return {
            action: "workflow",
            workflow: "explore",
            payload: {
              owner: t.owner,
              repo: t.repo,
              issue: ev.issueNumber,
              reply: ev.body,
              sender: ev.sender,
              workflowRunId: gate.runId,
              triggerId: ev.conversationKey,
            },
          };
        }
      }

      // 2. Only act on @last-light mentions (silent ignore otherwise).
      if (!hasBotMention(ev.body)) {
        return { action: "ignore", reason: "no bot mention in comment" };
      }

      // 3. Maintainer gate — non-maintainers get a router-emitted decline.
      if (!isMaintainer(ev.authorAssociation)) {
        return { action: "reply", message: declineMessage(ev.sender) };
      }

      // 4. Approve/reject regex (no classifier) — the durable-gate resume path.
      const approve = APPROVE_RE.test(ev.body);
      const reject = REJECT_RE.exec(ev.body);
      if (approve || reject) {
        return {
          action: "resume",
          // Correlate by the conversation thread (the pending gate's run); a bare
          // approve/reject resolves the gate parked on this issue/PR.
          runId: ev.conversationKey,
          decision: approve ? "approve" : "reject",
          reason: reject?.[1]?.trim() ? reject[1].trim() : undefined,
        };
      }

      // 5. Structured security-review match before LLM classification.
      if (/@last-light\s+security-review\b/i.test(ev.body)) {
        return {
          action: "workflow",
          workflow: "security-review",
          payload: { owner: t.owner, repo: t.repo, sender: ev.sender, source: ev.source },
        };
      }

      // 6. NL → classifier ∥ screener (parallel; the only LLM in this path).
      const classify = deps.classify ?? ((body, ctx) => classifyComment(deps.run, body, ctx));
      const screen = deps.screen ?? ((body) => screenForInjection(deps.run, body));
      const [{ intent }, screened] = await Promise.all([
        classify(ev.body, { issueTitle: ev.title, isPullRequest: !!ev.prNumber }),
        screen(ev.body),
      ]);
      const commentBody = screened.flagged ? `${flagPrefix(screened.reason)}${ev.body}` : ev.body;

      // 7. Intent dispatch (spec/05). PR comments and the security-scan-summary
      //    divert mirror the reference router.
      if (ev.prNumber) {
        return {
          action: "workflow",
          workflow: intent === "build" ? "pr-fix" : "pr-comment",
          payload: {
            owner: t.owner,
            repo: t.repo,
            prNumber: ev.prNumber,
            issueNumber: ev.issueNumber,
            title: ev.title,
            body: ev.body,
            sender: ev.sender,
            commentBody,
          },
        };
      }

      if ((ev.labels || []).includes("security-scan")) {
        return {
          action: "workflow",
          workflow: "security-feedback",
          payload: {
            owner: t.owner,
            repo: t.repo,
            issueNumber: ev.issueNumber,
            title: ev.title,
            body: ev.body,
            sender: ev.sender,
            commentBody,
          },
        };
      }

      if (intent === "build") {
        return {
          action: "workflow",
          workflow: "build",
          payload: {
            owner: t.owner,
            repo: t.repo,
            issue: ev.issueNumber,
            sender: ev.sender,
            commentBody,
            // The conversation key threads through to the run record at the gate
            // pause, so a later @last-light approve/reject on this issue resolves
            // THIS run (Phase 6 gate correlation).
            conversationKey: ev.conversationKey,
            triggerType: "comment",
          },
        };
      }
      if (intent === "explore") {
        return {
          action: "workflow",
          workflow: "explore",
          payload: {
            owner: t.owner,
            repo: t.repo,
            issue: ev.issueNumber,
            sender: ev.sender,
            commentBody,
            triggerId: ev.conversationKey,
          },
        };
      }
      // question / chat / approve / reject (already handled) → issue-comment.
      return {
        action: "workflow",
        workflow: "issue-comment",
        payload: {
          owner: t.owner,
          repo: t.repo,
          issueNumber: ev.issueNumber,
          title: ev.title,
          body: ev.body,
          sender: ev.sender,
          commentBody,
        },
      };
    }

    default:
      return { action: "ignore", reason: `unhandled event type: ${ev.type}` };
  }
}

/** The admission seams `dispatchRoute` calls to enact a decision. */
export interface DispatchDeps {
  /** Spawn `flue run <workflow>` (default) / inject a fake in tests. */
  invokeWorkflow: (workflow: string, payload: Record<string, unknown>) => Promise<void>;
  /** Dispatch the chat agent (later-wired for NL chat replies). */
  dispatchChat?: (payload: Record<string, unknown>) => Promise<void>;
  /** Resume a durable gate: approve re-invokes; reject terminalizes. */
  resumeGate?: (runId: string, decision: "approve" | "reject", reason?: string) => Promise<void>;
  /** Router-emitted GitHub reply (decline). */
  reply?: (ev: LastLightEvent, message: string) => Promise<void>;
}

/**
 * Enact a `RouteDecision`. ADMIT-FAST: workflow/chat admission is the durable
 * boundary — the heavy work runs in the spawned `flue run` / dispatched agent, not
 * inline, so the channel returns 2xx well within GitHub's 10s budget.
 */
export async function dispatchRoute(
  ev: LastLightEvent,
  decision: RouteDecision,
  deps: DispatchDeps,
): Promise<void> {
  switch (decision.action) {
    case "workflow":
      await deps.invokeWorkflow(decision.workflow, decision.payload);
      return;
    case "chat":
      if (deps.dispatchChat) await deps.dispatchChat(decision.payload);
      return;
    case "resume":
      if (deps.resumeGate) await deps.resumeGate(decision.runId, decision.decision, decision.reason);
      return;
    case "reply":
      if (deps.reply) await deps.reply(ev, decision.message);
      return;
    case "ignore":
      return;
  }
}
