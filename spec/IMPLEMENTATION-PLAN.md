---
title: "Implementation plan"
order: 99
description: "The phased, executable sequence for building Last Light on Flue. Spike-first; each phase is a working, verifiable slice."
---

# Implementation plan

Sequenced **spike-first** — inverting the Mastra attempt's mistake of broad
scaffolding before proving the hard parts. Each phase lands a working,
verifiable slice. Acceptance criteria are drawn from the per-layer spec pages
(`01`–`11`). Flue is **beta** — at the start of each phase, re-verify the
signatures that phase depends on and update `flue-reference.md`.

Repo: `~/work/lastlight-flue` (pnpm, TS ESM, `flue.config.ts → target: 'node'`).
`~/work/lastlight` stays running as reference + fallback until Phase 8.

---

## Phase 0 — Spike & de-risk
**Goal:** prove the three things the Mastra port couldn't, before porting anything.
**Work:**
- `flue` hello-world agent (`defineAgent`) via `npx flue connect`, Pi on our keys.
- **Sandbox — custom Docker `SandboxFactory`** (`src/sandboxes/docker.ts`,
  implementing Flue's `SandboxFactory`→`SandboxApi`): a container per run,
  workspace mounted, `exec`/file ops via `docker`. Prove it runs `git clone` + a
  build command from a `defineAgent({ sandbox })` and tears the container down.
- **Egress (risk #1, `09`) — DEFERRED this phase.** Containers run with full
  network and no SSRF floor (known, recorded, temporary). Egress hardening
  (re-host the CoreDNS/nginx allowlist into the factory, **or** E2B) is a later
  phase; do not run untrusted input through the sandbox until then.
- **Models:** default to an `openai/*` specifier (the available key is
  `OPENAI_API_KEY`; no Anthropic key).
- **Durable HITL + Node recovery (risk #1b, `06`):** a 2-step workflow + agent
  session that pauses (app-owned `pending` + return), survives a process restart,
  and resumes from an external signal. **Explicitly prove the two unknowns Flue
  docs can't settle:** (a) a second `invoke(wf, { input: { runId } })` *re-runs*
  `run()` (not a no-op) — keep app `runId` distinct from Flue's; (b) whether
  `harness.session('name')` reattaches across invokes (if not, committed-files
  handoff covers data flow).
**Deliverable:** 3 committed examples + `MIGRATION.md` with pinned signatures and
written answers to the two invoke/session unknowns. (Egress sign-off is **not**
part of this phase — it moves to the egress-hardening phase.)
**Verify:** each example runs; the Docker sandbox clones+builds in an isolated
container and tears down; resume survives restart with no duplicate side effects.

> **Phase 0 is a hard gate.** Do not start Phase 3+ (which depend on the sandbox
> and the resume model) until the Docker `SandboxFactory` works and the
> invoke/session answers are written down. **Egress is deferred, not skipped** —
> it must be hardened (`09`) before any prod cutover (`08`) or before running
> untrusted input.

## Phase 1 — Shared core port
**Goal:** bring across runtime-independent pieces near-verbatim.
**Work:** port `git-auth.ts` + `profiles.ts` (token downscoping, `09`); GitHub
tools as bound `defineTool` factories (`mcp-github-app` retired — `04`,`09`); copy `skills/`, `prompts/`,
`agent-context/` (`07`,`08`); port the template engine + `verdict.ts` +
`loop-eval.ts` (`06`,`07`); the typed config module + `resolveModel`/
`resolveThinking` (variant→`thinkingLevel`, `02`).
**Deliverable:** `@lastlight-flue/*` shared modules + `src/agents` persona/skill
wiring.
**Verify:** auth/profile unit tests pass; a tool call mints a scoped token and
reads a real issue; every `SKILL.md` parses (frontmatter audit test).

## Phase 2 — Server + preserved API surface
**Goal:** stand up the Hono app with the **full compatibility contract** so the
existing CLI + dashboard work from here on (`01`,`03`,`10`).
**Work:** `src/app.ts` = Hono + `flue()` + crons + ported `/api/*` and
`/admin/api/*`; trigger routes call `invoke`/`dispatch`; port `src/cli.ts`
unchanged; `78`/shutdown semantics (confirm the built server doesn't trap signals
before our handlers — else a custom Node entry owns `listen`/shutdown).
**Deliverable:** `lastlight status`/`/health` green; dashboard loads.
**Verify:** CLI hits each endpoint; contract tests assert response shapes match
the old server.

## Phase 3 — Vertical slice: `pr-review`
**Goal:** re-prove the Mastra port's live milestone (a real review on
`cliftonc/lastlight#69`) (`06`,`09`).
**Work:** one `defineWorkflow`: mint `review-write` token → reviewer
`harness.session()` (read tools + sandbox + `pr-review` skill) → emit
`VERDICT:` marker (`parseReviewerVerdict`) → workflow **posts deterministically**
with the bot's-own-PR COMMENT fallback.
**Deliverable:** `lastlight review <pr>` end-to-end.
**Verify:** a real `COMMENTED` review posted to a throwaway test PR.

## Phase 4 — `build` + durable approval gate
**Goal:** the hardest workflow + the human-in-the-loop primitive (`06`).
**Work:** port `build` as `run()` control flow: guardrails→architect→[gate]→
executor→reviewer-loop(fix↔recheck, `max_cycles`)→finalize→PR. Gate writes
`pending` + ends; `resume(runId,decision)` re-invokes idempotently against the
app run record; restart-count breaker; resume on boot via the durable session.
**Deliverable:** `lastlight build <issue>`.
**Verify:** build pauses at `post_architect`, resumes from a GitHub comment after
a process restart, opens a PR; no duplicate commits/PRs (idempotency holds);
golden phase-sequence test.

## Phase 5 — Remaining workflows + crons + chat
**Goal:** feature parity for the rest (`05`,`06`,`11`).
**Work:** port `pr-fix`, `issue-triage`, `issue-comment`, `repo-health`,
`explore` (web_search + open-egress research phases), `answer`; `cron-*` via
croner + `invoke`. Build the **read-only chat agent** (no sandbox, GET tools,
native skills, durable per-thread session); confirm per-thread serialization
(risk #6) and turn latency (risk #5).
**Deliverable:** every `lastlight <verb>` works; Slack chat answers questions.
**Verify:** one live run per workflow; a multi-turn Slack thread continues across
a restart; "fix that bug" redirects to build.

## Phase 6 — Channels (replace connectors + router)
**Goal:** native event ingestion (`03`,`04`,`05`).
**Work:** `@flue/github` `createGitHubChannel` + `@flue/slack`
`createSlackChannel` replace `src/connectors/*`; move router/classifier/screener
into the channel callbacks (routing stays code-based); build the internal
`LastLightEvent` mapper; re-implement allowlist/bot-filtering/maintainer gate;
Slack moves to the HTTP Events API.
**Deliverable:** real webhook + Slack message drive runs.
**Verify:** a signed comment and a Slack DM each trigger the right workflow;
invalid signature rejected; non-managed repo dropped; `/approve` resolves a gate.

## Phase 7 — Persistence + re-back admin API
**Goal:** the read/observability surface, sourced from Flue (`10`).
**Work:** `src/db.ts` `PersistenceAdapter` (libsql default); app-owned
`run-store.ts` (run record + approvals + stats); **rewrite the `/admin/api/*`
data layer** onto Flue's durable run/session store (`listRuns`/`getRun` +
`EventStreamStore`) + the run record; retire the jsonl shim + `SessionReader`;
wire `@flue/opentelemetry` from `LASTLIGHT_OTEL_*`.
**Deliverable:** dashboard shows runs/sessions/approvals from Flue data.
**Verify (risk #3):** a triggered run appears identically in dashboard, `lastlight
workflow log`, and `GET /runs/:id`; chat transcript renders from the durable
session via `EventStreamStore`; the run-list endpoint reads no large blobs.
**Per-phase stats rollups + messaging-thread grouping are the known app-owned
tables; add any further gap as a thin app table before deleting the shim.**

## Phase 8 — Deploy & cutover
**Goal:** production on the new stack (`01`,`09`).
**Work:** run as a Node service on the current host; cut Slack/GitHub App
webhooks over; the docker egress stack (compose coredns/nginx sidecars,
`egress-firewall-config.ts`, `nginx-*.conf`, `Corefile.*`) is **deleted only if
the chosen egress option is E2B**; if egress was hardened by re-hosting that stack
into the Docker `SandboxFactory` (`09` option 1), it is **kept**. Either way,
egress must be enforced and signed off before cutover.
**Deliverable:** new stack serving production.
**Verify:** dual-run both stacks against the same test repo; diff behavior
(triage/review/build/chat); keep the old stack parked one cycle for rollback,
then retire.

---

## Cross-cutting checks (every phase)
- Re-verify the Flue signatures the phase uses; update `flue-reference.md`.
- Add Vitest coverage (Flue ships `@flue/runtime/test-utils` + store-contract
  tests; `examples/vitest-evals` for eval-style tests).
- Keep `~/work/lastlight` as the running fallback until Phase 8 completes.
- Never regress an invariant marked **Must-preserve** in `01`–`11` without
  recording the trade-off here and in `00-overview.md`'s risk register.

## Dependency order
```
0 ─┬─ 1 ─ 2 ─ 3 ─ 4 ─ 5 ─ 6 ─ 7 ─ 8
   └─ (egress decision gates 9-related work in 3,4 and the deletion in 8)
```
Phases 3–5 build on the shared core (1) and server (2). Channels (6) can begin
after 2 but are most useful once workflows (3–5) exist to receive events.
Persistence re-backing (7) needs real runs (3–5) to validate against. Cutover
(8) is last and depends on the Phase 0 egress decision being enforced.
