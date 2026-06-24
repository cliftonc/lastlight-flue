# Flue beta.2 → beta.3 migration — remaining work

Status as of this checkpoint: **10 of 12 workflows migrated and typecheck-clean**; all
tools, the admin reader, and the sandbox infrastructure done. Only `build` + `explore`
(the multi-phase, durable-gate pair) and the test suite remain.

This is the question "are we using Agents/Workflows/Actions idiomatically?" — answered:
the codebase was idiomatic **for `@flue/runtime@1.0.0-beta.2`**, but the docs at
flueframework.com describe **beta.3**, which introduced `defineWorkflow` / `defineAction`
/ `defineAgent` and valibot-based `defineTool`. This is a version-skew migration, not a
rewrite. (Verified against the `withastro/flue` `CHANGELOG.md`, which is the migration spec.)

---

## 1. The beta.3 API deltas (verbatim from the flue CHANGELOG)

- **Workflows**: the bare `export async function run(ctx)` form is **removed**. A workflow
  module must `export default defineWorkflow({ agent, input?, output?, run })` (inline) or
  `defineWorkflow({ agent, action })` (extracted). Every workflow requires a static bound
  `agent`. `run` receives an `ActionContext = { harness, input, log }`. `ctx.init()` is gone
  (the runner owns root-harness init); `ctx.payload` → `input`; **`ActionContext` has no
  `id`/`env`/`req`** (`harness.name` is the literal `'default'`, NOT the run id).
