---
title: "Integrations & channels"
order: 3
traces: "lastlight/spec/03-integrations.md"
---

# 03 — Integrations & channels

## Requirement (from Last Light)

Five event sources: **GitHub App webhook** (HMAC-verified, repo-allowlisted),
**Slack** (Socket Mode, user-allowlisted), **CLI** (HTTP POST to `/api/run` /
`/api/build`, bearer auth), **cron** (in-process fan-out, one dispatch per
managed repo), **admin dashboard** (operator dispatch + resume). Each connector
authenticates *before* normalizing, filters bot/ignored events *before*
producing an envelope, and exposes a fire-and-forget `reply()`. CLI/cron/admin
bypass the envelope and dispatch a workflow directly with a `_triggerType` tag.

## Must-preserve invariants

- **Auth before normalize** — failed signature/allowlist never produces an
  event.
- **Filtering is connector business** — bot self-loops, ignored actions,
  non-managed repos drop at the source, never at the router.
- **One handler in** — every source feeds a single central dispatch.
- **Reply is fire-and-forget** — no delivery guarantee; callers needing the
  artifact (comment URL, message ts) fetch separately.
- **Self-review guard** — a PR authored by the bot is dropped from pr-review.
- **Maintainer/allowlist gates** — GitHub `@`-build commands require a
  maintainer `authorAssociation`; Slack requires the user allowlist.

## Flue mechanism

- **GitHub:** `@flue/github` `createGitHubChannel({ webhookSecret, webhook({
  delivery }) })` — route `/channels/github/webhook`, native HMAC verification,
  JSON-only, narrows `delivery.payload` to octokit types. Filtering lives in
  `webhook()`; it `dispatch`/`invoke`s the right target keyed by
  `channel.conversationKey(ref)`. (flue-reference §8.)
- **Slack:** `@flue/slack` `createSlackChannel({ signingSecret, events,
  interactions?, commands? })` — exact-byte signature verification; the
  `commands` surface (`/channels/slack/commands`) carries `/approve` `/reject`.
  (flue-reference §8.)
- **CLI:** retained verbatim — `src/cli.ts` is an HTTP client; the ported
  `/api/run`, `/api/build`, `/admin/api/*` routes (on the same Hono app) call
  `invoke`/`dispatch`. (flue-reference §9; locked decision: retain CLI + API.)
- **Cron:** `croner` + `invoke`/`dispatch` per managed repo
  (`examples/node-schedules/src/app.ts`).
- **Admin:** dashboard routes ported as custom Hono routes; resume calls the
  same `resume(runId, decision)` the GitHub/Slack paths use.

## Gaps & decisions

- **Slack transport: Socket Mode → HTTP Events API.** `@flue/slack` is
  signing-secret + HTTP events, not Socket Mode. *Decision:* accept the move to
  the public Events API endpoint (`/channels/slack/events`); it needs a public
  URL, which the harness already has for GitHub webhooks. Re-implement the
  user-allowlist and bot-message filtering inside the `events()` callback.
- **`reply()` closure → channel-bound tools.** Flue binds reply destinations as
  per-conversation **tools** (`commentOnIssue(parseConversationKey(id))`,
  `replyInThread(...)`). *Decision:* keep deterministic posts (reviews, status
  comments) as application code calling Octokit/WebClient directly (as today),
  and expose agent-driven replies as bound tools. Never put owner/repo/channel
  IDs or credentials in tool arguments (Flue security rule).
- **Never persist short-lived Slack tokens** — `trigger_id`/`response_url` must
  not reach dispatch input, model context, logs, or sessions (Flue rule).
- **`raw` session metadata → `conversationKey`.** Last Light stashes Slack
  channel/thread/user in `envelope.raw`; Flue encodes the same into the stable
  `conversationKey`/`parseConversationKey` id. Keep the canonical input small.

## Acceptance criteria

- A signed GitHub `issue_comment` hits `/channels/github/webhook`, verifies,
  and dispatches; an invalid signature is rejected pre-normalize.
- A non-managed repo's delivery is dropped in `webhook()`.
- A Slack `/approve` slash command resolves a pending approval.
- `lastlight build owner/repo#N` from the CLI triggers a build via `/api/build`.
- A bot-authored PR does not trigger pr-review.

## Source / target files

- Source: `lastlight/src/connectors/{types.ts,github-webhook.ts,slack/*,messaging/base.ts}`,
  `src/cron/*`, `src/cli.ts`, `src/admin/routes.ts`.
- Target: `lastlight-flue/src/channels/{github,slack}.ts`, `src/cron.ts`
  (croner), retained `src/cli.ts`, ported `src/admin/*` routes,
  `src/connectors/slack/mrkdwn.ts` (kept for formatting).
