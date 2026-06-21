---
title: "Phase 2 — Server + preserved API surface"
phase: 2
status: "design complete"
flue_pin: "@flue/runtime 1.0.0-beta.2 (withastro/flue@main, pushed 2026-06-21); built server = Hono, port 3000 default (PORT env)"
date: 2026-06-21
---

# Phase 2 — Server + preserved API surface

## Scope

Stand up the single Hono app with the **full Last Light compatibility contract**
so the existing `lastlight` CLI + admin dashboard keep working from here on
(`01`, `03`, `10`). `src/app.ts` = Hono + `flue()` + crons + the ported `/api/*`
and `/admin/api/*` routes; trigger routes call `invoke`/`dispatch`; `src/cli.ts`
ported unchanged (it is already an HTTP client); `78`/graceful-shutdown
semantics; observability surface (Studio correction below). Deliverable:
`lastlight status` / `/health` green, dashboard loads, runs inspectable.

## Current Flue research

Re-verified `2026-06-21` against `withastro/flue@main` (pushed `2026-06-21T06:40Z`,
`@flue/runtime` **1.0.0-beta.2**) + docs `.../index.md`.

### `app.ts` is an ordinary Hono app — custom routes coexist with `flue()`
Source: `packages/runtime/src/routing.ts` + `docs/guide/routing/index.md`
(`lastReviewedAt: 2026-06-20`). **Confirmed exactly as `01`/`03`/`flue-reference §9`
assumed:**
- `src/app.ts` is **optional**; when present its default export (any `Fetchable`,
  i.e. a `new Hono()`) **owns the request pipeline** and must mount `flue()`
  explicitly: `app.route('/', flue())`. Without it Flue auto-generates an app
  mounting `flue()` at `/`.
- Custom routes, middleware (auth), and a `/health` route compose on the same
  Hono app: the routing guide's canonical example registers
  `app.get('/health', …)`, `app.use('/agents/*', requireUser)`, then
  `app.route('/', flue())`. **This is our model verbatim.**
- A custom route can `dispatch(...)`/`invoke(...)` directly — the guide's
  `app.post('/webhooks/support-comments', …)` verifies & normalizes, then
  `dispatch(agent,{id,input})`, returning the receipt with `202`. **This is
  exactly how `/api/run` + `/api/build` will admit work.**
- Mount-prefix supported (`app.route('/api', flue())`) — *we won't use it*; our
  `/api/*` is Last-Light-owned, distinct from Flue's `/agents`,`/workflows`,
  `/runs`,`/channels`.

### `flue()` sub-app — the public Flue routes (we expose almost none of them)
Source: `docs/api/routing-api/index.md`. `flue(): Hono` mounts:
`GET /openapi.json`, `POST|GET|HEAD /agents/:name/:id`,
`POST /workflows/:name`, `GET|HEAD /runs/:runId` (+ `?meta` JSON view),
`* /channels/:name/*`.
- **Opt-in transports (load-bearing for us):** "Mounting `flue()` does not make
  every discovered agent or workflow directly invocable." A module is public
  **only if it exports `route`** (workflow/agent HTTP) or `runs` (run reads) or
  `channel`. **"An agent used only through application-owned `dispatch(...)`
  calls does not need a public transport export."** → Our workflow/agent modules
  **omit `route`**; they're driven exclusively by our `/api/*` routes and channel
  callbacks calling `invoke`/`dispatch`. Channels (`channel` export) are the only
  Flue-served public ingress.
- `?wait=result` turns `POST /workflows/:name` from `202 {runId}` into
  `200 {runId,result}`; agent prompts return `202 {streamUrl,offset,submissionId}`
  or `200 {result,…}` with `?wait=result`. We mostly fire-and-forget (`202`) to
  match Last Light's dispatch semantics.

### "Flue ships no admin HTTP surface" — we own `/admin/api/*` (no drift, confirms `10`)
Source: `docs/api/routing-api/index.md` ("Compose your own admin endpoints") +
`docs/api/data-persistence-api/index.md` ("Inspection primitives").
**Server-side free functions, importable from `@flue/runtime`:**
```ts
import { getRun, listAgents, listRuns } from '@flue/runtime';
function listRuns(options?: ListRunsOpts): Promise<ListRunsResponse>;  // run pointers, newest first, cursor-paged, status/workflowName filters
function getRun(runId: string): Promise<RunRecord | null>;            // full record incl. input/result/error
function listAgents(): Promise<AgentManifestEntry[]>;                 // { name, description?, transports, defined }
```
These read the configured run store directly (like `dispatch`). They are the
backbone of the **re-backed `/admin/api/*`** (full detail deferred to Phase 7).
**`listRuns()` returns pointers** = "every record field except `input`,
`result`, and `error`" (`RunStore.lookupRun` projection) → the spec-`10`
"list queries exclude blobs" invariant is **provided natively**.

