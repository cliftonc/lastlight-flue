---
title: "Overall architecture (living)"
status: "complete — all phases 0–8 folded in (2026-06-21); living doc, update as Flue beta evolves"
---

# Overall architecture (living document)

> This is a **living** doc. Each design phase (0–8) folds its **cross-cutting,
> system-wide** concerns into the sections below and adds a changelog entry. It
> is the place to reconcile decisions that no single phase owns. Per-phase
> detail lives in `design/phase-N-*.md`; only system-wide concerns belong here.
> Process: see `design/CHARTER.md`.

## System shape (one-paragraph north star)
A single Node service (Node ≥22.19): a Hono app mounts `flue()` routing
(`@flue/runtime/routing`) beside the retained Last Light `/api/*` +
`/admin/api/*` routes; `@flue/github` + `@flue/slack` channels admit events;
code-based routing dispatches to Flue agents (chat) via `dispatch(agent,{id,input})`
and `defineWorkflow`s (build/review/triage/…) via `invoke(workflow,{input})`;
workflow agents run in a **custom Docker `SandboxFactory`** (container isolation)
with a per-run scoped GitHub App token — **egress firewall is deferred this
phase** (full network; the default-deny allowlist + metadata SSRF floor are wired
in a later hardening phase, via the re-hosted CoreDNS/nginx stack or E2B); because
**Flue workflows are not resumable**,
durability is split — Flue's `PersistenceAdapter` makes **agent sessions**
durable while an **application-owned run record** (`run-store.ts`) carries phase
progress, approval gates, and `restart_count`; resume is an idempotent
re-`invoke`. Workflow/agent modules **omit `route`** (driven only via
`invoke`/`dispatch`); channels' `channel` export is the sole Flue-served public
ingress. The admin dashboard + `lastlight` CLI observe it via an
**application-owned `/admin/api/*`** built on Flue's `listRuns`/`getRun`/
`listAgents` inspection primitives (Flue ships no admin HTTP surface; **there is
no "Flue Studio" in beta.2** — that earlier assumption was stale).

> **Pins (2026-06-21):** `@flue/runtime` 1.0.0-beta.2; Pi core
> `@earendil-works/pi-agent-core`/`pi-ai` `^0.79.4`; Hono `^4.8.3`. Beta —
> re-verify per phase.

## Cross-cutting concerns

### Runtime & Pi
- Node ≥22.19. Single Hono app; `app.route('/', flue())` mounts Flue routing
  beside custom routes. `dispatch(agent,{id,input})` (conversational) and
  `invoke(workflow,{input})` (workflow runs) are the **single admission
  boundary** (the `dispatchWorkflow()` analogue). [P0]
- Pi core pinned via Flue beta.2 at `@earendil-works/pi-agent-core@^0.79.4` —
  same lineage as Last Light's `agentic-pi`. [P0]
- Agents: `defineAgent(() => …)` or **`async`** form (load-bearing — sandbox is
  created inside the async initializer). The initializer is **not a singleton
  constructor** — it "runs whenever a runner initializes a root harness," so a
  **fresh sandbox is created per `invoke`/run**. [P0,P3]
- **A phase = `harness.session()` + `session.prompt(text, opts)`**;
  `PromptOptions` confirms **per-operation `model` + `thinkingLevel` overrides**
  (resolves Q1.1) plus `result` (Valibot structured output), `tools`, `signal`,
  `images`. `PromptResponse` carries `{ text, usage, model }`. `harness.shell`/
  `harness.fs` run in the sandbox **off-transcript** (git plumbing/handoff
  staging). `defineWorkflow` takes a top-level **`output`** Valibot schema. [P3]

### Sandbox & egress  ⚠ (#1 risk — sandbox DECIDED; egress DEFERRED this phase)
- **Sandbox = a custom Docker `SandboxFactory`** (`src/sandboxes/docker.ts`):
  Flue sandboxes are bring-your-own (e2b/daytona/modal are *blueprints*, not
  packages — only the `SandboxFactory`→`SandboxApi` interface + `local()`/virtual
  are built in), so Docker is as first-class as any provider. A container per
  run, workspace mounted, `SandboxApi` (`exec`/`readFile`/`writeFile`/…)
  implemented via `docker exec`/file I/O. Created inside `defineAgent(async () =>
  …)` so the app owns all options. `local()` stays for quick dev. [P0]
- **⚠ Egress DEFERRED this phase.** The Docker factory gives **container
  isolation only** — containers run with **full network and no SSRF floor**. A
  known, temporary, recorded risk; don't run untrusted input or prod creds
  through it. The default-deny allowlist + metadata SSRF floor are **not yet
  wired**. [P0]
