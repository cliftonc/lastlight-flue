---
title: "Phase 0 — Spike & de-risk"
phase: 0
status: "design complete"
flue_pin: "@flue/runtime 1.0.0-beta.2 (withastro/flue, pushed 2026-06-21); pi core @earendil-works/pi-agent-core@^0.79.4"
date: 2026-06-21
---

# Phase 0 — Spike & de-risk

> **⚠ DECISION UPDATE (2026-06-21, supersedes the E2B framing below).** The
> sandbox is now a **custom Docker `SandboxFactory`** (`src/sandboxes/docker.ts`),
> not E2B — Docker is on the host and needs no account/key, and Flue sandboxes are
> bring-your-own anyway (e2b/daytona/modal are blueprints, not packages).
> **Egress is DEFERRED for this phase:** containers run with full network and no
> SSRF floor (a known, temporary, recorded risk). The detailed E2B / egress
> research in this doc is **retained as the eventual egress-hardening reference**
> (re-host CoreDNS/nginx into the factory, or switch prod to E2B). Default model
> for the spike = an `openai/*` specifier (only `OPENAI_API_KEY` is present).
> See `00` risk #1, `09`, and the decision log in `overall-architecture.md`.

## Scope

Prove the three things the Mastra port couldn't, before porting anything:
(1) a Flue hello-world agent on our Pi/OpenAI key; (2) a **custom Docker
`SandboxFactory`** that clones + builds a repo in an isolated container and tears
it down; (3) **durable HITL** — a gated run that suspends, survives a process
restart, and resumes from an external signal, proving `invoke(runId)` re-runs and
whether named sessions reattach. Egress enforcement is **deferred** (later
hardening phase). Deliverable: 3 committed examples + a `MIGRATION.md` with pinned
signatures and the invoke/session answers.

## Current Flue research

All claims re-verified against `withastro/flue@main` (pushed `2026-06-21T06:40Z`)
and `flueframework.com/docs/.../index.md` on **2026-06-21**.

### Version & runtime
- `@flue/runtime` is **`1.0.0-beta.2`** — unchanged from `flue-reference.md`.
  Source: `gh api repos/withastro/flue/contents/packages/runtime/package.json`
  → `"version": "1.0.0-beta.2"`.
- **New pin:** the Pi core is `@earendil-works/pi-agent-core@^0.79.4` +
  `@earendil-works/pi-ai@^0.79.4` (runtime `dependencies`). This is the exact
  Pi version Flue rides; record it in `MIGRATION.md`. Last Light's
  `agentic-pi`/`pi-ai` is the same lineage.
- Runtime bundles **Hono `^4.8.3`** + `@hono/node-server@^2.0.3` and
  `just-bash@^3.0.1` (the virtual-sandbox engine) and `ulidx` (run/session ids).
- Subpath exports confirmed: `.`, `./adapter`, `./routing`, `./tool`, `./node`,
  `./cloudflare`, `./test-utils`, `./internal` (private). Matches `flue-reference §1`.

### Agents & invocation (`examples/node-schedules`, `examples/hello-world`)
- `defineAgent(() => ({ model, tools, skills, sandbox, instructions, cwd, profile }))`;
  initializer may be `async`. Verified the **async form is the load-bearing
  one for us** — the e2b blueprint creates the sandbox inside
  `defineAgent(async () => { const sandbox = await Sandbox.create(...); return { sandbox: e2b(sandbox), ... }; })`.
  Doc: `flueframework.com/docs/guide/building-agents/index.md`; blueprint
  `blueprints/sandbox--e2b.md`.
- Admission boundary verified in `examples/node-schedules/src/app.ts`:
  `import { dispatch, invoke } from '@flue/runtime'` — `dispatch(agent, { id, input })`
  for conversational work, `invoke(workflow, { input })` for workflow runs.
  Mount with `app.route('/', flue())` from `@flue/runtime/routing`. **No drift.**

### Workflows (`examples/node-schedules/src/workflows/scheduled.ts`)
- Object form confirmed primary:
  `defineWorkflow({ agent, input: v.object({...}), async run({ harness, input }) {...} })`.
- `harness.session()` → `session.prompt(text, { result? })` / `session.shell(cmd)`;
  `harness.fs.readFile/writeFile`, `harness.shell(...)`. **No drift** vs
  `flue-reference §3`.
