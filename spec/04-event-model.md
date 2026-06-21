---
title: "Event model"
order: 4
traces: "lastlight/spec/04-event-model.md"
---

# 04 — Event model

## Requirement (from Last Light)

A single canonical `EventEnvelope` is the contract between connectors and the
router: `id`, `source`, `type` (a closed `EventType` enum), `sender`,
`senderIsBot`, `body`, `raw`, `reply`, `timestamp` required; `repo`,
`issueNumber`, `prNumber`, `title`, `labels`, `authorAssociation` conditional.
Platform-specific data lives in `raw`. There is exactly one definition and no
validation layer — connectors build conforming literals; the router trusts them
and reads only top-level fields (never `raw`).

## Must-preserve invariants

- **One canonical type** — every consumer imports the same shape; no
  platform-extended variants.
- **`type` is a closed enum** — typos caught at the connector boundary, not
  five minutes into a run.
- **`labels`/`authorAssociation`/`body` are snapshots** — captured at event
  time, immutable; no re-fetch at run time (avoids surprising races).
- **`raw` is opaque to routing** — routing decisions use top-level fields only.
- **Permissive schema, strict consumers** — a workflow needing `repo` refuses
  to run if it's missing.

## Flue mechanism

- Flue channels deliver **provider-native payloads** (`delivery.payload`
  narrowed by `delivery.name`; Slack `payload.event` as the native `SlackEvent`
  union) and the app builds the **dispatch input** it wants:
  `dispatch(agent, { id, input })` / `invoke(workflow, { input })` where `input`
  is validated by a **Valibot** schema. (flue-reference §3, §8.)
- The stable conversation identity is `channel.conversationKey(ref)` /
  `parseConversationKey(id)` — the Flue analogue of the envelope's routing id.

## Gaps & decisions

- **Keep a normalized internal event type.** Flue's guidance is to *not* build a
  parallel normalized model over provider payloads. *Decision (deliberate
  divergence):* Last Light is multi-source (GitHub + Slack + CLI + cron) and its
  router/workflows are written against one `EventEnvelope`. We keep a **single
  internal `LastLightEvent`** Valibot schema (the canonical input type each
  workflow/agent declares), and each channel's callback maps the provider
  payload into it — the normalization that used to live in the connectors now
  lives in the channel callback. This preserves the "one canonical shape"
  invariant while honoring Flue's "channels deliver native payloads" model at
  the boundary.
- **`reply()` → bound tools + deterministic posts.** See `03-integrations.md`.
- **`senderIsBot` filtering** stays in the channel callback (bot events dropped
  before dispatch), as in Last Light.
- **Snapshot semantics** preserved by copying label/association/body into the
  dispatch `input` at event time (don't re-read in the workflow).

## Acceptance criteria

- A Valibot `LastLightEvent` schema exists; each channel maps its native
  payload into it; workflows/agents declare it as their `input`.
- A GitHub comment and a Slack message both produce the same internal shape with
  source-appropriate fields populated.
- An `input` missing `repo` for a repo-scoped workflow fails validation/refuses.

## Source / target files

- Source: `lastlight/src/connectors/types.ts` (`EventEnvelope`, `EventType`),
  the GitHub + Slack normalizers.
- Target: `lastlight-flue/src/events.ts` (the `LastLightEvent` Valibot schema +
  mappers), used from `src/channels/{github,slack}.ts`.
