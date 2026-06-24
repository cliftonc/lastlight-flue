# CLAUDE.md

Guidance for working in **Last Light on Flue** (`lastlight-flue`). Keep this file current — update it when you change the routing pipeline, the discovery rules, the workflow set, or the durability model.

## What this is

A Node.js service that rebuilds the **Last Light** GitHub-maintenance agent on the **Flue** framework (`@flue/runtime`, `@flue/cli`, `@flue/github`, `@flue/slack` — all `1.0.0-beta.3`/`beta.1`). It ingests GitHub webhooks and Slack messages, routes them **deterministically** (no LLM picks the workflow), and runs multi-phase agent workflows (build a PR, review a PR, explore an idea, answer a question, security-scan a repo, …) with **application-owned durability** so a process restart resumes mid-flight.

The design history lives in `design/` (Phases 0–8, each a `phase-N-*.md`) and `spec/`; `design/overall-architecture.md` is the living architecture doc. `FLUE-BETA3-MIGRATION.md` records the beta.2→beta.3 migration and its gotchas. Treat `spec/flue-reference.md` as the empirically-verified Flue API surface.

## Commands

```bash
pnpm dev          # flue dev --env secrets/.env  — watch-mode dev server (port 3583)
pnpm build        # flue build  — compile to dist/server.mjs
pnpm typecheck    # tsc --noEmit
pnpm test         # vitest run  (~980 tests; fast — run it after every change)
pnpm cli          # tsx src/cli.ts  — HTTP client against a running instance
pnpm tunnel       # localtunnel 3583 → public HTTPS (for live webhooks)
```

Node **≥22.19** is required (uses `node:sqlite` `DatabaseSync`). Run a single test file with `pnpm vitest run <path>`. Always run `pnpm typecheck && pnpm test` before considering a change done.

## Discovery rules — the #1 structural gotcha

`flue build` discovers **every IMMEDIATE file** under these dirs as a framework entry (filename = entry name):

- `src/agents/*.ts` → an **agent** (default export from `defineAgent(...)`).
- `src/workflows/*.ts` → a **workflow** (default export from `defineWorkflow({ agent?, input?, run })`).
- `src/channels/*.ts` → a **channel** (named `channel` export for public ingress).
- `src/app.ts` → the Hono entrypoint (mounts `flue()` alongside `/api/*` + `/admin/api/*`).

**Nested files are NOT discovered.** So:

- Co-located tests go in `__tests__/` subdirs (`*.test.ts`). A `*.test.ts` placed as an *immediate* file under `agents/`/`workflows/`/`channels/` becomes a **phantom entry** — Flue inlines its module-eval and the server crashes at load. Never do this.
- Shared helpers (phase bodies, routers, mappers, the run-stores) live in `src/agent-lib/` and other top-level `src/` files — imported by the thin discovered entries, never discovered themselves. `src/events.ts` is deliberately top-level (not under `channels/`) for this reason.

## The ingress pipeline (both channels)

Each channel is a thin shell (`src/channels/github.ts`, `src/channels/slack.ts`); the real logic is in non-discovered `src/agent-lib/*` helpers, unit-tested behind injected seams (no live GitHub/Slack/LLM in tests).

```
native payload
  → (a) DEDUPE        app-owned ring on deliveryId / event_id (channels don't dedupe)
  → (b) SCREEN        deterministic policy (bot/self, managed-repo allowlist, Slack allowlist)
  → (c) MAP           native payload → LastLightEvent  (one normalized Valibot schema)
  → (c′) ENRICH       LastLightEvent → RoutableEvent    (src/agent-lib/event-enrich.ts)
  → (d) ROUTE         code-based decision (+ a cheap classifier/screener on NL only)
  → (e) ADMIT         dispatch(chatAgent) | invokeWorkflow(in-process `invoke`) | resume | reply
```

### Event model & enrichment

