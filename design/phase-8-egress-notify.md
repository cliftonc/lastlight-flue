# Phase 8 — Egress & the shared GitHub/Slack notification model

Status: **COMPLETE** (2026-06-24). chat-reply egress + origin-agnostic `answer` were done
earlier; the shared in-place progress notifier (`src/notify/`) + its wiring into `build`
and `explore` are now DONE and green (`pnpm typecheck` clean, full suite 972 passing,
`flue build` discovers everything).

## What landed (this pass)

- **`src/notify/`** — the platform-agnostic model ported faithfully from
  `~/work/lastlight/src/notify/`: `types.ts`, `render.ts` (+ `collapseDetail`), `model.ts`,
  `notifier.ts` (`ProgressNotifier`, serialized chain), `mrkdwn.ts` (markdown→Slack), plus
  `transports/github.ts` (over **Octokit**), `transports/slack.ts` (over **`SlackPoster`**),
  `state.ts` (`NotifierState`↔scratch + `NULL_REPORTER`), `index.ts`. 34 unit tests.
- **Adaptation:** Flue has no declarative `AgentWorkflowDefinition.phases`, so `model.ts`
  takes an explicit `PhaseSpec[]` (the same phase names the run-store keys `phasesDone` on).
- **Wiring:** `src/agent-lib/build-notify.ts` + `explore-notify.ts` (pure: phase specs,
  seed-model builders w/ resume re-insertion of dynamic loop/ask rows). `makeReporter` is an
  OPTIONAL `BuildDeps`/`ExploreDeps` seam (default = real `ProgressNotifier`; tests pass a
  recording fake or omit it → `NULL_REPORTER`). The control flow drives
  `step`/`insertStep`/`noteTerminal`; the reporter is constructed best-effort (a failed token
  mint degrades to a no-op, never the durable spine). `NotifierState` persists under
  `scratch.notifier:*` so a resume re-attaches to the SAME comment/message. 6 wiring tests.

### Resolved open decisions

1. **mrkdwn** — ported `markdownToSlackMrkdwn` as-is (not Block Kit).
2. **`deliverReply` vs transports** — kept `reply.ts` for one-shot (`answer`); the transports
   reuse the same Octokit/SlackPoster call shapes for the in-place surface.
3. **GitHub `terminalPing` = false** kept. **Gate asks + completion pings route via
   `noteTerminal`** so they reach ONLY the silent surface (Slack) — GitHub already gets the
   deterministic gate comment + PR event, so there's no double-post. (The in-place checklist
   marks the awaiting/done steps on both surfaces.)
4. **Dashboard URL** — `runDashboardUrl(config.publicUrl, appRunId, workflowName)` →
   `/admin/?run=…&tab=runs&wf=…`.

### Not done (deferred)

- LIVE smoke against a real GitHub issue + Slack thread (needs `SLACK_BOT_TOKEN` + a GitHub
  App install). The reporter is exercised only via offline fakes so far.
- The `answer`/one-shot workflows still use `deliverReply` (no in-place surface) — only the
  multi-phase `build`/`explore` got the notifier.

---

## Original plan (for reference)

Egress (posting back OUT to GitHub/Slack) was never carried over in the beta.2→beta.3
migration — only INGRESS (webhook → screen → map → route → dispatch) and the deterministic
GitHub single-posts (gate asks, PR open, verdict/issue comments). This phase closes the
egress gap by porting the reference's **shared notification model** (`~/work/lastlight/src/notify/`):
one platform-agnostic progress surface, edited in place as a workflow's phases run, mirrored
to a GitHub comment AND a Slack message — "shared code for both."

---

## What is already DONE (reuse these — do NOT rebuild)

- **`src/slack-client.ts`** — the Slack EGRESS client over `@slack/web-api` `WebClient`
  (bot token `SLACK_BOT_TOKEN` → `config.slack.botToken`):
  - `SlackPoster` = `{ postMessage(channel, text, threadTs?) → { ts? }, updateMessage(channel, ts, text) }`.
  - `createSlackPoster(botToken)` / `slackPosterFromConfig()` (→ `undefined` when no token → callers no-op).
  - `parseSlackConversationKey(key)` → `{ teamId, channelId, threadTs }` (standalone; no channel import).
  - `chat.update` is the in-place edit the Slack transport needs; `postMessage` returns the `ts` (the update handle).
- **`src/reply.ts`** — `deliverReply(target, markdown)`, the seed of the envelope's `reply()`:
  `{ kind:'github', octokit, owner, repo, issueNumber }` → `issues.createComment`;
  `{ kind:'slack', poster, channel, threadTs? }` → `poster.postMessage`. The notifier transports
  will use the SAME primitives (`createComment`/`updateComment`, `postMessage`/`updateMessage`).
- **`src/agent-lib/slack-chat-relay.ts`** — `observe()`-based chat-reply relay (already armed in `app.ts`
  `startSlackRelay()`, HMR-safe). The notifier is a SEPARATE concern (workflow PROGRESS, not chat replies).
