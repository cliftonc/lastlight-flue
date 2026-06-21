---
title: "Phase 6 — channels (replace connectors + router)"
phase: 6
status: "design complete"
flue_pin: "@flue/runtime 1.0.0-beta.2; @flue/github, @flue/slack (withastro/flue@main, 2026-06-21)"
date: 2026-06-21
---

# Phase 6 — channels (replace connectors + router)

## Scope

Native, verified event ingress: `@flue/github` + `@flue/slack` channels replace
`src/connectors/*`; the deterministic router + build-intent classifier +
prompt-injection screener move **into the channel callbacks** (routing stays
**code-based** — no LLM picks the workflow); build the internal `LastLightEvent`
mapper (`04`); re-implement auth-before-normalize, bot/self-loop filtering, the
managed-repo allowlist, the maintainer gate, and the reply-gate short-circuit
(`03`, `04`, `05`). Slack moves Socket-Mode → HTTP Events API.

## Current Flue research

Re-verified `2026-06-21` against `withastro/flue@main` + the in-repo channel
blueprints (`blueprints/channel--github.md`, `--slack.md`, `Version 1
2026-06-14`) and `apps/docs/.../guide/channels.md`.

### GitHub channel
`createGitHubChannel({ webhookSecret, webhook({ delivery }) })` — route
`/channels/github/webhook`; **native HMAC verification** over raw bytes,
**JSON-only** (form-encoded rejected pre-verification). `delivery.name` =
`X-GitHub-Event` and **narrows `delivery.payload`** to the octokit webhook type.
`channel.conversationKey(ref)` / `channel.parseConversationKey(id)` are the
stable id↔ref pair. GitHub expects `2xx` **within 10s and does not auto-retry**
→ admit durable work fast and **dedupe on `delivery.deliveryId`**. Filtering is
**application policy inside `webhook()`**. Needs `@flue/github` + `@octokit/rest`.

### Slack channel
`createSlackChannel({ signingSecret, events, interactions?, commands? })` —
routes `/channels/slack/{events,interactions,commands}`; **exact-byte signature +
timestamp verification**; URL-verification handled internally. `payload.event` is
the native `SlackEvent` union (no parallel normalized model). **`commands`** is
the surface for `/approve` `/reject`. `trigger_id`/`response_url` are
short-lived — **never** persist into dispatch input, model context, logs, or
sessions. Needs `@flue/slack` + `@slack/web-api@^8` (Fetch-based).

### Channel↔agent import cycle is supported
Both blueprints bind per-conversation tools via `channel.parseConversationKey(id)`
inside the agent initializer; the cycle is fine because bindings are read in
deferred callbacks. (Confirms the P1/P5 bound-`defineTool` pattern.)

## Design

### `LastLightEvent` mapper (`04`) — normalization moves to the callback
The single internal Valibot event schema; each channel callback maps its native
payload into it (the normalization that used to live in connectors):
```ts
// src/events.ts
export const LastLightEvent = v.object({
  id: v.string(), source: v.picklist(['github','slack']), type: EventType,
  repo: v.optional(v.string()), issueNumber: v.optional(v.number()),
  prNumber: v.optional(v.number()), sender: v.string(), senderIsBot: v.boolean(),
  body: v.string(), title: v.optional(v.string()), labels: v.optional(v.array(v.string())),
  authorAssociation: v.optional(v.string()),
  conversationKey: v.string(),        // = channel.conversationKey(ref) (replaces raw.* + triggerId)
});
```
Snapshot semantics preserved: labels/association/body copied **at event time**
into the dispatched `input`; the workflow never re-reads (`04` invariant).

### GitHub channel — the router lives here (`05`)
```ts
export const channel = createGitHubChannel({
  webhookSecret: env.GITHUB_WEBHOOK_SECRET,
  async webhook({ delivery }) {
    // 1. AUTH already done by Flue (HMAC). 2. FILTER (connector business, 03):
    if (IGNORED_ACTIONS.has(action)) return;                       // labeled/edited/…
    if (!isManagedRepo(repoFullName)) return;                      // repo allowlist
    if (isBotSelfEvent(delivery) && !botOpenedPr(delivery)) return;// self-loop guard
    if (isPrAuthoredByBot(delivery)) return;                       // self-review guard
    const ev = toLastLightEvent(delivery);                        // 04 mapper

    // 3. DETERMINISTIC ROUTES (no LLM, 05):
    if (ev.type === 'issue.opened' || ev.type === 'issue.reopened')
      return void invoke(issueTriage, { input: ev });
    if (ev.type === 'pr.opened' || ev.type === 'pr.synchronize')
      return void invoke(prReview, { input: ev });

    // 4. REPLY-GATE SHORT-CIRCUIT (beats mention parsing, 05):
    const gate = await runStore.pendingReplyGate(ev.conversationKey);
    if (gate) return void resume(gate.runId, { reply: ev.body });

    // 5. COMMENT @-mention path:
    if (ev.type === 'comment.created') {
      if (!hasBotMention(ev.body)) return;                         // ignore (silent)
      if (!MAINTAINER_ROLES.has(ev.authorAssociation)) return void replyDecline(ev); // router-emitted reply
      if (/approve|reject/.test(...)) return void resume(...);     // regex, no classifier
      // 6. NL → screener ∥ classifier (cheap single-shot LLM, parallel):
      const [screen, intent] = await Promise.all([screenForInjection(ev.body), classify(ev)]);
      const input = screen.flagged ? { ...ev, body: `[lastlight-flag: ${screen.reason}] ${ev.body}` } : ev;
      return void dispatchIntent(intent, input);                   // build/explore/chat/…
    }
  },
});
```
- **`invoke`/`dispatch` is the single admission boundary** (P1/P2). Deterministic
  routes call `invoke` directly — **no LLM** (`05` invariant). The classifier +
  screener run **in parallel** and only on maintainer NL comments.