- **`LastLightEvent`** (`src/events.ts`) is the single normalized event for every channel. **Snapshot semantics**: `title`/`body`/`labels`/`authorAssociation` are copied at event time and never re-fetched at run time. `conversationKey` (= `channel.conversationKey(ref)`) is the stable thread id. `commentId` (GitHub `comment.id`, on `comment.created`) is the **stable** dedup key the comment workflows re-invoke against — distinct from `id` (the delivery guid, which changes on redelivery). The mapper captures it; `issue-comment`/`pr-comment` payloads **require** it (omitting it crashed admission with `action_input_validation`).
- **`enrichEvent`** (`src/agent-lib/event-enrich.ts`) runs right after MAP in **both** channels and stamps two channel-agnostic derivations onto a `RoutableEvent`:
  - `resolvedRepo` — the repo to operate on: the event's own repo (GitHub), else the configured `EXPLORE_DEFAULT_REPO` (a repo-less Slack message), else `null`.
  - `correlationId` — the stable run/gate id (= `conversationKey`). It doubles as the workflow `runId` (the resume contract) and the reply/approve gate lookup key.

### Routing (code-based, spec/05 invariant)

`routeEvent` in `src/agent-lib/github-router.ts` / `src/agent-lib/slack-router.ts` is a **pure decision function**; the only LLM is a cheap **classifier ∥ injection-screener**, and only on NL maintainer @mentions / Slack messages. The classifier only *refines* an NL message — **CHAT is the safe default**, and the classifier failing falls back to CHAT (never silently launches a build). The screener fails *open*.

Routing order (GitHub comment path): reply-gate short-circuit → @bot mention gate → maintainer gate (non-maintainers get a router-emitted decline) → approve/reject regex → security-review regex → classify∥screen → intent dispatch.

### Workflow input — one builder, both channels

`buildWorkflowInput(workflow, ev, opts)` (`src/agent-lib/workflow-input.ts`) is the **single, shared** mapper from a `RoutableEvent` to a workflow's `--input`. Both routers call it for the cross-channel workflows (`explore`, `answer`, `security-review`). It derives `runId`/`owner`/`repo`/`commentBody` from the enriched event so the input is **schema-valid regardless of origin**. (Historically each router hand-built payloads inline and they drifted from the input schemas — the explore path omitted `runId` entirely and crashed admission with `action_input_validation`.) Every workflow input schema is a loose `v.object` (no `strictObject`), so a superset projection is safe — each schema keeps only the fields it declares. GitHub-only deterministic routes (issue-triage, pr-review, pr-fix, issue-comment, pr-comment, security-feedback) keep their bespoke GitHub-shaped payloads in `github-router.ts`.

When a workflow needs a concrete repo and none resolves (a Slack `explore`/`security` with no `EXPLORE_DEFAULT_REPO`), the Slack router **falls back to CHAT** rather than crash the channel.

### Slack live status (progressive feedback)

The Slack channel shows the user what it's doing, in two beats (`src/agent-lib/slack-thinking.ts`, best-effort, inert without `SLACK_BOT_TOKEN`):

1. **`defaultAck`** fires the generic "Thinking…" indicator at admission — *before* the classifier — via `assistant.threads.setStatus` (anchored on the thread root), falling back to a 👀 reaction in a regular channel. It covers **every** route (chat and all workflows), not just chat.
2. **`defaultNoteRoute`** refines the status once `routeEvent` decides, to a route-specific message (`routeStatusText`): "🧭 Exploring the idea…", "📚 Researching an answer…", "🔒 Running a security review…". CHAT keeps the generic rotating loader.

The `src/app.ts` Slack chat-reply relay clears the status when the turn ends; a workflow's own Slack post clears it too.

### GitHub live status (👀 ack)

