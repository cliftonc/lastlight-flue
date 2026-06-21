# Flue capability reference

> **Version pinned:** `@flue/runtime` **1.0.0-beta.2** (repo `withastro/flue`,
> Apache-2.0, ~6.2k★, created 2026-02-07, pushed daily). **Versions are not
> uniform across the family** — `@flue/runtime` is beta.2 while most peripheral
> packages (`@flue/github`, `@flue/slack`, `@flue/libsql`, …) are still beta.1;
> pin each independently. `@flue/runtime` is flagged **"Experimental — APIs may
> change"** and is churning.
> **Flue is beta — re-verify every signature against the installed package before
> each implementation phase.** Each claim below cites a docs URL
> (`flueframework.com/docs/...`) or a `withastro/flue` source path.
>
> **⚠ The pages below were researched against `withastro/flue@main`, which is
> AHEAD of the installed `1.0.0-beta.2`. §0 records what was empirically verified
> against the INSTALLED package on 2026-06-21 and OVERRIDES the older narrative
> (notably the agent/workflow/config import shapes) wherever they conflict.**

---

## 0. Installed-package verification (`1.0.0-beta.2`, 2026-06-21)

Empirically verified against the installed `node_modules` (export introspection +
bundled `node_modules/@flue/runtime/docs/**`, which is the authoritative API for
this pinned version). **This section wins over §2/§3/§9 on any conflict.** The
pinned `node_modules/@flue/runtime/docs/` is the source of truth going forward —
prefer it over `flueframework.com` (which tracks `main`).

**Pins (from `node_modules/.../package.json`):** `@flue/runtime` **1.0.0-beta.2**;
`@flue/cli` **1.0.0-beta.1**; `valibot` **1.4.1**. Runtime deps:
`@earendil-works/pi-agent-core ^0.79.4`, `@earendil-works/pi-ai ^0.79.4`,
`hono ^4.8.3`, `@hono/node-server ^2.0.3`, `just-bash ^3.0.1`, `ulidx ^2.4.1`.
Node ≥ 22.19 (local: v24.16.0).

**Subpath exports (verified):** `.`, `./adapter`, `./routing`, `./tool`,
`./node`, `./cloudflare`, `./cloudflare/internal`, `./test-utils`, `./internal`.

**Main `@flue/runtime` exports (full, verified):** `createAgent`, `dispatch`,
`defineTool`, `defineAgentProfile`, `createSandboxSessionEnv`, `connectMcpServer`,
`bash`, `observe`, `registerProvider`, `registerApiProvider`, `getRun`, `listRuns`,
`listAgents`, plus the `*Error` classes and `IMAGE_DATA_OMITTED`.

**Drift that overrides the design docs / older §2–§3 (IMPORTANT — use these
names):**
- **Agents:** `createAgent(({ id }) => ({ model, instructions, tools, skills,
  sandbox, cwd, profile, subagents }))`. **There is NO `defineAgent`** in beta.2
  (the rename to `defineAgent` exists on `main`, not in the pinned package). Init
  may be sync or async; receives `{ id }`. A file in `src/agents/<name>.ts` whose
  **default export** is `createAgent(...)`; optional `route: AgentRouteHandler`
  export ⇒ `POST /agents/<name>/:id`; optional `description` string export.
- **Workflows:** the **file/function form is the ONLY form** — a file in
  `src/workflows/<name>.ts` exporting `export async function run(ctx)`. **There is
  NO `defineWorkflow` and NO object form** in beta.2. Shape:
  ```ts
  import { createAgent, type FlueContext } from '@flue/runtime';
  const agent = createAgent(() => ({ model: 'openai/...', instructions: '…' }));
  export async function run({ init, payload }: FlueContext<{ text: string }>) {
    const harness = await init(agent);          // init(agent, options?) → FlueHarness
    const session = await harness.session();     // session.prompt(text, opts?)
    return { summary: (await session.prompt(payload.text)).text };
  }
  ```
  `FlueContext` carries `init`, `payload`, `id`, `runId?`, `dispatchId?`, `env`,
  `req?`, `createDefaultEnv`, `defaultStore`, `log`.