### Built server entrypoint, port, env (drift vs assumptions — note it)
Source: `docs/ecosystem/deploy/node/index.md` (`lastReviewedAt: 2026-06-20`).
- `flue build --target node` → `./dist/server.mjs`; start with `node
  dist/server.mjs`. **The built server is Hono and listens on `PORT` (default
  `3000`)** — *not* a port we choose in `app.ts`. **The built server reads only
  the env present at process start** (`.env` is build-time only; production must
  `source .env` / supply env at boot). `node_modules` needed at runtime
  (deps externalized, not bundled).
- `flue dev --target node` serves on **`3583`** (watch mode, `--env`, `--port`).
- **⚠ Implication:** Last Light's `PORT` default `8644` is **preserved by env**
  (`PORT=8644`), not by code — the listener is Flue's, configured via `PORT`. The
  shared-listener invariant (`01`) holds: admin + `/api/*` + `/admin/api/*` +
  `/channels/*` are all on this one Hono app / one port.

### Crons — `croner` + `invoke`/`dispatch` (no drift)
Source: `examples/node-schedules/src/app.ts` (read 2026-06-21). `new Cron(expr,
{ protect:true, timezone, catch }, async () => { await invoke(wf,{input}); })`,
registered in `app.ts`. `protect:true` skips overlapping ticks. Matches `03`.

### SDK client (reserved, not used in P2)
Source: `docs/sdk/client.md`, `docs/sdk/runs.md`. `@flue/sdk`
`createFlueClient({ baseUrl, token, headers, fetch })` is for **consuming a
deployed app over HTTP**, and `client.runs.{get,events,stream}` require the
workflow to export `runs` middleware. **We keep Last Light's own `src/cli.ts`**
(already an HTTP client against our `/api` + `/admin/api`) rather than adopting
`@flue/sdk` — locked decision "retain CLI + API". `@flue/sdk` is noted as an
optional future path, not a Phase 2 dependency.

### ⚠ DRIFT CORRECTION: "Flue Studio" is not a current product
Grepped the whole docs tree for `studio` → **zero hits**; the CLI command set is
`init|dev|connect|run|build|add|update|docs` (`docs/cli/overview/index.md`) with
**no Studio command**. `flue dev` is a **watch-mode local dev server on 3583**,
not a run/session inspector UI. `flue-reference §10`, `01`, `10`, and the
overall-architecture north star all say "**Flue Studio (`flue dev`) runs
alongside the dashboard**" — that is **stale**. **Corrected stance:** there is no
separate Studio to run alongside; live run/session inspection comes from (a) our
retained dashboard, (b) the `@flue/opentelemetry` adapter (Phase 7), and (c) the
raw `GET /runs/:runId` Durable-Streams endpoints / `listRuns`/`getRun`
primitives. Logged in the deviation log; Phase 7 owns the observability re-back.

## Design

### Module/file layout (`lastlight-flue/src`)
```
src/
  app.ts               Hono app: flue() mount + /health + /api/* + /admin/api/*
                       + auth middleware + cron registration + shutdown hooks.
                       Default export = the Hono app (the deploy entrypoint).
  api/
    routes.ts          POST /api/run, /api/build, /api/chat → invoke/dispatch.
    triggers.ts        buildTriggerInput(): CLI/admin/cron → workflow input
                       (+ _triggerType tag), the envelope-bypass path (`03`).
  admin/
    routes.ts          /admin/api/* — login, runs list/detail, sessions,
                       approvals, stats. P2: thin pass-through over listRuns/
                       getRun; full re-back in P7.
    auth.ts            bearer/operator middleware (ADMIN_PASSWORD/ADMIN_SECRET,
                       ported HMAC token scheme) — Hono MiddlewareHandler.
  cron.ts              registerCrons(app-less): croner Cron[] per managed repo;
                       exposes stop() for graceful shutdown.
  boot.ts              preflight(): config load (exit 78 on bad required config),
                       db connect check, ordered wiring; orphan-run recovery.
  config.ts            (P1) — consumed here for PORT alias, managed repos, gates.
  run-store.ts         (P0 seed / P7 full) — app run record; used by /admin + resume.
  db.ts                (P0) — PersistenceAdapter export (durability ON).
  channels/            (P6) — github.ts/slack.ts; their `channel` export is the
                       only Flue-served public ingress. Stubs in P2.
  workflows/, agents/  (P3+) — NONE export `route` (driven via /api + dispatch).
```