- **Egress hardening (later phase, required before prod) — pick one:** (1)
  **re-host** Last Light's CoreDNS-sinkhole + nginx-SNI-peek stack into the Docker
  factory's network, fed by the ported `egress-allowlist.ts` + the metadata SSRF
  floor (most faithful, fully local); or (2) switch the prod sandbox to **E2B**
  `Sandbox.create({ network: { allowOut, denyOut } })` with the CIDR floor in
  `denyOut`. Record the choice in `00` risk #1 when it lands.
- **⚠ Web search is NOT a Flue built-in** (no `web_search`/`web_fetch`/tavily/
  brave/exa anywhere in the repo). Implement as gated `web_search`/`web_fetch`
  `defineTool`s (Tavily>Exa>Brave) on the `explorer` agent only — reproducing
  Last Light's opt-in-per-phase. Corrects `flue-reference §6`/`09`. [P5]
- **Residual risk (carried, for when egress IS hardened):** SNI-peek without TLS
  termination — a hostname whose cert/SNI is allowlisted but resolves to a private
  IP isn't caught. Identical caveat to Last Light's docker firewall.
- **Env injection:** Flue passes `env` **per-`exec`, not per-session**. Long-lived
  run env (scoped token, provider keys) is baked into the container at create
  (`docker run -e …` / `Sandbox.create({ envs })`) at agent-init. [P0] (Open Q0.1
  — verify Pi bash doesn't clobber the baked env.)

### Persistence & durability  ⚠ (Flue workflows aren't resumable; sessions are — DECIDED model in Phase 0)
- **Confirmed:** Flue workflows do not checkpoint; resume = re-`invoke` as a new
  execution. Node sessions are in-memory until `src/db.ts` exports a
  `PersistenceAdapter` (`sqlite()`/libsql/`postgres()`). [P0]
- **Two-store model:** (1) Flue `PersistenceAdapter` → durable **agent sessions**
  (messages + compacted context = the transcript). (2) **Application-owned run
  record** (`run-store.ts`, raw sqlite) → phase-done flags, scratch pointers,
  approval gate state, `restart_count`, idempotency keys. [P0]
- **Resume = idempotent re-`invoke`.** Per-`(run,phase)` done flags in the run
  record reproduce `shouldRunPhase` ("skip completed phases"). `dispatchId` is
  the Flue-native idempotency correlator for dispatched (chat) input. [P0]
- **No Flue HITL/suspend primitive exists** (absent from current durable-exec
  docs). The approval/reply gate is **entirely application-side**: workflow writes
  `pending` to the run record and returns; external signal calls
  `resume(runId,decision)` → idempotent re-`invoke`. [P0]
- **Per-phase named durable sessions** carry the transcript:
  `harness.session(name)` is get-or-create, so each build phase opens
  `architect`/`executor`/`reviewer:N`/`fix:N`/`recheck:N`. But **cross-phase
  handoff is via committed branch files** (`harness.fs`/git), **not** session
  memory — resume re-`invoke`s and re-creates sessions, so in-session context is
  convenience, not the contract (`07`). [P4]
- **App run record = the resume contract** (`run-store.ts`): `phasesDone`
  (idempotency keys ≡ `shouldRunPhase`), `scratch` (**pointers only**, no blobs),
  `pendingGate`, `reviewerCycle`, `restartCount` (cap 3), `status`. Resume passes
  a per-gate `resumedGate` re-entry token (reviewer gate carries the cycle). [P4]
- **Two complementary breakers:** Flue `DurabilityConfig` (`maxAttempts`=10,
  `timeoutMs`=1h default, per submission — provider crash/runaway) **+** app
  `restart_count` (cap 3, per resume re-invoke — `06` requirement). [P4]
- **⚠ Subagents are NOT the architect/executor/reviewer split.** `session.task`
  subagents run **inside one parent operation** and **forbid `durability`**, so
  they can't span a gate or be the resumable role boundary. The roles are
  **separate top-level sessions in `run()`**. Subagents reserved for non-durable
  inner delegation only. (Corrects `flue-reference §2`/`01`.) [P4]
- **Chat = a durable Flue agent per thread.** `dispatch(chatAgent, {id:
  conversationKey})` keys one continuing instance; the `PersistenceAdapter` makes
  that session durable → **replaces** `messaging_sessions`/`messaging_messages` +
  the manual 50-message rehydrate **and** the `read_skill` tool (native skills).
  Chat has **no `sandbox`** + read-only tools → cannot edit/commit (`11`). [P5]
- **Reply gate (Socratic) = approval-gate machinery with a message resolver:**
  run record `pending='reply:<iter>'` + `resume(runId,{reply})` folds the next
  thread message into `scratch.socratic` and re-enters the loop. [P5]
- **P7 finalization:** the **app run-store** (resume contract + per-phase **stats
  rollups** from `PromptResponse.usage`/`.model` + **messaging-thread grouping**)
  and **Flue's `RunStore`/`EventStreamStore`/agent-session store** share **one**
  sqlite/libsql file; additive migrations; `@flue/runtime/test-utils`
  store-contract test guards the Flue side. Single-pass (non-gated) workflows
  keep no run record beyond stats — a crash just re-`invoke`s the whole pass
  (must be idempotent; `answer`/`security-feedback` need a posted-marker dedup —
  Q5.4). [P7]

### Auth & security
- Scoped GitHub App token + provider keys delivered to the sandbox via E2B
  `Sandbox.create({ envs })` at agent-init (per-run blast radius). [P0]
- **GitHub App token spine (ported verbatim):** `git-auth.ts` mints a per-run
  installation token, **downscoped** by permission profile + a **repo-name
  allowlist** baked into the token; `profiles.ts` holds
  `GITHUB_PERMISSION_PROFILES` (`read`/`issues-write`/`review-write`/`repo-write`).
  Both are runtime-independent → port unchanged. [P1]
- **⚠ Naming collision:** Flue's agent **`profile`** option (reusable agent def)
  ≠ Last Light's **`GitAccessProfile`** (GitHub permission). Keep distinct in code
  (`gitAccess`/`GitAccessProfile`); never overload Flue's `profile` key. [P1]
- **GitHub mutations = bound `defineTool` factories** (`src/tools/github.ts`):
  `owner/repo/issueNumber` + token are **closed over from trusted code**, not
  model-selected (Flue rule: tool args are not an auth boundary). **Profile gates
  which tools even exist** (defense in depth beside token scope). The stdio
  `mcp-github-app` is **retired** — reimplemented as `defineTool`s (Flue MCP is
  HTTP-only; defineTool gives the bound-credential pattern). [P1]
- **High-stakes side-effects are DETERMINISTIC WORKFLOW CODE, not model tools.**
  Posting a PR review (and, later, opening PRs / pushing) is done by **`run()`
  calling Octokit over the scoped token**, gated by the parsed `VERDICT:` marker
  — the model never holds the submit action. A **change from the reference**,
  where the agent posted via the github MCP tool. The model keeps **read-only**
  GitHub `defineTool`s to do its job. Self-authored PR → `COMMENT` (can't approve
  own PR). [P3]
- **PEM wall:** only the `repo-write` agent gets a PEM-readable path; never in
  env/args for other profiles. Host-side `git-auth.ts` mints the per-run token
  and injects it into the E2B sandbox via `Sandbox.create({envs})`; the PEM
  never enters the sandbox except the `repo-write` controlled path. [P0/P8]
- **Prompt-injection screening = the cheap single-shot LLM path, in the channel
  callback** (`screen.ts`/`classifier.ts`/`llm.ts` ported). Screener ∥ classifier
  run in parallel and **only on maintainer NL comments / Slack messages**;
  **screener fail-open, classifier fail-CHAT** (`05`). Flagged input reaches the
  agent **prefixed `[lastlight-flag: …]`, not blocked**; `agent-context/
  security.md` makes the agent treat flagged + `<<<USER_CONTENT_UNTRUSTED>>>`
  content as data. Untrusted-content handling stays **agent-side**. [P5,P6]
- **Web tools are bounded `defineTool`s, not a model-chosen URL/key.** `web_fetch`
  runs in **tool code** — if that executes harness-side it bypasses the sandbox
  egress firewall and needs its own host-side allowlist (Open Q5.3). [P5]

### API & compatibility surface
- **One Hono `app.ts`** is the deploy entrypoint + default export; `app.route('/',
  flue())` mounts Flue's routes (`/agents`,`/workflows`,`/runs`,`/channels/*`,
  `/openapi.json`) **beside** app-owned `/health`, `/api/*`, `/admin/api/*`. One
  listener, one port. [P2]