- **Invocation:** **NO top-level `invoke` export.** Workflows run via the `flue
  run <name>` CLI, over HTTP, or programmatically via `invokeWorkflowAttached` /
  `handleWorkflowRequest` (lower-level). `dispatch(agent, { id, input })` is the
  public agent-event entry. **Re-confirm the durable-HITL re-invoke mechanism in
  the Phase 0 spike against these primitives — the design's `invoke(wf,{input})`
  name does not exist as such.**
- **Config:** `defineConfig({ target })` is imported from **`@flue/cli/config`**,
  not `@flue/runtime`. Accepts only `{ target: 'node' | 'cloudflare', root?,
  output? }`.
- **Node adapters (`@flue/runtime/node`):** `local(options?) → SandboxFactory`
  and `sqlite(path?) → PersistenceAdapter` are the **only** two exports.
  `local({ env: { GH_TOKEN: process.env.GH_TOKEN } })` is the explicit per-sandbox
  env passthrough (layered over `DEFAULT_LOCAL_ENV_ALLOWLIST`; per-`exec` `env`
  layers on top) — directly answers design **Q0.1**.
- **Routing:** `@flue/runtime/routing` exports exactly `flue`. Mount with
  `app.route('/', flue())`.
- **Tool:** `@flue/runtime/tool` exports exactly `defineTool` (also re-exported
  from `.`).
- **CLI (`flue`, verified `--help`):** `dev | run | connect | build | init | add |
  update | docs | logs`. **`flue logs <workflowRunId>` DOES exist** (overrides §9's
  "no `flue logs`"). `flue connect <agent> <instance-id>` **requires** an
  instance-id arg (not `flue connect <agent> local`). `flue run <wf> --payload
  '<json>'`.

This document is the destination half of the spec: it records *what Flue
actually provides*, so the per-layer requirement pages (`01`–`11`) can cite a
concrete, verified mechanism rather than an assumption. Where Flue's model
differs materially from Last Light's, the difference is flagged as a **⚠ gap**.

---

## 1. What Flue is

"The sandbox agent framework" — build autonomous agents and AI workflows with a
programmable TypeScript harness, **powered by the Pi agent core**. The real Pi
packages are `@earendil-works/pi-agent-core` + `@earendil-works/pi-ai` (repo
`github.com/earendil-works/pi`, by Armin Ronacher; `@flue/runtime` pins
`^0.79.4`) — the same lineage Last Light runs as `agentic-pi`/`pi-ai`. (The bare
unscoped `pi-ai` on npm is a placeholder reservation, not the runtime.) Runtime:
Node ≥ 22.19; deploy targets Node, Cloudflare Workers, GitHub Actions, GitLab CI,
Render, Daytona. (`README.md`; `flueframework.com/docs/getting-started/quickstart/`.)

Published package surface (the only supported import is `@flue/runtime`; do not
import `@flue/runtime/internal`):

| Package | Role |
|---|---|
| `@flue/runtime` | harness, agents, workflows, tools, sandbox, sessions, routing |
| `@flue/cli` | `flue` binary — dev/build/run/logs, `flue add <blueprint>` |
| `@flue/sdk` | client for **consuming** deployed agents/workflows over HTTP |
| `@flue/github`, `@flue/slack`, … | channels (verified event ingress) |
| `@flue/libsql`, `@flue/postgres`, `@flue/mysql`, `@flue/mongodb`, `@flue/redis` | persistence adapters |
| `@flue/opentelemetry` | OTel tracing adapter |

`@flue/runtime` subpath exports (from `packages/runtime/package.json`): `.`,
`./adapter`, `./routing`, `./tool`, `./node`, `./cloudflare`, `./test-utils`,
`./internal` (private).

---

## 2. Agents — `createAgent`

