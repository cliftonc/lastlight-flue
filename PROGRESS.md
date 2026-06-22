# Build progress

> Single source of truth for "where is the build." The `/loop` (see `BUILD-LOOP.md`)
> reads this first every iteration. Keep it terse and current: update it at the end
> of every slice, right after the commit.
>
> **Detailed completed-slice notes: see `PROGRESS-ARCHIVE.md`.**

## ⚙ Loop execution mode (user directive, 2026-06-21)
**Run each build slice as ONE fresh subagent**, not inline in the main session —
to keep the main conversation's context lean over a long build. Each `/loop`
iteration: dispatch a general-purpose subagent with the build-loop prompt (it
reads BUILD-LOOP.md + PROGRESS.md, does ONE slice, runs tests, commits, updates
PROGRESS.md), then relay its short summary and schedule the next wakeup. Do NOT
do the slice work inline. (Cloud `/schedule` is unsuitable here: the build needs
local Docker + secrets/.env + ~/work/lastlight, absent in cloud.)

## Current position
- **Phase 3 (pr-review vertical slice) DONE ✅.** All of Phase 0/1/2/3 complete.
- **NEXT = Phase 4** — `build` workflow + durable approval gate.
- **Blockers:** none. No further live PR posts unless the user asks (the #941 test
  comment is left in place; both review paths are proven — see below).
- **Phase 3 LIVE milestone met:** both post paths proven on real infra —
  self-PR COMMENT fallback (`cliftonc/drizzle-cube#941`) + formal substantive
  APPROVE review (`#937`, non-bot author, 32 files). Docker sandbox now wired into
  the reviewer (additive, tool-only fallback). Details in PROGRESS-ARCHIVE.md.