The GitHub analogue of `defaultAck` (`src/agent-lib/github-ack-reaction.ts`, best-effort, inert without the GitHub App): `handleDelivery` reacts 👀 **right after enrich, BEFORE the (slow, LLM) classifier and the workflow invocation** — the earliest meaningful point, mirroring Slack's defaultAck. It's gated by `willActOn(ev)` (`github-router.ts`): a cheap deterministic predicate (no LLM, no gate lookup) that mirrors `routeEvent`'s gates — structural issue/PR events always act; a comment must @mention the bot **and** come from a maintainer. So an unrelated comment or one we'll decline gets no reaction; the rare explore reply-gate resume (an un-mentioned reply) routes without an early ack. The reaction targets the *triggering comment* (`reactions.createForIssueComment`, using `ev.commentId`) when present, else the *issue/PR* itself (`reactions.createForIssue`), over a scoped `issues-write` token (minted by the short repo **name**, not the slug — the API 422s on a slug). The `content` is a fixed literal, never model-selectable (distinct from the `github_react_*` model tools in `src/tools/github.ts`). Injected `ack` seam → offline-tested (incl. an ordering guard that the ack precedes the classifier).

## Durability model (the core invariant)

Flue does **not** checkpoint TypeScript workflow `run()` execution and has **no HITL primitive** on the Node target. So durability is split:

- **Flue `PersistenceAdapter` (SQLite, `src/db.ts`)** → durable agent **sessions**.
- **App-owned run-stores** (`src/build-run-store.ts`, `src/explore-run-store.ts`, `src/run-store.ts`) → per-phase done-flags, approval/reply gates, restart counters.
- **Resume = idempotent re-`invoke`**: re-running a workflow with the same app `runId` (= `correlationId`) skips completed phases via the done-flags and lands just past the gate. Approval/reply **gates are 100% application-owned**: `run()` writes `pendingGate=…`, posts the question/asks for approval, and **returns**; an external signal (a GitHub comment, a Slack `/approve`, a thread reply) re-invokes. A per-run restart breaker caps crash loops.

The production invoker calls beta.3's in-process `invoke(workflow, { input })` (`src/agent-lib/invoke-flue-run.ts`, used by `src/crons.ts` `defaultCronInvoker` and both `src/resume.ts`/`src/resume-explore.ts`). It resolves the workflow *definition* from a name→def map (`src/agent-lib/workflow-registry.ts`, dynamically imported so the all-workflows graph stays off the seam callers' module-load path) and admits the run **in-process** (no child `flue run` process). It's an injected seam so tests never touch the real runtime. Two consequences: (1) `invoke()` is **fire-and-forget** — it resolves after admission, not completion, so the run record (not the receipt) is the source of truth; (2) it requires the configured server (`configureFlueRuntime()` ran at boot) — crons start post-boot and resumes are channel-triggered, so this holds. This also keeps the agent transcript **off stdout**: per-delta thinking/message/tool printing lives only in the `@flue/cli` `flue run` presenter, never in the runtime — events still persist to `.data/flue.db` for the admin console.

## Workflows (`src/workflows/*.ts`)

| Workflow | What it does |
|---|---|
| `build` | Multi-phase durable: guardrails → architect → **[approve gate]** → executor → reviewer-loop(review → **[gate]** → fix → recheck) → PR. App-owned `BuildRunStore`. |
| `explore` | Multi-phase durable: read/research → Socratic ask-loop(ask → **[reply gate]** → fold human answer) → synthesize → publish spec. `ExploreRunStore`. Slack origin (no issue) publishes a new issue to `EXPLORE_DEFAULT_REPO`. |
| `answer` | Single-phase sourced answer to a direct question; GitHub: posts + `question`-labels the issue; Slack: replies in-thread. All input fields optional (origin derived internally). |
| `pr-review` | Single-phase formal PR review (`VERDICT:` marker) + deterministic comment post. |
| `pr-fix` | Sandboxed repo-write: fixes a PR on its HEAD branch in a Docker sandbox + deterministic push. |
| `pr-comment` | Single-phase reply to an @mention on a PR (diff context). |
| `issue-comment` | Single-phase reply to an @mention on an issue (+ bot-loop floor + dedup). |
| `issue-triage` | Single-phase classification (`CLASSIFICATION:` marker) + deterministic apply (labels/close/comment). |
| `security-review` | Sandboxed repo-scoped SDLC/diff review in a cloned repo + deterministic filed summary issue. |
| `security-feedback` | Classifies a parsed scan-summary issue (`FEEDBACK:` marker) + deterministic sub-issue creation. |
| `repo-health` | Repo-scoped metrics gather (read tools) + idempotent tracking issue. |
| `gated` | Phase-0 spike: pure-TS durable HITL proof (`model: false`), the template for the app-owned gate pattern. |

