# Build progress

> Single source of truth for "where is the build." The `/loop` (see `BUILD-LOOP.md`)
> reads this first every iteration. Keep it terse and current: update it at the end
> of every slice, right after the commit.

## Current position
- **Phase:** 1 — Shared core port (IN PROGRESS). Phase 0 ✅ (hard gate cleared).
- **Slice:** survey done + first port landed (templates/verdict/loop-eval) →
  NEXT: **config module** (`src/config.ts`: typed loader + `resolveModel(task)` /
  `resolveThinking(task)` variant→thinkingLevel, `LASTLIGHT_*` env aliases,
  fail-open JSON parse) — small, unblocks tools/agents. THEN git-auth + profiles
  (verbatim), THEN GitHub `defineTool` factories, THEN copy skills/prompts/
  agent-context + persona.ts + a SKILL.md frontmatter-audit test.

### Phase 1 port map (from reference survey of ~/work/lastlight) — target → source
Pure/portable (zero framework coupling). Target layout: `src/engine/` + `src/config.ts`
+ `src/tools/` + `src/agents/persona.ts` (per design/phase-1-shared-core.md §layout).
- [x] `src/engine/templates.ts`  ← `src/workflows/templates.ts` (175L, verbatim) ✅
- [x] `src/engine/verdict.ts`     ← `src/workflows/verdict.ts` (38L) ✅
- [x] `src/engine/loop-eval.ts`   ← `src/workflows/loop-eval.ts` (89L) ✅
- [ ] `src/config.ts`             ← `src/config.ts` (624L) + `src/config-resolve.ts`
      (68L). Key: `resolveModel(models,task)`, `resolveVariant/resolveThinking`,
      `LastLightConfig` shape, 3-layer merge (env>overlay>default), tests:
      config.test.ts / config-resolve.test.ts / config-overlay.test.ts.
- [ ] `src/engine/git-auth.ts`    ← `src/engine/git-auth.ts` (227L, +test). Node
      builtins only (crypto JWT RS256 → installation token, downscope). Verbatim.
      Exports: `configureGitAuth`/`refreshGitAuth`, `GitHubTokenPermissions`.
- [ ] `src/engine/profiles.ts`    ← `src/engine/profiles.ts` (266L). `GitAccessProfile`
      (read|issues-write|review-write|repo-write), `GITHUB_PERMISSION_PROFILES`,
      `GitSandboxAccess`. Re-point `loadAgentContext` → persona.ts. ⚠ keep
      `GitAccessProfile` distinct from Flue's agent `profile` option.
- [ ] `src/tools/github.ts` (+`github-read.ts`) ← reimplement `src/engine/github-tools.ts`
      (354L, pi-ai schema) as Flue `defineTool` factories bound to (ref, token,
      profile). `src/engine/github-app-client.ts` (Octokit factory) ports ~as-is.
      Harness `GitHubClient` (postComment/react) in `src/engine/github.ts`.
- [ ] copy `skills/` (12 SKILL.md dirs) `prompts/` (13 .md) `agent-context/` (3 .md:
      soul/rules/security) → `src/agents/persona.ts` concat + frontmatter-audit test.
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
  `src/engine/` with co-located tests (56 ported tests green; fidelity to
  reference confirmed). Full suite 68 passed / 2 skipped.
- **Last commit:** `e7752f5` — Phase 1 pure utilities ported.

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
- [ ] 1 — Shared core port (config, git-auth/profiles, tools, skills, persona, template/verdict/loop-eval)
- [ ] 2 — Server + preserved API surface (Hono + flue() + crons + /api + /admin/api + CLI)
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
