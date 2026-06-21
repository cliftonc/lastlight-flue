---
title: "Phase 4 — build + durable approval gate"
phase: 4
status: "design complete"
flue_pin: "@flue/runtime 1.0.0-beta.2 (withastro/flue@main, 2026-06-21); pi core ^0.79.4"
date: 2026-06-21
---

# Phase 4 — `build` + durable approval gate

## Scope

The hardest workflow + the human-in-the-loop primitive (`06`). Port `build` as
`run()` control flow: guardrails → architect → **[post_architect gate]** →
executor → reviewer-loop(fix↔recheck, `max_cycles`, **[post_reviewer gate]**) →
finalize → PR. A gate writes `pending` to the app run record + ends the run;
`resume(runId, decision)` re-`invoke`s idempotently against the run record; a
**restart-count breaker** caps crash loops; runs resume on boot from the durable
session + run record. Deliverable: `lastlight build <issue>`.

## Current Flue research

Re-verified `2026-06-21` against `withastro/flue@main` (`@flue/runtime`
1.0.0-beta.2) + docs `.../index.md`.

### Workflows still NOT resumable — gate is 100% app-owned (carries P0)
`docs/guide/durable-execution/`: *"Flue workflows are not resumable… Flue does
not checkpoint arbitrary TypeScript execution."* No suspend/HITL/approve API
exists. **Decision (P0, unchanged):** the gate is application-owned —
`run()` writes `pending` to the run record and **returns**; an external signal
calls `resume(runId, decision)` → idempotent re-`invoke`. Confirmed at HEAD.

### Named sessions are get-or-create + durable (the resume substrate)
Source: `docs/api/agent-api/` §Harness.
- `harness.session(name?)` is **get-or-create** (defaults to `'default'`);
  `harness.sessions.{get,create,delete}` manage named sessions; names starting
  `task:` are reserved. → **Each build phase opens its own named session**
  (`architect`, `executor`, `reviewer`, `fix:N`, `recheck:N`) under the harness,
  so resume after a gate re-opens exactly the right conversation, and a re-`invoke`
  finds the prior session by name instead of re-creating it.
- `delete()` "rejects while the session has accepted durable submissions queued
  or running" — safe; we never delete mid-flight.