## Phase status
- [x] **0 — Spike & de-risk** (HARD GATE) ✅ — hello-world agent (openai/*); Docker
  SandboxFactory (clone+build, egress deferred); durable HITL + invoke/session
  unknowns answered (MIGRATION.md).
- [x] **1 — Shared core port** ✅ — config, git-auth/profiles, github tools, skills,
  persona, templates/verdict/loop-eval. Suite 159/3. Commit `eee7933` (closes into P2 s1).
- [x] **2 — Server + preserved API surface** ✅ — single Hono app + `flue()` mount
  (one port); `/health`+`/api/status`; thin `/admin/api/*` reads; operator-auth;
  CLI port; dashboard SPA under `/admin`. Suite 240/3. Last commit `a58f0d7`.
  (Trigger routes `/api/*` were blocked-on Phase 3 — delivered there.)
- [x] **3 — Vertical slice: pr-review** ✅ — pr-review workflow + reviewer agent +
  deterministic poster (verdict→createReview, self-PR→COMMENT fallback); Docker
  sandbox wired in (additive). LIVE proven (#941 COMMENT, #937 formal APPROVE).
  Suite **273 passed / 5 skipped**. Last commit: Phase 3 slice 2 (Docker sandbox).
- [ ] **4 — build + durable approval gate** ← **NEXT.**
- [ ] 5 — Remaining workflows + crons + chat
- [ ] 6 — Channels (replace connectors + router)
- [ ] 7 — Persistence + re-back admin API
- [ ] 8 — Deploy & cutover

### Verified runtime facts
Durable, reusable facts the loop/subagents rely on. Where a fact is also in
`spec/flue-reference.md §0`, that file is authoritative; keep the short version here.
- **Agent HTTP contract:** `POST /agents/<name>/<id>` body `{ message, images? }`;
  `?wait=result` → `200 { result:{ text, usage:{input,output,totalTokens,cost},
  model:{provider,id} }, streamUrl, offset, submissionId }`; bare POST → `202
  { streamUrl, offset }`. HTTP exposure REQUIRES a `route` export on the agent.
- **openai provider auto-authenticates** from `OPENAI_API_KEY` — no `registerProvider`.
  Default model = `openai/*` (no Anthropic key present).
- **Flue DISCOVERY RULE (empirically verified; flue-reference §0):** Flue discovers
  EVERY immediate file in `src/agents/` + `src/workflows/` (+ `channels/`) as an
  entry. `flue build` does **NOT error** on a bad immediate file — it silently lists
  it + **inlines its module-eval into `dist/server.mjs`** → crash at LOAD/runtime
  (not build). So: NO test files / NO non-entry helpers as immediate files there.
  Helpers live in `src/agent-lib/` (not discovered); co-located tests live in nested
  `__tests__/` (matches `src/**/*.test.ts`, not discovered). Sanity per slice:
  discovery = agents{hello} + workflows{gated,pr-review}; `grep -c vitest dist/server.mjs` = 0.
- **Build-time markdown/skill inlining:** import authored content via
  `import x from '../path/file.md' with { type: 'markdown' }` (skills use
  `with { type: 'skill' }`) — Flue inlines the STRING at build time. Do NOT
  `readFileSync(import.meta.url-path)` for AUTHORED source (it resolves into `dist/`
  at runtime + the `.md` isn't shipped → ENOENT). persona.ts uses the markdown-import
  form. (External runtime files read from cwd/deploy disk — config YAML, dashboard
  assets — are NOT this case; see carried unknowns.)
- **Sandbox-adapter contract (caller-owns-lifetime; docs/api/sandbox-api.md):** the
  adapter (`docker()`) is a PURE mapper — must NOT create/delete/kill the provider
  sandbox; the CALLER (workflow) owns container `create()`/`remove()` and must
  `remove()` in a `finally`. `createSandboxSessionEnv(api, cwd)` is synchronous →
  `SessionEnv`; `createSessionEnv({ id })` once per `init()` (id = ctx/runId). `exec`
  honors `{cwd, env, timeoutMs, signal}` (round timeoutMs UP; exit 124 on timeout).
  Image `node:22-bookworm` (slim lacks git). EGRESS DEFERRED (full network, no SSRF floor).
- **Live pr-review facts:** verdict→post = `APPROVED→APPROVE`,
  `REQUEST_CHANGES→REQUEST_CHANGES`; **bot's-own PR (`author == config.botLogin`,
  `selfAuthored:true`) → `COMMENT` always** (GitHub forbids self-review) via
  `issues.createComment`; non-self → formal `pulls.createReview`. owner/repo/
  pull_number/token are CLOSED OVER (bound ref), never model-chosen. Bot login =
  `last-light[bot]`. Token NEVER logged (`redact()` any occurrence in stderr).
- **serveStatic / dashboard mount (flue-reference §0):** `@hono/node-server`
  `serveStatic` (DIRECT dep, not hoisted by pnpm) serves prebuilt `dashboard/dist/`
  under `/admin` (Vite `base:/admin/`). Mounted LAST in `createApp()`, AFTER
  `/admin/api/*` + operator-auth → does NOT shadow API/health/Flue routes; PUBLIC
  shell (SPA logs in itself). serveStatic `next()`s on a miss → SPA `index.html`
  fallback. Built-server entry (`dist/server.mjs`) owns `serve()` + SIGINT/SIGTERM
  traps + `db.close()` (Node signal handlers are additive).

### Carried unknowns / follow-ups
- **runtime-file-read follow-up:** `src/config.ts` + `src/admin/dashboard.ts` use
  `import.meta.url` + `readFileSync` for EXTERNAL runtime files (config YAML from
  cwd; prebuilt dashboard assets) — legit on-disk at deploy, NOT the inlining bug.
  Re-confirm dashboard asset paths resolve from the BUILT entry when dashboard
  serving is wired live.
- **Egress hardening (DEFERRED, required before prod — spec/09, 00 risk #1):**
  allowlist + metadata-CIDR/SSRF floor, via re-hosted CoreDNS/nginx in the Docker
  factory or E2B `allowOut`/`denyOut` (fed by the ported `egress-allowlist.ts`).
  Dev containers currently have full network + no SSRF floor (known, recorded).
- **Graceful-shutdown finalize** — leaning toward additive
  `process.on('SIGTERM', () => crons.stop())` (fires alongside Flue's handler), NOT
  a forked server entry; finalize when crons land (Phase 5).
- **`TODO(phase-7)` admin routes:** `stats`/`sessions`/`approvals` still honest 501;
  RunPointer/RunRecord lacks `currentPhase`/`repo`/`issueNumber`/`restartCount`
  (app-run-store joins) → returned as explicit `null`, never fabricated.
- **Open Qs:** per-thread chat serialization + sandbox-less chat latency (Phase 5).
- **Substantive-review caveat:** both #941 (self→COMMENT) and #937 (formal APPROVE)
  proven; no further live PR posts without the user's say-so.

## Secrets status (`secrets/.env`, git-ignored)
- ✅ Present (from `~/work/lastlight/.env`): `OPENAI_API_KEY`, `TAVILY_API_KEY`,
  Slack tokens, GitHub App creds + PEM (`...PATH` repointed to `./secrets/...pem`),
  `WEBHOOK_SECRET`, `MODAL_TOKEN_ID/SECRET`, `ADMIN_SECRET`.
- ⚠ Gaps: no `E2B_API_KEY` (dev sandbox = Docker factory, none needed);
  `SLACK_SIGNING_SECRET` (Phase 6 HTTP Events API only); no `ANTHROPIC_API_KEY` →
  default model is `openai/*`; `ADMIN_PASSWORD` commented out (→ auth disabled in dev).

## ⚠ Beta drift (installed 1.0.0-beta.2 vs design docs) — see flue-reference §0
flue-reference §0 (verified-installed) OVERRIDES the older §2–§3 narrative researched
against `withastro/flue@main` (ahead of pin). Key: agents = `createAgent` (NO
`defineAgent`); workflows = `export async function run(ctx)` only (NO `defineWorkflow`/
object form); NO top-level `invoke` (`dispatch(agent,{id,input})` is the agent entry;
workflows via `flue run`/HTTP/`invokeWorkflowAttached`); `defineConfig` from
`@flue/cli/config`; `@flue/runtime/node` exports `local()` + `sqlite()` only;
bundled `node_modules/@flue/runtime/docs/**` is authoritative for this pin.
