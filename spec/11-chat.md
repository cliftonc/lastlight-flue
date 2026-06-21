---
title: "Chat"
order: 11
traces: "lastlight/spec/11-chat.md"
---

# 11 — Chat

## Requirement (from Last Light)

Chat is the low-latency, **read-only**, non-sandboxed surface (pi-ai
`completeSimple` in-process), distinct from the sandboxed workflow path. One
session per Slack thread (`messaging_sessions`), resumed across turns with a
rolling 50-message history; **read-only GitHub tools** + a `read_skill` tool;
**no bash/edit/write/MCP** — chat physically cannot modify code or open issues
("fix that bug" is redirected to the build workflow). Per-thread turns are
**serialized**; different threads run in parallel. Same persona (`agent-context`)
and same transcript log as the sandbox path. Tool rounds capped (8).

## Must-preserve invariants

- **Chat is read-only on the world** — every tool is a GET; the only writes are
  message-history inserts.
- **Same thread → same agent session id** — reset is the only way to a new id.
- **Two runtimes, one persona file** — chat and workflows share
  `agent-context/*.md`; don't bifurcate.
- **Per-thread serialization** — concurrent turns on one thread would corrupt
  session state.
- **Redirect, don't add write tools** — "chat asks questions, workflows do work."
- **Tool rounds capped; rolling history window.**
- **Screened input reaches chat flagged, not blocked.**

## Flue mechanism

- Chat is a **persistent Flue agent** (`defineAgent`) addressed at
  `POST /agents/<name>/<id>` with `id = channel.conversationKey(thread)`; each
  Slack message `dispatch`es to it; Flue persists the **durable session** per id
  (messages + compacted context) — replacing `messaging_sessions` + the manual
  rehydrate. (flue-reference §2, §5; `08-skills.md`.)
- **Read-only tools** are `defineTool`s (the ported `github-tools.ts` GETs); the
  curated chat skills are `defineAgent({ skills: [...] })` (progressive
  disclosure replaces `read_skill`). (flue-reference §2, §4.)
- **Persona** → the agent's `instructions` = `agent-context` + chat suffix
  (`08-skills.md`).
- **No sandbox** → the chat agent simply has no `sandbox` and no
  bash/edit/write tools.

## Gaps & decisions

- **Durable session replaces the manual chat store.** Flue's per-id session
  durability supersedes `messaging_sessions`/`messaging_messages` + the
  50-message rehydrate. *Decision:* rely on Flue's session continuation; keep an
  app-owned thread→id mapping only if the admin view needs it (`10-state.md`).
- **Per-thread serialization** — Flue agent instances are keyed by `id`
  (one continuing conversation per id); confirm Flue serializes concurrent
  dispatches to the same instance, else reproduce the `chains` map. **Verify in
  Phase 5.**
- **`read_skill` → native skills** — drop the bespoke tool; the agent's
  `skills:` catalogue gives the same progressive-disclosure UX.
- **`chat-reset` / `status-report`** remain harness-level actions (a reset
  starts a new agent `id`; status queries the run record) — not agent tools.
- **Two runtimes → one.** Last Light split pi-ai (chat) vs agentic-pi (sandbox);
  Flue is one Pi-based runtime — chat is just an agent without a sandbox. A
  latency win and a simplification, but **confirm chat-turn latency** is
  acceptable without the lighter `completeSimple` path (Phase 5).

## Acceptance criteria

- A Slack thread holds a multi-turn conversation that continues across turns and
  a process restart (durable session).
- Chat answers a repo question via read-only GitHub tools; asking it to "fix"
  redirects to the build workflow.
- Two rapid messages in one thread are handled in order.
- Chat shares `agent-context/*.md` with the workflow agents.

## Source / target files

- Source: `lastlight/src/engine/{chat-runner,chat,github-tools,chat-skills}.ts`,
  `src/connectors/messaging/session-manager.ts`.
- Target: `lastlight-flue/src/agents/chat.ts` (`defineAgent`, read tools,
  skills, persona), `src/tools/github-read.ts` (ported GETs); dispatched from
  `src/channels/slack.ts`.