> **⚠ See §0 — the installed beta.2 export is `createAgent`, NOT `defineAgent`.**
> The example below uses the `main`-branch name; substitute `createAgent`.

Verified from `README.md` and `examples/*` (`withastro/flue`):

```ts
import { defineAgent } from '@flue/runtime';
import { local } from '@flue/runtime/node';
import triage from '../skills/triage/SKILL.md' with { type: 'skill' };
import * as githubTools from '../tools/github.ts';

export default defineAgent(() => ({
  model: 'anthropic/claude-sonnet-4-6',
  tools: [...githubTools],
  skills: [triage],
  sandbox: local(),
  instructions: '…',
}));
```

- **`defineAgent`** is the current name (renamed from `createAgent`, which
  survives as a deprecated alias). `defineWorkflow` was likewise renamed from
  `createWorkflow` (**no** alias). Older examples may still show the `create*`
  names.
- **Options** (`docs/guide/building-agents/`, `AgentRuntimeConfig`): `model`,
  `instructions` (inline string or imported markdown), `tools`, `skills`
  (imported `SKILL.md` with `with { type: 'skill' }`), `sandbox`, `cwd`,
  `profile`, `subagents`, `thinkingLevel`, `compaction`, `durability` (see §5).
  The initializer can be sync or **async** (`defineAgent(async () => …)`), and
  receives `{ id }` — used to bind per-conversation tools, e.g.
  `tools: [commentOnIssue(channel.parseConversationKey(id))]`.
- **Reasoning effort** is a first-class `thinkingLevel` (≈ `off | minimal | low |
  medium | high | xhigh`), settable per agent **and** per call via
  `session.prompt(text, { model?, thinkingLevel? })`. This is the Flue handle for
  Last Light's per-task `variants` — **not** an opaque Pi `--variant`.
- **Models** are router strings (`provider/model`) resolved through **Pi**; any
  Pi-supported provider works. Provider API keys come from env.
- **Addressing:** a persistent agent instance is reached at
  `POST /agents/<name>/<id>`; events stream at `GET /agents/<name>/:id`. `id`
  identifies the continuing instance. (`docs/guide/building-agents/`.)
- **Subagents:** agents can delegate to specialized subagents
  (`docs/guide/subagents/`) — maps to Last Light's architect/executor/reviewer
  split.

---

## 3. Workflows — file/function `run`

> **⚠ See §0 — RESOLVED against installed beta.2: the file/function `run()` form
> (b, below) is the ONLY form. There is NO `defineWorkflow` object form and NO
> top-level `invoke` in the pinned package.** The object form (a) below is
> `main`-only; ignore it for this build.

Two surface forms appear in current docs/examples (**beta drift — confirm which
the installed version uses**):

**a) Object form** (verified, `examples/node-schedules/src/workflows/scheduled.ts`):

```ts
import { defineAgent, defineWorkflow } from '@flue/runtime';
import * as v from 'valibot';
const agent = defineAgent(() => ({ model: 'anthropic/claude-sonnet-4-6' }));
export default defineWorkflow({
  agent,
  input: v.object({ prompt: v.string(), scheduledAt: v.string() }),
  async run({ harness, input }) {
    const session = await harness.session();
    const response = await session.prompt(input.prompt);
    return { text: response.text, scheduledAt: input.scheduledAt };
  },
});
```

**b) File/function form** (`docs/guide/workflows/`): a file under
`src/workflows/` exports `run(ctx)`; the filename is the workflow name.

```ts
export async function run({ init, payload }: FlueContext<{ text: string }>) {
  const harness = await init(summarizer);
  const session = await harness.session();
  const response = await session.prompt(payload.text);
  return { summary: response.text };
}
```

- **`FlueContext`** carries `init`, `payload`/`input`, `id`, `env`, `req`,
  `log`.
- **Harness surface:** `harness.session()` (open an agent context),
  `harness.fs.readFile/writeFile`, `harness.shell(...)`. (`docs/guide/workflows/`.)