- **Opt-in transports:** a workflow/agent is publicly invocable **only if its
  module exports `route`**; ours **don't** — they run exclusively via
  `invoke`/`dispatch` from our trigger routes + channel callbacks. "An agent used
  only through `dispatch(...)` needs no public transport export." Channels'
  `channel` export is the **sole** Flue-served public ingress. [P2]
- **`/api/*` trigger routes** (`/api/run`,`/api/build`,`/api/chat`) bypass the
  EventEnvelope and call `invoke`/`dispatch` directly with a `_triggerType` tag
  (cli/admin/cron) — the single admission boundary. CLI/admin/cron are
  pre-decided; the router decides for channel events (P6). [P2]
- **`/admin/api/*` is 100% application-owned** — Flue ships **no** admin HTTP
  surface. Re-backed by the server-side inspection primitives
  `listRuns()`/`getRun()`/`listAgents()` (`@flue/runtime`) + the app run record.
  `listRuns()` returns **pointers** (every field except `input`/`result`/`error`)
  → the `10` "list queries exclude blobs" invariant is **native**. Thin
  pass-through in P2; full shape-parity re-back in **P7** (risk #3). [P2]
- **`src/cli.ts` ported unchanged** — already an HTTP client against
  `/api`+`/admin/api`; only the server it talks to moved. `@flue/sdk`
  (`createFlueClient`) is reserved as an optional future path, not adopted. [P2]

### Event ingress & routing
- **Ingress = Flue channels** (`@flue/github` `createGitHubChannel`, `@flue/slack`
  `createSlackChannel`); the `channel` export is the sole Flue-served public
  ingress (P2). `/channels/github/webhook` (native HMAC, JSON-only, `2xx`<10s,
  dedupe on `deliveryId`) and `/channels/slack/{events,interactions,commands}`
  (exact-byte signature; `commands` = `/approve`/`/reject`). [P6]
- **The router lives INSIDE the channel callbacks** — deterministic type table →
  `invoke` (**no LLM**, `05`); classifier ∥ screener (cheap LLM) only for
  maintainer NL; maintainer-gate decline emitted by the router; **reply-gate
  short-circuit** = `runStore.pendingReplyGate(conversationKey)` → `resume(...)`
  before mention parsing. Connectors/registry/standalone-router **deleted**;
  `classifier.ts`/`screen.ts`/`llm.ts`/`mrkdwn.ts` **kept**. [P6]
- **Normalization moved to the callback** → one internal **`LastLightEvent`**
  Valibot schema; snapshot fields copied at event time; **`conversationKey`
  replaces `raw.*`/`triggerId`** (`04`). [P6]
- **Slack transport: Socket Mode → HTTP Events API** (needs the public URL GitHub
  already requires). **Never persist** `trigger_id`/`response_url`. [P6]

### Observability
- `@flue/opentelemetry` adapter (fed by `LASTLIGHT_OTEL_*`) — wired in P7.
- **⚠ CORRECTION (P2): there is no "Flue Studio".** Grep of the docs tree → zero
  `studio` hits; CLI = `init|dev|connect|run|build|add|update|docs`. `flue dev`
  is a **watch-mode local dev server (port 3583)**, not a run/session inspector.
  The earlier "Studio alongside the dashboard" framing (`flue-reference §10`,
  `01`, `10`) is stale. Live inspection = retained dashboard (re-backed P7) +
  OTEL + raw `GET /runs/:id` Durable-Streams reads + `listRuns`/`getRun`. [P2]
- **⚠ Tool-family classifier breaks:** the old dashboard classified tools by the
  `mcp_github_*` name prefix. New `defineTool` names don't carry it → the Phase 7
  admin re-back must classify on the new tool names. [P1]
- **Per-phase token/cost/model metrics have a NATIVE source:**
  `PromptResponse.usage` (PromptUsage — aggregated tokens + cost across the
  operation's turns) + `PromptResponse.model` (`{provider,id}`). Each phase
  records these to the app stats table — **no jsonl shim needed for metrics**.
  Reduces risk #3 for the Phase 7 re-back. [P3]
- **Durable run/session shape CONFIRMED queryable** (`data-persistence-api`):
  `RunStore` (`createRun`/`endRun`/`getRun`/`lookupRun`/`listRuns`),
  `EventStreamStore` (append-only per-run/per-agent event log = the JSONL
  replacement; paths `runStreamPath(runId)`, `agentStreamPath(name,id)`),
  `SessionStore` + `SessionData` (transcript; `metadata` is app-owned, Flue never
  touches it). Phase-7 re-back validated against this. [P2]
- **P7 admin re-back (risk #3 RESOLVED, mostly):** run list/detail and transcripts
  are natively reproducible — `listRuns` (pointers, blob-free) / `getRun` for
  list+detail; `EventStreamStore.read(runStreamPath(id))` and
  `agentStreamPath('chat', instanceId)` for run + chat transcripts (the **JSONL
  shim + `SessionReader`/`ChatSessionReader` are RETIRED**). The only app-owned
  gaps are **stats rollups** + **messaging-thread grouping** (small app tables).
  A thin read-endpoint adapter shapes `EventStreamStore` events for the existing
  SPA renderer (Open Q7.1). `@flue/opentelemetry` wired here. [P7]

### Configuration
- `flue.config.ts` → `defineConfig({ target: 'node' })`; `.env` loaded via
  `flue build/dev/run/connect` (`--env` selects one alternate). [P0/P1]
- **Typed `src/config.ts`** with `resolveModel(task)` (→ `provider/model`
  specifier) and `resolveThinking(task)` (→ `thinkingLevel`). Per-task
  `models`/`variants` maps with **fail-open JSON parse** (typo → warn + default,
  never blocks boot); **positive-enable** approval gates; legacy `OPENCODE_*`/
  `LASTLIGHT_*` env aliases tolerated during migration. [P1]
- **Reasoning effort = `thinkingLevel`** (`off|minimal|low|medium(default)|high|
  xhigh`) — a first-class agent option, settable per-agent and overridable per
  `prompt`/`skill`/`task`. **Maps 1:1 onto Last Light's variant vocabulary.** [P1]
- Provider auth env matches Last Light (`ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/
  `OPENROUTER_API_KEY`); catalog providers need no registration.
  **`registerProvider(id,{baseUrl,apiKey,headers})`** in `app.ts` is the hook for
  gateway/proxy routing without changing model specifiers (reserved for the
  OTEL/gateway story + direct-provider-route cost preference). [P1]
- **Local secrets (developer machine) — `secrets/` (git-ignored, never commit):**
  present on this machine so the build can run without re-prompting:
  - `secrets/lastlight.2026-04-03.private-key.pem` — GitHub App PEM (the
    `repo-write` PEM wall; point `GITHUB_APP_PRIVATE_KEY_PATH` here).
  - `secrets/.env` — supplies **`GITHUB_APP_ID` / `GITHUB_APP_INSTALLATION_ID` /
    `GITHUB_APP_PRIVATE_KEY_PATH` / `WEBHOOK_SECRET`** (GitHub channel) and
    `MODAL_TOKEN_ID`/`MODAL_TOKEN_SECRET`.
  - ⚠ **Still missing for the build** (the loop must stop and ask, or these must
    be added to `secrets/.env`): a **Pi/provider key** (`ANTHROPIC_API_KEY` or
    equivalent), the **`E2B_API_KEY`** (Phase 0 sandbox/egress), and **Slack**
    secrets (`SLACK_SIGNING_SECRET`, bot token) for Phase 5/6. The current `.env`
    also carries unrelated Discord/Browserbase/Hermes/terminal-tooling vars from
    another project — harmless, but not part of this build's contract (`02`). [P0]

### Testing strategy
- `@flue/runtime/test-utils` exports `define-store-contract-tests` — runs against
  any `PersistenceAdapter` (validate the libsql/sqlite adapter + any extension). [P0]
- Vitest; eval-style tests (`examples/vitest-evals`); **golden phase-sequence
  tests** for workflows asserting the exact session-name order incl. loop
  iterations (`reviewer:0`/`fix:0`/`recheck:0`/`reviewer:1`). [P4]
- **Frontmatter audit test** — every `SKILL.md` parses (Flue/Pi silently drops
  ones missing `name`/`description`). [P1]
- **Behavioral dual-run diff** is the cutover gate (P8) — drive every workflow on
  both stacks against a test repo and diff outcomes. [P8]

### Deployment & cutover
- **Built artifact:** `flue build --target node` → `dist/server.mjs` (Hono); start
  `node dist/server.mjs`. **Listens on `PORT` (default 3000) — set `PORT=8644`**
  to preserve Last Light's port. The built server reads **only env supplied at
  boot** (`.env` is build-time only) → production must `source .env`/inject env at
  start. `node_modules` required at runtime (deps externalized, not bundled). [P2]
- **Boot order strict** (config→db→routes→crons→orphan-recovery→ready); **exit
  78** reproduced in `boot.ts` preflight for bad required config; SIGINT/SIGTERM
  stop crons + close the store. [P2]
- **Prod topology:** `node dist/server.mjs` on the host (`PORT=8644`, env at
  boot, `npm ci --omit=dev`); **sandbox = the Docker `SandboxFactory`** (the dev
  sandbox, hardened with egress before prod) **or** E2B off-host — TBD at the
  egress-hardening phase. If egress is hardened by **re-hosting** the CoreDNS/nginx
  stack into the factory, that stack is **kept**, not deleted; it is deleted only
  if prod moves to **E2B** (`allowOut`/`denyOut`). `egress-allowlist.ts` is **kept**
  either way (feeds whichever mechanism). The OTEL collector sidecar
  is gone (sandboxes off-host → `@flue/opentelemetry` exports directly). [P8]
- **Secrets at boot, not in the image:** PEM host-side mode-600; scoped token
  into the sandbox via `Sandbox.create({envs})`; provider/E2B/Slack/webhook/
  ADMIN/OTEL keys via an env file. Process supervisor honors exit `78`. [P8]
- **Cutover = stand up alongside → dual-run behavioral diff on a test repo →
  egress sign-off on the real E2B account → flip GitHub/Slack ingress URLs →
  delete the docker stack → park the old stack one cycle for rollback.** Paused
  runs survive via the shared DB; `recoverOrphanRuns` re-invokes active runs. [P8]

## Decision & deviation log
_Record any research-forced deviation from a spec locked-decision or invariant._

| Date | Phase | Decision / deviation | Why |
|---|---|---|---|
| 2026-06-21 | 0 | **Egress (risk #1) DECIDED: E2B provider-enforced allowlist**, not the docker re-host fallback. | E2B `Sandbox.create({network:{allowOut,denyOut}})` gives SNI-based domain allowlisting + default-deny — same semantics as Last Light's nginx stack, sourced from the ported `egress-allowlist.ts`. Satisfies spec `09` Option 1. |
| 2026-06-21 | 0 | **SSRF floor via explicit CIDR `denyOut` (`169.254.0.0/16`)**, not provider default. | E2B does **not** auto-block metadata IPs; the floor must be set by us, and works in both strict and open modes (CIDR is allowed in `denyOut`; domains are not). |
| 2026-06-21 | 0 | **SUPERSEDES the two rows above. Sandbox = a custom Docker `SandboxFactory`; egress DEFERRED this phase.** | User decision: take container isolation now (Docker is on the host; no E2B account/key needed), and drop the egress firewall for this phase — dev containers run with full network + no SSRF floor (known, temporary, recorded risk). Egress hardening (re-host CoreDNS/nginx into the factory, or switch prod to E2B `allowOut`/`denyOut` + CIDR floor) is a later phase, required before prod. The E2B/SSRF detail above is retained as the eventual-hardening reference. `00` risk #1 + `09` updated. |
| 2026-06-21 | 0 | **Approval/HITL gate is 100% application-owned**; no reliance on any Flue suspend primitive. | Current `durable-execution` docs describe **no** suspend/approve/HITL API — only durable sessions + idempotency keys. Strengthens spec `06`'s "run record + re-invoke" decision; not a divergence from an invariant, but the absence is recorded. |
| 2026-06-21 | 0 | **Run env baked into `Sandbox.create({envs})`**, not Flue session env. | Flue injects `env` **per-`exec` only**; there is no session-level env map. The scoped token must persist for the whole run, so it goes in at sandbox creation. (Open Q0.1 to verify Pi bash doesn't clobber it.) |
| 2026-06-21 | 1 | **DRIFT CORRECTION:** variant/reasoning-effort = Flue **`thinkingLevel`** (`off\|minimal\|low\|medium\|high\|xhigh`), not an opaque Pi `--variant`. | `docs/guide/models.md` exposes `thinkingLevel` as a first-class agent option with **exactly** Last Light's six-level vocabulary; `resolveVariant`→`resolveThinking` maps 1:1. Corrects `flue-reference.md §2`. |
| 2026-06-21 | 1 | **Retire `mcp-github-app`; reimplement GitHub actions as bound `defineTool` factories.** | Flue MCP is HTTP-only (`connectMcpServer({url})`); a stdio server needs an HTTP wrapper. `defineTool` factories give the credential-closed-over pattern the spec wants and remove a co-process for cutover. |
| 2026-06-21 | 2 | **DRIFT CORRECTION: "Flue Studio" does not exist in beta.2.** Dropped "Studio alongside the dashboard" from the north star + `01`/`10`/`flue-reference §10` framing. | Docs-tree grep for `studio` → zero hits; CLI is `init\|dev\|connect\|run\|build\|add\|update\|docs`. `flue dev` is a watch-mode dev server (3583), not an inspector. Inspection = dashboard + OTEL + `GET /runs/:id` + `listRuns`/`getRun`. |
| 2026-06-21 | 2 | **Listener owned by built server; port via `PORT` (default 3000), not chosen in `app.ts`.** Preserve `8644` by setting `PORT=8644`. | `flue build --target node` → `dist/server.mjs` listens on `PORT`; the shared-listener invariant (`01`) is preserved by env, not code. Built server reads env at boot, not `.env`. |
| 2026-06-21 | 2 | **Workflow/agent modules omit `route`; `/admin/api/*` is fully app-owned.** | Flue makes a module public only via `route`/`runs`/`channel` exports, and ships no admin HTTP surface; our work is driven by `invoke`/`dispatch` + channel callbacks, and admin reads use `listRuns`/`getRun`/`listAgents`. Not a divergence from an invariant — confirms `01`/`10`. |
| 2026-06-21 | 3 | **Review submission moves from a model MCP tool to deterministic workflow code** (Octokit over the scoped token, gated by the parsed `VERDICT:` marker). | Change from the reference (agent posted the review itself). Flue's "tool args are not an auth boundary" rule + `03`'s "deterministic posts as app code." The model keeps read-only GitHub tools; self-authored PR → `COMMENT`. |
| 2026-06-21 | 3 | **Q1.1 RESOLVED:** per-operation `model` + `thinkingLevel` overrides confirmed on `PromptOptions`. | `docs/api/agent-api/` `PromptOptions` lists `result`/`tools`/`model`/`thinkingLevel`/`signal`/`images`. Per-phase variant overrides = `session.prompt(text, {thinkingLevel: resolveThinking('review')})`. Not a deviation — confirmation. |
| 2026-06-21 | 4 | **Architect/executor/reviewer are separate top-level `harness.session(name)` calls, NOT subagents.** | Subagents (`session.task`) run inside one parent operation and **forbid `durability`** (definition-time error) — they can't span an approval gate nor be the resumable boundary. Corrects `flue-reference §2`/`01`'s "subagents" suggestion. |
| 2026-06-21 | 4 | **Two breakers, not one:** keep app `restart_count`(3) AND set Flue `DurabilityConfig.maxAttempts`/`timeoutMs`. | They protect different failures — app breaker caps *resume re-invokes* (`06`); Flue's caps per-submission provider crashes/runaways. Both needed. |
| 2026-06-21 | 5 | **DRIFT CORRECTION: Flue has NO built-in `web_search`/`web_fetch`.** Implement them as gated `defineTool`s (Tavily>Exa>Brave) on the `explorer` agent only. | Repo grep for `web_search\|web_fetch\|tavily\|brave\|exa` → zero hits. `flue-reference §6`/`09` assumed a Pi-provided web tool; stale. Reproduces Last Light's opt-in-per-phase via tool code (not model-chosen URL/key). |
| 2026-06-21 | 5 | **Chat = a durable Flue agent (no sandbox); `messaging_sessions`+manual rehydrate+`read_skill` are RETIRED.** One Pi runtime (no separate pi-ai chat path). | Flue's per-`id` durable session + native `skills:` give the same continuity + progressive disclosure. Collapses Last Light's pi-ai/agentic-pi split to "agent with/without a `sandbox`". (Confirm latency — risk #5; serialization — risk #6.) |
| 2026-06-21 | 6 | **Normalization + the whole router move INTO the channel callbacks; connectors/registry/standalone-router deleted.** Internal `LastLightEvent` (Valibot) kept despite Flue's "no parallel normalized model" guidance. | Last Light is multi-source and its workflows are written against one event shape; the channel callback is where native payload → `LastLightEvent` mapping + code-based routing live. Honors `04`/`05` invariants; `conversationKey` replaces `raw.*`/`triggerId`. |
| 2026-06-21 | 6 | **Slack transport: Socket Mode → HTTP Events API.** | `@flue/slack` is signing-secret + HTTP (`/channels/slack/events`), not Socket Mode. Needs the public URL GitHub webhooks already require; user-allowlist + bot-filtering re-implemented in `events()`. `trigger_id`/`response_url` never persisted. |
| 2026-06-21 | 7 | **JSONL shim + `SessionReader`/`ChatSessionReader` RETIRED; transcripts come from `EventStreamStore`.** Risk #3 resolved against real source. | `RunStore.listRuns` pointers are blob-free natively (`10` invariant); `EventStreamStore.read(runStreamPath/agentStreamPath)` is the transcript source. Only app-owned gaps: stats rollups + thread grouping (small tables). Tool-family classifier must key on `defineTool` names, not `mcp_*`. |
| 2026-06-21 | 8 | **The entire docker egress stack (coredns/nginx/collector + configs + `docker.ts`) is DELETED; E2B `allowOut`/`denyOut` is the firewall.** `egress-allowlist.ts` kept (feeds E2B). | Locked-decision realization ("swap docker/coredns/nginx for a Flue sandbox blueprint"). Gated on the Phase-0 egress sign-off on the real E2B account before deletion; residual SNI-without-TLS caveat stays documented (identical to today). |

## Changelog
| Date | Phase | What changed here |
|---|---|---|
| (seed) | — | Skeleton created before Phase 0. |
| 2026-06-21 | 0 | North star written; Runtime/Sandbox-egress/Persistence/Auth/Config/Testing sections populated; egress + HITL + env-injection decisions logged. Pins: runtime beta.2, pi `^0.79.4`, Hono `^4.8.3`. Risk #1 moved from "open" to **decided (E2B allowlist + metadata CIDR floor)**. |
| 2026-06-21 | 1 | Config section filled (`resolveModel`/`resolveThinking`, `thinkingLevel` drift correction, `registerProvider`); Auth section gained the git-auth/profiles spine, the `GitAccessProfile`≠Flue-`profile` collision, and the bound-`defineTool`/MCP-retirement decision; Observability seeded (tool-family classifier breakage). pi-ai latest `0.79.9`. |
| 2026-06-21 | 2 | **API & compatibility surface** section filled (Hono `app.ts`, opt-in `route` transports, `/api/*` envelope-bypass dispatch, app-owned `/admin/api/*` on `listRuns`/`getRun`/`listAgents`, CLI retained). **Deployment & cutover** seeded (built `dist/server.mjs`, `PORT` default 3000, boot order, exit 78, shutdown). **Observability** corrected: **no Flue Studio**; confirmed `RunStore`/`EventStreamStore`/`SessionStore` queryable shape for the P7 re-back. North star + Studio claims corrected. |
| 2026-06-21 | 3 | Runtime/Pi section gained the phase=`session.prompt(opts)` shape + per-op `model`/`thinkingLevel` (Q1.1 resolved) + `defineWorkflow.output` + per-`invoke` sandbox. Auth section gained the **deterministic-side-effects** rule (review posted by workflow code, not a model tool). Observability gained `PromptResponse.usage`/`.model` as the native per-phase metrics source (reduces risk #3). |
| 2026-06-21 | 4 | Persistence section deepened: app run-record resume contract (`phasesDone`/`scratch`-pointers/`pendingGate`/`reviewerCycle`/`restartCount`), per-phase **named durable sessions** with **committed-file handoff**, two complementary breakers, and the **subagents-are-not-the-role-split** correction. Carries the two highest-risk unknowns Q4.1 (does re-`invoke` reattach the same named sessions / affinity key) + Q4.2 (does `invoke` dedupe on runId → may need app-runId ≠ Flue-runId). |
| 2026-06-21 | 5 | Sandbox section gained the **no-built-in-web-search** correction (gated `defineTool`s); Persistence gained **chat = durable agent (no sandbox)** replacing the messaging store + `read_skill`, and the reply-gate machinery; Auth section's screening line filled (cheap-LLM screener ∥ classifier, fail-open/fail-CHAT, flag-not-block, agent-side untrusted handling). Carries Q5.1 (per-thread serialization) + Q5.2 (chat latency) + Q5.3 (web_fetch egress). |
| 2026-06-21 | 6 | New **Event ingress & routing** section: Flue channels are the sole public ingress; the router + classifier + screener move into the channel callbacks (code-based, no LLM picks the workflow); `LastLightEvent` Valibot mapper; reply-gate short-circuit; connectors/registry deleted, classifier/screen/llm/mrkdwn kept. Slack Socket→Events API logged. |
| 2026-06-21 | 7 | Observability section finalized: **risk #3 resolved** — `listRuns`/`getRun` + `EventStreamStore` re-back the admin API; **JSONL shim + SessionReader retired**; stats rollups + thread grouping are the only app-owned gaps; OTEL wired; one DB file, contract-tested. Carries Q7.1 (event→SPA envelope shape) + Q7.2 (instanceId = conversationKey). |
| 2026-06-21 | 8 | Deployment section finalized: prod = `node dist/server.mjs` (`PORT=8644`, env-at-boot) + E2B off-host; **entire docker egress stack DELETED** (E2B `allowOut`/`denyOut` is the firewall, `egress-allowlist.ts` feeds it); secrets at boot; cutover = dual-run diff → egress sign-off → flip ingress → delete → park old stack. Carries Q8.1 (listen/signal control) + Q8.2 (E2B egress fidelity) + Q8.3 (DB migration) + Q8.4 (E2B cost/latency). **All 9 phases complete.** |
