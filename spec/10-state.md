---
title: "State & admin API"
order: 10
traces: "lastlight/spec/10-state.md"
---

# 10 — State & admin API

## Requirement (from Last Light)

State is split: **SQLite** (`executions`, `workflow_runs`, `workflow_approvals`,
`cron_overrides`, `workflow_overrides`, `messaging_sessions`/`messaging_messages`)
is the small, indexed **resume substrate + list/stats source**; **per-session
JSONL** is the append-only **event log** the dashboard renders. The split rule
is load-bearing — unbounded text never lands in frequently-listed rows
(`output_text` / JSONL hold it; `scratch` only *points* at it). `session_id`
joins the two stores. List queries exclude blob columns. Migrations are additive.
The **retained admin dashboard + `lastlight` CLI** read this state via the admin
API.

## Must-preserve invariants

- **The split** — resume/list state small + indexed; event stream append-only +
  per-session.
- **No unbounded text in listed rows** — scratch points at outputs.
- **`session_id` is the join key** between resume state and transcript.
- **List queries exclude blobs** — the dashboard polls ~5s.
- **Append-only / additive migrations** — audit trail over disk; never
  drop/narrow.
- **Restart-count capped at the schema level.**
- **Admin/CLI contract preserved** — the dashboard and CLI keep working
  unchanged (locked decision).

## Flue mechanism

- **Durable store:** `src/db.ts` exports a Flue `PersistenceAdapter`
  (`sqlite()`/`postgres()`/libsql); Flue owns **agent-session durability**
  (messages + compacted context) — this replaces the JSONL transcript log *and*
  the `messaging_sessions`/`messaging_messages` chat store. Reads: `listRuns(...)`
  (blob-free pointers) / `getRun(id)`, transcripts via an **`EventStreamStore`**
  (`runStreamPath(runId)` / `agentStreamPath(name, instanceId)`), plus
  `GET /runs/<id>` / `client.runs`. (flue-reference §5, §7.)
- **Application run record:** the `workflow_runs` + `workflow_approvals`
  equivalents (phase progress, scratch, `restart_count`, approval gates) are an
  **application-owned** table (`run-store.ts`) — the durable state the workflow
  engine's resume needs (`06-workflow-engine.md`), kept beside Flue's session
  store.
- **Admin API re-backed:** the ported `/admin/api/*` data layer queries **Flue's
  durable run/session store (`listRuns`/`getRun` + `EventStreamStore`) + the
  application run record** instead of the jsonl shim + `SessionReader`. The
  dashboard + CLI are unchanged; only their backing queries move. (No Flue Studio
  — inspection is the dashboard + `@flue/opentelemetry` + `GET /runs/:id`.)

## Gaps & decisions

- **JSONL shim retired.** Its sole purpose was feeding the dashboard; Flue's
  durable sessions + `EventStreamStore` are now the transcript source. *Decision:*
  delete `event-shim.ts` + `SessionReader`/`ChatSessionReader`; rewrite the admin
  read endpoints onto Flue + the run record. Validated against the `RunStore`/
  `EventStreamStore` source: run list/detail/transcript reproduce natively
  (`listRuns` pointers satisfy "list excludes blobs"). The **only** views needing
  thin app-owned tables are **per-phase cost/token stats rollups** and
  **messaging-thread grouping**. Final-validate in Phase 7 before deleting the
  shim — risk #3 in `00-overview.md`.
- **`executions` stats rows.** Cost/token/stop-reason rollups the dashboard
  shows: source from Flue run metadata if exposed, else a thin app-owned table
  written when a workflow/turn completes.
- **`output_text` bridge** for loop iterations → an app-owned pointer or
  `harness.fs` file, not inlined into the run record (preserve the split rule).
- **Additive-migration discipline** carries to whichever adapter backs the app
  tables. Use `@flue/runtime/test-utils` store-contract tests to validate the
  adapter. (flue-reference §7.)

## Acceptance criteria

- Triggering a run shows up identically in the dashboard, in `lastlight workflow
  log`, and via `GET /runs/:id`.
- A chat thread's transcript renders from Flue's durable session (no jsonl).
- The run-list endpoint returns without reading large blob columns.
- A killed+resumed build's phase progress + restart_count are read from the app
  run record.

## Source / target files

- Source: `lastlight/src/state/{db,migrate,*-store}.ts`,
  `src/engine/event-shim.ts`, `src/admin/{SessionReader,ChatSessionReader}.ts`,
  `src/admin/routes.ts`.
- Target: `lastlight-flue/src/db.ts` (PersistenceAdapter), `src/run-store.ts`
  (app run record + approvals + stats), re-backed `src/admin/*` routes,
  retained `dashboard/` + `src/cli.ts`.