- **Session surface:** `session.prompt(text, opts?)`, `session.shell(cmd)`,
  skill execution, subagent delegation. **Structured output** via a Valibot
  schema: `session.prompt(text, { result: v.object({...}) })`.
- **Invocation:** never call `run()` directly — go through the admission
  boundary. Local: `flue run <name> --target node --payload '{…}'`; in code:
  `invoke(workflow, { input })` (`examples/node-schedules/src/app.ts`). HTTP:
  export `route` and `POST /workflows/{name}` → `202 { runId, streamUrl,
  offset }`, or `?wait=result`.
- **Run inspection:** `GET /runs/<runId>`, `client.runs.get()` (`@flue/sdk`),
  `listRuns`/`getRun` (no `flue logs` CLI command exists — see §9).

### ⚠ Gap: workflows are NOT durable/resumable (verified, current)
`docs/concepts/durable-execution/`: *"Flue workflows are not resumable. If a
workflow is interrupted, Flue does not checkpoint arbitrary TypeScript execution
and continue the function from the last completed line or step."* *"Starting a
workflow again creates a new invocation. It does not continue the previous
function call."* Workflows are finite `run()` invocations, each with its own
`runId`. **Durability lives in agent sessions, not workflows** — see §5.

Precise layering (don't conflate with the "durable execution" headline):

- **Durable:** the **agent session** (messages + compacted context, persisted via
  a `PersistenceAdapter`) and the append-only "Durable Streams" event ledger of
  **agent submissions**. This is what survives restarts.
- **Cloudflare-only:** in-flight **agent-turn** checkpointing via Fibers
  (`runFiber()`/`stash()`/`onFiberRecovered()`) inside a Durable Object — and
  even that persists only *explicitly-stashed* state, not arbitrary control flow.
- **Node target — the load-bearing caveat:** *"Node does not get Cloudflare's
  automatic Durable Object wake or Fiber recovery,"* and *"Node currently has no
  recovery path that terminalizes a workflow run interrupted by a crash or closes
  its event stream."* Flue's Node reconciliation covers **agent submissions only,
  not workflow runs** — a crashed workflow run is left `active` with a dangling
  open stream. **The application must own boot-time orphan-run detection +
  idempotent re-invoke.** (`docs/guide/targets/node/`.)

This is the single most important constraint for porting Last Light's resumable,
ledger-driven runner and its approval gates. The app-owned "run record +
idempotency keys + re-invoke" model (`06`) is therefore **necessary on Node**,
and is exactly the pattern the Flue docs recommend ("design workflows so they can
be invoked again… much like CI jobs").

---

## 4. Tools — `defineTool` & MCP

Verified (`examples/github-channel/src/channels/github.ts`):

```ts
import { defineTool } from '@flue/runtime';
defineTool({
  name: 'comment_on_github_issue',
  description: '…',
  parameters: { type: 'object', properties: { body: { type: 'string', minLength: 1 } },
    required: ['body'], additionalProperties: false },
  async execute({ body }) { /* returns a string */ },
});
```

- Tools are **typed, bounded application actions** — JSON-Schema parameters,
  an `execute` returning a string. Flue's security guidance: keep credentials,
  repo/owner/IDs, and arbitrary API methods **out of tool arguments** unless
  explicitly authorized; don't let the model choose them. (`docs/guide/tools/`,
  channel blueprints.)
- **MCP:** agents can connect to MCP servers for authenticated external tools
  (`docs/guide/tools/#connect-mcp-tools`), but **Flue MCP is HTTP-only** — a
  stdio server like Last Light's `mcp-github-app` would need a wrapper.
  **Decision (P1):** retire `mcp-github-app`; reimplement the GitHub actions as
  bound `defineTool` **factories** that close over the scoped token + repo/owner,
  so neither is a model-selected argument (Flue security rule).

---

## 5. Durable execution & human-in-the-loop

`docs/guide/durable-execution/`:

- **Durable agents:** an agent instance is a single stateful conversation; *"a
  stored session includes messages and compacted context needed to reopen the
  conversation later… the session history is the durable record that lets an
  agent continue working after an earlier operation has finished."*
- **Recovery is conservative/idempotent:** Flue settles work as success when it
  can prove completion, restarts only when it can prove the provider was never
  reached, and resumes an interrupted response from durably stored partial
  output. *"Use application-owned idempotency keys where repeated effects would
  be harmful."*
- **Node default is in-memory** — durability requires a `PersistenceAdapter`
  (see §7).
- **Human-in-the-loop / approvals are an agent capability**, not a workflow
  one: the model streams, calls tools, waits for results, *"maybe asks a human
  for approval,"* or delegates to a subagent (Cloudflare blog; `README.md`
  feature list). On Cloudflare this rides Durable Objects; on Node it rides the
  persisted session. **There is NO native "suspend a workflow awaiting human
  input, then resume past the gate" primitive** — durable waiting-across-time is
  an *agent-session* property, and the workflow-level gate is application-owned
  (write `pending` + return + idempotent re-`invoke`).