- **`config.slack.botToken`** wired; `SLACK_APP_TOKEN` made optional (Socket-Mode-only, unused by the HTTP path).
- **`answer`** is origin-agnostic (GitHub issue comment | Slack thread post) — the pattern the notifier generalizes.

Requirements to go live (same as chat egress): `SLACK_BOT_TOKEN` (scope `chat:write`) in `secrets/.env`;
bot invited to the channel.

---

## The reference model (`~/work/lastlight/src/notify/` — port faithfully)

Platform-agnostic content model + renderer + a `ProgressNotifier` orchestrator + two transports.
Files + line counts (all small): `types.ts` (101), `model.ts` (140), `render.ts` (69),
`notifier.ts` (98), `transports/slack.ts` (46), `transports/github.ts` (44), `index.ts` (22),
plus `*.test.ts` (model/notifier/render/transports). Nothing in the model imports GitHub or Slack.

Key types (`types.ts`):
- `StepStatus = 'pending'|'running'|'done'|'blocked'|'awaiting'|'failed'|'skipped'`.
- `ProgressStep = { key, label, status, detail? }`.
- `ProgressModel = { title, subtitle?, meta?: string[], steps: ProgressStep[], footer? }`.
- `NotifierTransport = { publish(markdown), note(markdown), readonly terminalPing? }`
  — `publish` = create-or-update the ONE status surface in place; `note` = a NEW message
  (approval prompts / terminal summary — an in-place edit is silent so it deserves a real ping);
  `terminalPing` true for Slack (silent edits, no other signal), false for GitHub (the finished
  checklist + the PR-opened event already notify).
- `ProgressReporter = { start(model), step(key, status, detail?), insertStep(step, beforeKey?), note(md), noteTerminal(md) }`
  — the runner-facing API; it never touches a transport or markdown directly.
- `NotifierState = { githubCommentId?, slackTs?, slackChannel?, slackThread? }` — the persisted
  in-place-update handles (so a resumed run re-attaches to the SAME comment/message).

`ProgressNotifier` (`notifier.ts`): owns the current `ProgressModel`, re-renders once per mutation,
fans the rendered markdown to every transport's `publish()`. Mutations are **serialized through an
in-flight promise chain** so two quick transitions can't race / double-create the surface.
`publish()`/`note()` are **best-effort per transport** (one platform failing must not block the other).
`noteTerminal` only notes to transports with `terminalPing`.

`render.ts`: the SINGLE shared renderer (`renderProgress(model) → markdown`). `STATUS_EMOJI` map
(⬜/🔄/✅/⛔/⏸️/❌/➖). GitHub posts the markdown as-is; the Slack transport converts it via
`markdownToSlackMrkdwn` (port `~/work/lastlight/src/connectors/slack/mrkdwn.ts`) before `chat.update`.
Also `collapseDetail(s)` — one-line checklist detail capped on VISIBLE length (markdown links count as
their text, so a short label backed by a long URL is kept whole).

`transports/github.ts` (`GitHubTransport`): owns one comment id; `publish` does
`updateComment` if known else `postComment` + `save(id)`; `note` always posts a fresh comment.
`terminalPing = false`.
`transports/slack.ts` (`SlackTransport`): owns one message `ts`; `publish` does `updateMessage`
if known else `sendMessage` + `save(ts)`; `note` always sends a fresh threaded message.
`terminalPing = true`. Depends on a `SlackConnector` in the reference — in the Flue port it depends
on our `SlackPoster` (`src/slack-client.ts`).

---

## Target Flue structure (the port)

Create `src/notify/` mirroring the reference, adapted to the Flue codebase:

1. **`src/notify/types.ts`** — copy verbatim (pure types). Drop the `.js` import extensions (use `.ts`).
2. **`src/notify/render.ts`** — copy `renderProgress` + `STATUS_EMOJI` + `collapseDetail` verbatim.
3. **`src/notify/model.ts`** — copy the helpers (`setStep`, `upsertBefore`, `stepsFromPhases`,
   `buildProgressModel`, `runDashboardUrl`, `ProgressModelInput`). `runDashboardUrl` should point at
   THIS app's admin dashboard (check `config` for the base URL / the admin route).
4. **`src/notify/notifier.ts`** — copy `ProgressNotifier` verbatim (the serialized-chain orchestrator).
5. **`src/notify/mrkdwn.ts`** — port `markdownToSlackMrkdwn` from `connectors/slack/mrkdwn.ts`.
6. **`src/notify/transports/github.ts`** — `GitHubTransport` over **Octokit** (not the reference's
   `GitHubClient`): `publish` = `octokit.rest.issues.{createComment|updateComment}`; `note` =
   `createComment`. Reuse the bound-ref + scoped-token pattern (owner/repo closed over, never model-chosen).
7. **`src/notify/transports/slack.ts`** — `SlackTransport` over our **`SlackPoster`**: `publish` =
   `updateMessage(channel, ts, mrkdwn)` if `ts` known else `postMessage(channel, text, threadTs) → save(ts)`;
   `note` = `postMessage`. Convert the markdown via `mrkdwn.ts` first. `terminalPing = true`.