- **⚠ Confirmed: workflows are NOT resumable.**
  `docs/guide/durable-execution/index.md` verbatim: *"Flue workflows are not
  resumable. If a workflow is interrupted, Flue does not checkpoint arbitrary
  TypeScript execution and continue the function from the last completed line or
  step."* Applications must re-`invoke` as a **new execution**.

### Durable execution & HITL (`docs/guide/durable-execution/index.md`)
- **Durability lives in agent sessions, not workflows.** On Node, sessions are
  **in-memory by default** and become durable only when `src/db.ts` exports a
  `PersistenceAdapter` (`sqlite()` / `postgres()`). Without it, *"restarts lose
  all in-flight work."*
- **Idempotency is application-owned:** *"Use application-owned idempotency keys
  where repeated effects would be harmful."* For dispatched input, **`dispatchId`**
  correlates submissions (the Flue-native correlation handle).
- **⚠ New finding / drift vs spec narrative:** the durable-execution doc has
  **no documented HITL/approval/suspend primitive** at all. `flue-reference §5`
  implied HITL is "an agent capability"; the current doc page does **not**
  describe a suspend-await-approve API. **Decision: Last Light's approval gate is
  built entirely application-side** (run record + re-`invoke`), not on any Flue
  suspend primitive. This *strengthens* the spec's `06` decision rather than
  contradicting it — see the deviation log.

### Sandbox contract (`docs/api/sandbox-api/index.md`, `blueprints/sandbox--e2b.md`)
- `SandboxFactory { createSessionEnv(opts:{id:string}): Promise<SessionEnv>; tools?: SessionToolFactory }`.
  `createSessionEnv` is called **once per `init()`** and receives the context id.
- `SandboxApi` verbatim:
  ```ts
  interface SandboxApi {
    readFile(path): Promise<string>;
    readFileBuffer(path): Promise<Uint8Array>;
    writeFile(path, content: string | Uint8Array): Promise<void>;
    stat(path): Promise<FileStat>;
    readdir(path): Promise<string[]>;
    exists(path): Promise<boolean>;
    mkdir(path, opts?: { recursive? }): Promise<void>;
    rm(path, opts?: { recursive?; force? }): Promise<void>;
    exec(command, opts?: { cwd?; env?: Record<string,string>; timeoutMs?; signal?: AbortSignal }):
      Promise<{ stdout; stderr; exitCode }>;
  }
  ```
- Helpers: `createSandboxSessionEnv(api, cwd)` builds the `SessionEnv` (don't
  hand-write it); `SandboxOperationUnsupportedError` for unmapped ops.
- **⚠ Critical env-injection finding:** `env` is **per-`exec` only** — there is
  *no* documented session-level env map auto-applied to every command. Flue
  resolves agent-specific config (incl. env) and passes it per-call. **Impact
  for us:** the scoped GitHub token + provider keys must reach the sandbox via
  one of: (a) values baked into `Sandbox.create(...)` at agent-init time
  (E2B `envs`), or (b) per-`exec` `env`. We will bake long-lived run env (token,
  provider keys) into the provider sandbox at creation and rely on Flue's
  per-`exec` `env` for anything Flue itself injects. Recorded as an open
  question.
- **⚠ Confirmed: Flue ships NO egress firewall** for any sandbox type. Grepped
  all 11 `sandbox--*.md` blueprints for
  `network|egress|allowlist|firewall|isolat|metadata|outbound|proxy` →
  **zero hits**. The sandbox-api doc explicitly omits network controls. The
  `09`/`flue-reference §6` gap holds verbatim at HEAD.

### Sandbox provider catalogue (expanded since `flue-reference`)
- Blueprints now: `e2b, daytona, modal, vercel, cloudflare, cloudflare-shell,
  boxd, exedev, islo, mirage`. (`flue-reference` listed only e2b/daytona/modal/
  vercel/cloudflare.) New options exist but **none change the no-egress finding**
  — egress is the *provider's* concern, not Flue's.

