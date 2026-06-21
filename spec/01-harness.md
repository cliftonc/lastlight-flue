---
title: "Harness & server"
order: 1
traces: "lastlight/spec/01-harness.md"
---

# 01 — Harness & server

## Requirement (from Last Light)

A single long-lived Node process boots in strict dependency order (config →
DB → session manager → chat → git-auth → connectors → cron → admin → API →
event registry → `startAll()` → **resume orphaned runs** → ready), wires every
event source into **one** dispatch surface, mounts the admin dashboard + `/api`
on the **same HTTP listener** the GitHub webhook provides, recovers in-flight
runs on boot, and shuts down gracefully on `SIGINT`/`SIGTERM`. Config errors
exit `78` (`EX_CONFIG`); everything else continues with warnings.

## Must-preserve invariants

- **Single dispatch path** — every run (webhook, Slack, cron, CLI, admin)
  funnels through one dispatch function with one signature. The router decides;
  the harness routes the decision.
- **One shared HTTP server** — admin + `/api/*` + `/admin/api/*` live on the
  same listener (one TLS termination, one auth surface, one port).
- **Recovery is part of the contract** — on boot, scan persisted runs and
  resume in-flight ones; `paused`/awaiting-human runs are left alone.
- **Semantic exit codes** — `78` for "restart won't help"; `1` for crashes.
- **Graceful shutdown** — cron, connectors, and the store get explicit
  `stop()`/`close()` so half-flushed writes don't corrupt the resume substrate.
- **Strict boot ordering** — the dependency edges (store before chat, cron
  before admin) are real; do not parallelize boot.

## Flue mechanism

- **Server:** a **Hono app** mounts Flue routing — `app.route('/', flue())`
  (`@flue/runtime/routing`) — and the **same app** carries the ported Last
  Light routes (`/api/*`, `/admin/api/*`) and the channel routes
  (`/channels/github/webhook`, `/channels/slack/events`). One listener, exactly
  as today. (flue-reference §9.)
- **Boot:** an `app.ts` that constructs the Hono app, registers channels +
  custom routes, starts crons (`croner`), and is the deploy entrypoint
  (`flue.config.ts → target: 'node'`). (`examples/node-schedules/src/app.ts`.)
- **Dispatch surface:** `dispatch(agent, { id, input })` for conversational
  work and `invoke(workflow, { input })` for workflow runs are the single
  admission boundary — the Flue analogue of `dispatchWorkflow()`.
- **Observability:** no "Flue Studio" exists (`flue-reference §10`); live
  run/session inspection is the retained dashboard + `@flue/opentelemetry` spans
  + `GET /runs/:id`.

## Gaps & decisions

- **⚠ Boot-time resume of in-flight runs.** Flue **workflows are not
  resumable**, and on the **Node target Flue provides no workflow-run crash
  recovery at all** — an interrupted run is left `active` with a dangling stream
  (flue-reference §3, §5). *Decision:* durability splits — Flue's
  `PersistenceAdapter` makes the **agent session** durable (prior phase context
  reopens), while an **application-owned run record** (see `10-state.md`) carries
  phase progress + `restart_count`. Boot recovery is therefore **application-
  owned**: scan the run record for `active`/`running` rows and **idempotently
  re-`invoke`** (application-owned idempotency keys skip completed phases);
  `paused`/awaiting-human runs are left alone. This is required, not optional, on
  Node.
- **HTTP server always present.** In Last Light the listener only exists if the
  GitHub App is configured. *Decision:* on Flue the Hono app always exists
  (channels + admin + CLI need it); GitHub remains feature-gated at the channel
  level, not the server level. This is a deliberate, harmless divergence.
- **Config-error exit code.** Reproduce the `78` convention in `app.ts`
  pre-flight (Flue doesn't prescribe one).

## Acceptance criteria

- Process boots with channels, crons, admin, and CLI endpoints on one port;
  `lastlight status`/`/health` green.
- Kill the process mid-build and restart → boot recovery re-`invoke`s the run
  idempotently (the durable session supplies prior phase context); no duplicate
  commits/PRs; a `paused` approval run stays paused.
- Malformed required config → exit `78`; missing optional integration → warn +
  continue.
- `SIGTERM` stops crons + channels + store cleanly.

## Source / target files

- Source: `lastlight/src/index.ts` (boot + dispatch), `src/workflows/resume.ts`.
- Target: `lastlight-flue/src/app.ts` (Hono + `flue()` + crons + custom routes),
  `src/agents/*` + `src/workflows/*` (the work), `src/db.ts` (PersistenceAdapter).