- **`createAgent` → `defineAgent`** (deprecated alias kept). `FlueContext` → `FlueEventContext`
  (now observe-only). `AgentCreateContext` → `AgentInitializerContext` (`{ id, env }`, where
  `id` = the run id — but the initializer can't see workflow `input`).
- **Tools**: `parameters`(JSON-schema)+`execute` → valibot `input`/`output` + `run({ input, signal })`.
  The old form throws `ToolLegacyDefinitionError`. Return structured data directly (no `JSON.stringify`).
- **Invocation**: `{ payload }` → `{ input }`; `flue run --payload` → `--input`;
  `RunRecord.payload` → `input`; `AgentManifestEntry.created` → `defined`. New top-level
  `invoke(workflow, { input })` returns `{ runId }` (does not wait).
- **Durability is unchanged**: Flue still does NOT checkpoint TS execution and adds **no**
  HITL/gate primitive. App-owned durability (`BuildRunStore`/`resume()` + re-`invoke`) stays.
- **Sandboxes**: `SandboxFactory = { createSessionEnv({ id }): Promise<SessionEnv> }`, set by
  the agent **initializer** (per-run, async). **No teardown hook** — Flue only calls
  `harness.close()` (closes sessions), never disposes the `SessionEnv`. (`api/sandbox-api.md`:
  *"Flue does not manage sandbox lifetime."*) Per-run content goes in via `harness.shell`/`fs`
  in `run()`, NOT the initializer (which can't see input).

---

## 2. The proven migration template (apply to any single-phase workflow)

This compiled cleanly for all 10 migrated workflows. Use it as the reference.

**Agent factory file** (`src/agent-lib/<x>.ts`): replace
`createXAgent(ref, octokit[, sandbox])` returning `createAgent(() => ({ …, tools: githubReadTools(ref, octokit), … }))`
with a **static** export:
```ts
export const xAgent = defineAgent(() => ({
  model: resolveModel(KEY),
  thinkingLevel: resolveThinking(KEY),
  instructions: loadPersona(),
  skills: [...],
  // sandboxed flows only: sandbox: dockerSandbox(), cwd: WORKSPACE
}));
```
Drop `tools` (injected per-call) and the `ref`/`octokit` params.

**Workflow file** (`src/workflows/<x>.ts`):
1. `import { defineWorkflow, type FlueHarness, type FlueLogger, type JsonValue } from "@flue/runtime"; import * as v from "valibot"; import { xAgent } from "../agent-lib/x.ts"; import { githubReadTools } from "../tools/github-read.ts";` — remove `import type { FlueContext }`.
2. `interface XInput` → `export const XInputSchema = v.object({ …, runId: v.optional(v.string()) })` + `export type XInput = v.InferOutput<typeof XInputSchema>`.
3. Add `export interface XRunCtx { harness: FlueHarness; input: XInput; log: FlueLogger }` and retype the testable core + every `deps` callback from `FlueContext<XInput>` → `XRunCtx`.
4. Session runner: drop `createXAgent(...)` + `ctx.init(agent)`; use `const session = await ctx.harness.session(NAME)` and inject tools at the call: `runPhasePrompt(session, prompt, { runId: ctx.input.runId ?? ctx.harness.name, workflow, phase }, { tools: githubReadTools(ref, octokit) })` (or `{ tools }` on a bare `session.prompt`).
5. Body: `ctx.payload`→`ctx.input`; `ctx.id`→`ctx.input.runId ?? ctx.harness.name`; `ctx.log` stays.
6. Entry: replace `export async function run(ctx)` with
   ```ts
   export default defineWorkflow({
     agent: xAgent,
     input: XInputSchema,
     async run({ harness, input, log }) {
       return (await runX({ harness, input, log })) as unknown as JsonValue;
     },
   });
   ```
   (`output` schema omitted — optional; the `JsonValue` cast keeps the typed core for tests.)

**Sandboxed single-phase** (see `security-review`/`pr-fix` for the worked examples): the agent
declares `sandbox: dockerSandbox(), cwd: WORKSPACE`; the workflow `run()` clones with
`cloneRepoIntoHarness(ctx.harness, { owner, repo, branch, scrubRemote? }, token)` from
`src/agent-lib/build-sandbox.ts` (token passed as an env var, never argv). Use `scrubRemote: true`
for read-only flows; omit it when the flow pushes (the token-bearing origin is needed).

---

## 3. What's DONE (typecheck-clean)

- **Deps**: `@flue/runtime`/`@flue/cli` → `1.0.0-beta.3` (`valibot` already present). `@flue/github`/
  `@flue/slack` remain beta.1 — verified they import nothing from `@flue/runtime`, safe against beta.3.
- **Tools** (`src/tools/{github-read,github,web}.ts`): valibot `input`/`run`, structured returns.
- **Admin** (`src/admin/runs-reader.ts`): `RunRecord.payload`→`input`, `AgentManifestEntry.created`→`defined`.
- **Sandbox infra** (`src/sandboxes/docker.ts`): `dockerSandbox()` factory + `DockerContainer.createEphemeral`
  (self-terminating `docker run -d --rm … sleep <ttl>`). `src/agent-lib/build-sandbox.ts`: `cloneRepoIntoHarness()`.
- **Workflows migrated (10)**: `issue-triage`, `answer`, `issue-comment`, `pr-comment`,
  `security-feedback`, `repo-health`, `gated` (agent `model: false`), `pr-review` (tool-only —
  additive Docker dropped, see TODO in `reviewer.ts`), `security-review` (sandbox), `pr-fix` (sandbox + push).
- **Agents → static `defineAgent`**: triage, answer, issue-comment, pr-comment, security-feedback,
  repo-health (health), reviewer, security, fix.

Error count: 103 → ~66 (the only SOURCE errors left are `build.ts`, `explore.ts`,
`build-phases.ts`, `explore-phases.ts`; the rest are test files = Phase H).

---

## 4. REMAINING — `build` + `explore` restructure (the multi-phase pair)

**The blocker**: beta.2 `build` stands up a **separate named harness per phase** via
`ctx.init(agent, { name })` (guardrails/architect/executor/reviewer:N/fix:N/recheck:N — each a
different agent/model), all sharing a `withBuildSandbox` container keyed by `taskId`. beta.3 has no
`ctx.init` and binds ONE agent per workflow. So phases must become **subagent profiles** delegated
on a single shared harness.

### 4a. Agents → profiles
For `architect.ts`, `executor.ts`, `guardrails.ts`, and `build-reviewer.ts` (reviewer + fix), convert
each `createXAgent(ref, octokit, sandbox)` to:
```ts
export const xProfile = defineAgentProfile({
  name: '<phase>',                     // 'architect' | 'executor' | 'guardrails' | 'reviewer' | 'fix'
  model: resolveModel(KEY),
  thinkingLevel: resolveThinking(KEY),
  instructions: loadPersona(),
  skills: [...],
});
```
NO `tools` (injected per `session.task`), NO `sandbox`/`cwd` (inherited from the coordinator harness).
(`build-reviewer.ts` already has a `fixAgent` `defineAgent` for `pr-fix` — keep it; add the profiles
alongside.)

### 4b. Coordinator agent (new — in `build-phases.ts` or `build.ts`)
```ts
export const buildAgent = defineAgent(() => ({
  model: false, // REQUIRED: the coordinator only delegates (session.task); beta.3
                // initializeRootHarness rejects a root agent with no model. `false`
                // = "this agent makes no LLM calls itself" (each profile has its own).
  sandbox: dockerSandbox(),
  cwd: BUILD_WORKSPACE,
  subagents: [guardrailsProfile, architectProfile, executorProfile, buildReviewerProfile, fixProfile],
}));
```
> ⚠️ A coordinator agent (build, explore) MUST set `model: false` — it crashes a live `flue run`
> with "defineAgent() requires a model" otherwise. Unit tests inject a fake harness so they never
> hit `initializeRootHarness`; this only surfaces on a real run.

### 4c. `build-phases.ts` rewrite (1052 lines — the bulk)
- `BuildDeps.runPhase` / `postGateComment` / `openPullRequest` take `BuildRunCtx { harness, input, log }`,
  not `FlueContext<BuildInput>`.
- Each phase body: drop the per-phase `withBuildSandbox` + `ctx.init(agent, { name })`. Instead:
  - **Clone once per invocation**: `await cloneRepoIntoHarness(ctx.harness, { owner, repo, branch }, token)`,
    guarded by a per-run "cloned" flag (phases share the one harness sandbox, so the checkout persists
    across `session.task` calls; on a resume the harness is fresh and `cloneRepoIntoHarness` continues
    the pushed branch tip — executor/fix push their commits, so the remote branch carries prior work).
  - Run the phase: `await ctx.harness.session(name)` then
    `runPhasePrompt(session, prompt, { runId: input.runId, workflow:'build', phase:name }, { tools: githubReadTools(ref, octokit) })`
    — OR delegate `session.task(prompt, { agent: '<profile>', tools: githubReadTools(ref, octokit) })`.
  - executor/fix: `readHeadSha`/`pushBranch` via `harness.shell('git …', { cwd: BUILD_WORKSPACE })` over the
    token-bearing origin (clone WITHOUT `scrubRemote`).
- Keep `mintToken` (repo-write) for the clone/push and the deterministic gate/PR posts (unchanged).

### 4d. `build.ts`
- `runBuild(ctx: BuildRunCtx, store, deps)` — the control flow (store logic, gates, breaker, phase-skip,
  reviewer loop) is UNCHANGED; only the `ctx` type + `ctx.payload`→`ctx.input` change.
- Entry:
  ```ts
  export default defineWorkflow({
    agent: buildAgent,
    input: BuildInputSchema,
    async run({ harness, input, log }) {
      const store = new BuildRunStore(storePath());
      try { return (await runBuild({ harness, input, log }, store)) as unknown as JsonValue; }
      finally { store.close(); }   // drop closeBuildWorkspace — container self-terminates
    },
  });
  ```
- `BuildInput` → `BuildInputSchema` (valibot). The `runId`/`owner`/`repo`/`issue`/`branch`/`taskId`/
  `issueContext`/`conversationKey`/`resumedGate`/`triggerType` fields all carry over.

### 4e. `explore` + `explore-phases.ts`
Same pattern: read/ask/synthesize/publish phases → profiles + coordinator; the reply-gate via
`ExploreRunStore` is preserved unchanged; **web tools** (`webTools()`) injected per-call on the
research phases ONLY (never `publish`). `explore.ts` `run()` → `defineWorkflow` like build.

---

## 5. Phase G — channels / resume

- `src/resume.ts` and `src/resume-explore.ts`: the gate re-invoke switches from spawning
  `flue run … --payload` to `invoke(buildWorkflow, { input: { …, resumedGate } })` (or `flue run … --input`).
- `src/channels/{github,slack}.ts`: switch dispatch/spawn to `invoke(workflow, { input })`; validate
  transport payloads at admission and pass explicit `input` (no `ctx.payload`/`ctx.env` downstream).

---

## 6. Phase H — tests & verification (~50 test-file fixups)

Mechanical, but broad. Per failing test file:
- `ctx: FlueContext<…>` fakes → `{ harness, input, log }` shape; `ctx.payload` → `ctx.input`.
- Tool tests: `.execute(args)` → `.run({ input })`; expect structured returns (no `JSON.stringify` string).
- Sandbox workflow tests: `withBuildSandbox`/`withPrFixSandbox`/`reviewer-sandbox` fakes → fake `harness`
  (`harness.session`, `harness.shell`, `harness.fs`) + the `deps.run*Session` seam; assert
  `cloneRepoIntoHarness`/push via the harness fake.
- `RunRecord.payload`→`input`, `AgentManifestEntry.created`→`defined` in `test/app.test.ts` etc.

If beta.3 ships no test harness for `FlueHarness`, build a minimal fake exposing
`session().prompt()/.task()`, `shell()`, `fs`.

**Verify end-to-end:**
- `pnpm typecheck` clean; `pnpm test` (vitest) green — security-spine tests (closed-over creds; model
  never holds write tools) and gate/resume tests must pass.
- `pnpm build` (`flue build`) discovers all workflows via the `defineWorkflow` default export.
- Smoke (needs Docker + a model key): `pnpm exec flue run pr-review --input '{…}'`; a gated `build` run
  driven to `post_architect`, `invoke()`-resumed, confirming phase-skip + deterministic PR + the
  `cloneRepoIntoHarness` clone/scrub/push path (this is the one part NOT statically verifiable).

---

## 7. Open risks / notes
- **Runtime-unvalidated**: the `dockerSandbox()` self-termination + `cloneRepoIntoHarness` token/clone/push
  path compiles but has not run against real Docker — smoke-test in Phase H.
- **Node orphaned-run caveat**: beta.3 Node has no crash-recovery terminalization (an orphaned run stays
  `active`); confirm `BuildRunStore` restart accounting still reconciles.
- **`harness.name === 'default'`** — never use it as the run id; thread `runId` via `input`.
- Companion packages `@flue/github`/`@flue/slack` are beta.1; re-check when a beta.3 release lands.