Scheduled fan-outs (cron, `src/crons.ts`): repo-health, security-review, issue-triage, pr-review over the managed repos.

## Conventions

- **Testable seams everywhere.** A workflow's `run()` is a thin wrapper over a `run*(ctx, store, deps)` core with an injected `deps` (phase runner, gate poster, publisher) and a real store on temp SQLite. Tests drive the whole loop with **no live model, web, GitHub, or Slack**. Match this when adding a workflow.
- **All user-authored text is untrusted** — wrap it (`wrapUntrusted` / `flagPrefix`) before it reaches a model prompt. The injection screener prefixes flagged bodies.
- **Deterministic egress.** Posting back (comments, labels, Slack replies, the explore spec) is **application code with a bound ref + scoped token**, never a model-selectable write tool. Read tools are injected per-call, scoped to the resolved repo.
- **Scoped tokens.** GitHub access is minted per-run via the GitHub App, downscoped to the target repo + the workflow's permission profile (`src/engine/profiles.ts`, `src/engine/git-auth.ts`).
- **Sandboxes** are per-run self-terminating Docker containers (`src/sandboxes/docker.ts`); the agent initializer is async/per-run and there's no teardown hook (the container `--rm`s itself).
- **Config is fail-open / positive-enable** (`src/config.ts`): a bad JSON layer warns and degrades; gates default closed.

## Config & secrets

- `flue.config.ts` — `defineConfig({ target: 'node' })` from **`@flue/cli/config`** (not `@flue/runtime`). Its `vite` export ignores `.data/**` in the watcher (runtime SQLite `-wal`/`-shm` churn would otherwise reload-loop dev).
- `src/config.ts` — typed resolver; `resolveModel(task)` / `resolveThinking(task)` map tasks → provider/model/thinking level. `managedRepos` is the allowlist; `exploreDefaultRepo` (← `EXPLORE_DEFAULT_REPO`) is the Slack-origin / fallback repo.
- Secrets live in `secrets/.env` (git-ignored), loaded via `flue dev --env secrets/.env`. Key vars: GitHub App (`GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, `GITHUB_APP_PRIVATE_KEY_PATH`, `WEBHOOK_SECRET`); Slack (`SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN`, `SLACK_ALLOWED_USERS`); explorer (`EXPLORE_DEFAULT_REPO`); providers (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`); state paths (`LASTLIGHT_*_RUNSTORE`, `LASTLIGHT_OVERLAY_DIR`). Channels construct with an **offline placeholder** secret when theirs is unset so `flue build`/tests boot without live ingress — live Slack/GitHub stays INACTIVE until the real secret is set.

## Beta.3 reminders

- Workflows: `export default defineWorkflow({ agent, input, run: async ({ harness, input, log }) => … })`. `ctx.payload`→`input`; `ctx.init(agent)` is gone (the runner owns the root harness).
- Agents: `defineAgent(() => ({ sandbox, cwd, subagents }))` — async, per-run; sandbox created inside.
- Tools: valibot `input`/`output` + `run({ input, signal })`, returning structured data (no `JSON.stringify`).
- Our workflows omit a `route` export (no public `POST /workflows/:name`) — they run only via internal dispatch / `flue run`.
