# Build progress

> Single source of truth for "where is the build." The `/loop` (see `BUILD-LOOP.md`)
> reads this first every iteration. Keep it terse and current: update it at the end
> of every slice, right after the commit.

## ⚙ Loop execution mode (user directive, 2026-06-21)
**Run each build slice as ONE fresh subagent**, not inline in the main session —
to keep the main conversation's context lean over a long build. Each `/loop`
iteration: dispatch a general-purpose subagent with the build-loop prompt (it
reads BUILD-LOOP.md + PROGRESS.md, does ONE slice, runs tests, commits, updates
PROGRESS.md), then relay its short summary and schedule the next wakeup. Do NOT
do the slice work inline. (Cloud `/schedule` is unsuitable here: the build needs
local Docker + secrets/.env + ~/work/lastlight, absent in cloud.)

## Current position
- **Phase:** 2 — Server + preserved API surface **🔶 IN PROGRESS**. Phase 1 ✅,
  Phase 0 ✅ (hard gate cleared).
- **Slice (this iteration — slice 3, OPERATOR-AUTH MIDDLEWARE ✅):** ported the
  reference HMAC-bearer operator auth to `src/admin/auth.ts`, mounted
  `requireOperator` on `/admin/api/*`, made `auth-required` report REAL config.
  → **NEXT: Phase 2 slice 4 — CLI port** (`src/cli.ts`, a thin HTTP client
  against `/health` + `/api/*` + `/admin/api/*` — now that status + auth +
  admin-reads exist), then the custom-entry-vs-additive-SIGTERM shutdown +
  crons; trigger routes `/api/*` BLOCKED on Phase 3 (need real workflows).

### Phase 2 · slice 3 — operator-auth middleware ✅
- **Ported:** `src/admin/auth.ts` from `~/work/lastlight/src/admin/auth.ts`,
  VERBATIM token semantics. **Scheme:** stateless HMAC-signed bearer token —
  `createToken(secret, method?)` → `base64url({exp,method?}).base64url(HMAC-
  SHA256(payload, secret))`, 7-day TTL; `verifyToken` recomputes the HMAC and
  compares with **`crypto.timingSafeEqual`** (constant-time) then checks `exp`.
  Adapted the reference's `authMiddleware` into a Hono `requireOperator(config)`
  **`MiddlewareHandler` factory** + a `loginHandler(config)` (password → token,
  **constant-time** password compare over equal-length buffers) + an
  `operatorAuthConfigFromEnv()` resolver.
- **SESSION-STORE MECHANISM + CAVEAT:** there is **NO server-side session store**
  — the token is self-describing/self-verifying, so it **SURVIVES PROCESS
  RESTART** as long as `ADMIN_SECRET` is stable (it is: a fixed env secret; the
  reference defaults it to `"lastlight-dev-secret"` when unset). No in-memory
  store, no db, no Phase-7 dependency. **Caveat:** rotating `ADMIN_SECRET`
  invalidates every outstanding token (intended). Single-process and multi-
  process both fine (stateless).
- **How applied (protected vs public):** `createApp()` mounts
  `app.use('/admin/api/*', requireOperator(authConfig))` ONCE, before any
  `/admin/api` route. The middleware **exempts public-by-contract paths**
  (`/admin/api/auth-required`, `/admin/api/login`) via `isPublicAuthPath` (path
  `.endsWith` check, mirroring the reference) so the CLI/dashboard can read
  auth-required to learn HOW to auth and POST login to obtain a token. **When no
  `ADMIN_PASSWORD` is configured, auth is DISABLED → everything passes through**
  (reference behaviour; dev/fresh install). Token accepted via `Authorization:
  Bearer <t>` **or** `?token=` query (EventSource path). Invalid/absent → **`401
  { error: "unauthorized" }`** (exact reference shape).
- **`auth-required` now reports REAL config:** `authRequiredBody(auth)` →
  `required = Boolean(auth.password)`; `slackOAuth`/`githubOAuth` = **`false`
  with `// TODO(phase-6/admin-oauth)`** — config does NOT model OAuth providers
  yet (OAuth login is Phase 6), so NOT fabricated.
- **Config keys:** `src/config.ts` does NOT model admin auth (neither did the
  reference's config module — `adminPassword`/`adminSecret` were read straight
  from env at the server-wiring layer in `~/work/lastlight/src/index.ts`). So
  `operatorAuthConfigFromEnv()` sources **`ADMIN_PASSWORD`** (default `""`) +
  **`ADMIN_SECRET`** (default `"lastlight-dev-secret"`), matching the reference
  defaults, and is injected at `createApp({ authConfig })`. `secrets/.env` has
  `ADMIN_PASSWORD` commented out (→ auth disabled in dev) + `ADMIN_SECRET` set.
