# Migration notes — Last Light → Flue

> Phase 0 deliverable. Pinned signatures + the empirically-answered unknowns that
> Flue's docs alone could not settle. The authoritative running record of the
> installed API is `spec/flue-reference.md §0`; this file adds the **proofs** from
> the Phase 0 spikes. Re-verify each phase against the installed package.

## Pins (installed, verified 2026-06-21)

| Package | Version | Notes |
|---|---|---|
| `@flue/runtime` | `1.0.0-beta.2` | main runtime; the bundled `node_modules/@flue/runtime/docs/**` is the source of truth for THIS pin (flueframework.com tracks `main`, which is ahead) |
| `@flue/cli` | `1.0.0-beta.1` | `flue` binary; `defineConfig` from `@flue/cli/config` |
| `valibot` | `1.4.1` | input schemas |
| `hono` | `4.12.26` | app entrypoint (`src/app.ts`) |
| Pi core | `@earendil-works/pi-agent-core ^0.79.4`, `@earendil-works/pi-ai ^0.79.4` | runtime deps |
| Node | `≥22.19` (built on v24.16) | `node:sqlite` (`DatabaseSync`) available for the app run-store |

## ⚠ API drift vs the design docs (the design researched `main`, ahead of beta.2)

The pinned package differs from the design narrative. **Use the installed names:**
- **`createAgent`** — there is NO `defineAgent` in beta.2.
- **Workflows = file/function only**: `src/workflows/<name>.ts` exporting
  `export async function run(ctx: FlueContext<Input>)`. NO `defineWorkflow`, NO
  object form.
- **NO top-level `invoke`.** Workflows run via the `flue run <name>` CLI, HTTP
  `POST /workflows/:name` (needs a `route` export), or `invokeWorkflowAttached`.
  `dispatch(agent, { id, input })` is the public agent-event entry.
- **`defineConfig`** from `@flue/cli/config`. **`local()` / `sqlite()`** from
  `@flue/runtime/node`.

## Answered unknowns (the two Flue docs couldn't settle)

### (a) Does re-invoking a workflow RE-RUN `run()` (not a no-op)? — **YES.**
Verified empirically (Spike 3) and confirmed by `docs/concepts/durable-execution.md`:
*"Starting a workflow again creates a new invocation. It does not continue the
previous function call."* Each `flue run gated` is a fresh invocation with its own
Flue `runId` (e.g. `run_01KVNJS2…`) that executes `run()` from the top. **Keep the
APP runId distinct from Flue's per-invocation runId** — the app runId (a caller-owned
key) is what the run record is keyed on; Flue's runId changes every invocation.
**Implication:** the approval gate cannot rely on any Flue resume — it is 100%
application-owned (write `pending` + return; re-invoke with `resumed:true`; the run
record's done-flags reproduce `shouldRunPhase`).

### (b) Does `harness.session(name)` reattach across invocations? — **Conditional; not load-bearing.**
Per `docs/concepts/durable-execution.md` + `database.md`: agent **sessions** persist
across process restart ONLY when `src/db.ts` exports a `PersistenceAdapter`
(`sqlite()` file-backed); they are keyed by the agent instance `id`. A workflow's
`init(agent)` opens a session within that invocation. **For workflow-to-workflow
data hand-off across a gate we do NOT depend on session reattachment** — the
application-owned run record (and committed files) carry state between invocations.
Full session-reattach (same `id`, persisted history) is exercised when an
*addressable agent* receives a later message; to be re-proven empirically with a
model call in Phase 5 (chat). Recorded so the gate design never assumes it.

## Durability model (decided, proven in Spike 3)

```
trigger → invoke(workflow, { runId, … })        # app runId, NOT Flue's
  run(): step work → at a gate, write `pending` to the run record → RETURN
external signal (GitHub comment / Slack /approve / dashboard / boot re-scan)
  → re-invoke workflow with { runId, resumed:true }   # fresh invocation
  run(): run-record done-flags skip completed side effects → finish → result
```
- **Durable agent sessions** = Flue `PersistenceAdapter` (`src/db.ts` →
  `sqlite('./data/flue.db')`).
- **Workflow gate / phase cursor** = app-owned `run-store.ts` (raw `node:sqlite`:
  `id, step1_done, step2_done, pending_gate, restart_count, status`). Survives a
  process restart because it is on disk.
- **Idempotency = structural**: every side-effecting step is guarded by a done-flag,
  so a duplicate resume / boot re-invoke never repeats it. Proven: 3 separate
  `flue run` processes (pause → resume → resume-again) produced step1×1 + step2×1.
- **`restart_count`** increments on each resume; Phase-4 breaker caps it (≤3).
- **Node has no workflow crash recovery**: an orphaned run stays `active` with a
  dangling stream (`durable-execution.md`). App owns boot-time orphan re-invoke.

## Sandbox (Spike 2)

Custom Docker `SandboxFactory` (`src/sandboxes/docker.ts`) — first-class, since Flue
sandboxes are bring-your-own. The **adapter is a pure mapper and must not manage
container lifetime**; `DockerContainer.create()/.remove()` is caller-owned. EGRESS
DEFERRED: containers have full network + no SSRF floor (known, temporary — `spec/09`,
`00` risk #1). Must be hardened (re-host CoreDNS/nginx into the factory, or E2B
`allowOut`/`denyOut` + metadata CIDR floor) before prod cutover or untrusted input.

## Spike acceptance (all committed, all green)

| Spike | Proof | Test |
|---|---|---|
| 1 hello-world agent | `POST /agents/hello/:id?wait=result` → openai/gpt-5.1 text on our key | `test/spike-1-hello.test.ts` (gated `FLUE_SERVER_URL`) |
| 2 Docker SandboxFactory | isolated container: git clone + npm build artifact; full FS contract; teardown | `test/spike-2-docker.test.ts` (auto-skip w/o docker) |
| 3 durable HITL | pause → restart → resume; step2 exactly-once; app-runId ≠ Flue-runId | `test/spike-3-gated.test.ts` (+ `RUN_FLUE_CLI=1` cross-process) |