- **`durability` / `DurabilityConfig`** on `defineAgent` is **submission
  retry/timeout policy, not workflow checkpointing**: `maxAttempts` (default 10,
  "maximum total attempts before the submission is terminalized as failed") and
  `timeoutMs` (default 3600000, "maximum wall-clock ms for a single submission").
  It governs how long/often an accepted agent submission is retried — it does
  **not** make workflow TypeScript resumable. (`docs/api/agent-api/`.)

### Implication for Last Light's approval gate
Last Light pauses a **workflow** at `post_architect`, persists `paused`, and
resumes from an external signal. Since Flue workflows don't checkpoint, the gate
must be modeled either as (a) a **durable agent session** that suspends awaiting
human approval, or (b) **application-owned run state** (mirroring Last Light's
own `workflow_runs` + `executions` ledger) that drives an idempotent
re-`invoke`. Decision is recorded in `06-workflow-engine.md` / `10-state.md`.

---

## 6. Sandboxes & egress

`docs/guide/sandboxes/`; `blueprints/sandbox*.md`; e2b adapter source.

Three models:
- **Virtual (default):** in-memory "just-bash" workspace; files don't persist
  past the session. *"Not a network isolation boundary: current generated
  runtimes permit network access from the virtual sandbox."*
- **Local — `local()` (`@flue/runtime/node`):** direct host filesystem + shell.
  *"Use `local()` only where the host and input are already trusted."* Host env
  is limited by default; expose values via `local({ env: { … } })`.
- **Remote/managed (e2b, daytona, modal, vercel, cloudflare, …):** provider VMs.
  *"Your application is responsible for deciding which workspace belongs to
  which agent instance or workflow, what credentials and network access it
  receives."*

**Contract** (`SandboxFactory` → `createSessionEnv()` → `SandboxApi`):
`readFile`, `readFileBuffer`, `writeFile`, `stat`, `readdir`, `exists`, `mkdir`,
`rm`, `exec(command, { cwd, env, timeoutMs, signal })`. Adapters wrap a provider
SDK (e.g. e2b Firecracker microVMs; `Sandbox.create()`). Spec at
`docs/api/sandbox-api/`.

### ⚠ Gap: no built-in egress firewall — enforced at the provider (decided P0)
**Flue exposes no egress allowlist, SNI filtering, or network-isolation controls
for any sandbox type** (docs explicitly; blueprints contain zero network/egress
config). Last Light's default-deny allowlist (CoreDNS sinkhole + nginx SNI-peek,
`src/sandbox/egress-allowlist.ts`) has **no Flue analogue**. This is the
rebuild's **#1 security risk** — see `09-sandbox.md`.

