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
- **COMMIT DIRECTLY ON `main`.** This is a linear greenfield build — every slice
  commits to `main`. Do NOT create feature branches (ignore the generic
  "branch first" habit); a stray branch strands the slice from the next one.

## Current position
- **Phase 5 ✅ COMPLETE** (all 12 workflows + chat + web tools + crons + shutdown).
  Phases 0-4 ✅ (Phase 4 structurally complete; its LIVE build acceptance is DEFERRED
  — see blockers). Suite **614 passed / 6 skipped**.
- **NEXT = Phase 6 (channels)** — replace connectors + router.
- No active blockers besides those in "Carried unknowns / blockers / deferred" below
  (Phase-6 Slack secret is a STOP-AND-ASK; the GitHub channel is unblocked).

## Phase status
- [x] **0 — Spike & de-risk** (HARD GATE) ✅ — hello agent (openai/*) + Docker
  SandboxFactory (egress deferred) + durable HITL gate (MIGRATION.md).
- [x] **1 — Shared core port** ✅ — config, git-auth/profiles, github tools, skills,
  persona, templates/verdict/loop-eval. Commit `eee7933` (closes into P2 s1).
- [x] **2 — Server + preserved API surface** ✅ — single Hono app + `flue()` mount
  (one port), `/health`+`/api/status`, thin `/admin/api/*` reads, operator-auth,
  CLI port, dashboard SPA under `/admin`. Last commit `a58f0d7`.
- [x] **3 — Vertical slice: pr-review** ✅ — workflow + reviewer agent + deterministic
  poster (verdict→createReview, self-PR→COMMENT). LIVE proven (#941 COMMENT, #937
  formal APPROVE). Docker sandbox wired (additive). Last commit: Phase 3 slice 2.
- [x] **4 — build + durable approval gate** ✅ *(structurally; LIVE build DEFERRED)* —
  control-flow + all phase bodies (architect/executor/reviewer-loop/guardrails/gate-
  ask/open-PR) + durable gate + resume + boot recovery, all behind `BuildDeps` with
  every side effect MOCKED. Slice-6 suite 384/5. Last commit: Phase 4 slice 6.
- [x] **5 — Remaining workflows + crons + chat** ✅ COMPLETE — issue-triage,
  issue-comment, pr-fix, answer, web-tools, explore, repo-health, chat,
  security-review, security-feedback, pr-comment, crons+shutdown. Last commit `7718f71`.
- [ ] **6 — Channels** (replace connectors + router) ← **NEXT**
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
- **Flue DISCOVERY RULE (flue-reference §0):** Flue discovers EVERY immediate file in
  `src/agents/` + `src/workflows/` (+ `channels/`) as an entry; a bad immediate file
  does NOT fail `flue build` — it's silently listed + inlined → crash at LOAD/runtime.
  So NO test files / NO non-entry helpers as immediate files there. Helpers →
  `src/agent-lib/` (not discovered); co-located tests → nested `__tests__/`
  (`src/**/*.test.ts`, not discovered). Sanity per slice: `grep -c vitest dist/server.mjs`
  = 1 (inlined prompt text, NOT a `from 'vitest'`/`require('vitest')` module import).
- **Build-time markdown/skill inlining:** import authored content via
  `import x from '../path/file.md' with { type: 'markdown' }` (skills:
  `with { type: 'skill' }`) — Flue inlines the STRING at build time. Do NOT
  `readFileSync(import.meta.url-path)` for AUTHORED source (resolves into `dist/` +
  the `.md` isn't shipped → ENOENT). External runtime files (config YAML, dashboard
  assets) read from cwd/deploy disk are NOT this case (see carried unknowns).
- **Sandbox-adapter contract (caller-owns-lifetime; spec/flue-reference §0):** the
  adapter (`docker()`) is a PURE mapper — must NOT create/remove the provider sandbox;
  the CALLER (workflow) owns `create()`/`remove()` and must `remove()` in `finally`.
  `withBuildSandbox` / `withReviewerSandbox` (+`withPrFixSandbox`) clone+checkout then
  teardown-in-finally (incl. on throw). Image `node:22-bookworm` (slim lacks git).
  EGRESS DEFERRED (full network, no SSRF floor) — see blockers.
- **Deterministic-post security spine (every workflow):** the agent emits TEXT (a
  verdict/classification/feedback marker or free reply); the WORKFLOW posts/labels/
  closes deterministically via a top-level `*-post.ts` with owner/repo/IDs/token
  CLOSED OVER (bound ref) — NEVER model-selectable. Token never logged (`redact()`).
  DEDUP marker per trigger id/issue/runId, author-checked (human-pasted marker ignored)
  → re-invoke / duplicate-delivery never double-acts (design Q5.4).
- **Verdict/classification marker pattern:** agent emits `VERDICT:`/`CLASSIFICATION:`/
  `FEEDBACK:` line; a pure parser (golden-tested, mirrors `parseReviewerVerdict`) maps
  it to the deterministic action. Reviewer verdict→post: APPROVED→APPROVE,
  REQUEST_CHANGES→REQUEST_CHANGES; **bot's-own PR (`author==config.botLogin`) →
  COMMENT always** (GitHub forbids self-review). Bot login = `last-light[bot]`.
- **openai auto-auth + serveStatic dashboard:** see flue-reference §0. `@hono/node-server`
  `serveStatic` (DIRECT dep) serves prebuilt `dashboard/dist/` under `/admin` (Vite
  `base:/admin/`), mounted LAST in `createApp()` AFTER `/admin/api/*`+operator-auth →
  no shadowing; PUBLIC shell; `next()`s on miss → SPA fallback.
- **Additive-SIGTERM shutdown decision:** the built entry (`dist/server.mjs`) owns
  `serve()` + SIGINT/SIGTERM traps + `db.close()`; Node signal handlers are additive,
  so app.ts registers a plain `process.on('SIGTERM'|'SIGINT')→stopCrons()` (NOT a forked
  server entry). Chosen over re-implementing Flue's listen/shutdown.
- **resume.ts reinvoke = spawn `flue run <wf> --payload`** (Spike-3 proven: re-invoke
  RE-RUNS `run()`; app runId ≠ Flue runId). Idempotent via the app run-store phasesDone
  cursor + restart breaker ≤3; boot recovery re-invokes `active` orphans, leaves `paused`.
- **crons VITEST-inert:** `startCrons()` is run-once + skipped under VITEST/
  LASTLIGHT_SKIP_CRONS → tests/imports never schedule a timer or spawn `flue run`.
  Crons built `{paused:true}`; positive-enable; per-repo failure isolated; overlap-skip.

### Carried unknowns / blockers / deferred
- **🚨 Phase-6 Slack BLOCKED — needs `SLACK_SIGNING_SECRET`** (HTTP Events API). NOT in
  `secrets/.env` (source `~/work/lastlight/.env` only has the Socket-Mode app token) →
  the **Slack channel is STOP-AND-ASK**. The **GitHub channel is UNBLOCKED**
  (`WEBHOOK_SECRET` present) — build it first.
- **⏸ Phase-4 LIVE build acceptance DEFERRED (user-gated):** the live `flue run build`
  (writes real code, pushes a branch, opens a REAL PR, pauses at the gate for human
  approval) is NOT to be run autonomously — run it later WITH THE USER supervising the
  gate. The mocked push/gate-comment/open-PR/reinvoke seams go live then. Also pending:
  the Phase-6 GitHub-comment resume trigger (`@last-light approve/reject` COMMENT →
  `resume(runId,decision)`; the dashboard+CLI HTTP path is already live).
- **Egress hardening DEFERRED (required before prod — Phase 8, spec/09 + 00 risk #1):**
  sandbox has full network + no SSRF floor. Allowlist + metadata-CIDR floor via
  re-hosted CoreDNS/nginx (Docker factory) or E2B allowOut/denyOut (fed by the ported
  `egress-allowlist.ts`). Riding on it: gitleaks/semgrep scanner image
  (`TODO(phase-9/egress + scanner-image)`), the security.md-PR flow
  (`TODO(phase-9/security-md-pr)` — needs clone+push), Slack/channel delivery for
  repo-health (`TODO(phase-6/channels)`, behind the existing `deliver` seam).
- **Other open TODOs to track:** web-research seam in `answer`
  (`TODO(phase-5/web-tools)` — web tools were built + consumed by explore, but answer
  was left as-is); Phase-7 admin data (`stats`/`sessions` still 501; RunPointer lacks
  `currentPhase`/`repo`/`issueNumber`/`restartCount` → returned as explicit `null`);
  chat-channel auth (`agents/chat.ts` `route` open, `TODO(phase-6) channel auth`).
- **runtime-file-read follow-up:** `src/config.ts` + `src/admin/dashboard.ts` use
  `import.meta.url`+`readFileSync` for EXTERNAL runtime files (config YAML from cwd;
  prebuilt dashboard assets) — legit on-disk at deploy, NOT the inlining bug. Re-confirm
  dashboard asset paths resolve from the BUILT entry when serving is wired live.

## Secrets status (`secrets/.env`, git-ignored)
- ✅ Present (from `~/work/lastlight/.env`): `OPENAI_API_KEY`, `TAVILY_API_KEY`,
  Slack tokens (bot + Socket-Mode app token), GitHub App creds + PEM, `WEBHOOK_SECRET`,
  `MODAL_TOKEN_ID/SECRET`, `ADMIN_SECRET`.
- ⚠ Gaps: **`SLACK_SIGNING_SECRET`** (Phase-6 Slack HTTP Events — STOP-AND-ASK, above);
  no `E2B_API_KEY` (dev sandbox = Docker factory, none needed); no `ANTHROPIC_API_KEY`
  (→ default model `openai/*`); `ADMIN_PASSWORD` commented out (→ auth disabled in dev).

## ⚠ Beta drift (installed 1.0.0-beta.2 vs design docs) — see flue-reference §0
flue-reference §0 (verified-installed) OVERRIDES the older §2–§3 narrative researched
against `withastro/flue@main` (ahead of pin). Key: agents = `createAgent` (NO
`defineAgent`); workflows = `export async function run(ctx)` only (NO `defineWorkflow`/
object form); NO top-level `invoke` (`dispatch(agent,{id,input})` is the agent entry;
workflows via `flue run`/HTTP/`invokeWorkflowAttached`); `defineConfig` from
`@flue/cli/config`; `@flue/runtime/node` exports `local()` + `sqlite()` only;
bundled `node_modules/@flue/runtime/docs/**` is authoritative for this pin.
