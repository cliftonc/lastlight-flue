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
- **Phase:** 1 — Shared core port **✅ COMPLETE**. Phase 0 ✅ (hard gate cleared).
- **Slice:** skills/prompts/agent-context copied + `persona.ts` + frontmatter
  audit ✅ (final Phase-1 slice). → **NEXT: Phase 2 — Server + preserved API
  surface** (Hono + `flue()` + crons + `/api` + `/admin/api` + CLI). Read
  `design/phase-2-server-api.md` next iteration.

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
- **Last commit:** `439d140` — Phase 1 (final slice): copy skills/prompts/
  agent-context under src/ + persona.ts + frontmatter audit.

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
- [ ] 2 — Server + preserved API surface (Hono + flue() + crons + /api + /admin/api + CLI) ← **NEXT (read design/phase-2-server-api.md)**
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
