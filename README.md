# Last Light → Flue

A working rebuild of **[Last Light](https://lastlight.dev)** — an AI-powered
GitHub repo-maintenance agent — on top of the
**[Flue](https://flueframework.com)** agent-harness framework.

> **Status: feature-complete (Phases 0–7), runs locally, not yet deployed.**
> This is no longer a spec — it's an application. The full Last Light surface
> (workflows, agents, channels, admin dashboard, CLI, durable resume) is ported
> and green (**~900 tests**). The `build` workflow has been verified
> **end-to-end against a live repo** — a real run opened
> [cliftonc/drizzle-cube#956](https://github.com/cliftonc/drizzle-cube/pull/956).
> What remains is **Phase 8**: egress-firewall hardening and the live
> deploy/cutover (see [Remaining](#remaining--phase-8)).

This is a faithful port: behaviour is traced 1:1 to the original Last Light, and
`spec/` still documents *what a Flue implementation must satisfy to match Last
Light* — page-for-page against the original's spec.

## Why this exists

Last Light's execution engine is hand-rolled: a YAML-driven workflow runner, a
bespoke Docker + CoreDNS + nginx egress firewall, a JSONL "shim" that fakes a
transcript for the dashboard, and its own connectors, router, and SQLite store.
Its underlying agent runtime was already migrated to **Pi** (`agentic-pi` /
`pi-ai`).

**Flue is the maintained framework built on that same Pi harness.** Its
primitives — agents, workflows, channels, sandboxes, durable sessions,
persistence adapters, observability — map closely onto what Last Light built by
hand. A prior port to **Mastra** stalled having dropped the three hardest pieces
(egress firewall, real sandbox isolation, durable resume); Flue supplies
analogues for all three, so this is a far tighter fit. The result: the same
behaviour with far less bespoke machinery to maintain.

## What's built

Everything below is implemented, tested, and discoverable by `flue dev`.

**Workflows** (`src/workflows/`) — the ported Last Light operations:

| Workflow | What it does (matches Last Light) |
|---|---|
| `build` | Full durable build cycle: guardrails → architect → *approval gate* → executor → reviewer loop → opens a PR |
| `pr-review` | Reviews an open PR, posts one formal review |
| `issue-triage` | Classifies an issue, applies labels / comments |
| `explore` | Socratic reply-gate research loop → publishes a spec |
| `pr-fix` | `@last-light build …` on a PR — lands a fix on the PR branch |
| `pr-comment` · `issue-comment` · `answer` | Conversational @mention replies |
| `repo-health` | Scheduled repo health report |
| `security-review` · `security-feedback` | Sandboxed security scan → files issues |

**Agents** (`src/agents/`): a durable read-only `chat` agent (per-thread sessions).
**Channels** (`src/channels/`): native `github` (webhook ingress) and `slack`
(Events API) — replacing the original's connectors + router.
**Admin dashboard** (`dashboard/`, served at `/admin`): React/Vite SPA — workflow
runs, run pipelines (derived from the run's event stream), sandbox & chat session
transcripts, crons, config, approvals.
**CLI** (`src/cli.ts`, `lastlight`): a thin HTTP client to a running instance
(`workflow`/`session`/`logs`/`approvals`/`stats`/trigger commands).

Plus the load-bearing infrastructure: a **durable build run-store** with an
application-owned **approval gate** + resume (Flue does not checkpoint `run()` on
Node, so durability is app-owned), a **Docker `SandboxFactory`** with one shared
workspace per run (`taskId`-keyed, as the original), **crons**, **OpenTelemetry**,
and the admin read-layer re-backed onto Flue's durable `RunStore` /
`EventStreamStore`.

## How it maps to the original

| Last Light (hand-rolled) | This port (on Flue) |
|---|---|
| YAML workflow runner | Flue workflows — `export async function run(ctx)` modules |
| Connectors + router | Flue **channels** (`github`, `slack`) |
| JSONL transcript shim | Flue durable **event stream** (`EventStreamStore`) |
| Bespoke SQLite store | Flue **persistence adapter** (`src/db.ts`) + app tables |
| Docker + CoreDNS + nginx egress firewall | Docker `SandboxFactory` — **egress hardening is Phase 8** ⚠ |
| Custom resume logic | App-owned durable run-store + `resume()` re-invoke |

The destination contract for each layer is pinned in `spec/`, traced 1:1 to the
original's `spec/` — see [Source of truth](#source-of-truth).

## Repo layout

| Path | What it is |
|---|---|
| `src/workflows/`, `src/agents/`, `src/channels/` | The Flue units (discovered by `flue dev`) |
| `src/agent-lib/`, `src/engine/`, `src/tools/`, `src/sandboxes/` | Phase bodies, scoped-token/PEM-wall logic, tools, Docker sandbox |
| `src/admin/` | The `/admin/api/*` read-layer over Flue's stores |
| `src/app.ts` | Hono app composition — mounts `flue()` beside the app-owned `/admin` + `/api` |
| `dashboard/` | The admin SPA (committed prebuilt at `dashboard/dist/`) |
| `spec/` | The destination spec, traced 1:1 to the original Last Light spec |
| `PROGRESS.md` | Build journal — phase status + Phase 8 remaining |

## Running it

```bash
pnpm install
pnpm dev                         # flue dev — watch-mode server (+ /admin dashboard)
pnpm test                        # vitest (~900 tests, offline)

# Trigger a workflow one-shot (builds + invokes; needs secrets/.env):
pnpm exec flue run issue-triage \
  --payload '{"owner":"o","repo":"r","issueNumber":1,"triggerType":"cli"}' \
  --env secrets/.env
pnpm exec flue logs <runId> --follow
```

Secrets live in `secrets/.env` (gitignored; GitHub App, Slack, model providers,
etc.). `config/default.yaml` holds non-secret defaults; a private overlay sets
the managed-repo list.

## Remaining — Phase 8

Not yet done, and required before any production use:

1. **Egress hardening** (the #1 deferred risk): re-host the original's CoreDNS +
   nginx allowlist and SSRF metadata floor into the Docker `SandboxFactory` so
   build/security containers aren't on an open network.
2. **Live deploy + cutover**: deploy the Node service, point the GitHub App +
   Slack at it (a public HTTPS endpoint for Slack's Events API), dual-run against
   the original stack, then retire the old one.

## Source of truth

- **Behaviour to match:** the original Last Light implementation + its
  rebuild-grade spec (`~/work/lastlight/spec/`, `~/work/lastlight/CLAUDE.md`).
- **Destination framework:** Flue — docs at <https://flueframework.com/docs/>.
  Pinned at **v1.0.0-beta.x** (re-verify per phase; Flue is beta and moves fast).
  Capability-by-capability evidence in `spec/flue-reference.md`.
