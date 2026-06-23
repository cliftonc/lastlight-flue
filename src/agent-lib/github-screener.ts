/**
 * GitHub-channel SCREENER — deterministic admission policy (spec/03).
 *
 * Ported from the reference's `src/connectors/github-webhook.ts` filtering block.
 * Pure functions over the native GitHub delivery + the internal `LastLightEvent`;
 * NO LLM, NO side effects. These are the security/policy gates that run inside the
 * channel callback BEFORE any workflow is invoked:
 *   - IGNORED_ACTIONS    — noisy actions that never need agent work (labeled/edited/…)
 *   - isManagedRepo      — the managed-repo allowlist (only repos we operate on)
 *   - bot self-loop guard — drop bot senders (no reply-to-self loop), with the
 *                           PR-attention exception (a bot fix-commit on a human PR
 *                           is a legitimate re-review signal)
 *   - bot-authored-PR guard — never review a PR the bot itself AUTHORED (GitHub 422)
 *   - maintainer gate    — only OWNER/MEMBER/COLLABORATOR can trigger privileged work
 *   - dedupe             — same `deliveryId` processed once (idempotent)
 *
 * Lives in `src/agent-lib/` (NOT discovered) — imported by `src/channels/github.ts`.
 */
import type { GitHubWebhookDelivery } from "@flue/github";
import { isManagedRepo as defaultIsManagedRepo } from "../managed-repos.ts";

/**
 * GitHub webhook actions we skip — noisy, never need agent work. Ported verbatim
 * from the reference. NOTE: `synchronize` is intentionally NOT here — it is the
 * canonical "needs a fresh review" trigger (new commit pushed to a PR branch).
 */
export const IGNORED_ACTIONS = new Set([
  "deleted",
  "edited",
  "labeled",
  "unlabeled",
  "assigned",
  "unassigned",
  "closed",
  "milestoned",
  "demilestoned",
  "locked",
  "unlocked",
  "transferred",
  "pinned",
  "unpinned",
]);

/** Author associations that may trigger privileged workflows via @mention. */
export const MAINTAINER_ROLES = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/** Bot mention pattern — case-insensitive (ported from the reference router). */
export const BOT_MENTION = /@last-light\b/i;

/** Narrow read of the common, untyped payload fields off a native delivery. */
function payloadOf(delivery: GitHubWebhookDelivery): Record<string, any> {
  return delivery.payload as unknown as Record<string, any>;
}

/** The `action` discriminator within the native payload (undefined for e.g. push). */
export function actionOf(delivery: GitHubWebhookDelivery): string | undefined {
  return payloadOf(delivery).action;
}

/** owner/repo full name off the native payload (the allowlist key). */
export function repoFullName(delivery: GitHubWebhookDelivery): string | undefined {
  return payloadOf(delivery).repository?.full_name;
}

/** A PR-attention event — the only case a bot SENDER is allowed through. */
export function isPrAttention(delivery: GitHubWebhookDelivery): boolean {
  const action = actionOf(delivery);
  return (
    delivery.name === "pull_request" &&
    (action === "opened" || action === "synchronize" || action === "reopened")
  );
}

/** Bot sender (self-loop guard): a Bot type, the bot login, or any `[bot]` login. */
export function isBotSender(delivery: GitHubWebhookDelivery, botLogin: string): boolean {
  const sender = payloadOf(delivery).sender ?? {};
  const login: string = sender.login || "";
  return sender.type === "Bot" || login === botLogin || login.endsWith("[bot]");
}

/** PR AUTHORED by the bot — a self-review GitHub forbids (422), distinct from sender. */
export function isBotAuthoredPr(delivery: GitHubWebhookDelivery, botLogin: string): boolean {
  if (!isPrAttention(delivery)) return false;
  const author: string = payloadOf(delivery).pull_request?.user?.login || "";
  return author === botLogin || author.endsWith("[bot]");
}

/** A maintainer (privileged) per the GitHub author association. */
export function isMaintainer(authorAssociation: string | undefined): boolean {
  return MAINTAINER_ROLES.has(authorAssociation || "");
}

/** Does the comment body mention the bot? (silent-ignore gate for comments). */
export function hasBotMention(body: string): boolean {
  return BOT_MENTION.test(body);
}

/** The deterministic screen verdict — drop or allow, with a reason for logging. */
export type ScreenVerdict =
  | { allow: false; reason: string }
  | { allow: true };

/**
 * Run the full deterministic admission screen over a native GitHub delivery.
 * Mirrors the reference connector's filter order exactly:
 *   ignored-action → bot self-loop (with PR exception) → bot-authored PR →
 *   managed-repo allowlist.
 * The maintainer gate is applied LATER (only on @mention comments) by the router,
 * since deterministic routes (issue.opened / pr.opened) don't require it.
 */
export function screenDelivery(
  delivery: GitHubWebhookDelivery,
  botLogin: string,
  isManagedRepo: (repo: string | undefined) => boolean = defaultIsManagedRepo,
): ScreenVerdict {
  const action = actionOf(delivery);

  if (action && IGNORED_ACTIONS.has(action)) {
    return { allow: false, reason: `ignored action=${action}` };
  }

  if (isBotSender(delivery, botLogin) && !isPrAttention(delivery)) {
    return { allow: false, reason: "bot sender (self-loop)" };
  }

  if (isBotAuthoredPr(delivery, botLogin)) {
    return { allow: false, reason: "bot-authored PR (self-review)" };
  }

  const repo = repoFullName(delivery);
  if (!isManagedRepo(repo)) {
    return { allow: false, reason: `repo not managed: ${repo}` };
  }

  return { allow: true };
}

/**
 * In-memory dedupe on `deliveryId` (the application owns dedup — channels do not;
 * see @flue/github docs "does not deduplicate"). A manual redelivery reuses the
 * same `deliveryId`, so a bounded LRU set makes re-processing a no-op.
 *
 * Bounded so a long-lived process can't grow unboundedly; GitHub redeliveries are
 * near-term so a small ring suffices. (A durable store is the Phase-7 follow-up.)
 */
export class DeliveryDedupe {
  private readonly seen = new Set<string>();
  private readonly order: string[] = [];
  constructor(private readonly max = 5000) {}

  /** Returns true the FIRST time this id is seen; false on every repeat. */
  admit(deliveryId: string): boolean {
    if (this.seen.has(deliveryId)) return false;
    this.seen.add(deliveryId);
    this.order.push(deliveryId);
    if (this.order.length > this.max) {
      const evicted = this.order.shift()!;
      this.seen.delete(evicted);
    }
    return true;
  }
}