**Decision (Phase 0): enforce at the E2B provider.** Use
`Sandbox.create({ network: { allowOut, denyOut }, envs })` — **default-deny** via
`denyOut: allTraffic`, then `allowOut` the GitHub + provider + package-registry
hosts. The existing `egress-allowlist.ts` is **kept** as the single source
feeding that config. **The SSRF metadata floor is NOT automatic on E2B** — add
`169.254.0.0/16` (and `metadata.google.internal`) explicitly to `denyOut`, even
in opt-in "open" mode. Residual caveat (identical to today's nginx stack): SNI
filtering without TLS termination — a hostname→private-IP redirect is not caught
in open mode. Validate fidelity on the **prod** E2B account before deleting the
docker stack (`08`).

### ⚠ Gap: no built-in `web_search` / `web_fetch`
Despite Pi powering the runtime, Flue exposes **no first-class web-search/fetch
agent tool**. **Decision (P5):** implement `web_search`/`web_fetch` as **gated
`defineTool`s** (Tavily › Exa › Brave), bound only onto the `explorer` agent and
only on phases that opt in — reproducing Last Light's per-phase web-search gate.
Do not assume `09`/older notes' "Flue's `web_search` (Pi)" — it must be built.

---

## 7. Persistence adapters

`docs/guide/durable-execution/`; `blueprints/database*.md`.

- A project exports a `PersistenceAdapter` from `src/db.ts` (or `.flue/db.ts`):
  `sqlite()` (file-backed), `postgres()`, plus `@flue/mysql`, `@flue/mongodb`,
  `@flue/redis`, libsql/turso/supabase/valkey blueprints.
- The adapter stores **agent sessions** (messages + compacted context) and run
  records — this is what makes agents durable across restart/deploy.
- `@flue/runtime/test-utils` exports a **store-contract test suite**
  (`define-store-contract-tests`) any adapter must pass — useful to validate a
  custom/extended adapter.

- **Read paths (validated against `RunStore`/`EventStreamStore` source):**
  `listRuns({ status, workflowName, limit, cursor })` returns blob-free pointers
  (satisfies "list excludes blobs" natively); `getRun(id)` for detail; an
  **`EventStreamStore`** yields transcripts via `runStreamPath(runId)` and
  `agentStreamPath(name, instanceId)`. This is what **replaces** Last Light's
  JSONL shim + `SessionReader`/`ChatSessionReader` (§— retired in `10`). `GET
  /runs/<id>` + `client.runs` remain the HTTP read paths.
- The only views **not** natively reproducible (small app-owned tables): per-phase
  cost/token **stats rollups** and **messaging-thread grouping**. Validate the
  rest in Phase 7 before deleting the shim (risk #3).

---

## 8. Channels (verified event ingress)

`docs/guide/channels/`; `blueprints/channel--github.md`, `--slack.md`;
`examples/{github,slack}-channel`.

**GitHub** (`@flue/github` + `@octokit/rest@^22`):
```ts
export const channel = createGitHubChannel({
  webhookSecret: process.env.GITHUB_WEBHOOK_SECRET!,
  async webhook({ delivery }) {           // path: /channels/github/webhook
    // delivery.name = X-GitHub-Event; narrows delivery.payload (octokit types)
    await dispatch(agent, { id: channel.conversationKey(ref), input: { … } });
  },
});
```
- `channel.conversationKey(ref)` / `channel.parseConversationKey(id)` — stable
  per-conversation id ↔ ref. JSON content-type only; respond `2xx` within 10s
  (GitHub doesn't auto-retry) — admit durable work fast and **dedupe on
  `delivery.deliveryId`**. Filtering is application policy inside `webhook()`.

**Slack** (`@flue/slack` + `@slack/web-api@^8`):
```ts
export const channel = createSlackChannel({
  signingSecret: process.env.SLACK_SIGNING_SECRET!,
  async events({ payload }) { … },        // /channels/slack/events
  async interactions({ payload }) { … },  // /channels/slack/interactions  (optional)
  async commands({ c, payload }) { … },   // /channels/slack/commands       (optional → SLASH commands)
});
```
- Exact-byte signature + timestamp verification; URL-verification handled
  internally. `payload.event` is the native `SlackEvent` union (no parallel
  normalized model). `trigger_id`/`response_url` are short-lived — **never**
  persist them into dispatch input, model context, logs, or sessions.
- `commands` is the surface for Last Light's `/approve` `/reject`.

**Dispatch/invoke** (`@flue/runtime`): `dispatch(agent, { id, input })` routes
an event to a persistent agent instance; `invoke(workflow, { input })` starts a
workflow run. Mount everything with `app.route('/', flue())` on a Hono app
(`@flue/runtime/routing`).

---

## 9. Routing, server, CLI, deploy

- **Server:** a Hono app mounts `flue()` routing (`examples/node-schedules/src/app.ts`).
  Custom routes (Last Light's `/api/*`, `/admin/api/*`) coexist on the same Hono
  app — this is how the existing dashboard + CLI surface is preserved.
- **Config:** `flue.config.ts` → `defineConfig({ target: 'node' | 'cloudflare' | … })`
  (`@flue/cli/config`).
- **CLI (`flue`):** the actual command set is
  `init | dev | connect | run | build | add | update | docs`. `flue dev` is a
  **watch-mode local dev server** (port 3583) — **not** a run/session inspector.
  `flue run <wf>`, `flue connect <agent> local` (interactive session), `flue add
  <blueprint>` (scaffold sandbox/db/channel adapters), `--env <file>` to load
  `.env`. **There is no `flue logs` / `flue studio` command** — read runs via
  `GET /runs/<id>` / `client.runs`.
- **Crons:** plain `croner` + `dispatch`/`invoke` (`examples/node-schedules`).

---

## 10. Observability

`docs/guide/observability/`: built-in observer + adapters for
**OpenTelemetry** (`@flue/opentelemetry`), Braintrust, Sentry. Last Light's
existing `LASTLIGHT_OTEL_*` env feeds the OTel adapter.

**⚠ Correction: there is no "Flue Studio."** A docs-tree grep for `studio`
returns zero hits, and the CLI has no `studio` command; `flue dev` is a
watch-mode dev server, not an inspector. Earlier drafts of this reference and
pages `01`/`10` said "Studio runs alongside the dashboard" — **dropped.** Live
run/session inspection comes from (a) the retained dashboard, (b) `@flue/
opentelemetry` spans, and (c) `GET /runs/:id` + `listRuns`/`getRun`.

---

## 11. Maturity & risk signals

- **Strong:** 6.2k★, Apache-2.0, by the Astro team, daily pushes, broad
  first-party ecosystem (25+ channel/db/sandbox packages), built on Pi (already
  Last Light's runtime), store-contract tests shipped.
- **Watch:** pre-1.0 **beta**, `@flue/runtime` flagged **"Experimental."** APIs
  are shifting — the `createAgent→defineAgent`/`createWorkflow→defineWorkflow`
  rename already landed, and versions are **not uniform** across `@flue/*` (runtime
  beta.2, peripherals beta.1). No tagged GA release yet; pin and re-verify every
  signature per phase.
- **No GA `latestRelease`** at time of writing (`gh repo view` → `latestRelease:
  null`); track the 1.0 milestone.

---

## 12. Source citations index

- Docs: `flueframework.com/docs/{getting-started/quickstart, guide/building-agents,
  guide/workflows, concepts/durable-execution, guide/targets/node,
  guide/targets/cloudflare, guide/sandboxes, guide/tools, guide/channels,
  guide/subagents, guide/observability, api/sandbox-api, api/agent-api,
  sdk/overview, ecosystem/deploy/*}` (markdown via the `…/index.md` suffix).
- Repo `withastro/flue`: `README.md`, `packages/runtime/package.json`,
  `examples/node-schedules/*`, `examples/github-channel/*`,
  `blueprints/{sandbox,sandbox--e2b,sandbox--daytona,database,database--postgres,
  database--libsql,channel--github,channel--slack}.md`.
- Context: Cloudflare blog `blog.cloudflare.com/agents-platform-flue-sdk/`;
  `flueframework.com/blog/flue-1-0-beta/`.
