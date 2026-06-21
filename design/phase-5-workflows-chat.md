---
title: "Phase 5 — remaining workflows + crons + chat"
phase: 5
status: "design complete"
flue_pin: "@flue/runtime 1.0.0-beta.2 (withastro/flue@main, 2026-06-21); pi core ^0.79.4"
date: 2026-06-21
---

# Phase 5 — remaining workflows + crons + chat

## Scope

Feature-parity for everything after `build`: the read-mostly workflows
(`pr-review` already in P3; `pr-fix`, `issue-triage`, `issue-comment`,
`repo-health`, `security-review`, `security-feedback`, `answer`), the
`generic_loop`/reply-gate workflow (`explore` — Socratic), the `cron-*` jobs,
and the **read-only chat agent** (`05`, `06`, `11`). Resolves the `web_search`
question and the prompt-injection / untrusted-content handling left `_pending_`
in the Auth section.

## Current Flue research

Re-verified `2026-06-21` against `withastro/flue@main` (`@flue/runtime`
1.0.0-beta.2) via `gh api`.

### ⚠ DRIFT: Flue has **no built-in `web_search`/`web_fetch`** tool
Grepped the whole repo tree for `web_search|web_fetch|tavily|brave|exa` →
**zero hits** (only Flue's own `.agents/skills` dev tooling matches `web`).
`spec/09`/`flue-reference §6` assumed "Flue's `web_search`/`web_fetch` (Pi)
enabled per phase" — **stale.** Pi core may expose web tools internally, but
Flue does **not** surface them as a first-class agent option. **Decision:**
implement web search as **bound `defineTool`s** (`web_search`, `web_fetch`)
wrapping a provider (Tavily > Exa > Brave, same precedence as Last Light),
attached **only** to the `explore` research agent and gated by the
per-provider key — reproducing Last Light's "opt-in per phase" exactly, with
the provider call made from trusted tool code (not the model picking a URL/key).

### Chat = a durable Flue **agent** addressed by `dispatch`, no sandbox
Source: `docs/guide/building-agents/`, `docs/api/agent-api/`, channel blueprints.
- A persistent agent instance is `dispatch(agent, { id, input })` (or
  `POST /agents/:name/:id`); `id = channel.conversationKey(thread)` keys one
  continuing conversation. The `PersistenceAdapter` (P0) makes that session
  **durable** — messages + compacted context persist and reopen across restart,
  **replacing** `messaging_sessions`/`messaging_messages` + the manual 50-message
  rehydrate.
- A chat agent simply has **no `sandbox`** and only **read-only `defineTool`s**
  → it physically cannot edit/commit (the `11` invariant), no bash/edit/write.
- **Skills** via `defineAgent({ skills: [...] })` give the same
  progressive-disclosure catalogue → the bespoke `read_skill` tool is **retired**
  (carries the P1 "native skills" decision).

### `generic_loop` / reply gate = the same app-owned pause as P4
No Flue loop/until primitive; the Socratic loop is `run()` control flow with the
**reply-kind** gate: write `pendingGate='reply:<iter>'` + the question, return;
the next maintainer message on the thread (router reply-gate short-circuit, P6)
calls `resume(runId, { reply })` → re-`invoke` merges the reply into the run
record's `scratch.socratic` and re-enters the loop at `iter+1`. Same machinery
as P4's approval gate, different resolver (any message, no approve/reject).

## Design

### Module/file layout
```
src/
  workflows/
    pr-review.ts        (P3) reviewer + deterministic post.
    pr-fix.ts           repo-write, no architect/review: read comment+CI → fix → push.
    issue-triage.ts     single-phase: skill: issue-triage (label/dedupe/stale).
    issue-comment.ts    single-phase: skill: issue-comment.
    repo-health.ts      single-phase: skill: repo-health (→ Slack/issue report).
    security-review.ts  / security-feedback.ts  (skill-based).
    answer.ts           single-phase: skill: issue-answer (sourced reply, no PR).
    explore.ts          read → socratic(generic_loop, reply gate) → synthesize → publish.
  agents/
    worker.ts           read/issues/review-write agents (per-profile sandbox + tools).
    chat.ts             defineAgent: NO sandbox, read-only github tools, skills, persona.
    explorer.ts         defineAgent: sandbox + web_search/web_fetch tools (gated), skills.
  tools/
    github-read.ts      (P1) read-only GETs (defineTool) — shared by chat + workers.
    web.ts              web_search/web_fetch defineTool factories (Tavily/Exa/Brave).
  engine/
    screen.ts           (P1) prompt-injection screener (cheap single-shot LLM).
    loop-eval.ts        (P1) until-expr + unrendered-{{}} guard for generic_loop.
```

### Single-phase workflows (the common case)
Most ex-`build` behaviors are one agent pass over a skill — a trivial `run()`:
```ts
export default defineWorkflow({
  agent: triageAgent,                       // issues-write sandboxed agent
  input: LastLightEvent,                    // (04) internal schema
  async run({ harness, input }) {
    const s = await harness.session('triage');
    const r = await s.prompt(renderTriagePrompt(input),
      { model: resolveModel('triage'), thinkingLevel: resolveThinking('triage') });
    return { text: r.text, usage: r.usage };  // usage → stats (P3/P7)
  },
});
```
No gate, no loop, no run record needed beyond stats — these are not resumable-
across-human-input, so a crash just re-`invoke`s the whole single pass
(idempotent enough; the agent re-reads current GitHub state). `pr-fix` is the
same shape with a `review-write`→push deterministic side-effect (P3/P4 rule:
the workflow pushes, the agent edits).

### `explore` — generic_loop + reply gate
```ts
async run({ harness, input }) {
  const run = runStore.getOrCreate(input.runId, input);
  if (shouldRun(run,'read')) { await phase(harness,'read',renderRead(run)); markDone(run,'read'); }
  // Socratic loop (reply gate) — capped by max_iterations
  for (let it = run.iter; it < MAX_ITER; it++) {
    const a = await phase(harness, `socratic:${it}`, renderAsk(run, it));
    if (evalUntil("output.contains('READY')", a.text)) break;
    if (input.resumedGate !== `reply:${it}`) {                 // pause for the human
      runStore.setPending(run.id, `reply:${it}`); runStore.setIter(run.id, it);
      await postQuestion(run, a.text); return { status: 'paused' };
    }
    runStore.mergeScratch(run.id, 'socratic', input.reply);    // fold the reply in
  }
  if (shouldRun(run,'synthesize')) { await phase(harness,'synthesize',renderSynth(run)); markDone(run,'synthesize'); }
  await phase(harness,'publish',renderPublish(run));           // GitHub comment / new issue
  return { status: 'complete' };
}
```
- **Research phases (`read`,`socratic`,`synthesize`) use the `explorer` agent**
  with the **gated `web_search`/`web_fetch` tools** and **open-egress mode**
  (E2B `denyOut` drops the domain allowlist, keeps the metadata CIDR floor — P0).
  `publish` uses the strict-egress, repo-scoped path (the one write moment).

### Chat agent (`11`)
```ts
// src/agents/chat.ts
export default defineAgent(({ id }) => ({
  model: resolveModel('chat'),
  thinkingLevel: resolveThinking('chat'),
  instructions: persona() + CHAT_SUFFIX,           // agent-context/*.md + chat constraints (08)
  tools: githubReadTools(/* read-only, token from trusted code */),
  skills: [chatSkill, issueTriage, prReview, repoHealth],   // native progressive disclosure
  // NO sandbox  → cannot bash/edit/write (11 invariant)
}));
```
- Dispatched from the Slack channel (P6): `dispatch(chatAgent, { id:
  channel.conversationKey(thread), input: { text } })`. Durable session per
  thread; restart-safe.
- **`chat-reset`** → start a new agent `id` (e.g. append a generation suffix to
  the conversationKey) so the next message gets a fresh session. **`status-
  report`** → query the run store (`listRuns({status:'active'})`), not an agent
  call (`11`: harness-level, not a tool).
- **Screened input reaches chat flagged, not blocked** — the channel callback
  (P6) prefixes `[lastlight-flag: …]`; `agent-context/security.md` tells the
  agent to treat flagged + `<<<USER_CONTENT_UNTRUSTED>>>` content as data.

### Crons
`croner` `Cron[]` in `app.ts` (P2): `cron-health`/`cron-security` always;
`cron-triage`/`cron-review` only when webhooks are **disabled** (dual model
preserved). Each tick `invoke`s the matching workflow per managed repo.

## Cross-cutting concerns raised (mirror to overall-architecture.md)
- **Web search is NOT a Flue built-in** — implement `web_search`/`web_fetch` as
  gated `defineTool`s on the `explorer` agent only; open-egress (metadata CIDR
  floor still applies). Corrects `flue-reference §6`/`09`.
- **Chat = durable Flue agent, no sandbox, read-only tools, native skills** —
  Flue's per-`id` durable session **replaces** `messaging_sessions` + manual
  rehydrate + `read_skill`. One Pi runtime (no separate pi-ai chat path).
- **One agent runtime** — Last Light's pi-ai(chat) vs agentic-pi(sandbox) split
  collapses to "an agent with or without a `sandbox`". (Confirm chat latency —
  risk #5.)
- **Reply gate = approval-gate machinery with a message resolver** (run record
  `pending='reply:<iter>'` + `resume(runId,{reply})`).
- **Untrusted-content handling stays agent-side** (`agent-context/security.md`);
  the screener LLM call lives in the channel callback (P6), flag-not-block.

## Open questions / risks
- **Q5.1 — per-thread turn serialization (risk #6).** Does Flue serialize
  concurrent `dispatch`es to the **same** agent `id`? `docs/api/agent-api`
  implies one continuing instance per id; confirm two near-simultaneous messages
  queue rather than interleave. Fallback: reproduce Last Light's `chains` map in
  the channel callback.
- **Q5.2 — chat latency (risk #5).** A sandbox-less Flue agent should be
  low-latency, but confirm there's no per-dispatch durable-write overhead that
  dwarfs the LLM call vs Last Light's `completeSimple`. Measure in the slice.
- **Q5.3 — web tool provider surface.** Decide whether `web_fetch` honors the
  egress allowlist (it runs in *tool* code on the host/sandbox, not the model) —
  if tool code runs harness-side, it bypasses the sandbox firewall entirely and
  needs its own host-side allowlist. (Security-relevant; ties to `09`.)
- **Q5.4 — single-pass idempotency.** Re-`invoke` of a crashed single-phase
  workflow re-runs the whole pass; confirm that's safe for each (triage re-labels
  idempotently; `answer`/`security-feedback` must not double-post — add a
  posted-marker check or app dedup).

## Acceptance hooks
- Each `lastlight <verb>` (triage/review/pr-fix/health/security/answer/explore)
  runs end-to-end against a test repo (→ `06`).
- A multi-turn Slack thread continues across a process restart (durable session);
  asking chat to "fix that bug" redirects to `build` (→ `11`).
- `explore` pauses on a Socratic question, resumes from the next thread message,
  publishes a spec (→ `05` reply gate, `06`).
- `explore` research phases can reach an off-allowlist docs host (open mode) but
  **not** the metadata IP; `publish` runs strict (→ `09`).
- Two rapid messages on one thread are handled in order (→ `11`, Q5.1).