- **`replyDecline`/`dispatchIntent`** post via the bound GitHub tool / Octokit
  over a scoped `issues-write` token — the router itself can reply (`05`).
- **`pendingReplyGate(conversationKey)`** is one indexed run-store lookup; cache
  the active key set in memory for the remote-adapter case (`05` rebuild note).

### Slack channel
```ts
export const channel = createSlackChannel({
  signingSecret: env.SLACK_SIGNING_SECRET,
  async events({ payload }) {
    if (payload.type !== 'event_callback') return;
    const e = payload.event;
    if (e.bot_id || e.subtype) return;                       // bot/edit/delete filter (03)
    if (!isAllowedUser(e.user)) return;                      // SLACK_ALLOWED_USERS (03)
    const thread = { teamId: payload.team_id, channelId: e.channel, threadTs: e.thread_ts ?? e.ts };
    const key = channel.conversationKey(thread);
    const gate = await runStore.pendingReplyGate(key);
    if (gate) return void resume(gate.runId, { reply: stripMention(e.text) });   // reply-gate short-circuit
    // NL → screener ∥ classifier → chat (default) or a workflow:
    const text = stripMention(e.text);
    const [screen, intent] = await Promise.all([screenForInjection(text), classify({ source:'slack', body:text })]);
    return void dispatchIntent(intent, { source:'slack', body: flag(screen,text), conversationKey: key });
  },
  async commands({ payload }) {                              // /approve /reject (05)
    if (payload.command === '/approve') await resume(payload.text /* runId? */, 'approve');
    if (payload.command === '/reject')  await resume(/*…*/, 'reject');
    return { response_type: 'ephemeral', text: 'ack' };
  },
});
```
- **Transport change (logged):** Socket Mode → **HTTP Events API**
  (`/channels/slack/events`); needs the public URL the GitHub webhook already
  requires. User-allowlist + bot-filtering re-implemented in `events()`.
- **Never persist** `trigger_id`/`response_url`.

### What gets deleted
`src/connectors/{github-webhook,slack/connector,messaging/*}.ts`,
`src/connectors/index.ts` (registry), and the standalone `router.ts` entry —
their logic now lives in the two channel callbacks. `src/connectors/slack/
mrkdwn.ts` (table→monospace) and `classifier.ts`/`screen.ts`/`llm.ts` are
**kept** (ported).

## Cross-cutting concerns raised (mirror to overall-architecture.md)
- **Event ingress = Flue channels**; the `channel` export is the only
  Flue-served public ingress (P2). `/api/*` (CLI/admin/cron) stays the
  envelope-bypass path. One Hono app, one port (P2).
- **Routing is code-based, in the channel callback** — deterministic table →
  `invoke`; classifier + fail-open screener (parallel) only for maintainer NL;
  maintainer gate + reply-gate short-circuit reproduced. **No LLM decides the
  workflow** (`05` invariant preserved).
- **Normalization moved to the callback** — one internal `LastLightEvent`
  (Valibot); snapshot fields copied at event time; `conversationKey` replaces
  `raw.*`/`triggerId`.
- **GitHub `2xx`<10s + dedupe on `deliveryId`**; **Slack Socket→Events API**;
  **never persist** `trigger_id`/`response_url` (security).

## Open questions / risks
- **Q6.1 — Slack `/approve` run correlation.** A slash command must resolve to a
  `runId`. Decide: encode the runId in the gate's posted message / a per-thread
  pending-gate lookup by `conversationKey` (preferred — mirrors GitHub) rather
  than the operator typing a runId.
- **Q6.2 — classifier/screener latency in the webhook 10s budget.** Two parallel
  cheap LLM calls must finish well under GitHub's 10s. They already run only on
  NL comments; confirm p99 < ~3s or move the dispatch behind an immediate `202`
  + async classify (admit-fast pattern the blueprint recommends).
- **Q6.3 — Events API replay/dedupe.** Slack retries on non-2xx; dedupe on
  `payload.event_id` like GitHub's `deliveryId`.
- **Q6.4 — channel ↔ workflow/agent import graph.** Keep bindings in deferred
  callbacks (blueprint rule) to avoid the construct-time cycle.

## Acceptance hooks
- A signed GitHub `issue_comment` hits `/channels/github/webhook`, verifies, and
  dispatches; an invalid signature is rejected pre-normalize; a non-managed repo
  is dropped (→ `03`).
- `issue.opened` triggers triage with **zero** LLM calls; a maintainer
  `@last-light build` classifies BUILD → `invoke(build)`; a non-maintainer gets a
  router-emitted decline (→ `05`).
- A Slack DM triggers chat; `/approve` resolves a pending gate (→ `05`, `06`).
- A comment on a thread with a pending reply gate feeds the loop with no mention
  (→ `05`).
- A bot-authored PR does not trigger pr-review (→ `03`).
