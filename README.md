# Last Light → Flue

This repository holds the **destination specification** and **implementation
plan** for rebuilding [Last Light](https://lastlight.dev) — an AI-powered
GitHub repo-maintenance agent — on top of the **[Flue](https://flueframework.com)**
agent-harness framework.

> **This is documentation, not code (yet).** There is no application here.
> `spec/` describes *what a Flue implementation must satisfy to match Last
> Light*, with the Flue research that backs each decision, plus a phased,
> executable build plan. Application code lands later, phase by phase, by
> following `spec/IMPLEMENTATION-PLAN.md`.

## Why this exists

Last Light's execution engine is hand-rolled: a YAML-driven workflow runner, a
bespoke Docker + CoreDNS + nginx egress firewall, a JSONL "shim" that fakes a
transcript for the dashboard, and its own connectors, router, and SQLite store.
Its underlying agent runtime was already migrated to **Pi** (`agentic-pi` /
`pi-ai`).

**Flue is the maintained framework built on that same Pi harness.** Its
primitives — agents, workflows, channels, sandboxes, durable sessions,
persistence adapters, observability — map closely onto what Last Light built by
hand. A prior port to **Mastra** (`~/work/mac`) stalled having dropped the three
hardest pieces (egress firewall, real sandbox isolation, durable resume); Flue
supplies analogues for all three, so this is a far tighter fit.

## What's here

| Path | What it is |
|---|---|
| `spec/README.md` | Index, how to read, the destination page contract, status |
| `spec/00-overview.md` | Rebuild goal, glossary, source→destination map, rebuild checklist, locked decisions |
| `spec/flue-reference.md` | Version-pinned, cited reference of every Flue capability the rebuild relies on |
| `spec/01-harness.md` … `spec/11-chat.md` | One requirements page per Last Light layer, traced 1:1 to `lastlight/spec/` |
| `spec/IMPLEMENTATION-PLAN.md` | The phased (0–8) executable rebuild plan |

## Source of truth

- **Behavior to match:** `~/work/lastlight/spec/` (the rebuild-grade Last Light
  spec) + `~/work/lastlight/CLAUDE.md`.
- **Destination framework:** Flue — docs at <https://flueframework.com/docs/>,
  source at <https://github.com/withastro/flue>. Pinned at **v1.0.0-beta.x**
  (re-verify before each phase; Flue is beta and moves fast).
- **Cautionary precedent:** `~/work/mac/MIGRATION.md` (the Mastra attempt's
  dropped/deferred log).