- **SECURITY:** constant-time for BOTH the HMAC verify and the password compare
  (preserved from the reference); secrets read from env, never hardcoded, never
  logged. OAuth authorize/callback exemptions from the reference are NOT ported
  (Phase 6) — noted in `isPublicAuthPath` to re-add then.
- **Offline:** pure app-owned Hono middleware, no Flue runtime. Tests inject an
  explicit `authConfig` (no env/secret touch) + a fake `RunsReader`.
- **Tests:** `src/admin/auth.test.ts` (+10: ported token suite verbatim +
  expired-token + `operatorAuthConfigFromEnv`); `test/app.test.ts` operator-auth
  block (+8: protected `/admin/api/runs` 401 w/o creds / 200 w/ valid bearer /
  200 via `?token=` / 401 wrong-secret; `auth-required` reachable unauth &
  `required:true`; login correct→token-that-authenticates / wrong→401; auth-
  disabled passthrough + `authDisabled` login). Existing `createApp()` tests
  pinned to explicit disabled-auth so they don't flake on a shell `ADMIN_PASSWORD`.
  Full suite **203 passed / 3 skipped** (was 184/3). `pnpm typecheck` clean.
- **Last commit:** `60b1b7a` — Phase 2 slice 3: operator-auth middleware on
  `/admin/api/*`.

### Phase 2 · slice 2 — thin `/admin/api/*` read pass-through ✅
- **Built:** `src/admin/runs-reader.ts` — the Flue-data **`RunsReader` seam**
  (`{ listRuns, getRun, listAgents }`, signatures mirroring `@flue/runtime`) +
  **pure shape adapters** `toRunSummary`/`toRunDetail`/`toAgentSummary` +
  `mapRunStatus`. `createApp(opts?: { runsReader? })` now mounts the admin DATA
  reads when a reader is injected; the **default export wires the REAL Flue free
  functions** (`{ listRuns, getRun, listAgents }`) — passed through, NOT invoked
  at import. **Routes implemented (replacing 501 stubs):**
  - `GET /admin/api/workflow-runs` **and** alias `GET /admin/api/runs` →
    `listRuns({ status?, workflowName?, limit?, cursor? })` → legacy
    `{ workflowRuns, total, nextCursor }`. **Blob-free** (listRuns excludes
    payload/result/error natively; NO event streams loaded in the list path).
    Maps dashboard status filter (`running`/`succeeded`/`failed`/…) → Flue's
    3-value `active|completed|errored`.
  - `GET /admin/api/workflow-runs/:id` **and** `GET /admin/api/runs/:id` →
    `getRun(id)` → `{ workflowRun }`; **404 `{ error:"workflow run not found" }`**
    when absent (matches the reference shape `~/work/lastlight/src/admin/routes.ts`).
  - `GET /admin/api/agents` → `listAgents()` → `{ agents }`.
- **Shape mapping (Flue → dashboard):** `runId`→`id`; status
  `active→running`/`completed→succeeded`/`errored→failed`; absent optionals
  coerced to `null`/`false`. **Fields Flue's RunPointer/RunRecord does NOT carry**
  (`currentPhase`, `repo`, `issueNumber`, `restartCount` — all app-run-store
  joins) are returned as **explicit `null` with `// TODO(phase-7)`**, never
  fabricated. `total` = page length (Flue is cursor-paged, not offset/total —
  `nextCursor` surfaced; true global total is a Phase-7 app-run-store concern).
- **AUTH SEAM:** routes mounted beneath the `/admin/api/*` seam comment with a
  clear `// TODO(phase-2/operator-auth): app.use('/admin/api/*', requireOperator)`
  attach point. **Operator auth NOT built this slice.** `auth-required` kept
  unauthenticated and mounted ABOVE the (future) middleware.
- **STILL 501 (genuinely Phase 7, not backable by listRuns/getRun/listAgents):**
  `GET /admin/api/stats` (per-phase cost/token rollups — app run-store),
  `/admin/api/sessions` (transcripts — EventStreamStore), `/admin/api/approvals`
  (pendingGate queue — app run-store). Tagged `slice:'phase-7'`.
