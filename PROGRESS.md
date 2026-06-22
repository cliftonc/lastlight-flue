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
- **Phase:** 3 — Vertical slice `pr-review` **✅ LIVE MILESTONE MET**. Phase 2 ✅,
  Phase 1 ✅, Phase 0 ✅.
- **SUBSTANTIVE REVIEW PROVEN ✅ (2026-06-22):** `flue run pr-review` on
  `cliftonc/drizzle-cube#937` (non-bot author `cliftonc`, 32 files +2627/-14) →
  `VERDICT: APPROVED` → **formal `pulls.createReview` APPROVE** (selfAuthored:false
  → formal-review path, not the COMMENT fallback): review 4540832141
  (https://github.com/cliftonc/drizzle-cube/pull/937#pullrequestreview-4540832141).
  The review was genuinely substantive (composite-PK semantics, --out/--check CI
  guidance, parseFlags nits, test-coverage ideas, typing nits — file-referenced).
  So BOTH paths are proven: self-PR COMMENT fallback (#941) + formal substantive
  review (#937). The #941 test comment is LEFT in place (user choice).
- **Resuming autonomous build (subagent-per-slice):** NEXT = wire the deferred
  Docker SANDBOX into the reviewer (Phase 3 cleanup), THEN Phase 4 (build workflow
  + durable approval gate). No further live PR posts unless the user asks.

### Phase 3 · LIVE ACCEPTANCE ✅ (run by main loop, 2026-06-22)
- `flue run pr-review` against `cliftonc/drizzle-cube#941` ran END-TO-END: minted
  review-write token → reviewer agent activated `pr-review`+`code-review` skills,
  read the PR (`github_get_pull_request`) → emitted `VERDICT: REQUEST_CHANGES`
  marker → workflow posted DETERMINISTICALLY via the **bot's-own-PR COMMENT
  fallback** (`selfAuthored:true → COMMENT`). Posted: issue comment 4764305596
  (https://github.com/cliftonc/drizzle-cube/pull/941#issuecomment-4764305596),
  `postKind:"comment"`, by `last-light[bot]`.
- **Proven:** the full pipeline (token mint → Flue agent + skills + bound read
  tools → verdict contract → deterministic post + self-PR COMMENT fallback) works
  on real infra. Two integration bugs were found+fixed getting here (clean Flue
  discovery `slice 1.5`; build-time agent-context inlining `f333e91`).
- **NUANCE / not-yet-shown:** because #941 is the bot's OWN PR, the reviewer
  (correctly, per persona/security rules) DECLINED a substantive self-review and
  posted a conflict-of-interest note instead — so a substantive CODE review on a
  human-authored PR is still unproven. Candidate follow-up: run pr-review on a
  non-bot PR. Also DEFERRED from Phase 3: the Docker SANDBOX in the reviewer
  (currently tool-only) — wire `docker()` so the reviewer can check out + build.

### Phase 3 · slice 1.5 — BUILD-BREAK FIX: clean Flue discovery ✅ (UNBLOCKS the live run)
- **Bug:** `flue run pr-review` crashed at its build step with "Vitest failed to
  access its internal state … 'vitest' is imported inside Vite/Vitest config file".
- **Root cause (now in flue-reference §0, EMPIRICALLY VERIFIED):** Flue discovers
  EVERY immediate file in `src/agents/`+`src/workflows/`(+`channels/`) as an
  entry. `flue build` does **NOT error** on a bad immediate file — it **silently
  lists it + inlines its module-eval into `dist/server.mjs`**. So the co-located
  `*.test.ts` files (`vitest` import) + non-default-export helpers became phantom
  entries; the test files' `vitest` import got inlined → server entry crashes at
  LOAD time (run-time), even though the build EMIT succeeded. Phantom agents seen:
  `persona`, `reviewer`; phantom workflows: `pr-review-prompt`, + `*.test`.
- **Fix (moves only, no logic change):**
  - Helpers → **`src/agent-lib/`** (new, NOT discovered): `agents/persona.ts`,
    `agents/reviewer.ts` (factory), `workflows/pr-review-prompt.ts`. All were
    depth-1 under `src/` and stay depth-1, so their `../` imports are unchanged;
    `reviewer.ts` still imports `./persona.ts` (sibling). `pr-review.ts` updated to
    import from `../agent-lib/{reviewer,pr-review-prompt}.ts`.
  - Co-located tests → nested **`__tests__/`** (matches `src/**/*.test.ts`, NOT
    discovered): `persona.test.ts`+`pr-review-prompt.test.ts` →
    `src/agent-lib/__tests__/`; `pr-review.test.ts` → `src/workflows/__tests__/`.
    Relative imports bumped one `../`.
- **Verified:** `flue build --target node` succeeds; discovery is now exactly
  **agents = {hello}**, **workflows = {gated, pr-review}** (confirmed via build's
  own agent/workflow list AND `grep '^//#region src/(agents|workflows)/'
  dist/server.mjs` → only hello/gated/pr-review). `grep -c vitest dist/server.mjs`
  = **0** (was non-zero). `pnpm typecheck` clean. `pnpm test` **264 passed / 4
  skipped** — UNCHANGED (the 3 moved tests still run from `__tests__/`).
- **Hardening:** tightened `vitest.config.ts` `stubSkillMd.resolveId` from
  `endsWith('.md')` → `endsWith('/SKILL.md')` (was masking real markdown imports;
  all skill imports end in `/SKILL.md`, verified). Tests still 264/4.
- **NO live run / NO GitHub post happened.** This UNBLOCKS the Phase 3 live
  `flue run pr-review` (done by the main loop, not a subagent).
- **Last commit:** see `git log` (Phase 3: fix Flue discovery / build break).

### Phase 3 · slice 1 — pr-review workflow + reviewer agent + deterministic poster ✅
- **Built:** `src/workflows/pr-review.ts` (`export async function run(ctx)` — the
  only beta.2 form), `src/agents/reviewer.ts` (`createReviewerAgent(ref, octokit)`),
  `src/github-post.ts` (deterministic poster), `src/workflows/pr-review-prompt.ts`
  (thin prompt assembly via ported `renderTemplate`).
- **Flow:** mint `review-write` token (ported `configureGitAuth` +
  `GITHUB_PERMISSION_PROFILES['review-write']`, downscoped to the target repo) →
  build reviewer (read tools bound to ref+token, `pr-review`/`building`/`code-review`
  skills, `loadPersona()`, `resolveModel/Thinking('review')`) → `init`→`session.prompt`
  → `parseReviewerVerdict` → **WORKFLOW posts deterministically** (NOT the model).
- **Verdict→post mapping** (`mapVerdictToEvent`): `APPROVED→APPROVE`,
  `REQUEST_CHANGES→REQUEST_CHANGES`; **bot's-own PR → `COMMENT` always**. The poster
  (`postReviewDeterministically`): formal `pulls.createReview` for non-self PRs;
  **self-authored → `issues.createComment` fallback** (GitHub forbids reviewing your
  own PR). `selfAuthored` compares the PR author login to `config.botLogin`.
  owner/repo/pull_number/token are CLOSED OVER (bound ref), never model-chosen.
- **DI seam:** `runPrReview(ctx, deps)` with injectable `PrReviewDeps`
  (mintToken/makeOctokit/botLogin/runReviewer/isSelfAuthored/post); `run()` uses
  `defaultDeps()`. Lets the run-level test drive the whole flow offline.
- **DEVIATION (recorded): SANDBOX DEFERRED.** Reviewer is TOOL-ONLY this slice — it
  reads the PR diff/files via bound read tools, NO Docker sandbox, so the
  build/test gate (which needs `docker()` wired) is deferred to a later slice. The
  slice's core (verdict → deterministic post + COMMENT fallback) is fully proven.
  `agents/reviewer.ts` omits `sandbox` with a header note to wire it later.
- **Mocked vs live:** ALL GitHub writes MOCKED (fake octokit). `vitest.config.ts`
  gains a `stub-skill-md` plugin (vite can't parse `with { type:'skill' }` .md
  imports; the stub keeps agent-importing tests offline). **`test/pr-review-live.ts`
  is GATED on `PR_REVIEW_LIVE=1` (UNSET) — skipped, never run.**
- **Tests (+24):** `src/github-post.test.ts` (15: mapping incl. self→COMMENT, body
  extraction, selfAuthored, poster calls createReview vs createComment with bound
  ref), `pr-review-prompt.test.ts` (5: context render, trigger-conditional, VERDICT
  contract parseable, purity), `pr-review.test.ts` (4: full flow APPROVED/REQUEST_
  CHANGES/self-COMMENT/missing-marker-fallback over fake deps). Suite **264 passed
  / 4 skipped** (was 240/3). `pnpm typecheck` clean. flue-reference §0 updated
  (PromptResponse/PromptOptions/skill-md ambient decl).
- **⚠ LIVE acceptance against `cliftonc/drizzle-cube#941` still PENDING** — run by
  the MAIN LOOP (user watching), NOT a subagent. Gated test present but UNRUN. No
  live side effect occurred this slice. Verify the App is installed on
  drizzle-cube before the live run (token mint fails otherwise → STOP).
- **Last commit:** see `git log` (Phase 3 slice 1: pr-review workflow).

### (earlier) Phase 3 start note
- Phase-2 leftovers are later-phase-coupled (trigger routes→P3,
  crons+shutdown→P5, stats/sessions→P7).

### ⚠ Phase 3 live-acceptance directive (external side effect — read before any live run)
- **Authorized live-test PR:** `cliftonc/drizzle-cube#941` (user's repo; user
  authorized 2026-06-21 — see memory `pr-review-live-target`).
- **Subagents BUILD + test with ALL GitHub WRITES MOCKED — NO live posting.** The
  live run (which posts a real review/comment) is executed by the MAIN LOOP, not a
  subagent, and the user reviews what will be posted before it's triggered.
- Before the live run: verify the `secrets/.env` GitHub App (id/installation in env)
  is installed on `cliftonc/drizzle-cube` (≠ reference repo `cliftonc/lastlight`).
  If it lacks access, token minting fails → STOP + ask.

### Phase 2 · slice 5 — admin dashboard SPA served ✅
- **Assets:** `dashboard/dist/` (4 files, 1.6M: index.html + assets/*.js,*.css +
  logo.png) copied from `~/work/lastlight/dashboard/dist/` (NOT the SPA source or
  build pipeline — the Phase-2 deliverable is "dashboard LOADS", so the PREBUILT
  artifacts are the minimal path; design says serve the dashboard, doesn't mandate
  a source port). The SPA's Vite `base` is `/admin/` → assets reference
  `/admin/assets/*` + `/admin/logo.png`, so it MUST mount under `/admin`
  (preserves `~/work/lastlight/src/admin/index.ts`). **Secret-scanned clean**
  (only React-internal `__SECRET_INTERNALS`, login `type:password`, a "Secrets
  omitted" help string — no creds). `.gitignore` `dist/` → `/dist/` (root-scoped)
  so build output stays ignored but `dashboard/dist/` commits.
- **Served by** `src/admin/dashboard.ts:mountDashboard(app)` via
  `@hono/node-server` `serveStatic`: `/admin/*` → assets (strips `/admin`), then
  `/admin` + `/admin/*` → `index.html` SPA fallback (serveStatic `next()`s on a
  miss). Mounted in `createApp()` LAST, AFTER `/admin/api/*` + the operator-auth
  middleware → **does NOT shadow** `/admin/api/*`, `/api/*`, `/health`, or Flue's
  `/agents,/workflows,/runs,/channels`. **PUBLIC** (the SPA logs in via
  `/admin/api/login` itself — no `requireOperator` on the shell). `serveDashboard`
  opt (default on; default export on).
- **Asset path:** `resolveDashboardRoot()` returns an ABSOLUTE root (serveStatic
  `join`s it, so absolute is stable) chosen from candidates relative to
  `import.meta.url` — robust across `flue dev` (tsx, `src/admin/`) and the built
  `dist/` layout, with a cwd-relative last resort.
- **Added dep:** `@hono/node-server@^2.0.3` as a DIRECT dep (it's flue's transitive
  pin but pnpm didn't hoist it → `@hono/node-server/serve-static` wasn't
  resolvable from root). flue-reference §0 updated with the serveStatic API.
- **Tests:** `test/dashboard.test.ts` (+11) — all in-process via `app.request`
  (serveStatic reads `dashboard/dist/` from disk, no listener): `/admin`+`/admin/`
  +deep `/admin/<view>` → 200 HTML containing `<div id="root"`; real asset
  `/admin/logo.png` → 200 `image/png`; **`/admin/api/runs` still 401 JSON** +
  `/admin/api/auth-required` 200 JSON + `/health` 200 JSON (NOT shadowed); pure
  `isSpaFallbackPath`; `serveDashboard:false` → 404. Full suite **240 passed / 3
  skipped** (was 229/3). `pnpm typecheck` clean.
- **Last commit:** `a58f0d7` — Phase 2 slice 5: serve prebuilt admin dashboard
  SPA under `/admin`.

### Phase 2 · slice 4 — CLI port ✅
- **Ported (near-verbatim from `~/work/lastlight/src/`):**
  - `src/cli-config.ts` ← `cli-config.ts` (no relative-import rewrites needed;
    `resolveTarget` precedence `--url/--token` → `LASTLIGHT_URL/LASTLIGHT_TOKEN`
    → `~/.lastlight/config.json` → `DEFAULT_URL=http://localhost:8644` PRESERVED).
  - `src/cli-format.ts` ← `cli-format.ts` (table/age/colorStatus/checkmark +
    dependency-free `followSSE`). Adaptation: `widths[i]!` for
    `noUncheckedIndexedAccess`.
  - `src/cli-timeline.ts` ← `cli-timeline.ts` (timeline render, tool-family
    classify, result summarize). Adaptation: `FAMILY_BY_NAME[l]!`,
    `FAMILY_STYLE[<ToolFamily>]!`.
  - `src/cli.ts` ← `cli.ts` (842L). Adaptations: `.js`→`.ts` import specifiers;
    `argv[i]!`/regex-group `!` guards; **`setup` wizard NOT ported** — `lastlight
    setup` exits with a graceful "not available yet, use login" message
    (`// TODO(phase-2/cli-setup)`; the 844L interactive docker/secrets wizard is
    out of scope for the thin client port — NOT deleted from help, NOT faked).
- **Deps added (matching the reference's installed versions):** `chalk@5.6.2`,
  `@clack/prompts@1.6.0` (ref `^1.2.0`), `cli-table3@0.6.5`. All runtime deps
  (CLI ships as part of the app).
- **How to RUN the CLI (offline, no build):** `pnpm cli <args>` (= `tsx
  src/cli.ts`), or `pnpm exec tsx src/cli.ts <args>`, or the `bin` launcher
  `node bin/lastlight.mjs <args>` (`package.json#bin.lastlight` → a `.mjs`
  wrapper that re-execs `src/cli.ts` through the local `tsx`, since the CLI uses
  `.ts` import specifiers). E.g. `pnpm cli --help`, `pnpm cli status`.
- **Commands LIVE now (server endpoints already implemented):** `--help`/`help`,
  `status`/`whoami` (`/health` + `/admin/api/auth-required` + token probe vs
  `/admin/api/stats`), `login`/`logout` (`/admin/api/login` POST — auth slice),
  `workflow list` (`/admin/api/workflow-runs`), `workflow log <id>` partial
  (`/workflow-runs/:id` works; its `/executions` companion is 501 → command
  surfaces the error). Pure local: `logout`.
- **Commands that HIT 501 (endpoint not implemented yet — surface the server's
  error gracefully, NOT faked, NOT removed):** `stats` (`/admin/api/stats*`),
  `session list|log` (`/admin/api/sessions*`), `logs search`
  (`/admin/api/log-search`), `approvals list|approve|reject`
  (`/admin/api/approvals*`), `server list|logs` (`/admin/api/server/*` — never
  existed), `workflow log`'s `/executions` leg. **BLOCKED on Phase 3** (need real
  workflows): `build` (`/api/build`), `triage/review/health/security` + the
  default github-ref dispatch (`/api/run`), `chat` (`/api/chat`) — all currently
  501 trigger-route stubs.
- **Offline + app-independent:** the CLI is a pure HTTP client (global `fetch` +
  chalk). No Flue runtime, no build, no server needed for `--help`/`status`.
  Verified: `pnpm exec tsx src/cli.ts --help` prints + exits 0; `node
  bin/lastlight.mjs status --url http://localhost:9` degrades to "Server
  unreachable" cleanly.
- **Tests:** ported `cli-config.test.ts` (+6) + `cli-timeline.test.ts` (+11)
  (`.js`→`.ts` imports), added `cli-format.test.ts` (+9: table alignment/ANSI-
  width/empty, relative age units, colorStatus passthrough, checkmark glyphs).
  Target/URL+token precedence covered by cli-config. NO live smoke added this
  slice (default `pnpm test` stays offline). Full suite **229 passed / 3 skipped**
  (was 203/3; +26). `pnpm typecheck` clean.
- **Last commit:** see `git log` (Phase 2 slice 4: CLI port). Hash NOT embedded
  here (avoids the self-referential amend churn the prior slices hit).

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
- **Last commit:** `8c97570` — Phase 2 slice 3: operator-auth middleware on
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
- [ ] 2 — Server + preserved API surface ← **IN PROGRESS (essentially complete; see assessment).** slice 1 ✅ (app.ts composition + shutdown finding); slice 2 ✅ (thin `/admin/api/*` reads); slice 3 ✅ (operator-auth); slice 4 ✅ (CLI port); slice 5 ✅ (admin dashboard SPA under `/admin`). Trigger routes `/api/*` BLOCKED on Phase 3.

#### Phase 2 completeness assessment (2026-06-21, after slice 5)
**DONE:** single Hono app + `flue()` mount + one-port invariant (slice 1) ·
`/health`+`/api/status` green (1) · `/admin/api/*` thin reads over
listRuns/getRun/listAgents (2) · operator-auth (3) · CLI port (4) · dashboard
**LOADS** under `/admin` (5). The design's headline deliverable — "`lastlight
status`/`/health` green, dashboard loads, runs inspectable" — is **MET**
(modulo live data, which needs runs to exist = Phase 3).
**REMAINS in Phase 2:**
  - **Trigger routes `/api/run|build|chat`** — **BLOCKED on Phase 3** (need real
    workflows to `invoke`/`dispatch`; currently honest 501 stubs).
  - **Crons** (`croner` + per-repo `invoke`/tick) — **effectively BLOCKED on
    Phase 5** (no workflows to tick) and is itself a Phase-5 deliverable; doing
    it now would be a no-op shell.
  - **`boot.ts` preflight + exit-78 + orphan re-invoke** — UNBLOCKED but thin
    until there are workflows/run-store to recover; low value pre-Phase-3.
  - **Graceful-shutdown finalize** (additive `SIGTERM`→`crons.stop()` vs custom
    entry) — coupled to crons; finalize when crons land.
  - **`stats/sessions/approvals`** admin routes — genuinely **Phase 7**.
→ **Verdict: advance to Phase 3 (pr-review vertical slice).** The remaining
Phase-2 items are all blocked-on or better-built-with Phase 3/5; the compatibility
surface (server, auth, CLI, admin reads, dashboard) is in place.
- [ ] 3 — Vertical slice: pr-review ← **IN PROGRESS.** slice 1 ✅ (workflow + reviewer agent + deterministic poster + COMMENT fallback; sandbox/build-gate deferred; live acceptance PENDING, gated test unrun).

### Phase-3 fix: persona ENOENT under `flue build` (build-time markdown inlining)
- **Bug (confirmed by a real `flue run`):** workflow built + GitHub token minted,
  then crashed `ENOENT … open '…/agent-context/rules.md'`. Root cause:
  `loadPersona()` (`src/agent-lib/persona.ts`) read `agent-context/{rules,security,
  soul}.md` via `readFileSync` on an `import.meta.url`-derived path AT RUNTIME.
  Under `flue build` persona.ts is inlined into `dist/server.mjs`, so
  `import.meta.url` → `dist/`, the path resolved to `<root>/agent-context` (files
  live at `src/agent-context/`) AND the `.md` files were never shipped to dist.
  Unit tests passed only because tsx runs from `src/`. Broke EVERY persona-using
  agent under a real run/deploy → blocked the Phase-3 live milestone.
- **Fix (Flue-idiomatic, build-time):** persona.ts now imports the three files via
  `import rules from '../agent-context/rules.md' with { type: 'markdown' }` (+
  security, soul) — Flue INLINES the contents as strings at build time (same
  mechanism skills use). No fs/path/import.meta.url at runtime. Public API
  unchanged: order preserved (rules→security→soul), `\n\n---\n\n` joiner, optional
  `opts.suffix` — callers/tests untouched.
- **vitest plugin:** `stub-skill-md` → `stub-markdown` with TWO branches:
  `*/SKILL.md` → skill stub `{ name, __stub }` (unchanged); any other `*.md` →
  the REAL file contents inlined as a default string (loaded in the `load` hook),
  so persona tests still assert real content offline and match the build.
- **Verified (no live run):** `flue build --target node` ✅; agent-context CONTENT
  inlined into `dist/server.mjs` — `grep -c "diligent and methodical open-source
  maintenance bot" dist/server.mjs` = 1 (also GitHub-First Coordination=1,
  USER_CONTENT_UNTRUSTED=1), present as an escaped JS string literal → build-time
  inlining proven. `pnpm typecheck` clean; `pnpm test` 264 passed / 4 skipped
  (persona test count unchanged). Discovery clean (agents={hello},
  workflows={gated,pr-review}); `grep -c vitest dist/server.mjs` = 0. Verified
  markdown-import behaviour recorded in flue-reference §0.
  **⇒ UNBLOCKS the live `flue run pr-review`** (not run here; left to the main loop).
- **Follow-up (NOT this slice):** `src/config.ts` + `src/admin/dashboard.ts` also
  use `import.meta.url` + `readFileSync`, but read EXTERNAL runtime files (config
  YAML resolved from cwd; prebuilt dashboard HTML assets) that legitimately exist
  on disk at deploy time — NOT authored source needing inlining — so not the same
  bug. Re-confirm dashboard asset paths resolve from the built entry when dashboard
  serving is wired live; prompts are already string-rendered, skills already use
  the `with { type: 'skill' }` build path.
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
