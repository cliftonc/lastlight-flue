---
title: "Last Light → Flue — Specification"
order: -1
description: "Requirements the Flue rebuild must satisfy to match Last Light, traced 1:1 to the source spec, with verified Flue research and a phased plan."
---

# Last Light → Flue — Specification

This directory is the **destination specification** for rebuilding Last Light on
[Flue](https://flueframework.com). It answers one question: *what must a Flue
implementation provide to match Last Light's behavior?*

It is read against the source spec at `~/work/lastlight/spec/` (the rebuild-grade
description of the system as it exists today). Every page here traces to its
source counterpart.

> **Status: design-complete, pre-implementation.** No application code exists
> yet. These documents are the contract the build follows.
> Flue is pinned at **v1.0.0-beta.x** — re-verify signatures before each phase.

## How to read

1. Start with **`00-overview.md`** — goal, locked decisions, the source→
   destination map, the rebuild checklist, and the risk register.
2. Read **`flue-reference.md`** — the verified, version-pinned Flue capabilities
   every page cites. The two findings that shape everything: Flue **workflows
   aren't durable (sessions are)**, and Flue has **no built-in egress firewall**.
3. Then the per-layer pages **`01`–`11`**, each tracing one source layer.
4. Finish with **`IMPLEMENTATION-PLAN.md`** — the phased (0–8) build sequence.

## Page contract

Each `NN-*.md` page has six sections:

1. **Requirement** — what Last Light does here that the rebuild must match.
2. **Must-preserve invariants** — non-negotiable behaviors carried from the
   source spec's *Invariants*.
3. **Flue mechanism** — the specific Flue primitive(s) that satisfy it, citing
   `flue-reference.md`.
4. **Gaps & decisions** — where Flue differs/is missing/offers a choice, and the
   decision taken (⚠ marks load-bearing gaps).
5. **Acceptance criteria** — observable checks proving the match (feed the plan).
6. **Source / target files** — `lastlight/src/...` → planned `lastlight-flue/...`.

## Pages

| # | Page | Source | Covers |
|---|---|---|---|
| 00 | `00-overview.md` | `00-overview.md` | Goal, glossary, map, checklist, risks |
| ★ | `flue-reference.md` | — | Verified, version-pinned Flue capabilities |
| 01 | `01-harness.md` | `01-harness.md` | Boot, server, dispatch, resume |
| 02 | `02-configuration.md` | `02-configuration.md` | Config, models/variants, secrets |
| 03 | `03-integrations.md` | `03-integrations.md` | Channels, CLI, cron, admin |
| 04 | `04-event-model.md` | `04-event-model.md` | The internal event schema |
| 05 | `05-router.md` | `05-router.md` | Code-based routing, classifier, screener |
| 06 | `06-workflow-engine.md` | `06-workflow-engine.md` | Workflows, loops, gates, **resume** |
| 07 | `07-phases-and-prompts.md` | `07-phases-and-prompts.md` | Template engine, prompts, handoff |
| 08 | `08-skills.md` | `08-skills.md` | Native skills, persona |
| 09 | `09-sandbox.md` | `09-sandbox.md` | Sandbox, **egress (#1 risk)**, tokens |
| 10 | `10-state.md` | `10-state.md` | Persistence, re-backed admin API |
| 11 | `11-chat.md` | `11-chat.md` | Read-only chat agent |
| — | `IMPLEMENTATION-PLAN.md` | — | Phased build sequence (0–8) |

## Sources of truth

- **Behavior to match:** `~/work/lastlight/spec/` + `~/work/lastlight/CLAUDE.md`.
- **Destination framework:** Flue — <https://flueframework.com/docs/>,
  <https://github.com/withastro/flue> (v1.0.0-beta.x).
- **Cautionary precedent:** `~/work/mac/MIGRATION.md` (the Mastra attempt).