- **Offline-testability:** the real `listRuns`/`getRun`/`listAgents` **THROW
  `"runtime not configured"` in-process** (verified via `tsx` — same failure as
  `flue()`), so they're injected via `RunsReader`; tests pass a **fake reader**
  returning sample data — NO live runtime, NO build. Adapter tested with sample
  Flue records; routes tested via `app.request('/admin/api/...')` asserting
  status + mapped shape + 404 for a missing run + filter pass-through + the
  blob-free invariant + the explicit Phase-7 nulls.
- **DEFERRED + RECORDED this slice:**
  - **(a) Trigger routes `/api/run|build|chat` are BLOCKED until Phase 3** —
    `dispatch`/`invokeWorkflowAttached` need real workflows to target, which
    don't exist yet. Their `501` stubs are KEPT (tagged `phase-2/trigger-routes`).
  - **(b) Graceful shutdown — leaning toward a SIMPLE additive
    `process.on('SIGTERM', () => crons.stop())`** registered when crons land,
    **NOT** a forked custom server entry. flue-reference §0 shows Flue's
    generated `dist/server.mjs` already owns `serve()` + the SIGINT/SIGTERM traps
    + `db.close()`; Node signal handlers are additive, so a plain handler that
    calls `crons.stop()` fires alongside Flue's (and runs to completion before
    Flue's async `agentCoordinator.shutdown()` resolves and exits). Forking the
    entry to own `serve()` is risky (re-implements Flue's listen+shutdown) and
    unnecessary for the only app-owned shutdown need (stop crons). **Decision
    leaning recorded; finalize when crons are built** (revises slice-1's
    "custom Node entry needed" toward the simpler additive handler).
- **Flue signatures re-verified (beta.2):** `RunRecord`'s blob field is
  **`payload`** (not `input` as the docs prose says); `AgentManifestEntry` =
  `{ name, description?, transports:{http?}, created }` (field is `created`, not
  `defined`); `RunStatus` = 3 values. **flue-reference §0 updated** (new
  "Inspection primitives" sub-bullet under Routing) + the in-process-throw note.
  No locked-decision-breaking drift.
- **Tests:** full suite **184 passed / 3 skipped** (+9 `src/admin/runs-reader.test.ts`
  adapter, +8 `test/app.test.ts` injected-reader route tests; was 167/3).
  `pnpm typecheck` clean.
- **Last commit:** `edea5cd` — Phase 2 slice 2: thin `/admin/api/*` read
  pass-through over Flue inspection primitives (RunsReader seam + adapters).

### Phase 2 · slice 1 — app composition + shutdown finding ✅
- **Built:** `src/app.ts` rewritten from the Phase-0 skeleton into the real
  composition the rest of Phase 2 builds on. Exports a **`createApp()` factory**
  (app-owned routes, mountable WITHOUT `flue()`) + pure shape builders
  `healthBody()` / `authRequiredBody()`; the **default export** = `createApp()`
  then `app.route('/', flue())` (one Hono app, one listener, one port —
  `PORT||3000`, set `PORT=8644` to preserve). Implemented app-owned routes:
  `GET /health` (preserves legacy `{ status:"ok", … }` shape + `version`+`uptime`;
  shallow by design — Q2.4), `GET /api/status` (same readiness view),
  `GET /admin/api/auth-required` (unauthenticated by contract; CLI `status` +
  dashboard login read it). **Not-yet-ported routes are explicit `501
  not_implemented` stubs** (NOT fake data) with `slice`/phase tags: POST
  `/api/run|build|chat` → trigger-routes slice; GET `/admin/api/runs|workflow-runs|
  agents|stats|sessions|approvals` → Phase 7. Clearly-marked SEAM comments where
  bearer auth (`/api/*`) and operator auth (`/admin/api/*`) middleware + the real
  routers attach.
- **Endpoint shapes confirmed against the reference** (`~/work/lastlight/src`):
  `/health` legacy body `{ status:"ok", stateDir }` (we keep `status:"ok"`);
  CLI `cmdStatus` (cli.ts:290) probes `/health` + `/admin/api/auth-required`
  (`{ required, slackOAuth, githubOAuth }`) + `/admin/api/stats` for token
  validity; admin `/api/*` (run trigger) mounted on the connector Hono app
  returning `202 { accepted, … }`.
- **🔑 SHUTDOWN / SIGNAL FINDING (resolves design Q2.1 + Q2.2; evidence in
  flue-reference §0):** read the GENERATED `dist/server.mjs` directly. `flue
  build` **inlines `src/app.ts`** (top-level `await` runs at import → Q2.1
  resolved: preflight-at-module-eval is viable), sets `var flueApp = app`,
  asserts `flueApp.fetch` is a function, and **the generated entry — not our
  `app.ts` — owns the listener and the signal traps**: `serve({ fetch:
  flueApp.fetch, port: PORT||3000 })` + `process.on('SIGINT'/'SIGTERM', …)` →
  `agentCoordinator.shutdown()` → `persistenceAdapter.close()` → `server.close()`
  → `process.exit(130|143)` (60s unref timeout fallback). Node `process.on`
  handlers are ADDITIVE so an `app.ts`-registered handler would also fire, BUT
  Flue's handler also runs and calls `process.exit` — **we don't control exit
  timing and there's no documented app-owned shutdown hook in beta.2.** → To
  deterministically `crons.stop()` + drain before exit (spec/01), a **custom Node
  entry (`src/server.ts`) owning serve()/listen/the traps is needed** (build →
  `app.fetch`, run our entry instead of `dist/server.mjs`). **Decision recorded;
  build deferred to slice 2.** Flue already closes our `db.ts` `sqlite()` adapter
  on signal, so a `paused` run's session store flushes cleanly even today.
- **Testability (chose approach (a) — app-owned surface unit-testable, no build):**
  verified `flue()` from `@flue/runtime/routing` imports + composes in-process,
  BUT invoking a Flue route in-process throws *"flue() route invoked before
  runtime was configured … used outside a Flue-built server entry"* (the spike-1
  test needed a running `flue dev` for that reason). So `createApp()` deliberately
  omits `flue()`, making the app-owned routes fully offline-testable via Hono's
  `app.request(...)`. `test/app.test.ts` (8 tests): /health shape, /api/status,
  /admin/api/auth-required, the 501 trigger + admin stubs, 404 unknown, and pure
  `healthBody`/`authRequiredBody` unit tests. The full default export (with
  `flue()`) stays gated on a running server like spike-1.
