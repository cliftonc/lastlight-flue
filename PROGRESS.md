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
- **Phase 4 IN PROGRESS** — slice 1 (control flow + gate + run-record) DONE ✅;
  slice 2 (real ARCHITECT) DONE ✅; slice 3 (real EXECUTOR) DONE ✅;
  slice 4 (real REVIEWER-LOOP) DONE ✅.
- **This slice (4) built:** the real REVIEWER-LOOP phase bodies (reviewer:N →
  [post_reviewer gate] → fix:N → recheck:N), wired into `defaultBuildDeps().runPhase`
  behind the `BuildDeps` seam — the existing build.ts loop control flow drives them.
  - `src/agent-lib/build-reviewer.ts` — `createBuildReviewerAgent` (review task key,
    persona, pr-review+building+code-review skills, sandbox REQUIRED, cwd /workspace;
    reviews the executor's COMMITTED diff in the checkout, NO GitHub post — internal
    build review) + `createFixAgent` (fix task key→default fallback, persona, building
    skill, READ-ONLY github tools, sandbox+cwd). Recheck = the SAME reviewer agent
    re-prompted with re-reviewer.md.
  - `src/agent-lib/reviewer-prompt.ts` — pure renderers for reviewer.md / re-reviewer.md
    / fix.md (`fixCycle` for the latter two). Reviewer NOTES are the handoff: committed
    `reviewer-verdict.md`, named in the fix prompt (read from checkout, NOT inlined).
  - `runReviewerPhase(cycle,isRecheck)` + `runFixPhase(cycle)` (build-phases.ts): mint
    repo-write → octokit → `withBuildSandbox` (pre-clone+checkout) → per-cycle named
    session (`reviewer:N`/`recheck:N`/`fix:N`) → verdict text returned to the loop →
    `parseReviewerVerdict` drives break/continue. Reviewer records the verdict POINTER;
    fix reads HEAD sha + PUSHES via the SAME mocked `pushBranch` seam as the executor.
  - `cycleFromPhaseName` parses the `:N` suffix; `runPhase` routes `reviewer:`/`recheck:`/
    `fix:` per-cycle. build.ts merges each phase's scratch pointer into `markPhaseDone`.
  - Prompts edited: reviewer/re-reviewer/fix no longer instruct the model to
    `git push` (the workflow pushes deterministically — mirrors executor.md).
- **This slice (3) built:** the real EXECUTOR phase body, wired into
  `defaultBuildDeps().runPhase('executor')` behind the `BuildDeps` seam (runs AFTER
  the post_architect gate). Mirrors the architect:
  - `src/agent-lib/executor.ts` — `createExecutorAgent(ref,octokit,sandbox)`:
    model=resolveModel('executor') (falls back to default), thinking='executor',
    persona instructions, READ-ONLY github tools, `building` skill, sandbox+cwd
    /workspace. Top-level NAMED session `executor` (NOT a subagent).
  - `src/agent-lib/executor-prompt.ts` — renders `src/prompts/executor.md`; NAMES
    `.lastlight/issue-<N>/architect-plan.md` (the plan is the handoff — read from
    the checkout, NOT inlined); optional untrusted-wrapped issue snapshot.
  - `runExecutorPhase` (build-phases.ts): mint repo-write token → octokit →
    `withBuildSandbox` (pre-clone+`checkout -B`, plan on branch) → session (agent
    implements + COMMITS in-sandbox via git CLI, NOT a tool) → `readHeadSha` →
    **`pushBranch` SEAM** (the controlled repo-write side effect). Scratch records
    executor-summary POINTER + commit sha (spec/10); `PhaseResult.scratch` carries
    them up to the workflow's `markPhaseDone`.
  - **PUSH = mockable seam:** `withBuildSandbox` now also hands the `BuildContainer`
    to the body so the workflow runs `git push origin <bound-branch>` in-sandbox
    after the session. MOCKED in all default tests (asserts it WOULD push the bound
    ref) — NO real push. Executor prompt no longer instructs the model to push.
