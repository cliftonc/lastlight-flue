---
title: "Phase 7 — persistence + re-back admin API"
phase: 7
status: "design complete"
flue_pin: "@flue/runtime 1.0.0-beta.2 (RunStore/EventStreamStore @ withastro/flue@main, 2026-06-21); @flue/opentelemetry"
date: 2026-06-21
---

# Phase 7 — persistence + re-back admin API

## Scope

The read/observability surface, sourced from Flue (`10`). `src/db.ts`
`PersistenceAdapter` (durability ON); the application-owned `run-store.ts` (the
bits Flue's `RunStore` doesn't carry); **rewrite the `/admin/api/*` data layer**
onto Flue's `RunStore` + `EventStreamStore` + the app run record; **retire** the
JSONL shim + `SessionReader`/`ChatSessionReader`; wire `@flue/opentelemetry`;
resolve risk #3 (admin-API parity).

## Current Flue research

Re-verified `2026-06-21` against `packages/runtime/src/runtime/{run-store,
event-stream-store}.ts` + `apps/docs/.../api/data-persistence-api.md`.

### `RunStore` — the run list/detail backbone (confirms `10` "list excludes blobs")
`packages/runtime/src/runtime/run-store.ts`:
```ts
type RunStatus = 'active' | 'completed' | 'errored';
interface RunRecord { runId; workflowName; status; startedAt; endedAt?;
  input; result?; error?; /* … */ }
interface RunPointer extends WorkflowRunPointer { status }     // every field EXCEPT input/result/error
interface ListRunsOpts { status?; workflowName?; limit?; cursor? }     // limit ≤ MAX_LIST_LIMIT(1000)
interface ListRunsResponse { runs: RunPointer[]; nextCursor? }
interface RunStore {
  getRun(runId): Promise<RunRecord|null>;                      // full record (blobs)
  lookupRun(runId): Promise<WorkflowRunPointer|null>;          // pointer (no blobs)
  listRuns(opts?): Promise<ListRunsResponse>;                  // newest-first, status/workflowName filter, cursor
}
```
**`listRuns` returns pointers (no `input`/`result`/`error`) → the `10`
"list queries exclude blob columns" invariant is provided natively.** Exposed as
the free functions `listRuns`/`getRun`/`listAgents` from `@flue/runtime` (P2).

### `EventStreamStore` — the transcript source (replaces JSONL + SessionReader)
`packages/runtime/src/runtime/event-stream-store.ts`:
```ts
runStreamPath(runId): string;                  // workflow-run event stream
agentStreamPath(agentName, instanceId): string;// chat/agent event stream
interface EventStreamStore { /* read(path, {offset, limit}) → EventStreamReadResult; meta(path) */ }
// offsets via formatOffset/parseOffset; DEFAULT_READ_LIMIT 100, MAX 1000
```
→ **The durable event stream per run/agent is the transcript** the dashboard
renders — the Claude-SDK-style JSONL shim + `SessionReader`/`ChatSessionReader`
are **retired**; `runStreamPath(runId)` / `agentStreamPath(name,id)` replace the
`projects/-<cwd>/<sessionId>.jsonl` scan. `isStreamExcludedEvent`/
`isBufferedRunEvent` define what's in the stream.

### Adapters + the store-contract test
`src/db.ts` exports `sqlite()` (node) / `postgres()` / libsql; the SQL
implementations are `sql-run-store.ts` / `sql-agent-execution-store.ts` /
`sql-persisted-chunk-store.ts`. `@flue/runtime/test-utils`
(`define-store-contract-tests`) validates any adapter — run it against our
chosen adapter + our app run-store wrapper.

## Design

### Two stores, one adapter (carries P0/P4)
```
Flue PersistenceAdapter (src/db.ts → sqlite/libsql)   ── owns ──▶
  • RunStore          : run records (input/result/error/status/timing)
  • EventStreamStore  : per-run + per-agent event streams (transcripts)
  • AgentExecutionStore + chunk store : durable agent sessions (chat continuity)

Application run-store (src/run-store.ts, same sqlite handle, our tables) ── owns ──▶
  • phase progress (phasesDone), scratch POINTERS, pendingGate, reviewerCycle,
    restartCount, status  (the resume contract — P4)
  • per-execution STATS rollups (cost/tokens/stopReason/duration) — see below
  • messaging-thread grouping for the chat view (conversationKey ↔ agent instanceId)
```
Both live on the **same** SQLite/libsql file → one connection, additive
migrations (`10` discipline), `@flue/runtime/test-utils` contract test guards
the Flue side.