- **Flue signatures re-verified (beta.2):** `flue()` (`@flue/runtime/routing`) →
  `{ fetch }` Hono sub-app, mount `app.route('/', flue())`; `app.ts` default
  export consumed as `flueApp = <default>` + `.fetch` assertion; `getRun`/
  `listRuns`/`listAgents` importable from `@flue/runtime` (confirmed; backbone of
  the Phase-7 admin re-back). **flue-reference §0 updated** with the built-server
  entry/listen/shutdown facts. No locked-decision-breaking drift.
- **Tests:** full suite **167 passed / 3 skipped** (+8 from `test/app.test.ts`;
  was 159/3). `pnpm typecheck` clean.

### Phase 1 port map (from reference survey of ~/work/lastlight) — target → source
Pure/portable (zero framework coupling). Target layout: `src/engine/` + `src/config.ts`
+ `src/tools/` + `src/agents/persona.ts` (per design/phase-1-shared-core.md §layout).
- [x] `src/engine/templates.ts`  ← `src/workflows/templates.ts` (175L, verbatim) ✅
- [x] `src/engine/verdict.ts`     ← `src/workflows/verdict.ts` (38L) ✅
- [x] `src/engine/loop-eval.ts`   ← `src/workflows/loop-eval.ts` (89L) ✅
- [x] `src/config.ts` (+ `src/config-resolve.ts`) ← reference `src/config.ts`
      (624L) + `src/config-resolve.ts` (68L), near-verbatim ✅. `resolveModel`,
      `resolveVariant`, **`resolveThinking`** (typed `ThinkingLevel`
      'off'|'minimal'|'low'|'medium'|'high'|'xhigh', fails open to 'medium'),
      `LastLightConfig` shape, 3-layer merge (env>overlay>default), `LASTLIGHT_*`
      + legacy `OPENCODE_*` aliases, fail-open JSON parse. Added single-arg
      `resolveModel(task)`/`resolveThinking(task)` forms reading the runtime
      config (per design signature). Deviations: model default
      `anthropic/claude-sonnet-4-6`→`openai/gpt-5.1` (no Anthropic key);
      `config/default.yaml` `sandbox.backend: gondolin`→`none` (firewall backends
      unported, egress deferred); ported only `normalizeAllowlistHost` into
      `src/engine/egress-allowlist.ts` (rest of egress module deferred to the
      egress-hardening phase). Used `yaml` dep. Tests: config.test.ts (35) +
      config-overlay.test.ts (9) + config-resolve.test.ts (6) = 50 green.