- **This slice (2) built:** the real ARCHITECT phase body, wired into
  `defaultBuildDeps().runPhase('architect')` behind the `BuildDeps` seam.
  - `src/agent-lib/architect.ts` — `createArchitectAgent(ref,octokit,sandbox)`:
    model=resolveModel('architect'), thinkingLevel=resolveThinking('architect'),
    instructions=loadPersona() (carries security.md), read-only github tools (closed
    over ref/octokit), `building` skill, sandbox + cwd=/workspace. Top-level NAMED
    session `architect` (NOT a subagent — resume can re-open it).
  - `src/agent-lib/build-sandbox.ts` — `withBuildSandbox` (mirrors reviewer-sandbox;
    caller-owns-lifetime): creates a node+git container w/ repo-write token baked as
    env, FULL-clones the repo + `checkout -B <branch>`, ALWAYS `remove()`s in finally.
    NO tool-only fallback (architect needs the workspace → clone/checkout failure
    THROWS, token-redacted). EGRESS still deferred.
  - `src/agent-lib/architect-prompt.ts` — renders `src/prompts/architect.md`
    (build-time markdown import, inlined) w/ repo/branch/issueDir/issueNumber +
    a contextSnapshot. `src/engine/untrusted.ts` — ported `wrapUntrusted` markers:
    issue title/body/comment wrapped UNTRUSTED (spec/07); trigger metadata stays
    outside; injected markers stripped so hostile text can't escape the wrapper.
  - Plan PERSISTENCE: agent writes+commits `.lastlight/issue-<N>/architect-plan.md`
    on the branch (durable handoff); run-record scratch stores the POINTER only
    (spec/10 split rule), so the gate can surface it + the executor can consume it.
  - Architect's own seams (mintToken/makeOctokit/sandboxOps/runArchitectSession)
    injectable → default impl tested OFFLINE.
- **STILL STUBBED / deferred (later Phase-4 slices):** guardrails body + the gate ask
  (postGateComment) + the deterministic open-PR are `defaultBuildDeps()` STUBS that
  throw (TODO(phase-4/guardrails|channels|github-post)); guardrails BLOCKED-bypass
  parity; boot-wire of `recoverOrphanRuns`; channels resume entry. **The LIVE
  executor/fix PUSH** is the mocked `pushBranch` seam — real push is gated + run later
  WITH THE USER (never in tests).
- **NO LIVE SIDE EFFECTS this slice** — reviewer-loop wired but NOT run live; all
  GitHub/sandbox/model/PUSH interaction MOCKED in tests; no branches/commits/PRs/pushes.
- **Blockers:** none.

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
- [~] **4 — build + durable approval gate** ← **IN PROGRESS** (slice 4 of N).
  Slice 1: durable control flow + gate + run-record. Slice 2: real ARCHITECT.
  Slice 3: real EXECUTOR (mocked push seam). Slice 4: real REVIEWER-LOOP — reviewer:N
  (reviews committed diff in checkout, emits VERDICT, NO GitHub post) → [post_reviewer
  gate] → fix:N (addresses notes, commits, MOCKED push) → recheck:N (re-reviewer on
  the fix); verdict→loop break/continue; per-cycle idempotency (`reviewer:N`/`fix:N`/
  `recheck:N` keyed). New tests: reviewer-prompt golden (7), build-reviewer agent-config
  + reviewer/fix phase-wiring + defaultBuildDeps routing (13), build.ts max_cycles +
  per-cycle idempotency golden (+2). Suite **346 passed / 5 skipped** (+22).
  `flue build` green; discovery = agents{hello} + workflows{build,gated,pr-review};
  `grep -c vitest dist/server.mjs` = 0.
  **Next slice:** guardrails body + the gate-ask (postGateComment) + the deterministic
  open-PR (then boot-wire recoverOrphanRuns + channels resume entry).
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
