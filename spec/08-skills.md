---
title: "Skills & agent context"
order: 8
traces: "lastlight/spec/08-skills.md"
---

# 08 — Skills & agent context

## Requirement (from Last Light)

**Skills** are `skills/<name>/` directories with a frontmatter'd `SKILL.md`
(`name` + `description` mandatory) plus optional `scripts/`/`references/`/
`assets/`. They reach the agent by **progressive disclosure** — only name +
description in a system-prompt `<available_skills>` catalogue; the agent reads
the body on demand via its `read` tool. The runner stages declared skills into a
per-phase bundle (never in the repo's git tree) and maps them via
`--skill`/`skillPaths`; it never embeds skill bodies in prompts. **Agent
context** (`agent-context/{soul,rules,security}.md`) concatenates into `AGENTS.md`
(or the chat system prompt) — the shared persona + hard rules every session sees.

## Must-preserve invariants

- **Progressive disclosure** — only name+description in context; body loaded on
  demand; scales linearly with skill count.
- **Frontmatter mandatory** — skills missing `name`/`description` are silently
  dropped; audit on add.
- **Runner never reads SKILL.md content** — filesystem layout + frontmatter is
  the contract.
- **Whole directory travels** — `scripts/`/`references/`/`assets/` come along.
- **Bundle is out of the repo git tree** — the agent can't commit it.
- **One canonical `AGENTS.md`/persona per session** — read once; persona drives
  *both* surfaces (sandbox + chat); skills aren't template-rendered.

## Flue mechanism

- **Flue has native skills** — `import triage from '../skills/triage/SKILL.md'
  with { type: 'skill' }`, passed via `defineAgent({ skills: [...] })`. This *is*
  the same Pi progressive-disclosure model (catalogue in system prompt, body via
  read tool). (flue-reference §2; `README.md`.) The `skills/` directories port
  **as-is**, including the frontmatter contract and helper subdirs.
- **Agent context** → each agent's `instructions` (inline or imported markdown).
  `agent-context/{soul,rules,security}.md` concatenate into the `instructions`
  string per agent; the chat agent gets the same plus a chat suffix
  (`11-chat.md`). (flue-reference §2.)
- **Tools alongside skills** — `defineAgent({ tools, skills })` is exactly the
  README's triage example shape.

## Gaps & decisions

- **Per-phase bundle staging → Flue-native skill imports.** Last Light's
  hand-rolled `.lastlight-skills/<phase>/` staging + `--skill` mapping is
  **replaced** by Flue's `with { type: 'skill' }` import + `skills:` option.
  *Decision:* drop the bespoke staging; assign each agent exactly the skills its
  role needs at `defineAgent` time (architect/executor/reviewer/triage/review/
  chat agents each list their own). This preserves per-role scoping without the
  per-phase filesystem dance. Confirm Flue stages helper subdirs (`scripts/`)
  into the sandbox — verify in Phase 1; if not, stage them via `harness.fs`.
- **Skill catalogue parity** — `CHAT_SKILL_NAMES` and the workflow→skill mapping
  become per-agent `skills:` arrays.
- **Frontmatter audit** — keep the "drop on missing name/description" awareness;
  add a test that every `SKILL.md` parses.
- **Persona is small on purpose** — keep `agent-context/` ruthless; one persona
  source for both surfaces (don't bifurcate).

## Acceptance criteria

- An agent defined with `skills: [pr-review]` surfaces it in its catalogue and
  loads the body on demand; a malformed SKILL.md is caught by a test, not
  silently dropped in prod.
- A skill's `scripts/` helper is runnable by the agent inside the sandbox.
- The same `agent-context/*.md` drives both a workflow agent and the chat agent.

## Source / target files

- Source: `lastlight/skills/*`, `agent-context/{soul,rules,security}.md`,
  `src/workflows/loader.ts` (`resolveSkillPaths`), `src/engine/agent-executor.ts`
  (`stageSkillBundle`), `src/engine/chat-skills.ts`.
- Target: `lastlight-flue/skills/*` (copied), `src/agents/*.ts`
  (`skills:` + `instructions`), `src/agents/persona.ts` (agent-context loader).