- [x] `src/engine/git-auth.ts`    ← `src/engine/git-auth.ts` (227L, +test) ✅. Node
      builtins only (crypto JWT RS256 → installation token, downscope). Verbatim
      (adapted: `data` typed instead of `any` for `noUncheckedIndexedAccess`; no
      behavior change). Exports: `configureGitAuth`/`refreshGitAuth`,
      `GitHubTokenPermissions`, `GitHubPermissionLevel`. Co-located `git-auth.test.ts`
      ported (`.js`→`.ts` specifier); mocks `child_process`/`fs`/`crypto` + global
      `fetch` → **NO live GitHub creds/network needed**. 9 tests green.
- [x] `src/engine/profiles.ts`    ← `src/engine/profiles.ts` (266L) ✅. `GitAccessProfile`
      (read|issues-write|review-write|repo-write), `GITHUB_PERMISSION_PROFILES`,
      `AGENTIC_PROFILE_FOR`, `GitSandboxAccess`, `ExecutorConfig`/`ExecutionResult`/
      `Extension*`/`Skills*` interfaces — all ported. Imports `GitHubTokenPermissions`
      from `./git-auth.ts` and `OtelConfig`/`SandboxBackend` from `../config.ts`
      (verified exports). ⚠ `GitAccessProfile` kept distinct from Flue's agent
      `profile`. **Deviation:** `loadAgentContext()` (delegated to unported
      `workflows/loader.ts`) NOT ported — replaced with a `// TODO(persona)` note;
      superseded by `src/agents/persona.ts:loadPersona()` (later slice, design Q1.4).
      Reference has no profiles test; nothing added (pure types/const maps).
