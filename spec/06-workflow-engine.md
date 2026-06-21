---
title: "Workflow engine"
order: 6
traces: "lastlight/spec/06-workflow-engine.md"
---

# 06 — Workflow engine

> **This is the highest-risk page.** Last Light's resumable, ledger-driven,
> YAML-defined runner is exactly where Flue's model differs most. Read
> flue-reference §3 and §5 first.

## Requirement (from Last Light)

A workflow-agnostic runner executes phases (`context` / `agent` / `loop`) in
order (linear) or as a DAG (`depends_on` + `trigger_rule`), supports two loop
kinds (reviewer fix/recheck `max_cycles`; `generic_loop` with an `until`
expression + reply gate), pauses at **approval gates** (positive-enable) and
**reply gates**, and **resumes across process restarts** — re-running from the
top while a per-`(run,phase)` dedup (`shouldRunPhase`) skips completed phases.
A **verdict marker** (`^\s*VERDICT:\s*(APPROVED|REQUEST_CHANGES)`) is the
prompt↔code interface. A **restart-count circuit breaker** (3) bounds crash
loops. `taskId` scopes one persistent sandbox workspace across phases.

## Must-preserve invariants

- **Workflow-agnostic execution** — adding behavior shouldn't require engine
  changes (in Last Light: a YAML file).
- **Completed phases never re-run on resume** — idempotency is per-`(run,phase)`.
- **Approval gates are data, not code** — config decides whether a gate fires.
- **Verdict/READY/BLOCKED markers are exact interfaces** — first matching line.
- **Restart-count circuit breaker** — crash loops are a certainty; cap them.
- **Workspace persistence across phases** — architect writes a plan; executor
  reads it from the same checkout.
- **Resume persists *resume state*, not in-flight buffers** — reconstruct from
  disk + store.

## Flue mechanism

- **A workflow = `defineWorkflow({ agent, input, run({ harness, input }) })`**;
  `run()` is plain TypeScript, so DAG/loop/skip become ordinary control flow
  (`for`, `if`, `await`). `harness.session()` opens agent contexts;
  `session.prompt()` / `session.shell()` / `harness.fs` do the work; structured
  output via a Valibot `result:` schema. (flue-reference §3.)
- **Reviewer loop** → a bounded `for` loop calling reviewer then fix sessions,
  parsing the verdict marker with the ported `parseReviewerVerdict`.
- **Sandbox workspace** persists for the run via the agent's `sandbox` (one
  managed sandbox per run; `09-sandbox.md`); phases share it through
  `harness.fs`/`session.shell`.

## Gaps & decisions

- **⚠ Workflows are not resumable; durability lives in sessions.** Flue does not
  checkpoint workflow `run()`, and on the **Node target it provides no workflow-
  run crash recovery at all** (flue-reference §3). *Decision:* model the run as a
  **durable agent session** (persisted via `PersistenceAdapter`) plus an
  **application-owned run record** (`workflow_runs`-equivalent, `10-state.md`)
  that records `phasesDone` (the resume cursor), `scratch` pointers, `pendingGate`,
  and `restart_count`. On restart/resume, **re-`invoke` from the top**; `run()`
  reads `phasesDone` and **skips completed phases**, guarded by **application-owned
  idempotency keys** (flue-reference §5), reproducing `shouldRunPhase` without
  engine-level checkpointing. Two IDs must be kept distinct: the **application
  `runId`** (passed in `input`, the resume contract) and Flue's per-invocation
  `runId` (returned by `invoke`). **Verify in Phase 0/4** that a second
  `invoke(build, { input: { runId } })` actually *re-runs* `run()` (vs dedupes to
  a no-op) and whether `harness.session('architect')` reattaches across invokes —
  if not, the committed-files handoff (`07`) still carries all cross-phase data,
  so this is an efficiency question, not a correctness one.
- **Considered alternative (recorded, not chosen):** because Flue **agents**
  natively wait across arbitrary time and resume, the gated build could be a
  durable *agent* rather than a re-invoked workflow. The workflow + app-run-record
  model is chosen for deterministic, inspectable phase control.
- **Approval gate.** Human-in-the-loop is an **agent** capability in Flue.
  *Decision:* implement the gate as: the workflow reaches the gate → writes a
  `pending` approval row + sets the run record `paused` → **returns** (the
  workflow function ends). The GitHub/Slack/dashboard response calls
  `resume(runId, decision)` which re-`invoke`s the workflow; the run record's
  phase progress + idempotency keys make it pick up after the gate. Positive-
  enable config preserved. (This mirrors Last Light's own ledger-driven resume,
  re-expressed because Flue won't checkpoint the function.)
- **Reply gate (Socratic loop)** → same shape: persist iteration scratch, end
  the run, resume on the next thread message via the reply-gate short-circuit
  (`05-router.md`).
- **DAG.** Only one example workflow uses real `depends_on` today. *Decision:*
  express dependencies as ordinary `await`/`Promise.all` in `run()`; drop the
  generic DAG engine. Phase-scoped workspaces (DAG) are unnecessary with a
  single per-run sandbox unless we add parallel sessions later.
- **YAML → TypeScript.** Workflows become TS files, not YAML (the locked
  trade-off; confirm the `instance/` overlay doesn't depend on YAML-only
  authoring — risk #4 in `00-overview.md`). The verdict/marker contracts and the
  prompt templates (`07`) are retained.
- **Circuit breaker** lives in the application run record, incremented on each
  resume, capped at 3.

## Acceptance criteria

- `build` runs guardrails→architect→executor→reviewer-loop→PR as `run()` control
  flow; the reviewer loop honors `max_cycles` and the exact verdict marker.
- Killing the process mid-build and restarting resumes after the last completed
  phase (no duplicate commits/PRs — idempotency keys hold).
- An approval gate pauses, persists `pending`, ends the run; a `/approve`
  resumes past it; a disabled gate doesn't pause.
- The restart-count breaker caps resumes at 3 (`restart_count > 3` → run marked
  `failed`), so a crash-looping run terminalizes instead of resuming forever.

## Source / target files

- Source: `lastlight/src/workflows/{simple,runner,dag,phase-executor,loop-eval,
  resume,schema,loader,templates,verdict,phase-ref}.ts`, `workflows/*.yaml`.
- Target: `lastlight-flue/src/workflows/*.ts` (`defineWorkflow` per behavior),
  `src/engine/verdict.ts` + `loop-eval.ts` (ported), `src/run-store.ts`
  (application run record), `src/db.ts` (PersistenceAdapter).