### E2B provider network controls (the egress unblock — NEW, decisive)
Researched the E2B SDK directly (E2B docs `sandbox/internet-access`, the E2B
infra `sandbox-network` Go package, E2B's 2026 "fine-grained outbound" launch).
**E2B exposes exactly the control Last Light needs**, at `Sandbox.create()`:
```ts
const sandbox = await Sandbox.create({
  network: {
    allowOut: ['*.github.com', 'api.anthropic.com', 'registry.npmjs.org', ...],
    denyOut: ({ allTraffic }) => [allTraffic],   // default-deny everything else
  },
});
```
- `allowInternetAccess: false` ≡ `denyOut: ['0.0.0.0/0']` (full block).
- `allowOut` accepts **IPs, CIDR blocks, and domains** incl. **wildcards**
  (`*.github.com`). **Domain filtering is SNI/Host-header based** (port 443 SNI,
  port 80 Host) — *the same mechanism as Last Light's nginx `ssl_preread`*. Other
  ports fall back to CIDR-only; QUIC/HTTP3 unsupported.
- **Default-deny pattern:** domains in `allowOut` **require** `denyOut` to deny
  all other traffic (domains can't appear in `denyOut`). "Allow rules take
  precedence over deny rules." `8.8.8.8` DNS auto-allowed when any domain is set.
- `updateNetwork()` replaces (not merges) egress rules on a running sandbox.
- **SSRF floor:** E2B does **not** auto-block `169.254.169.254` /
  `metadata.google.internal`. We must add them to `denyOut` as explicit CIDRs
  (`169.254.0.0/16`, plus the GCP metadata literal) — `denyOut` accepts IP/CIDR.

> **This is the single most important Phase 0 result:** the egress allowlist is
> **portable to a provider-native control**, satisfying the spec's preferred
> Option 1 with the *same SNI semantics* as today's stack. Risk #1 moves from
> "open until Phase 0" to **decided: E2B provider-enforced allowlist + explicit
> metadata-CIDR floor.**

## Design

Three committed example apps under `lastlight-flue/examples/spike-*/`, each a
minimal Flue project (`flue.config.ts → target:'node'`, `pnpm`, TS ESM). They
are throwaway proofs, not production modules — but they pin the exact shapes the
real `src/` will use.

### Module/file layout (spike)
```
lastlight-flue/
  flue.config.ts                 defineConfig({ target: 'node' })
  src/db.ts                      sqlite() PersistenceAdapter (durability ON)
  examples/
    spike-hello/
      src/agents/hello.ts        defineAgent(() => ({ model, instructions }))
      src/app.ts                 Hono + flue(); POST /agents/hello/:id
    spike-sandbox/
      src/sandboxes/e2b.ts       ported e2b() factory (blueprint, verbatim)
      src/egress-allowlist.ts    ported GITHUB+PROVIDER+REGISTRY hosts + META floor
      src/agents/builder.ts      defineAgent(async () => Sandbox.create({network}))
      src/workflows/build.ts     clone + `pnpm i && pnpm build`; assert blocked host
    spike-hitl/
      src/run-store.ts           app-owned run record (sqlite, raw)
      src/workflows/gated.ts     2-step: step1 → write pending → END
      src/resume.ts              resume(runId, decision) → invoke(step2)
      src/app.ts                 POST /resume/:runId calls resume()
```

### Spike 1 — hello-world (proves Pi-on-our-keys)
`defineAgent(() => ({ model: 'anthropic/claude-sonnet-4-6', instructions: '…' }))`,
mounted via `app.route('/', flue())`, exercised with `flue connect hello local`
and a `POST /agents/hello/:id`. Provider keys (`ANTHROPIC_API_KEY` etc.) from
`.env` via `flue dev --env`. **Pass:** a turn returns model text.

### Spike 2 — Docker `SandboxFactory` (egress deferred — see banner)
> **Authoritative for this phase:** implement `src/sandboxes/docker.ts` as a Flue
> `SandboxFactory` — a container per run (workspace mounted, env baked at `docker
> run`), `SandboxApi.exec`/file-ops via `docker exec`, torn down after. **Pass:**
> it clones + builds a repo in an isolated container and tears down. **No egress
> restriction is wired this phase.** The E2B/allowlist code below is the
> egress-hardening reference, not this phase's work.
```ts
// src/egress-allowlist.ts  (ported from lastlight/src/sandbox/egress-allowlist.ts)
// NOTE: ported now but WIRED IN AT THE EGRESS-HARDENING PHASE, not here.
export const GITHUB_HOSTS = ['*.github.com', 'github.com', 'codeload.github.com', ...];
export const PROVIDER_HOSTS = ['api.anthropic.com', 'api.openai.com', ...];
export const PACKAGE_REGISTRY_HOSTS = ['registry.npmjs.org', '*.npmjs.org', ...];
// SSRF floor — non-negotiable, always denied even in "open" mode:
export const METADATA_DENY = ['169.254.0.0/16', '169.254.169.254/32', /* GCP literal handled at DNS */];

export function allowOutFor(opts: { open?: boolean }) {
  return opts.open ? undefined /* open mode: allow all EXCEPT metadata */
                   : [...GITHUB_HOSTS, ...PROVIDER_HOSTS, ...PACKAGE_REGISTRY_HOSTS];
}
```
```ts
// src/agents/builder.ts
const agent = defineAgent(async () => {
  const sandbox = await Sandbox.create({
    network: {
      allowOut: allowOutFor({ open: false }),
      denyOut: ({ allTraffic }) => [allTraffic, ...METADATA_DENY],
    },
    envs: { GH_TOKEN: scopedToken, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY! },
  });
  return { sandbox: e2b(sandbox), model: 'anthropic/claude-sonnet-4-6' };
});
```
The workflow runs `git clone https://github.com/<repo>` + `pnpm i && pnpm build`,
then proves the allowlist by attempting `curl https://example.org` (off-list →
must fail) and `curl http://169.254.169.254/` (metadata → must fail). **Pass:**
clone+build succeed; both forbidden fetches fail.

> **Open-mode SSRF floor caveat:** "open" egress (Phase 5's `explore` phases)
> can't use a domain allowlist *and* a domain denylist simultaneously (E2B
> forbids domains in `denyOut`). The metadata floor in open mode is therefore
> enforced by **CIDR** `denyOut` (`169.254.0.0/16`) which works regardless of
> `allowOut`, plus a coredns-style note that `metadata.google.internal` resolves
> into `169.254.169.254` and is thus caught by the CIDR. Recorded as a residual
> risk (no TLS termination → same caveat as Last Light's open-mode firewall).

### Spike 3 — durable HITL (the resume proof)
Because Flue has no suspend primitive, the gate is **100% application-owned**:
```ts
// src/workflows/gated.ts
export default defineWorkflow({ agent, input: v.object({ runId: v.string(), resumed: v.optional(v.boolean()) }),
  async run({ harness, input }) {
    const run = runStore.getOrCreate(input.runId);
    if (!run.step1Done) { /* do step1 work */ runStore.markStep1(run.id, result); }
    if (!input.resumed) { runStore.setPending(run.id, 'gate-1'); return { paused: true }; } // END
    // resumed past the gate:
    if (!run.step2Done) { /* do step2 */ runStore.markStep2(run.id); }
    return { done: true };
  }});
```
```ts
// src/resume.ts
export async function resume(runId: string, decision: 'approve' | 'reject') {
  const run = runStore.get(runId);
  if (decision === 'reject') return runStore.fail(runId, 'rejected');
  runStore.clearPending(runId);
  return invoke(gated, { input: { runId, resumed: true } });   // idempotent: step1 skipped via run record
}
```
`run-store.ts` is a raw sqlite table (`id, step1_done, step2_done, pending_gate,
restart_count, status`) — the **application-owned run record** the whole rebuild
will share. `src/db.ts` exports the Flue `sqlite()` adapter so the *agent
session* is also durable. **Pass:** trigger → run pauses with `pending_gate`;
**kill the process**; restart; `POST /resume/:runId` → step2 runs exactly once
(idempotency holds via `step1_done`); no duplicate side effects.

### Data flow established for later phases
1. Event/trigger → `invoke(workflow,{input:{runId,...}})` (run record created/looked up).
2. Workflow does phase work in `run()`; at a gate it writes `pending` to the run
   record and **returns** (function ends — Flue does not checkpoint).
3. External signal (GitHub comment / Slack `/approve` / dashboard) → `resume()`
   → idempotent re-`invoke` with `resumed:true`; the run record's per-phase done
   flags reproduce `shouldRunPhase`.
4. Sandbox per run created in `defineAgent(async () => Sandbox.create({network,envs}))`;
   egress = provider allowlist sourced from the ported `egress-allowlist.ts`.

## Cross-cutting concerns raised (mirrored into overall-architecture.md)
- **Runtime & Pi:** Node ≥22.19; Pi pinned at `@earendil-works/pi-agent-core
  @^0.79.4` via Flue beta.2; single Hono app + `flue()`; `dispatch`/`invoke`
  admission boundary.
- **Sandbox & egress (risk #1 — sandbox DECIDED, egress DEFERRED):** **a custom
  Docker `SandboxFactory`** (container isolation; container per run, env baked at
  create). **Egress is NOT enforced this phase** — full network, no SSRF floor
  (known, temporary, recorded). Egress hardening (re-host the CoreDNS/nginx
  allowlist + CIDR SSRF floor into the factory, or switch prod to E2B
  `allowOut`/`denyOut`) is a later phase, required before prod. The ported
  `egress-allowlist.ts` is staged now but wired in then. Residual (for when
  hardened): SNI-only filtering caveat, carried.
- **Persistence & durability (gap #2 — DECIDED model):** durability = Flue
  `PersistenceAdapter` (`sqlite()`/libsql) for **agent sessions** + an
  **application-owned run record** (`run-store.ts`) for phase progress / gates /
  `restart_count`. Resume = idempotent re-`invoke`, **not** a Flue suspend
  primitive (none exists). `dispatchId` is the Flue-native idempotency correlator
  for dispatched (chat) input.
- **Auth & security:** scoped token + provider keys reach the sandbox via E2B
  `Sandbox.create({ envs })` at agent-init (no session-level Flue env injection);
  PEM never enters env except the `repo-write` agent's controlled path.
- **Config:** `flue.config.ts` (`target:'node'`) + `.env` via `flue dev/run --env`.
- **Testing:** `@flue/runtime/test-utils` store-contract tests validate any
  custom/extended adapter.

## Open questions / risks
- **Q0.1 — session-level env injection.** Flue injects `env` per-`exec`, not per
  session. Baking run env into `Sandbox.create({ envs })` works, but confirm Pi's
  bash tool doesn't *override* `envs` with an empty per-call `env`. Verify against
  the installed pi-agent-core in Phase 1. (Risk: token not visible to `git`.)
- **Q0.2 — E2B egress availability tier.** Confirm `network.allowOut/denyOut` is
  on our E2B plan (not enterprise-gated) and GA, not preview. Blocks the Phase 8
  deletion of the docker stack. (risk #1 residual.)
- **Q0.3 — open-mode metadata floor.** E2B forbids domains in `denyOut`; the
  metadata block in open mode relies on CIDR `denyOut` + the fact that
  `metadata.google.internal` resolves into `169.254.169.254`. Confirm E2B's
  resolver doesn't bypass CIDR deny for that literal. (SSRF floor.)
- **Q0.4 — no Flue HITL primitive.** Confirmed *absent* from current docs; the
  whole gate is application-owned. If a future beta adds one, revisit. (risk #2.)
- **Q0.5 — `restart_count` breaker placement.** Lives in the run record,
  incremented on each `resume`/boot-recover, capped at 3 — designed in Phase 4.

## Acceptance hooks
- **Spike 1:** `flue connect hello local` and `POST /agents/hello/:id` both
  return model output on our keys → proves `01`/`02` runtime.
- **Spike 2:** the Docker `SandboxFactory` clones + builds a repo in an
  **isolated container**; `SandboxApi` file ops + `exec` work; the container is
  removed after the run → satisfies `09` Phase-0 acceptance. **Egress is NOT
  tested here** (deferred); the off-allowlist/metadata-block checks move to the
  egress-hardening phase.
- **Spike 3:** gated run pauses (`pending` in run record), survives a process
  **kill+restart**, resumes from `POST /resume/:runId`, runs step2 **exactly
  once** → satisfies `01`/`06` "kill mid-run and resume" + idempotency.
- **`MIGRATION.md`** committed with: version pins (above), the verified
  signatures, the **invoke/session answers** (does `invoke(runId)` re-run; do
  named sessions reattach), and a note that **egress is deferred** with the chosen
  hardening path recorded later.