8. **`src/notify/index.ts`** — re-exports (mirror the reference).

NOTE: the existing `src/reply.ts` `deliverReply` is the one-shot primitive; the transports are the
STATEFUL in-place version. Consider having the transports' `publish/note` delegate to the same Octokit/
SlackPoster calls (keep them consistent), or leave `deliverReply` for the simple workflows (`answer`) and
the transports for the multi-phase ones. Don't duplicate the createComment/postMessage call shapes.

---

## Wiring it into the workflows

The reporter is driven from the **build** and **explore** phase loops (the multi-phase workflows).

- **State persistence (resume-safe):** persist `NotifierState` in the run-store `scratch` (BuildRunStore /
  ExploreRunStore already have a `scratch: Record<string,string>`). On a fresh run the first `publish`
  creates the surface and `save()` writes `githubCommentId` / `slackTs` to scratch; on a resume the
  transport is constructed WITH those handles so it edits the SAME surface (no duplicate comment/message).
  Mirror how `build-phases.ts` already records gate-comment ids in scratch (`gateCommentScratchKey`).
- **Build:** in `src/workflows/build.ts` / `src/agent-lib/build-phases.ts`, build a `ProgressModel` from the
  phase list (guardrails → architect → [gate] → executor → reviewer-loop → PR) and call
  `reporter.start(model)` at the top, `reporter.step(key, 'running'|'done'|...)` around each phase,
  `reporter.insertStep(...)` for reviewer/fix cycles, `reporter.note(...)` for the approval-gate ask
  (replaces / complements the current deterministic gate comment), and `reporter.noteTerminal(...)` on
  completion. The gate ASK is a `note` (a real ping); the per-phase checklist is `publish` (in-place).
- **Explore:** same shape over read → ask-loop → synthesize → publish; the reply-gate question is a `note`.
- **Transport construction:** a build/explore run has a GitHub issue (→ GitHubTransport) and/or a Slack
  thread (→ SlackTransport, when `source==='slack'` + a `SlackPoster` from `slackPosterFromConfig()`).
  Construct the `ProgressNotifier([...transports])` from whichever origin(s) apply — a GitHub-triggered
  build can ALSO mirror to a Slack thread if a conversationKey is present (the reference does both).
- **Injectable seam:** thread the reporter through the existing `BuildDeps`/`ExploreDeps` (a `reporter`
  field or a `makeReporter(ctx)` dep) so tests pass a fake reporter (record start/step/note calls) and the
  control-flow tests stay offline. Production builds the real transports.

---

## Tests

- Port the reference's `model.test.ts` / `render.test.ts` / `notifier.test.ts` / `transports.test.ts`
  (adapted to Octokit + `SlackPoster` fakes). Key cases: in-place update vs first-create; the
  serialized chain doesn't double-create; `note` posts fresh; `noteTerminal` only to `terminalPing`
  transports; per-transport failure is isolated (one throws, the other still publishes); mrkdwn conversion.
- Build/explore: assert the phase loop drives `start → step(running) → step(done)` per phase, `note` on the
  gate, and that `NotifierState` is persisted to scratch + re-attached on resume (no duplicate surface).
- `vitest.config.ts` SKILL.md stub already handles the markdown-import quirk; the notify model has no
  skill imports, so no stub changes needed.

---

## Verification

`pnpm typecheck` clean; `pnpm test` green (port the ~4 notify test files + the wiring tests);
`pnpm build` discovers everything. Live smoke: a build/explore run from GitHub shows ONE comment edited
through the phases (not a comment-per-phase); the same run mirrored to a Slack thread edits ONE message;
the approval gate posts a real `note` ping; a resume re-attaches to the same surfaces.

---

## Open decisions (resolve at implementation time)

1. **Markdown→mrkdwn fidelity** — port `connectors/slack/mrkdwn.ts` as-is, or use Slack Block Kit? The
   reference uses mrkdwn (simpler). Start with mrkdwn.
2. **`deliverReply` vs transports overlap** — keep `reply.ts` for one-shot (`answer`) and transports for
   in-place (build/explore), sharing the underlying Octokit/SlackPoster call shapes (don't fork them).
3. **GitHub `terminalPing`** — the reference leaves it false (no terminal comment). Keep that unless the
   product wants an explicit "done" comment.
4. **Dashboard URL** in `runDashboardUrl` — wire to this app's admin base URL/config.

## Pointers

- Reference: `~/work/lastlight/src/notify/*` + `~/work/lastlight/src/connectors/slack/{connector,mrkdwn}.ts`
  + the `EventEnvelope` in `~/work/lastlight/src/connectors/types.ts` (the `reply()` shape).
- Reuse: `src/slack-client.ts`, `src/reply.ts`, the `BuildRunStore`/`ExploreRunStore` `scratch`, the
  `LastLightEvent` envelope (`src/events.ts`), `slackPosterFromConfig()`.
- Memory: `slack-github-egress` (status), `flue-beta3-migration` (the beta.3 architecture).