### Re-backed `/admin/api/*` (the parity work — risk #3)
| Legacy endpoint (reads…) | Re-backed source |
|---|---|
| runs list (`workflow_runs`, no blobs) | `listRuns({status,workflowName,limit,cursor})` → `RunPointer[]` (blob-free natively) |
| run detail | `getRun(runId)` ⨝ app run-store (phasesDone/pendingGate/restartCount) |
| run/phase transcript (was JSONL via `SessionReader`) | `EventStreamStore.read(runStreamPath(runId), {offset,limit})` |
| chat thread transcript (was `ChatSessionReader`) | `EventStreamStore.read(agentStreamPath('chat', instanceId))`, instanceId via app thread map |
| executions list + stats rollups | app run-store stats table (written per phase from `PromptResponse.usage`/`.model`, P3) |
| approvals list/respond | app run-store `pendingGate` + `resume(runId,decision)` (P4/P6) |
| cron/workflow toggles | app config tables (cron_overrides/workflow_overrides ported) |
| login/auth | ported `auth.ts` (HMAC token) unchanged (P2) |

- **Stats** the dashboard shows (cost/tokens/stop reason) are **not** in Flue's
  `RunRecord` per-phase → the app run-store writes a small **`executions` stats
  row** per `session.prompt` from `r.usage`/`r.model` (the P3 native metrics
  source). This is the `10` `executions` table, app-owned, blob-free.
- **`output_text` bridge** (loop iteration prior-output) → a `harness.fs` file
  pointer in the run-store `scratch`, never inlined (`10` split rule).
- **⚠ Tool-family classifier fix (P1 carry):** the dashboard grouped tools by the
  `mcp_github_*` name prefix; new `defineTool` names don't carry it → the
  transcript-render endpoint classifies on the new tool names (`github_*` read,
  `comment_on_github_issue`, etc.). Map table in `admin/tool-families.ts`.

### What gets deleted
`src/engine/event-shim.ts` (JSONL writer), `src/admin/SessionReader.ts`,
`src/admin/ChatSessionReader.ts`, and the `projects/-<cwd>/*.jsonl` directory
convention. The dashboard SPA + `src/cli.ts` are **unchanged** — only the
backing queries moved.

### Observability
`@flue/opentelemetry` adapter registered at boot, fed by the existing
`LASTLIGHT_OTEL_*` env (spans for runs/sessions/tool calls). **No Flue Studio**
(P2 correction) — live inspection = the retained dashboard (now Flue-backed) +
OTEL + raw `GET /runs/:id`.

## Cross-cutting concerns raised (mirror to overall-architecture.md)
- **Persistence model finalized:** Flue `PersistenceAdapter` owns run records +
  event streams + durable agent sessions; the app run-store (same DB) owns the
  resume contract + stats + thread grouping. One file, additive migrations,
  contract-tested.
- **Risk #3 RESOLVED (mostly):** run list/detail and transcripts are natively
  reproducible (`listRuns`/`getRun`/`EventStreamStore`); the only app-owned gaps
  are (a) per-phase **stats rollups** and (b) **messaging-thread grouping** —
  both small app tables. `listRuns` pointers satisfy "list excludes blobs"
  natively. **Validated against the real `RunStore`/`EventStreamStore` source.**
- **JSONL shim + SessionReader RETIRED** — `EventStreamStore` is the transcript
  source (`runStreamPath`/`agentStreamPath`).
- **Observability = OTEL + dashboard + `/runs/:id`; no Studio.**
- **Tool-family classifier** must key on `defineTool` names, not `mcp_*` prefix.

## Open questions / risks
- **Q7.1 — event-stream event shape vs the dashboard's expected envelope.** The
  dashboard renders Claude-SDK-style envelopes today. Confirm `EventStreamStore`
  events carry text/tool_use/tool_result/usage equivalents, and write a thin
  **adapter in the read endpoint** (not a stored shim) to shape them for the
  existing SPA — or update the SPA renderer. (Last real parity unknown.)
- **Q7.2 — durable agent-session ↔ chat thread mapping.** `agentStreamPath(name,
  instanceId)` needs the instanceId = our `conversationKey`. Confirm `dispatch`'s
  `id` is the `instanceId` used in the stream path (almost certainly yes).
- **Q7.3 — stats granularity.** Is `PromptResponse.usage` per-`prompt` only, or
  is there a run-level aggregate in `RunRecord`? If only per-prompt, the app
  stats table sums them per run (cheap).
- **Q7.4 — retention/rotation.** Last Light's JSONL was append-only, no rotation.
  Confirm `EventStreamStore` growth/retention controls for long-lived chat
  threads; decide a prune policy.

## Acceptance hooks
- A triggered run appears identically in the dashboard, `lastlight workflow log`,
  and via raw `GET /runs/:id` (→ `10`).
- A run/phase transcript renders from `EventStreamStore` (no JSONL on disk);
  a chat thread transcript renders from `agentStreamPath` (→ `10`, `11`).
- The run-list endpoint reads **no** blob columns (`listRuns` pointers) under a
  5s dashboard poll (→ `10`).
- A killed+resumed build's `phasesDone`/`restartCount` read from the app
  run-store; cost/token stats show per phase (→ `06`, `10`).
- `@flue/runtime/test-utils` store-contract test passes against the chosen
  adapter.