### `src/app.ts` — the single listener, boot order, shutdown
```ts
import { flue } from '@flue/runtime/routing';
import { Hono } from 'hono';
import { preflight } from './boot.ts';
import { mountApi } from './api/routes.ts';
import { mountAdmin } from './admin/routes.ts';
import { registerCrons } from './cron.ts';

await preflight();                 // config → exit(78) on bad required config; db connect check

const app = new Hono();
app.get('/health', (c) => c.json({ ok: true, version, uptime }));   // app-owned, unauthenticated
mountApi(app);                     // /api/run, /api/build, /api/chat  (bearer auth)
mountAdmin(app);                   // /admin/api/*                     (operator auth)
app.use('/channels/*', /* channel-level gating happens inside the callbacks */);
app.route('/', flue());            // /agents,/workflows (none exposed),/runs,/channels/*

const crons = registerCrons();     // croner; one invoke()/dispatch() per managed repo per tick
await recoverOrphanRuns();         // run-store: re-invoke active (non-paused) runs idempotently

for (const sig of ['SIGINT','SIGTERM'] as const)
  process.on(sig, () => shutdown(crons));   // crons.stop() → db.close() → exit(0)

export default app;                // built server (dist/server.mjs) owns listen(PORT||3000)
```
- **One listener / one port** (`01`): the built Hono server listens on `PORT`
  (set `PORT=8644` to preserve Last Light's port); every surface — `/health`,
  `/api/*`, `/admin/api/*`, `/channels/*`, Flue's `/runs/*` — shares it.
- **Strict boot order** (`01`): `preflight` (config→db) precedes route mount;
  crons register after routes; orphan recovery last → ready. We **do not**
  parallelize. Because the built server, not `app.ts`, calls `listen()`, the
  top-level `await preflight()` runs at module evaluation (before first request)
  — the "fails at boot, not in the first request" guarantee Flue's adapter also
  upholds for `connect()`.
- **Exit 78** (`01`): `preflight()` throws `ConfigError`; `boot.ts` catches at
  top level → `process.exit(78)` for missing/malformed **required** config;
  optional integrations (Slack, OTEL) warn + continue. Flue prescribes no exit
  code; we add it.
- **Graceful shutdown** (`01`): `SIGINT`/`SIGTERM` → `crons.forEach(c=>c.stop())`
  → drain in-flight `invoke`s (best-effort; durable sessions survive anyway) →
  `db.close()` → `exit(0)`. Half-flushed writes can't corrupt resume because the
  run record + Flue session store are the substrate, written transactionally.

### Trigger routes — the envelope-bypass dispatch path (`03`)
`/api/run`, `/api/build`, `/api/chat` (+ admin operator-dispatch + cron) **bypass
the EventEnvelope** and call `invoke`/`dispatch` directly with a `_triggerType`
tag (`cli`/`admin`/`cron`), exactly as Last Light does:
```ts
app.post('/api/build', requireBearer, async (c) => {
  const { repo, issue } = await c.req.json();
  const input = buildTriggerInput({ workflow: 'build', repo, issue, _triggerType: 'cli' });
  const { runId } = await invoke(buildWorkflow, { input });   // 202, fire-and-forget
  return c.json({ runId }, 202);
});
```
The single admission boundary (`01` "single dispatch path") = `invoke`/`dispatch`;
the router (`05`, designed in P6) decides which workflow; these routes just
**route the already-decided trigger**. CLI/admin/cron are pre-decided.

### Admin API in Phase 2 (thin) vs Phase 7 (full re-back)
P2 stands up `/admin/api/*` as a **thin pass-through** so the dashboard loads and
`lastlight status`/`workflow list` return *something*:
- `GET /admin/api/runs` → `listRuns({ limit, status?, workflowName? })` (pointers,
  no blobs).
- `GET /admin/api/runs/:id` → `getRun(id)` (full record) **+** the app run record
  (phase progress / approvals) merged.
- `GET /admin/api/agents` → `listAgents()`.
- login/auth ported verbatim (`auth.ts`).
The **shape-matching** of every legacy endpoint (executions list, session
transcript, stats rollups, tool-family classification) is **Phase 7's job**
(risk #3). P2 only proves the wiring + auth + that the dashboard boots.

### `src/cli.ts` — ported unchanged
It is already a thin HTTP client (`--url/--token` → env → `~/.lastlight`). Its
endpoints (`/api/run`,`/api/build`,`/admin/api/*`) are the ones above. **No code
change**; only the server it talks to moved. `lastlight status` hits `/health` +
a token-validity probe.

### Observability surface (Studio-corrected)
- **No Flue Studio.** Live inspection = retained dashboard (re-backed in P7) +
  `@flue/opentelemetry` (P7) + raw `GET /runs/:id` Durable-Streams reads for
  ad-hoc debugging. `flue dev` is dev-only (watch server on 3583).

## Cross-cutting concerns raised (mirrored into overall-architecture.md)
- **API & compatibility surface (fills the _Pending_ section):** one Hono
  `app.ts` is the deploy entrypoint and default export; `app.route('/', flue())`
  mounts Flue routes **beside** app-owned `/health`, `/api/*`, `/admin/api/*`.
  **Workflow/agent modules omit `route`** → not publicly invocable; they run only
  via `invoke`/`dispatch` from our trigger routes + channel callbacks. Channels'
  `channel` export is the sole Flue-served public ingress. **`/admin/api/*` is
  100% application-owned** (Flue ships no admin HTTP surface) and re-backed by
  the `listRuns`/`getRun`/`listAgents` inspection primitives + the app run record.
- **Runtime / deployment:** built server = `dist/server.mjs` (Hono), **listens on
  `PORT` (default 3000; set `PORT=8644` to preserve)**; reads env at boot, not
  `.env`. Single listener / single port invariant preserved by env, not code.
  Boot order strict; `exit 78` reproduced in `boot.ts` preflight; SIGINT/SIGTERM
  stop crons + close db.
- **Observability (correction):** **Flue Studio does not exist** in beta.2 —
  remove "Studio alongside" from the north star; inspection = dashboard + OTEL +
  `/runs/:id`. (Deviation log.)
- **Crons:** `croner` `Cron[]` with `protect:true`, registered in `app.ts`,
  `stop()` on shutdown; one `invoke`/`dispatch` per managed repo per tick.

## Open questions / risks
- **Q2.1 — top-level `await` in `app.ts` vs Flue's build.** We rely on
  module-eval `await preflight()` before the built server listens. Confirm
  `flue build` tolerates a top-level `await` in `app.ts` (ESM allows it; verify
  the bundler doesn't hoist `listen` ahead of it). Fallback: run preflight inside
  the first middleware with a boot-gate latch.
- **Q2.2 — where does `listen()` live / can we intercept it for shutdown?** The
  built server owns `listen(PORT)`. Confirm `SIGTERM` handlers registered in
  `app.ts` module scope are honoured by `dist/server.mjs` (they run at import).
  If the generated server traps signals first, expose a documented shutdown hook
  or wrap with a custom entry. (Affects `01` graceful-shutdown acceptance.)
- **Q2.3 — `listRuns` filter/scope granularity.** Verify `ListRunsOpts` exposes
  enough (status, workflowName, cursor) to back the dashboard's filters without
  reading blobs; full validation is Phase 7 (risk #3). Pointers exclude
  input/result/error — confirm phase-progress/approval columns come from the app
  run record, not `getRun`.
- **Q2.4 — health-check depth.** `/health` must distinguish "process up" from
  "db reachable / crons registered" so `lastlight status` is meaningful. Decide a
  shallow vs deep health contract (deep risks load on a 5s dashboard poll).

## Acceptance hooks
- Process boots with `/health`, `/api/*`, `/admin/api/*`, `/channels/*` (stub),
  and Flue `/runs/*` on **one port** (`PORT=8644`); `lastlight status` + `GET
  /health` green (→ `01`).
- `lastlight build owner/repo#N` POSTs `/api/build` → `invoke` → `202 {runId}`;
  `lastlight workflow list` reads `/admin/api/runs` (→ `03`, `10` list-excludes-blobs).
- Malformed required config → process exits `78`; missing Slack/OTEL → warn +
  continue (→ `01`).
- `SIGTERM` stops crons + closes the store cleanly; a `paused` run stays paused
  (→ `01`).
- Dashboard SPA loads against the re-pointed `/admin/api/*` (thin in P2; shape
  parity proven in P7).
