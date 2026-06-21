---
title: "Overview"
order: 0
description: "Goal, glossary, source→destination map, locked decisions, rebuild checklist, and risk register for rebuilding Last Light on Flue."
---

# 00 — Overview

## Goal

Rebuild Last Light — a GitHub repo-maintenance agent — on **Flue**, the
maintained agent-harness framework built on the **same Pi runtime** Last Light
already migrated to (`agentic-pi`/`pi-ai`; Flue's Pi packages are
`@earendil-works/pi-*`). The rebuild adopts Flue **fully** (agents, workflows,
channels, sandbox, persistence, observability) while **retaining** Last Light's
admin dashboard, `lastlight` CLI, and HTTP API surface. (There is no "Flue
Studio"; inspection is the retained dashboard + OTEL + `GET /runs/:id`.)

This spec describes *what the Flue implementation must satisfy to match Last
Light*. It traces 1:1 against the source spec at `~/work/lastlight/spec/`.
`flue-reference.md` records the verified Flue capabilities each page cites.
`IMPLEMENTATION-PLAN.md` sequences the build.

## Locked decisions

| Decision | Choice | Rationale |
|---|---|---|
| **Scope** | Full adoption — engine + channels + persistence + sandbox | Flue natively supplies the 3 things the Mastra port dropped (egress sandbox, durable resume, the connector/shim layer) |
| **Location** | New sibling repo `~/work/lastlight-flue` | Keep `~/work/lastlight` as reference + running fallback until cutover |
| **Runtime** | Self-hosted Node + a **custom Docker `SandboxFactory`** (container isolation; egress added later, or E2B for prod) | Docker is already on the host and is the lowest-friction isolated sandbox; egress firewall is deferred, not dropped (see risk #1) |
| **Surface** | **Retain** dashboard + CLI + `/api` + `/admin/api` | Re-back the admin read API on Flue's durable store; no UX regression. (No Flue Studio — see `flue-reference §10`.) |
| **Workflows** | TypeScript `defineWorkflow`, not YAML | Plain-TS control flow; verdict/prompt contracts retained (see risk #4) |

## Glossary (Last Light term → Flue mapping)

- **EventEnvelope** → an internal `LastLightEvent` Valibot schema built in each
  channel callback from the provider-native payload (`04`).
- **Workflow** → `defineWorkflow({ agent, input, run({harness,input}) })`; phases
  are control flow in `run()` (`06`).
- **Workflow Run** → an **application-owned run record** + a **durable agent
  session** (Flue workflows aren't resumable; sessions are) (`06`, `10`).
- **Phase** → a `session.prompt()`/`session.shell()` step in `run()` (`06`,`07`).
- **Skill** → a native Flue skill (`import … with { type: 'skill' }`,
  `defineAgent({ skills })`) — same Pi progressive-disclosure model (`08`).
- **Profile** (`GitAccessProfile`) → ported verbatim; scopes the minted GitHub
  App token; feeds sandbox env + GitHub tools (`09`).
- **Sandbox** → `defineAgent({ sandbox })` — a **custom Docker `SandboxFactory`**
  (`local()` also available for quick dev). No built-in egress firewall, and
  **egress is deferred this phase** (full network) — see risk #1 (`09`).
- **Session** → a Flue durable agent session; the join key into transcripts
  (`10`).
- **Agent context** (`AGENTS.md`) → agent `instructions` (`08`).
- **Approval gate** → workflow writes `pending` + ends; `resume(runId, decision)`
  re-invokes idempotently (human-in-the-loop is agent-level in Flue) (`06`).
- **Reply gate** → same mechanism, resumed by the next thread message (`05`,`06`).
- **Channel** → `@flue/github` / `@flue/slack` verified event ingress (`03`).

## Source → destination map (traceability)

| Source (`lastlight/spec/`) | Destination (`lastlight-flue/spec/`) | Headline change |
|---|---|---|
| `00-overview.md` | `00-overview.md` | this page + risk register |
| — | `flue-reference.md` | **new** — verified, version-pinned Flue capabilities |
| `01-harness.md` | `01-harness.md` | Hono `flue()` + retained routes; boot-resume via durable sessions |
| `02-configuration.md` | `02-configuration.md` | `flue.config.ts` + `.env`; per-task models/variants kept |
| `03-integrations.md` | `03-integrations.md` | connectors → Flue channels; CLI/admin retained; Slack Socket→Events |
| `04-event-model.md` | `04-event-model.md` | `EventEnvelope` → internal `LastLightEvent` Valibot schema |
| `05-router.md` | `05-router.md` | routing moves into channel callbacks; **stays code-based** |
| `06-workflow-engine.md` | `06-workflow-engine.md` | YAML runner → `defineWorkflow`; **resume via sessions + run record** |
| `07-phases-and-prompts.md` | `07-phases-and-prompts.md` | template engine + prompts ported; handoff folder unchanged |
| `08-skills.md` | `08-skills.md` | bespoke staging → native Flue skills (same Pi model) |
| `09-sandbox.md` | `09-sandbox.md` | docker/egress stack → managed sandbox; **egress = #1 risk** |
| `10-state.md` | `10-state.md` | SQLite+JSONL shim → Flue persistence + re-backed admin API |
| `11-chat.md` | `11-chat.md` | pi-ai chat → a Flue agent w/o sandbox; durable session |

## Rebuild checklist

A matching Flue implementation must provide:

- [ ] A Hono app mounting `flue()` + the retained `/api/*` and `/admin/api/*`
      routes on one listener; config-error exit `78`; graceful shutdown (`01`)
- [ ] `flue.config.ts` + `.env` config with per-task `models`/`variants`
      resolution and the PEM/secret discipline (`02`)
- [ ] `@flue/github` + `@flue/slack` channels; retained CLI; cron via croner;
      auth-before-normalize, bot/self-loop filtering in callbacks (`03`)
- [ ] A single internal `LastLightEvent` Valibot schema per channel mapper (`04`)
- [ ] Code-based routing in the channel callbacks; classifier + fail-open
      screener for natural-language input only (`05`)
- [ ] `defineWorkflow`s for build/pr-review/pr-fix/issue-triage/issue-comment/
      repo-health/explore/answer + crons; loops + verdict marker; **durable
      approval/reply gates + resume via session + app run record + idempotency
      keys + restart-count breaker** (`06`)
- [ ] Ported template engine + prompts + the committed `.lastlight/issue-<N>/`
      handoff folder (`07`)
- [ ] Native Flue skills (frontmatter contract) + `agent-context` persona as
      agent `instructions`, shared by chat + workflows (`08`)
- [ ] A managed sandbox per run; **a decided-and-documented egress control**
      (provider allowlist / tool-bounded capability) + SSRF floor; per-run
      **scoped GitHub App token**, PEM-wall, gated web-search keys (`09`)
- [ ] A Flue `PersistenceAdapter` + an app-owned run record; the admin read API
      re-backed on Flue's durable store (`listRuns`/`getRun` + `EventStreamStore`);
      jsonl shim retired; OTEL + `/runs/:id` for inspection (`10`)
- [ ] A read-only chat agent (no sandbox, GET-only tools, native skills),
      durable per-thread session, per-thread serialization, redirect-on-write
      (`11`)

## Risk register

| # | Risk | Where | Decision / status |
|---|---|---|---|
| 1 | **Egress firewall has no Flue analogue** | `09` | **Sandbox DECIDED: a custom Docker `SandboxFactory`** (Flue sandboxes are bring-your-own; even E2B/Daytona ship as blueprints, not packages). **Egress enforcement DEFERRED for the current phase** — dev containers run with **full network and no SSRF floor** (a known, temporary, recorded risk; do not run untrusted input through it). Egress is still **required before prod**: add it by re-hosting the docker CoreDNS/nginx allowlist (`egress-allowlist.ts` + SSRF floor) into the factory, **or** switch the prod sandbox to E2B `allowOut`/`denyOut`. **Open** until that hardening phase. |
| 1b | **Workflow durability — NONE on Node** | `06`, `flue-reference §3` | Flue does not checkpoint workflow `run()`; on Node a crashed run is left `active` with no recovery. **App-owned run record + idempotency keys + boot-time orphan re-invoke is necessary, not optional.** Confirm `invoke(runId)` re-runs (not no-ops) and named-session reattach in **Phase 0/4**. |
| 2 | **Flue is beta, APIs may drift** | `flue-reference` | `@flue/runtime` beta.2 ("Experimental"); peripherals beta.1; `create*→define*` rename already landed. Pin signatures per phase; keep old stack as fallback until cutover. |
| 3 | **Admin-API parity** — Flue's durable store must expose enough to reproduce dashboard/CLI views | `10` | **Mostly resolved:** `listRuns`/`getRun` (blob-free) + `EventStreamStore` reproduce list/detail/transcript (validated vs source). Only per-phase stats rollups + messaging-thread grouping need thin app tables. Final-validate in **Phase 7** before deleting the shim. |
| 4 | **"New workflow = just YAML" goal lost** — workflows become TS | `06` | Accepted; confirm the `instance/` overlay doesn't rely on YAML-only authoring. |
| 5 | **Chat latency without the lighter `completeSimple` path** | `11` | Confirm acceptable turn latency for a sandbox-less Flue agent in Phase 5. |
| 6 | **Per-thread turn serialization** | `11` | Confirm Flue serializes same-`id` dispatches; else reproduce the `chains` map. |
