---
title: "Phases & prompts"
order: 7
traces: "lastlight/spec/07-phases-and-prompts.md"
---

# 07 — Phases & prompts

## Requirement (from Last Light)

Each agent phase renders a **prompt template** (`workflows/prompts/*.md`) against
a variable context (`owner`, `repo`, `issueNumber`, `branch`, `taskId`,
`issueDir`, `phaseOutputs`, `scratch`, loop vars, `contextSnapshot`, `models`,
`variants`, …) using a small Mustache-ish engine (`{{var}}`, `{{#if}}`,
`${phase.output}`, helpers `slugify`/`branchUrl`). Phases coordinate through a
git branch + a `.lastlight/issue-<N>/` **handoff folder** (`architect-plan.md`,
`status.md`, `reviewer-verdict.md`, …) committed between phases — not in-memory
state. The reviewer **verdict marker** is the prompt↔code contract.

## Must-preserve invariants

- **Prompt files are code** — versioned, reviewed; the wire-format between
  agents.
- **Verdict marker matched on the first matching line** — reviewer prompts emit
  it first.
- **Handoff via committed files, not the DB** — preserves the audit trail on the
  PR; the runner never reads/writes the handoff folder.
- **`contextSnapshot` wraps untrusted user content** — marked untrusted so the
  agent treats it as data (ties to `agent-context/security.md`, `08`).
- **Skill content reaches the agent via the read tool, not the prompt** — skills
  are never template-rendered (`08`).
- **`fixCycle` indexing + marker exactness** are behavioral contracts.

## Flue mechanism

- The prompt templates port **as-is** into `workflows/prompts/`; render them
  with the **ported template engine** (`templates.ts`) and pass the result to
  `session.prompt(rendered)` inside the workflow's `run()`. (flue-reference §3.)
- The variable context is assembled in `run()` from the workflow `input` + the
  application run record's scratch + phase outputs.
- The handoff folder lives in the **sandbox workspace** (`harness.fs` /
  `session.shell` git commits), exactly as today (`09-sandbox.md`).
- Structured phase outputs (e.g. a verdict object) can additionally use
  `session.prompt(..., { result: schema })` for robustness, while keeping the
  text marker for parity. (flue-reference §3.)

## Gaps & decisions

- **Template engine: keep it.** Flue has no prescribed prompt-templating layer.
  *Decision:* port `templates.ts` verbatim and call it in `run()` — minimal risk,
  preserves every `{{...}}`/`${...}` contract and the truthy rules.
- **Phase-output flow** moves from the runner's in-memory `phaseOutputs` to
  ordinary local variables / the run record in `run()` — simpler, same effect.
- **`output_var` collisions** remain a convention (unprotected); document it.
- **`until_bash` injection guard** — reproduce the "reject unrendered `{{}}`
  after render" check when porting `loop-eval`.

## Acceptance criteria

- The ported template engine renders `build`'s `architect.md` with a real
  context and produces byte-identical output to Last Light for a fixed fixture.
- A reviewer session's output is parsed by the exact verdict regex.
- Architect commits `architect-plan.md` to the branch; the reviewer session reads
  it from the same checkout.

## Source / target files

- Source: `lastlight/src/workflows/templates.ts`, `workflows/prompts/*.md`,
  `src/workflows/runner.ts` (`buildPhasePrompt`).
- Target: `lastlight-flue/src/engine/templates.ts` (ported), `prompts/*.md`
  (copied), prompt assembly inside each `src/workflows/*.ts` `run()`.
