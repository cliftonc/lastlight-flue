---
title: "Router"
order: 5
traces: "lastlight/spec/05-router.md"
---

# 05 — Router

## Requirement (from Last Light)

`routeEvent(envelope) → { action: "skill" | "reply" | "ignore" }` is the one
place "what should happen?" is decided. Predictable events (`issue.opened` →
triage, `pr.opened`/`synchronize` → review) route by a literal type check — **no
LLM**. Only natural-language `@`-mention comments and free-form chat reach a
cheap LLM **classifier** (10 intents) run **in parallel** with a fail-open
prompt-injection **screener**. A **reply-gate short-circuit** (DB lookup by
`triggerId`) routes a comment into a paused workflow before any mention parsing.
A **maintainer gate** lets the router itself reply-decline non-maintainer build
requests.

## Must-preserve invariants

- **No LLM in deterministic routes** — the LLM never decides whether to triage
  an issue or review a PR.
- **Reply gate beats mention parsing** — a paused thread's next message feeds
  the loop regardless of mention/command.
- **Screener fail-open, classifier fail-CHAT** — a broken screener never
  silences the bot; a broken classifier never launches a build. Asymmetric on
  purpose.
- **Maintainer gate is a router decision** — workflows assume an authorized
  caller.
- **`ignore` is silent** — no reply, no DB write; "no reaction = not seen".
- **Discriminated-union result** — exhaustive, type-safe handling.
- **Classifier prompt is an interface** — versioned, golden-tested; exact output
  format.

## Flue mechanism

- The router becomes **code inside the channel `webhook()`/`events()`
  callbacks** (flue-reference §8): deterministic branches `invoke` the matching
  workflow / `dispatch` the matching agent; the classifier + screener are plain
  LLM calls (Pi or a direct provider call) gated to the natural-language
  branches; the maintainer-decline path posts directly via the bound tool /
  Octokit and returns.
- The reply-gate lookup is an application-owned query against the run/approval
  store (`10-state.md`) — same as today.

## Gaps & decisions

- **Routing stays code-based — explicitly.** Flue makes it easy to hand events
  straight to an autonomous agent. *Decision:* preserve the invariant that **no
  LLM decides the workflow**; keep the deterministic table in the channel
  callback. The classifier remains a narrow intent extractor for
  natural-language input only.
- **Cheap-helper LLM path.** Keep the `llm.ts`-style direct single-shot provider
  call for screener/classifier rather than spinning a full agent session — it's
  latency-critical and must run parallel. (Pi powers agents; the classifier
  doesn't need an agent.)
- **Reply-gate query** must be a single indexed lookup; with a remote
  persistence adapter, cache the active `triggerId` set in memory (Last Light's
  own rebuild note).
- **Skill-string → target map.** Last Light's `skill → handler` table becomes a
  `intent/event → workflow|agent` map; each former skill is a `defineWorkflow`
  or a `dispatch` target (`06`, `11`).

## Acceptance criteria

- `issue.opened` triggers triage with zero LLM calls.
- A maintainer `@last-light build` on an issue classifies BUILD and invokes the
  build workflow; a non-maintainer gets a router-emitted decline, no workflow.
- A comment on a thread with a pending reply gate feeds the loop without a
  mention.
- Screener timeout → event still processed (fail-open); classifier timeout →
  CHAT (no accidental build).

## Source / target files

- Source: `lastlight/src/engine/{router.ts,classifier.ts,screen.ts,llm.ts}`.
- Target: routing logic in `lastlight-flue/src/channels/{github,slack}.ts`;
  `src/engine/{classifier.ts,screen.ts,llm.ts}` ported near-verbatim.