- [x] `src/tools/github.ts` (+`github-read.ts`) + `src/engine/github-app-client.ts` ✅.
      Reimplemented the reference `src/engine/github-tools.ts` (354L, pi-ai/typebox
      schema) as Flue `defineTool` FACTORIES bound to (ref, token, profile).
      `github-read.ts` = 11 GET-only read tools (getRepository/getIssue/listIssue
      Comments/listIssues/getPullRequest/getPullRequestDiff/listPullRequests/
      getFileContents/listCommits/searchIssues/searchCode) — `githubReadTools(ref,
      octokit)`. `github.ts:githubTools(ref, token, profile)` builds an Octokit from
      the bound token, ALWAYS includes the read set, pushes write tools by profile:
      `issues-write`→comment/react(comment+issue)/createIssue; `review-write`+`repo-
      write`→+createReview (repo-write code mutation is via the sandbox git CLI, NOT
      a tool, so its model-tool surface == review-write). `github-app-client.ts`
      (`githubAppClient(config)` via `@octokit/auth-app` createAppAuth + Octokit)
      ported near-verbatim (`fs`/`path`→`node:` specifiers). **SECURITY INVARIANT
      enforced:** owner/repo/token/IDs are CLOSED OVER in `execute`, never model
      `parameters`; every schema is `additionalProperties:false` exposing only safe
      payload fields (body / reaction `content` enum / review event+body / issue
      title); search tools FORCE `repo:owner/repo` from the bound ref so the model
      can't widen scope. Deps added: `octokit@5.0.5` + `@octokit/auth-app@7.2.2`
      (matching the reference's installed versions). NO pi-ai / @sinclair/typebox.
      Tests: `src/tools/github.test.ts` (11, mocks `octokit` via `vi.hoisted` →
      offline; asserts profile gating by tool NAME for read/issues-write/review-
      write/repo-write, the no-forbidden-param + `additionalProperties:false`
      security invariant, and that `execute` calls Octokit with the closed-over
      ref/token not args). **Flue `defineTool` signature re-verified** against
      `node_modules/@flue/runtime/dist/tool-types-*.d.mts`: `defineTool({ name,
      description, parameters: <valibot|raw JSON-Schema object>, execute })` →
      `ToolDefinition`; `execute(args, signal?) => Promise<string>`, JSON-Schema
      params yield `Record<string,any>` args. **No drift** — flue-reference §0/§4
      already correct; NOT changed.
      ⚠ **Harness `GitHubClient` (postComment/updateComment/react/checks/reviews,
      ~360L) DEFERRED** (scope-note call: it's a deterministic harness client used
      by the Phase 2+ workflow runner, not a model tool — porting it now would
      balloon this slice). TODO: port to `src/engine/github.ts` when the runner
      needs it (it reuses `githubAppClient`). 
      ⚠ **LIVE acceptance gated & NOT YET RUN:** `test/github-tools-live.test.ts`
      ("mint a read-scoped token → read a real issue") is gated on `GITHUB_LIVE_TEST=1`
      + App creds (like spike-1 on `FLUE_SERVER_URL`); default `pnpm test` stays
      offline/green. Run deliberately before relying on the live path.
- [x] copy `skills/` (12 SKILL.md dirs, incl. `references/` subdirs) `prompts/`
      (13 .md) `agent-context/` (3 .md: soul/rules/security) → `src/agents/persona.ts`
      concat + frontmatter-audit test ✅. **Placement:** all three copied under
      `src/` (`src/skills/`, `src/prompts/`, `src/agent-context/`), NOT repo root.
      **DEVIATION from design layout (intentional, follows the installed truth):**
      design/phase-1-shared-core.md §layout puts `skills/`/`prompts/`/`agent-context/`
      at repo ROOT, but `node_modules/@flue/runtime/docs/guide/skills.md` requires
      skills live UNDER the source dir (it uses `src/skills/`) for the
      `import x from '../skills/<name>/SKILL.md' with { type: 'skill' }` attribute
      to resolve from `src/agents/` — so skills MUST be `src/skills/`. Kept
      prompts + agent-context under `src/` too for ONE consistent location.
      `persona.ts` reads `../agent-context/*.md` and the audit test reads
      `src/skills/*/SKILL.md` accordingly. `cp -R`; counts verified (12/13/3).
      Secret scan of copied content: clean (one match was a doc *example*
      placeholder `sk_live_abc123...` in `security-review/references/issue-format.md`,
      not a real key); no `.env`/`.pem`/symlinks in `src/skills/`.
      `src/agents/persona.ts:loadPersona(opts?)` — reads the 3 `.md` via `fs`
      (path from `import.meta.url`), concatenates in **alphabetical filename
      order (rules→security→soul) joined by `\n\n---\n\n`** to MATCH the reference
      `loadAgentContext()` (`~/work/lastlight/src/workflows/loader.ts:296`, which
      `localeCompare`-sorts + same separator); `opts.suffix` appends the chat
      suffix (empty/whitespace ignored). Offline-testable, no build step.
      Tests: `src/agents/persona.test.ts` (7 — non-empty, distinctive content
      from each of soul/rules/security, separator count, suffix append/ignore) +
      `src/skills/skills-frontmatter.test.ts` (14 — parses every SKILL.md
      frontmatter via `yaml`, asserts non-empty `name`+`description` [the only
      two fields present in ALL 12; `chat` lacks version/tags], name==dirname per
      Flue, exactly 12 skills) = 21 green.
- **Bootstrap (done):** git init; `.gitignore` (secrets/, `.claude/` ignored);
  `package.json` (pnpm, ESM, @flue/runtime 1.0.0-beta.2 + @flue/cli + valibot +
  hono ^4.12.26 + Vitest); `tsconfig.json`; secrets wired; `pnpm install` ✅;
  `flue.config.ts` (`defineConfig` from `@flue/cli/config`, target:'node');
  `vitest.config.ts`; `test/bootstrap.test.ts` (pins installed API surface).
- **Spike 1 (done ✅):** `src/agents/hello.ts` (`createAgent`, model
  `openai/gpt-5.1` via `LASTLIGHT_MODEL`) + `src/app.ts` (Hono + `flue()` +
  `/health`). **Proven live** on our `OPENAI_API_KEY` via `flue dev`:
  `POST /agents/hello/spike-1?wait=result` → `result.text` non-empty,
  `result.model = { provider:"openai", id:"gpt-5.1" }`, ~$0.0012/turn.
  Acceptance: `test/spike-1-hello.test.ts` (gated on `FLUE_SERVER_URL`; default
  `pnpm test` = 4 passed / 1 skipped). Response contract recorded below.
- **Spike 2 (done ✅):** `src/sandboxes/docker.ts` — Flue `SandboxFactory` over the
  host `docker` CLI. `DockerContainer.create()/.remove()` is **caller-owned**
  lifetime (the adapter must NOT manage it); `DockerSandboxApi` drives exec + all
  file ops via `docker exec`; `docker(container)` → `createSessionEnv()` via
  `createSandboxSessionEnv(api,'/workspace')`. Image `node:22-bookworm` (slim
  lacks git). **Proven** by `test/spike-2-docker.test.ts` (auto-skips w/o docker;
  free): isolated empty workspace + baked env; **git clone + npm build artifact**
  read back through the API; full FS contract incl. binary roundtrip; factory→
  SessionEnv; **teardown verified** (container gone after `remove()`). 5/5 green,
  no leaked containers. EGRESS still DEFERRED.
  Also: tsconfig `allowImportingTsExtensions` (Flue imports use `.ts` specifiers).
- **Spike 3 (done ✅):** durable HITL gate — `src/db.ts` (`sqlite()` durable
  sessions) + `src/run-store.ts` (raw `node:sqlite` app run record) +
  `src/workflows/gated.ts` (pure-TS 2-step gate: step1 → write `pending` → return;
  re-invoke `resumed:true` → step2 once). **Proven across 3 separate `flue run`
  processes** (pause → restart → resume-again): step1×1 + step2×1 exactly-once,
  final status=done, restart_count=2; **app runId ≠ Flue runId**. Answers: (a)
  re-invoke RE-RUNS `run()` = YES; (b) session reattach is conditional & not
  load-bearing (run record carries cross-invoke state). `test/spike-3-gated.test.ts`
  (in-process default + `RUN_FLUE_CLI=1` cross-process). `MIGRATION.md` written.
- **Phase 1 so far:** ported the 3 pure utilities (templates/verdict/loop-eval) →
  `src/engine/`, then the config module (`config.ts` + `config-resolve.ts` +
  `engine/egress-allowlist.ts` partial + `config/default.yaml`), then git-auth +
  profiles (`engine/git-auth.ts` +test, `engine/profiles.ts`), then the GitHub
  `defineTool` factories (`tools/github.ts` + `tools/github-read.ts` +
  `engine/github-app-client.ts` + `tools/github.test.ts` + gated
  `test/github-tools-live.test.ts`), and finally **copied skills/prompts/
  agent-context under `src/` + `agents/persona.ts` + frontmatter audit** (this
  slice). Full suite **159 passed / 3 skipped** (+7 persona, +14 skills audit;
  github-tools-live + spike-1 + spike-3-cross-process gated). **Phase 1 COMPLETE.**
- **Last commit:** `eee7933` — Phase 2 slice 1: app.ts composition (createApp +
  /health + /api/status + /admin/api/auth-required + 501 seams) + shutdown/signal
  finding.

### Verified runtime facts (add to as spikes land)
- Agent HTTP contract: `POST /agents/<name>/<id>` body `{ message, images? }`;
  `?wait=result` → `200 { result:{ text, usage:{input,output,totalTokens,cost},
  model:{provider,id} }, streamUrl, offset, submissionId }`; bare POST → `202
  { streamUrl, offset }`. HTTP exposure REQUIRES a `route` export on the agent.
- `openai` provider auto-authenticates from `OPENAI_API_KEY` — no `registerProvider`.
- `flue dev --env secrets/.env --port 3583` serves discovered `src/` agents;
  `/health` (app-owned) confirms readiness in ~1s.
- **Sandbox adapter contract** (docs/api/sandbox-api.md, verified): adapter is a
  PURE mapper — must not create/delete/kill the provider sandbox (lifetime is the
  caller's). `createSandboxSessionEnv(api, cwd)` is **synchronous** → `SessionEnv`.
  `createSessionEnv({ id })` called once per `init()`; `id` = ctx id (agent
  instance id, or workflow runId inside a workflow). `exec` honors
  `{cwd, env, timeoutMs, signal}`; round `timeoutMs` UP; exit 124 on timeout.
  Shell-native adapters (docker) may implement FS ops via the shell.

## ⚠ BETA DRIFT FOUND & RECORDED (installed 1.0.0-beta.2 vs design docs)
The design docs / `flue-reference §2–§3` were researched against
`withastro/flue@main`, which is AHEAD of the pinned `beta.2`. **Verified installed
reality (now in `flue-reference §0`, which overrides the older narrative):**
- Agents: **`createAgent`** (NO `defineAgent`). Workflows: **file/function
  `export async function run(ctx)` only** (NO `defineWorkflow`, NO object form).
- **NO top-level `invoke`** — workflows run via `flue run`/HTTP/`invokeWorkflowAttached`;
  `dispatch(agent,{id,input})` is the public agent entry. **Phase-0 spike-3 must
  re-prove the re-invoke/HITL mechanism against these real primitives.**
- `defineConfig` from **`@flue/cli/config`** (not `@flue/runtime`).
- `@flue/runtime/node` exports exactly `local()` + `sqlite()`. `local({env})` is
  the explicit per-sandbox env passthrough → answers **Q0.1**.
- Bundled `node_modules/@flue/runtime/docs/**` is the authoritative API for this
  pin — prefer it over flueframework.com (which tracks `main`).

## Key decision (this phase)
- **Sandbox = a custom Docker `SandboxFactory`** (`src/sandboxes/docker.ts`,
  implementing Flue's `SandboxFactory`→`SandboxApi`). **Egress DEFERRED** — dev
  containers have full network + no SSRF floor (known, temporary, recorded). Not
  using E2B. Egress hardening (re-host CoreDNS/nginx into the factory, or E2B) is
  a later phase, required before prod (`spec/09`, `00` risk #1).
- **Default model = `openai/*`** (only `OPENAI_API_KEY` is present; no Anthropic).

## Phase status
- [x] **0 — Spike & de-risk** (HARD GATE) ✅ — hello-world agent (openai/*); Docker SandboxFactory (clone+build, egress deferred); durable HITL + invoke/session unknowns answered (MIGRATION.md)
- [x] **1 — Shared core port** ✅ (config, git-auth/profiles, tools, skills, persona, template/verdict/loop-eval) — all port-map items done; full suite 159 passed / 3 skipped
- [ ] 2 — Server + preserved API surface (Hono + flue() + crons + /api + /admin/api + CLI) ← **IN PROGRESS.** slice 1 ✅ (app.ts composition + shutdown finding); slice 2 ✅ (thin `/admin/api/*` read pass-through); slice 3 ✅ (operator-auth middleware — `requireOperator` on `/admin/api/*`, stateless HMAC bearer, `auth-required`/`login` public, `auth-required` reports real config). NEXT slice: CLI port (`src/cli.ts`), then custom-entry-vs-additive-SIGTERM shutdown + crons. Trigger routes `/api/*` BLOCKED on Phase 3 (need real workflows).
- [ ] 3 — Vertical slice: pr-review
- [ ] 4 — build + durable approval gate
- [ ] 5 — Remaining workflows + crons + chat
- [ ] 6 — Channels (replace connectors + router)
- [ ] 7 — Persistence + re-back admin API
- [ ] 8 — Deploy & cutover

## Secrets status (`secrets/.env`, git-ignored)
- ✅ Present (copied from `~/work/lastlight/.env`, the authoritative source):
  `OPENAI_API_KEY`, `TAVILY_API_KEY`, `SLACK_BOT_TOKEN`/`SLACK_APP_TOKEN`/
  `SLACK_ALLOWED_USERS`, GitHub App creds + PEM (`GITHUB_APP_PRIVATE_KEY_PATH`
  repointed to `./secrets/...pem`), `WEBHOOK_SECRET`, `MODAL_TOKEN_ID/SECRET`.
- ⚠ Remaining gaps:
  - **Sandbox provider** — no `E2B_API_KEY`. For dev use Flue `local()` (no key);
    for the egress/isolation gate pick a provider (E2B / Modal [tokens present] /
    re-host the existing docker firewall). **Decision pending — see below.**
  - **`SLACK_SIGNING_SECRET`** — source has Socket-Mode `SLACK_APP_TOKEN`; the
    Flue HTTP Events API needs the signing secret. Needed at Phase 6 only.
  - No `ANTHROPIC_API_KEY` → set the default model to an `openai/*` specifier.

## Carried unknowns to prove (per spec risk register / design open Qs)
- **Q (Phase 0):** does `invoke(wf,{input:{runId}})` re-run `run()` (not no-op)? Keep app-runId ≠ Flue-runId.
- **Q (Phase 0):** does `harness.session(name)` reattach across invokes? (If not, committed-file handoff covers data flow.)
- **Q (egress-hardening phase, deferred):** allowlist + metadata-CIDR/SSRF floor — via re-hosted CoreDNS/nginx in the Docker factory, or E2B `allowOut`/`denyOut`.
- **Q (Phase 5):** per-thread chat serialization; sandbox-less chat latency.

## Notes
- Bootstrap partially done (see Current position). Next: `pnpm install`,
  `flue.config.ts`, vitest config, first commit — then the Phase 0 proofs.
- Before coding the Docker factory, read the REAL `SandboxFactory`/`SandboxApi`
  types from `node_modules/@flue/runtime` (`./node` + main types) — don't trust
  `flue-reference.md`'s claimed contract (it's beta).