### Subagents run INSIDE the parent operation and forbid `durability` (decisive)
Source: `docs/guide/subagents/` (`lastReviewedAt: 2026-05-29`),
`docs/api/agent-api/` §`defineAgentProfile`.
- `session.task(text, { agent, result })` delegates to a `defineAgentProfile`
  subagent in a **child session inside the parent operation**; child history is
  owned by the parent session. **`durability` on a subagent profile is a
  definition-time error** ("Delegated task sessions run inside the parent
  operation").
- **⚠ Decision (Phase 4):** the architect/executor/reviewer split is **NOT**
  modeled as subagents. They are **separate top-level `harness.session(name)`
  calls** in `run()`. Reason: the build cycle's gates **end the workflow
  function** and resume **re-`invoke`s** — subagent delegation can't span a
  gate (it's a single parent operation) and can't be durable. Subagents are
  reserved for *non-durable inner delegation* (e.g. a reviewer asking a
  classifier sub-task within one phase), if ever needed. (Corrects `01`/`flue-
  reference §2`'s "architect/executor/reviewer → subagents" suggestion.)

### Flue's own attempt/timeout breaker complements our restart_count
Source: `docs/api/agent-api/` §`DurabilityConfig`.
- `durability: { maxAttempts (default 10), timeoutMs (default 3_600_000 = 1h) }`
  on a **durable agent submission**: each interruption consumes an attempt;
  exceeding `maxAttempts` terminalizes the submission as failed; `timeoutMs`
  bounds a single submission's wall-clock (checked at turn boundaries). → **Two
  complementary breakers:** Flue's per-submission `maxAttempts`/`timeoutMs`
  (provider-level crash/runaway protection) **and** our app-owned **`restart_count`
  (cap 3)** in the run record (the `06` requirement, counts *resume re-invokes*).
  We set a generous `timeoutMs` for long executor phases (e.g. `21_600_000` per
  the docs' 6-hour example is overkill; pick a per-phase budget).

### Handoff via committed files, not session memory (confirms `07`)
Because resume re-`invoke`s and re-creates sessions per phase, **in-session
context is not the cross-phase carrier** — the **handoff folder**
(`.lastlight/issue-<N>/architect-plan.md`, `status.md`, `reviewer-verdict.md`)
**committed to the branch via `harness.fs`/`harness.shell` git commits** is the
durable, audit-visible handoff (`07` invariant). The architect session writes +
commits the plan; the (possibly post-resume, fresh) executor session reads it
from the checkout. This is *more* important under Flue than under Last Light,
since Flue won't carry the architect's in-memory context across the gate.

## Design

### Module/file layout (`lastlight-flue/src`)
```
src/
  workflows/
    build.ts            defineWorkflow: the full cycle as run() control flow.
  agents/
    builder.ts          defineAgent(async () => ({ sandbox: e2b(repo-write),
                        model, tools: githubReadTools, skills, instructions }))
                        — ONE agent; per-phase model/thinkingLevel via PromptOptions.
  engine/
    verdict.ts          (P1) parseReviewerVerdict.
    loop-eval.ts        (P1) until-expr + unrendered-{{}} guard (used by generic loops; P5).
    templates.ts        (P1) prompt render.
  run-store.ts          app run record: phase-done flags, scratch pointers,
                        pending_gate, restart_count, status, idempotency keys.
  resume.ts             resume(runId, decision) → clear/abort gate → re-invoke(build).
  github-post.ts        deterministic openPullRequest(ref, token, {...}), commit helpers.
prompts/                guardrails/architect/executor/reviewer/fix/re-reviewer/pr (copied).
```

### `run-store.ts` — the application-owned run record (the resume contract)
```ts
interface RunRecord {              // raw sqlite (NOT Flue's RunStore; ours)
  id: string;                      // = runId (also Flue invoke runId / idempotency key)
  workflow: 'build'; owner; repo; issue: number; branch: string; taskId: string;
  phasesDone: Record<string, true>;        // shouldRunPhase: skip completed
  scratch: Record<string, string>;         // POINTERS only (file paths), not blobs (`10`)
  pendingGate: 'post_architect' | 'post_reviewer' | null;
  reviewerCycle: number;                   // loop iteration index
  restartCount: number;                    // breaker, capped 3
  status: 'active' | 'paused' | 'complete' | 'failed';
}
```
- **`shouldRunPhase(run, phase)`** = `!run.phasesDone[phase]` — reproduces Last
  Light's per-`(run,phase)` dedup with **application-owned idempotency keys**
  (the durable-execution doc's prescription). Each phase, on success, sets
  `phasesDone[phase]=true` atomically with its scratch pointer.
- `scratch` holds **pointers** (e.g. `architect-plan.md` is on the branch / in
  `harness.fs`), never inlined text — preserves `10`'s split rule.

### `src/workflows/build.ts` — the cycle as control flow
```ts
export default defineWorkflow({
  agent: builderAgent,
  input: v.object({ owner, repo, issue: v.number(), runId: v.string(),
                    resumedGate: v.optional(v.string()), _triggerType: v.optional(v.string()) }),
  output: v.object({ status: v.string(), prUrl: v.optional(v.string()) }),
  async run({ harness, input }) {
    const run = runStore.getOrCreate(input.runId, input);

    // breaker: each (re-)invoke increments; >3 → fail
    if (runStore.bumpRestart(run.id) > 3) return runStore.fail(run.id, 'restart-breaker');

    // phase_0 context + guardrails (skipped if done)
    if (shouldRun(run, 'guardrails')) {
      const g = await phase(harness, 'guardrails', renderGuardrails(run), { run });
      if (/^\s*BLOCKED/im.test(g.text) && !bootstrapBypass(run))
        return runStore.fail(run.id, 'guardrails-blocked');
      markDone(run, 'guardrails');
    }

    // architect (writes+commits architect-plan.md)
    if (shouldRun(run, 'architect')) {
      await phase(harness, 'architect', renderArchitect(run), { run });
      markDone(run, 'architect');
    }
    // ── GATE: post_architect (positive-enable) ──────────────────────────
    if (gateEnabled('post_architect') && run.pendingGate !== 'post_architect:cleared') {
      if (input.resumedGate !== 'post_architect') {
        runStore.setPending(run.id, 'post_architect');
        await postGateComment(run, 'post_architect');   // GitHub/Slack ask
        return { status: 'paused' };                    // FUNCTION ENDS — Flue won't checkpoint
      }
      runStore.clearPending(run.id);
    }

    if (shouldRun(run, 'executor')) {
      await phase(harness, 'executor', renderExecutor(run), { run, skill: 'building' });
      markDone(run, 'executor');
    }

    // ── reviewer loop: max_cycles=2, fix↔recheck, optional post_reviewer gate ──
    for (let cycle = run.reviewerCycle; cycle < MAX_CYCLES; cycle++) {
      const rv = await phase(harness, `reviewer:${cycle}`, renderReviewer(run, cycle), { run });
      const { verdict } = parseReviewerVerdict(rv.text);
      if (verdict === 'APPROVED') break;
      // gate before fixing (positive-enable)
      if (gateEnabled('post_reviewer') && input.resumedGate !== `post_reviewer:${cycle}`) {
        runStore.setPending(run.id, `post_reviewer:${cycle}`); runStore.setCycle(run.id, cycle);
        await postGateComment(run, 'post_reviewer'); return { status: 'paused' };
      }
      await phase(harness, `fix:${cycle}`, renderFix(run, cycle), { run, skill: 'building' });
      await phase(harness, `recheck:${cycle}`, renderRecheck(run, cycle), { run });
      runStore.setCycle(run.id, cycle + 1);
    }

    // finalize: deterministic PR open (workflow code, not a model tool — P3 rule)
    if (shouldRun(run, 'pr')) {
      const pr = await openPullRequest({ owner, repo }, scopedToken, { branch: run.branch, … });
      markDone(run, 'pr'); runStore.complete(run.id);
      return { status: 'complete', prUrl: pr.html_url };
    }
    return { status: 'complete' };
  },
});
```
`phase(harness, name, prompt, {run, skill?})` = open the named session, render +
`session.prompt(prompt, { model: resolveModel(name), thinkingLevel:
resolveThinking(name) })`, capture `usage`/`model` to stats, return the response.
Loop-iteration session names (`reviewer:0`, `fix:0`, `recheck:0`, `reviewer:1`,
…) mirror Last Light's `reviewer_fix_1`/`reviewer_recheck_1` naming.

### Approval gate — the data flow (`06`)
1. `run()` reaches a gate; **positive-enable** config (`gateEnabled(name)`) decides
   if it fires (disabled → fall through, no pause — `06` invariant).
2. If firing and not yet resumed for this gate: write `pendingGate` to the run
   record, post the ask (GitHub comment / Slack), `status='paused'`, **return**.
3. External signal (GitHub `@last-light approve`/`reject`, Slack `/approve`,
   dashboard) → `resume(runId, 'approve'|'reject')`:
   - reject → `runStore.fail(runId, 'rejected')`.
   - approve → `runStore.clearPending` + `invoke(build, { input: { …, runId,
     resumedGate: <gateName> } })`. The run record's `phasesDone` skips every
     completed phase; execution lands just past the gate. **Idempotent** — a
     duplicate approve is a no-op (gate already cleared; phases already done).
4. `resumedGate` is the per-gate re-entry token; the reviewer gate carries the
   cycle (`post_reviewer:<cycle>`) so a mid-loop resume re-enters the right cycle.

### Boot resume + breaker (`01`/`06`)
- On boot (`app.ts` `recoverOrphanRuns`): scan the run record for `status='active'`
  (not `paused`); for each, `invoke(build, { input: { runId, … } })` — idempotent,
  picks up after the last `phasesDone`. **`paused` runs are left alone** (awaiting
  a human). Flue's durable sessions are reopened by name on the re-invoke.
- **Restart breaker:** `bumpRestart` increments on each `invoke` (boot-recover or
  resume); >3 → `fail`. Caps crash loops (`06`). Distinct from Flue's per-
  submission `maxAttempts` (provider-crash protection) — both apply.

### Deterministic side-effects (carries P3)
PR creation, branch commits between phases, and any status comment are **workflow
code over the scoped `repo-write` token**, not model tools. The builder agent's
GitHub tools are **read-only**; code lands via the sandbox git CLI + `harness.fs`
(the agent edits files; the workflow commits/pushes/opens-PR deterministically).
**PEM wall:** only the `repo-write` builder agent's sandbox can read the PEM-minted
token; default agents get an empty path (`09`).

## Cross-cutting concerns raised (mirrored into overall-architecture.md)
- **Persistence & durability:** the **app run record** (`run-store.ts`) is the
  resume contract — `phasesDone` (idempotency keys = `shouldRunPhase`), `scratch`
  (pointers only), `pendingGate`, `reviewerCycle`, `restartCount` (cap 3),
  `status`. Per-phase **named durable sessions** (`architect`/`executor`/
  `reviewer:N`/`fix:N`/`recheck:N`) carry the transcript; **handoff is via
  committed branch files**, not session memory (resume re-creates sessions).
- **Two complementary breakers:** Flue `DurabilityConfig.maxAttempts`(10)/
  `timeoutMs`(1h default) per submission + app `restart_count`(3) per resume.
- **Subagents are NOT the role split** — architect/executor/reviewer are separate
  top-level sessions in `run()` (subagents run inside one operation + forbid
  durability, can't span a gate). Corrects the earlier subagents framing.
- **Approval gate = write `pending` + return + idempotent re-`invoke`** (no Flue
  suspend primitive). Positive-enable; per-gate `resumedGate` re-entry token;
  reviewer gate carries the cycle.
- **Deterministic side-effects** (PR open, commits) = workflow code over the
  scoped token; builder GitHub tools are read-only; **PEM wall** for `repo-write`.

## Open questions / risks
- **Q4.1 — does a re-`invoke` reattach to the SAME `harness`/named sessions?**
  Resume relies on `harness.session('architect')` returning the *persisted*
  architect session on the new `invoke`. Confirm that across separate `invoke`s
  of the same workflow with the same `runId`, the harness resolves to the same
  durable session store (PersistenceAdapter keyed how? by runId? by an explicit
  session affinity?). **If sessions are per-invoke, not per-run**, the handoff-via-
  committed-files model fully covers it (transcript is convenience, not the
  contract) — but verify whether we must pass a stable session/affinity key on
  `invoke`. (Highest-risk unknown of the phase.)
- **Q4.2 — idempotency of `invoke` itself.** Flue's `RunStore.createRun` is
  "idempotent, first-writer-wins" on `runId`. But we re-`invoke` with the **same**
  `runId` after a gate. Confirm a second `invoke(build,{input:{runId}})` actually
  **runs** `run()` again (we need it to) rather than returning the prior terminal
  record as a no-op. **If `invoke` dedupes on runId**, resume needs a *new* Flue
  runId per attempt while our app `runId` stays stable (decouple the two ids).
  Likely outcome: app `runId` ≠ Flue invoke runId; carry app runId in `input`.
- **Q4.3 — gate comment idempotency.** `postGateComment` must not double-post if
  `run()` re-enters the pause path; guard on `pendingGate` already set.
- **Q4.4 — `timeoutMs` per phase vs per submission.** `DurabilityConfig` is
  per-submission (one `session.prompt`?). Confirm the granularity so a long
  executor phase isn't killed at the 1h default. Set per-phase via the agent's
  `durability` or per-op. (Long-build risk.)
- **Q4.5 — guardrails BLOCKED bypass parity.** Reproduce the `lastlight:bootstrap`
  label / `guardrails:` title bypass exactly (`build.yaml`).

## Acceptance hooks
- `build` runs guardrails→architect→executor→reviewer-loop→PR as `run()` control
  flow; the reviewer loop honors `max_cycles=2` and the exact verdict marker (→ `06`).
- Build **pauses at `post_architect`**, persists `pending`, ends the run; a
  GitHub `@last-light approve` after a **process restart** resumes and opens a PR;
  **no duplicate commits/PRs** (idempotency via `phasesDone`) (→ `06` Acceptance).
- A **disabled** gate doesn't pause (positive-enable) (→ `06`).
- Four consecutive failed resumes mark the run `failed` (restart breaker) (→ `06`).
- Golden **phase-sequence test**: a scripted run asserts the exact session-name
  order incl. loop iterations (`reviewer:0`,`fix:0`,`recheck:0`,`reviewer:1`).
