# Build progress

> Single source of truth for "where is the build." The `/loop` (see `BUILD-LOOP.md`)
> reads this first every iteration. Keep it terse and current: update it at the end
> of every slice, right after the commit.
>
> **Detailed completed-slice notes: see `PROGRESS-ARCHIVE.md`.**

## ⚙ Loop execution mode (user directive, 2026-06-21)
**Run each build slice as ONE fresh subagent**, not inline in the main session —
to keep the main conversation's context lean over a long build. Each `/loop`
iteration: dispatch a general-purpose subagent with the build-loop prompt (it
reads BUILD-LOOP.md + PROGRESS.md, does ONE slice, runs tests, commits, updates
PROGRESS.md), then relay its short summary and schedule the next wakeup. Do NOT
do the slice work inline. (Cloud `/schedule` is unsuitable here: the build needs
local Docker + secrets/.env + ~/work/lastlight, absent in cloud.)
- **COMMIT DIRECTLY ON `main`.** This is a linear greenfield build — every slice
  commits to `main`. Do NOT create feature branches (ignore the generic
  "branch first" habit); a stray branch strands the slice from the next one.

## Phase 5 slice 11 DONE ✅ — `pr-comment` ported (kind:comment, single-phase, TOOL-ONLY)
- **`src/workflows/pr-comment.ts`** (`run`→`runPrComment(ctx,deps)` DI seam): PR-side analogue of issue-comment
  (Q on a PR → agent reads PR+thread → evidence-cited reply → DETERMINISTIC createComment on bound PR). Distinct
  b/c PR Qs need the DIFF + 8-read cap: workflow fetches PR+unified DIFF deterministically and seeds the prompt;
  agent `agent-lib/pr-comment.ts` = `pr-comment` skill, persona, model key `comment`, read tools (incl. diff), NO sandbox.
- **REUSES (by import, no shared edits)** `issue-comment-post.ts` poster + `isBotSender`/dedup-marker guards (PR
  accepts issue comments, same endpoint) + `IssueCommentRef`. Profile `issues-write`. Prompt
  `agent-lib/pr-comment-prompt.ts` UNTRUSTED-wraps title/body/DIFF/comments + triggering Q.
- **Tests +10** (587→597 passed/6 skipped): run-level (right profile, BOUND ref incl. diff, `comment` model key,
  bot-loop pre-mint, dedup, token-not-logged) + prompt golden (untrusted diff/Q, prNumber/8-read) + poster reuse smoke.
  flue build green; **discovery+=pr-comment** (workflows=12); grep -c vitest dist=1. **NO LIVE SIDE EFFECT**, no shared edits. Next=**crons** (FINAL).

## Phase 5 slice 10 DONE ✅ — `security-feedback` ported (kind:health, single-phase, TOOL-ONLY)
- **`src/workflows/security-feedback.ts`** (`run`→`runSecurityFeedback(ctx,deps,today)` DI seam): CONSUMER of
  the `Security scan — <date>` issue security-review files. Mints `issues-write`; FETCHES + PARSES the parent
  body DETERMINISTICALLY (`agent-lib/security-feedback-parse.ts`: version check + finding-row/severity regex
  from issue-format.md). Agent (`agent-lib/security-feedback.ts`, `security-feedback` skill, persona, model
  key `security`, read tools, NO sandbox) CLASSIFIES intent+selection → `FEEDBACK:` marker; workflow ACTS.
- **PRIMARY create-issues flow** (`src/security-feedback-post.ts`, bound ref+token, NOT model tools): files
  sub-issues (labels `[security,<severity>]`), rewrites parent rows pending/ticked→broken-out (`~~…~~ → #N`),
  posts summary. discuss/reopen→reply; version-mismatch/empty-selection→canned reply; ignore→noop. UNTRUSTED-wrap
  parent body (bot-authored but carries user-derived snippets) + triggering comment. **accept-risk/false-positive
  SECURITY.md-PR DEFERRED** TODO(phase-9/security-md-pr) (needs clone+push, like security-review's scanners).
- **Tests +23** (564→587 passed/6 skipped): parser (3 states+version+severity) + classify/select (ticked/all/
  severity/items, broken-out-dropped) + poster (row-rewrite/sub-issue body/summary/create on BOUND ref) + prompt
  golden (untrusted-wrap incl. hostile escape) + run-level (profile, BOUND ref, version-mismatch, empty-selection,
  discuss/reopen/ignore, token-not-logged). flue build green; **discovery+=security-feedback** (workflows=11);
  grep -c vitest dist=1 (no module import). **NO LIVE SIDE EFFECT**, no shared-file edits. Next=**pr-comment**, then crons.

## Phase 5 slice 9 DONE ✅ — `security-review` ported (kind:health, repo-scoped, SANDBOXED)
- **`src/workflows/security-review.ts`** (`run`→`runSecurityReview(ctx,deps,scanDate)` DI seam): SIBLING
  of repo-health but SANDBOXED — mints `issues-write` (contents:read clone+issues:write file), REUSES
  `withBuildSandbox` (by IMPORT) to CLONE; agent `src/agent-lib/security-review.ts` (`security-review` skill,
  persona, model/thinking key `security`, read tools, sandbox+cwd /workspace) reviews checkout → REPORT;
  prompt wraps repo desc/topics UNTRUSTED.
- **DETERMINISTIC dated-issue post** `src/security-review-post.ts` (`fileSecurityScanIssue`, bound ref+token,
  NOT a model tool): inverts ref agent-files-issue → workflow files a NEW dated snapshot (title
  `Security scan — <date>`, labels `[security,security-scan]`, issue-format for security-feedback); CREATE each
  run (never update-in-place); NO_FINDINGS/empty → files nothing.
- **gitleaks/semgrep DEFERRED** (image lacks them+egress deferred) → LLM SDLC review only,
  `TODO(phase-9/egress + scanner-image)` (like repo-health's Slack deferral; no apt-install).
- **Tests +18** (546→564 passed/6 skipped): agent config + prompt golden + run-level (token mint right profile,
  BOUND ref, NO_FINDINGS no-file, token-not-logged) + REAL sandbox clone + ALWAYS-teardown(incl. throw) + filer
  (exact em-dash title/labels, snapshot-not-update, 403/422). flue build green; **discovery+=security-review**
  (workflows=10); grep -c vitest dist=1. **NO LIVE SIDE EFFECT**, no shared-file edits. Next=**security-feedback**.

## Phase 5 slice 8 DONE ✅ — read-only CHAT agent (`src/agents/chat.ts`)
- **DISCOVERED agent** (default `createAgent(({id})=>…)` + `route` open [TODO(phase-6) channel auth]
  + `description`). `id`=per-THREAD key → durable per-thread session (db.ts sqlite); agent
  instance==thread, replaces reference messaging_sessions/rehydrate. Thin shell; logic in
  `src/agent-lib/chat.ts` (CHAT_SUFFIX, parseChatThread id→repo, buildChatAgentConfig) +
  `chat-token.ts` (mintReadOctokitFor — **read**-profile token, DI seam).
- **READ-ONLY HARD INVARIANT (spec/11):** ONLY githubReadTools (GET-only, bound per-thread repo),
  NO web tools (design: web gated to explorer only), NO write/mutating tools, NO sandbox/cwd.
  persona+chat-suffix instructions (one persona source). Risk #5 latency=sandbox-less+GET-only;
  risk #6 serialization=FLUE per-instance ordered submission queue (documented, not implemented).
- **Tests +19** (suite 527→546 passed/6 skipped): chat.test (id-parse, model/thinking, persona+suffix,
  skill, READ-ONLY asserts [no mutating-verb tool + NO sandbox], per-thread binding) + chat-token.test
  (DI, read-profile, graceful undefined) + agents/__tests__/chat (shape, route, initialize offline via
  mocked mint). flue build green; **discovery agents={chat,hello}**, workflows unchanged (9);
  grep -c vitest dist=1 (inlined text, no module import). **NO LIVE side effect.** Next=security-review/feedback or crons.

## Phase 5 slice 7 DONE ✅ — `repo-health` workflow ported (cron/CLI repo-scoped scan)
- **`src/workflows/repo-health.ts`** (`run` → `runRepoHealth(ctx, deps)` DI seam). Input
  `{owner, repo, triggerType?}` — REPO-SCOPED (no issue/PR). Single-phase TOOL-ONLY agent
  (NO sandbox; gathers metrics via bound `github_*` read tools — listIssues/listPRs/
  searchIssues/getRepository). Mints an **`issues-write`** scoped token (see profile note).
- **agent** `src/agent-lib/repo-health.ts` (`createHealthAgent`: `health` key, persona,
  `repo-health` skill, READ-ONLY github tools bound to ref+token, NO sandbox) +
  `repo-health-prompt.ts` (thin; repo slug + trigger metadata; the repo
  DESCRIPTION/topics — user-authored text the agent summarizes — are `wrapUntrusted`-wrapped;
  contract = produce ONLY the report markdown).
- **report→deterministic delivery + IDEMPOTENCY** `src/repo-health-post.ts`
  (`deliverHealthReport`, bound ref+token, NOT a model tool): delivers the report to an
  idempotent per-repo TRACKING ISSUE — find the existing OPEN, bot-authored, marker-carrying
  (`<!-- lastlight:repo-health:owner/repo -->`) issue → **UPDATE** its title+body; else
  **CREATE** one. So the weekly cron / crash re-invoke never piles up duplicate issues.
  Marker author-checked (human can't hijack); PRs skipped; `repo-health` label best-effort
  (403 skip / 422 ok). Empty report → nothing touched.
- **PROFILE DEVIATION (documented in module + poster):** reference repo-health is READ-only
  and surfaces the report via the Slack delivery channel / CLI stdout (no GitHub write). The
  channel sink is Phase 6 (not built), so this slice delivers via the one durable,
  deterministic, idempotent surface now available — a tracking issue — hence `issues-write`.
  Slack/channel delivery lands behind the same `deliver` seam with Phase 6 (TODO(phase-6/channels)).
- **Tests: +15 (suite 512 → 527 passed / 6 skipped).** run-level (token mint, BOUND ref not
  model-selectable, agent gets bound ref+fetched meta, idempotent updated=true pass-through,
  empty-report warn, token-not-logged) + prompt golden (untrusted-wrap incl. hostile
  description/topic, no-metadata snapshot drops out, report contract) + deliverer security
  (create-when-absent, UPDATE-existing-not-duplicate, marker per-repo, human-marker ignored,
  PR skipped, label 403/422).
- **flue build green; discovery NOW INCLUDES repo-health** = agents{hello} + workflows{answer,
  build,explore,gated,issue-comment,issue-triage,pr-fix,pr-review,**repo-health**}. Helpers in
  src/agent-lib/ (+ repo-health-post.ts at src/ top-level), tests in nested __tests__/ — no
  phantom. `grep -c vitest dist/server.mjs` = 1 (inlined prompt text, NOT a vitest module
  import — verified no `from 'vitest'`/`require('vitest')`).
- **NO LIVE SIDE EFFECT** — all GitHub/model MOCKED or injected; no real issue create/update,
  no live `flue run`. Last commit: Phase 5 slice 7 (repo-health). Next slice = security-review/
  security-feedback, or chat, or crons (incl. the cron-health schedule that triggers repo-health).

## ▶ RESUMED 2026-06-22 — explore VERIFIED + committed (stash popped & dropped)

## Phase 5 slice 6 DONE ✅ — `explore` workflow (Socratic reply-gate loop) — VERIFIED THE WIP
- **Path taken: VERIFIED-THE-WIP** (not a rewrite). The stashed WIP (10 files, 31 tests)
  was clean, correct, well-integrated, and typecheck/test/build green out of the box.
  `git stash@{0}` **popped + dropped** (no dangling stash). The one addition: wired
  `recoverOrphanExploreRuns()` into `src/app.ts`'s boot-recovery hook (parallel to build's,
  same run-once/non-blocking/non-fatal guards) so an `active` explore orphan is reconciled
  on boot (`paused` runs left for a human reply) — the WIP had the function but it wasn't called.
- **Loop shape** (`src/workflows/explore.ts` → testable `runExplore(ctx, store, deps)`):
  read/research → socratic ask-loop( ask → **REPLY GATE** pause → human reply folds into
  `scratch.socratic.qa` → re-invoke → next round ; break on `READY`, capped at
  MAX_SOCRATIC_ROUNDS=8 ) → synthesize → **deterministic publish**. Durability = app-owned
  `ExploreRunStore` (raw sqlite, `src/explore-run-store.ts`): phasesDone cursor + socraticIter
  + pendingGate + restart breaker (≤3). PARALLEL to build's run-store/resume by design (the
  reply gate resolves with ANSWER TEXT, not approve/reject) — kept separate so build's
  contract is untouched; clean, not confusingly duplicative → left as-is per the prompt.
- **Reply gate** (`src/resume-explore.ts` `resumeExplore(runId, reply)`): folds the answer
  into the transcript BEFORE the idempotent re-invoke; the breaker does NOT bump on a normal
  reply (an expected re-invoke), only on a crash/boot re-entry. Idempotent: duplicate/terminal
  replies are no-ops; unknown runId → failed (no throw).
- **Web tools GATED to research phases** (`src/agent-lib/explore.ts` `createExploreAgent`):
  read/ask/synthesize agents opt into `webTools()`; publish does NOT (it's app code, not an
  agent). Provider key closed over, never model-selectable. Test asserts withWebTools toggles
  web_search/web_fetch on/off.
- **Deterministic publish** (`src/explore-publish.ts`): bound ref + token, NOT a model tool.
  GitHub-origin → comment on the bound issue; Slack-origin → new issue in EXPLORE_DEFAULT_REPO.
  DEDUP marker keyed by runId (author-checked → human-pasted marker ignored). Reply-gate
  question post (`src/explore-github-post.ts`) is likewise deterministic + bound.
- **UNTRUSTED-wrapping** (`src/agent-lib/explore-prompts.ts`): issue title/body, triggering
  comment, AND every accumulated human reply (`scratch.socratic.qa`) are `wrapUntrusted`-wrapped;
  hostile close-marker injection neutralized (golden-tested).
- **Tests: +31 (suite 481 → 512 passed / 6 skipped).** explore.test.ts (13: reply-gate
  pause/persist/return, fold+continue, multi-round, dup-no-op, max-round bound, immediate-READY,
  golden order, per-phase idempotency across re-invokes, restart breaker @3, boot recovery,
  unknown-run safe) + explore-units.test.ts (18: untrusted-wrap incl. hostile, web-tools gating,
  READY detection, deterministic publish bound-ref/dedup/security, reply-gate post bound-ref).
- **flue build green; discovery NOW INCLUDES explore** = agents{hello} + workflows{answer,build,
  **explore**,gated,issue-comment,issue-triage,pr-fix,pr-review}. NO phantom (explore-phases/
  -prompts/-run-store/-publish/-github-post/resume-explore are in src/agent-lib/ or src/ top-level,
  tests in nested __tests__/). `grep -c vitest dist/server.mjs` = 1 (the inlined building-skill
  prompt text, NOT a vitest module import — verified no import/require 'vitest').
- **NO LIVE SIDE EFFECT** — all model/web/GitHub/sandbox MOCKED or injected; no live `flue run`,
  no real comments/issues, no real web calls. Stash final state: **popped + dropped** (clean).
  Next slice = **repo-health** (or chat, or crons).

## Current position
- **Phase 5 IN PROGRESS** (remaining workflows + crons + chat). Phase 4 ✅ structurally
  complete (all phases + resume + boot recovery); Phases 0-3 ✅. Suite **481/6 skipped**.
- **Phase 5 slice 5 DONE ✅ — web tools built** (`src/tools/web.ts` — FACTORIES returning
  Flue `defineTool`s, GATED, not global). Resolves the design phase-5 §DRIFT (Flue has NO
  built-in web_search/web_fetch).
  - **`web_search(opts?)`** — queries a provider; precedence **Tavily › Exa › Brave** by
    KEY PRESENCE (`TAVILY_API_KEY` primary; `EXA_API_KEY`/`BRAVE_API_KEY` optional aliases).
    Provider + key are **CLOSED OVER**, NEVER model-selectable params (model supplies only
    `query` + optional `count`≤10). **No provider key → graceful "unavailable" string, never
    a throw.** Provider clients (Tavily POST /search, Exa POST /search, Brave GET web/search)
    implemented host-side (reference used agentic-pi's built-in, nothing to port → built from
    the public provider HTTP shapes). Returns formatted title/url/snippet; key never logged/returned.
  - **`web_fetch(opts?)`** — fetches a model URL host-side, HTML→text, truncated (20k).
    🚨 **SERVER-SIDE SSRF GUARD** (`guardFetchUrl`, non-stub): runs on the NODE server (NOT
    the sandbox → deferred egress floor does NOT cover it). REFUSES non-http(s) schemes +
    any host that IS or **RESOLVES TO** a private/loopback/link-local/unique-local/metadata
    address (127/8, 10/8, 172.16/12, 192.168/16, **169.254.0.0/16 incl. 169.254.169.254**,
    ::1, fc00::/7, fe80::/10) + `localhost`/`metadata.google.internal` by NAME. **Resolves
    the host first** (injectable `resolveHost` for testability) → defeats DNS-rebinding-to-private;
    `redirect:'error'` so a redirect can't escape the check. Reuses exported
    `isPrivateOrInternalIp`/`INTERNAL_HOSTNAMES` from `engine/egress-allowlist.ts` (one source
    of range coverage, no drift). Blocked URL → refusal string, NO request issued.
  - **GATED-not-global:** `webTools(opts?)` returns `[web_search, web_fetch]` for an agent to
    opt into via `tools:[...]`; bound onto the explorer agent + opt-in phases LATER, NOT added
    to every agent. `hasWebSearchProvider()` helper. **`answer` left as-is** (web-research seam
    stays a TODO — explore is the first real consumer next slice).
  - **Tests (+24, +1 skipped live):** web_search (Tavily-primary + Exa/Brave fallback +
    precedence; query sent + results formatted; no-key graceful; key NOT a param + never in
    output) + web_fetch SSRF (refuses 169.254.169.254/127/10/192.168/172.16/::1 literals,
    localhost+metadata by name, file/gopher/ftp schemes, **hostname that RESOLVES to private/
    metadata** via injected resolver; ALLOWS a public-resolving URL; fetches+cleans HTML;
    resolver not a model param) + `webTools`/`hasWebSearchProvider`. Gated live Tavily smoke
    `skipIf(!WEB_TOOLS_LIVE=1)` — SKIPPED by default, NOT run.
  - **flue build green; discovery UNCHANGED = agents{hello} + workflows{answer,build,gated,
    issue-comment,issue-triage,pr-fix,pr-review}** — `web.ts` is in `src/tools/` (NOT a
    discovered dir) → no phantom entry; no real vitest module import in dist (`grep vitest`=1
    = the inlined guardrails prompt example, not an import).
  - **NO LIVE WEB CALL by default** — provider HTTP + DNS resolver MOCKED/injected in every
    default test; `web_fetch`/`web_search` never hit the network under `pnpm test`. No live
    `flue run`. Next slice = **`explore`** (first consumer of the web tools).
- **Phase 5 slice 4 DONE ✅ — `answer` workflow ported** (`src/workflows/answer.ts`,
  `run` → `runAnswer(ctx, deps)` DI seam). Single-phase, TOOL-ONLY agent (NO sandbox).
  Mints an **`issues-write`** token (model key `answer`; matches reference answer.yaml).
  vs issue-comment: answer is a THOROUGH SOURCED reply to a question — reads more repo
  context, applies the `question` label, leaves the issue OPEN.
  - **agent** `src/agent-lib/answer.ts` (`createAnswerAgent`: `answer` key, persona,
    `issue-answer` skill, READ-ONLY github tools bound to ref+token, NO sandbox) +
    `answer-prompt.ts` (thin; issue title/body/comments + routed question UNTRUSTED-wrapped;
    trigger metadata outside; contract = produce ONLY answer text).
  - **answer→deterministic post+label** `src/answer-post.ts` (`postAnswerDeterministically`,
    bound ref+token, NOT a model tool): `issues.createComment` + applies `question` label
    (createLabel idempotent; 403/422 best-effort, label never fails the run). **DEDUP** keyed
    by ISSUE number (answer has no triggering-comment id) — invisible `<!-- lastlight:answer:N -->`
    marker, author-checked → re-invoke / duplicate-delivery never double-answers (design Q5.4).
  - **WEB-RESEARCH DEFERRED:** reference answer phase used `web_search`+`unrestricted_egress`+
    checkout. Web tools NOT built (design phase-5 §DRIFT → later slice as gated defineTools on
    explorer). This slice ports the answer STRUCTURE + scopes the agent to the repo/GitHub-context
    path (flags unverified facts); web-research = clearly-marked **TODO(phase-5/web-tools)** seam
    in createAnswerAgent + answer-prompt. Did NOT block the slice.
  - **Tests (+13):** run-level (token mint, BOUND ref not model-selectable, dedup pass-through,
    token-not-logged) + prompt golden (untrusted-wrap incl. hostile question, repo-context scope,
    no-code-change) + poster security (createComment+addLabels bound ref, dedup floor, human-marker
    ignored, label 403/422 best-effort).
  - **flue build green; discovery = agents{hello} + workflows{answer,build,gated,issue-comment,
    issue-triage,pr-fix,pr-review}**; no vitest import in dist; helpers in agent-lib/
    (+ answer-post.ts at src/ top-level), tests in nested __tests__/.
  - **NO LIVE SIDE EFFECT** — all GitHub/model MOCKED; no real comments/labels, no live `flue run`.
    Last commit: Phase 5 slice 4 (answer). Next slice = `repo-health` or the web-search tools.
- **Phase 5 slice 3 DONE ✅ — `pr-fix` workflow ported** (`src/workflows/pr-fix.ts`,
  `run` → `runPrFix(ctx, deps)` DI seam). Standalone EXECUTOR-ON-A-PR (no architect/review):
  mints a **`repo-write`** scoped token (PEM wall, downscoped to repo); resolves the PR
  HEAD ref deterministically (`pulls.get().head.ref` — workflow code, not a model tool);
  `withPrFixSandbox` (new in build-sandbox.ts) pre-clones + checks out the EXISTING PR
  head BRANCH (`git clone --branch <headRef>`, NOT `checkout -B` → fix lands on the PR's
  branch); REUSES `createFixAgent` (fix task key, persona, `building` skill, read tools,
  sandbox, cwd /workspace); renders `pr-fix.md` via `renderPrFixPrompt` (fix request + CI
  text + PR title all UNTRUSTED-wrapped). Agent fixes + COMMITS in-sandbox; workflow reads
  HEAD sha + PUSHES the BOUND head branch via the same **mocked `pushBranch` seam**; then
  posts a deterministic **ack comment** (`src/pr-fix-post.ts`, bound ref → `issues.createComment`).
  Container ALWAYS torn down in `finally` (incl. on throw/clone-fail); token never logged.
  - **Tests (+17):** prompt golden (untrusted-wrap incl. hostile-escape, CI section) +
    sandbox variant (clones existing branch not -B, teardown-on-throw, token-redacted) +
    run-level over fakes (token mint, bound head-ref resolve, push targets bound ref not
    model text, teardown-on-fix-throw + clone-fail, token-not-logged) + ack-poster security.
  - **flue build green; discovery = agents{hello} + workflows{build,gated,issue-comment,
    issue-triage,pr-fix,pr-review}**; no vitest import in dist; helpers in agent-lib/
    (+ pr-fix-post.ts at src/ top-level), tests in nested __tests__/.
  - **NO LIVE SIDE EFFECT** — all GitHub/git/model/sandbox MOCKED; no real commits/pushes/
    PRs/comments, no live `flue run`. Last commit: Phase 5 slice 3 (pr-fix). Next slice =
    `answer` or `repo-health`.
- **Phase 5 slice 2 DONE ✅ — `issue-comment` workflow ported** (`src/workflows/issue-comment.ts`,
  `run` → `runIssueComment(ctx, deps)` DI seam). Single-phase, TOOL-ONLY agent (NO sandbox —
  reads issue/PR thread via bound read tools; skill caps at ≤2 reads, no checkout). Mints an
  **`issues-write`** scoped token (matches reference issue-comment.yaml profile; model key `comment`).
  - **agent** `src/agent-lib/issue-comment.ts` (`createIssueCommentAgent`: `comment` task key,
    persona, `issue-comment` skill, READ-ONLY github tools bound to ref+token, NO sandbox) +
    `issue-comment-prompt.ts` (thin; issue title/body + prior comments + the TRIGGERING comment
    all UNTRUSTED-wrapped via `wrapUntrusted`; trigger metadata outside; contract = produce reply
    text only). Agent composes a free-form markdown reply (no marker).
  - **reply→deterministic post** `src/issue-comment-post.ts` (`postIssueReplyDeterministically`,
    mirrors github-post.ts/triage-post.ts — bound ref+token, NOT a model tool): posts via
    `issues.createComment`. **BOT-LOOP floor** (`isBotSender`): skip if triggering sender is the
    bot / any `[bot]` (reference filters bot senders at the webhook = Phase 6; this is the
    workflow-local second floor). **DEDUP** (design Q5.4): embeds an invisible
    `<!-- lastlight:reply-to:<commentId> -->` marker; `alreadyReplied` scans bot-authored
    comments for it → re-invoke / duplicate-delivery never double-replies (human-pasted marker
    ignored — author-checked).
  - DI seam: fake token-minter/octokit/issue-fetch/agent-run/poster → fully offline.
  - **Tests (+15):** run-level (token mint, BOUND ref+commentId not model-selectable, bot-loop
    skip-before-mint, dedup pass-through, token-not-logged) + prompt golden (untrusted-wrap incl.
    hostile trigger, PR/issue phrasing) + poster security (createComment bound ref, bot-loop +
    dedup floors, per-trigger-id keying, human-marker ignored).
  - **flue build green; discovery = agents{hello} + workflows{build,gated,issue-comment,
    issue-triage,pr-review}**; no vitest module import in dist; helpers in agent-lib/
    (+ issue-comment-post.ts at src/ top-level, not discovered), tests in nested __tests__/.
  - **NO LIVE SIDE EFFECT** — all GitHub/model MOCKED; no real comments posted, no live `flue run`.
    Last commit: Phase 5 slice 2 (issue-comment). Next slice = `pr-fix` (or `answer`).
- **Phase 5 slice 1 DONE ✅ — `issue-triage` workflow ported** (`src/workflows/issue-triage.ts`,
  `export async function run` → `runIssueTriage(ctx, deps)` DI seam). Single-phase,
  TOOL-ONLY agent (NO sandbox — reads issue + dup-search via bound read tools; design
  phase-5 §"Single-phase workflows"). Mints an **`issues-write`** scoped token (downscoped
  to the repo).
  - **agent** `src/agent-lib/triage.ts` (`createTriageAgent`: triage task key, persona,
    `issue-triage` skill, READ-ONLY github tools bound to ref+token, NO sandbox) +
    `triage-prompt.ts` (renders the request; issue title/body/comments UNTRUSTED-wrapped
    via `wrapUntrusted`, trigger metadata stays outside the wrapper).
  - **classification→deterministic action** (reconciles the reference's agent-applies-
    labels-via-MCP-tools with our pr-review verdict→post split): agent emits a
    `CLASSIFICATION: category=… [state=…] [duplicate] [close]` marker;
    `triage-classification.ts` parses it (golden-tested, mirrors parseReviewerVerdict)
    + maps to canonical SKILL.md labels; `src/triage-post.ts`
    (`applyTriageDeterministically`, mirrors github-post.ts — bound ref+token, NOT a
    model tool) ensures labels exist (createLabel idempotent; **403 → existing-only
    fallback**, matching the reference), `addLabels` (idempotent → Q5.4 re-invoke safe),
    posts the pre-marker comment, and closes on duplicate/already-implemented.
  - DI seam: fake token-minter/octokit/issue-fetch/agent-run/applier → fully offline.
  - **Tests (+28):** 17 classification/mapping golden (triage-classification.test.ts);
    11 run-level + poster security (issue-triage.test.ts — bound ref not model-selectable,
    correct mocked octokit createLabel/addLabels/createComment/update, token not logged).
  - **flue build green; discovery = agents{hello} + workflows{build,gated,issue-triage,
    pr-review}**; no vitest module import in dist; helpers in agent-lib/ (+ triage-post.ts
    at src/ top-level like github-post.ts, not discovered), tests in nested __tests__/.
  - **NO LIVE SIDE EFFECT** — all GitHub/model MOCKED; no real labels/comments/close, no
    live `flue run`. Last commit: Phase 5 slice 1 (issue-triage). Next slice = `issue-comment`
    (or `pr-fix`).
- **Phase 4 STARTING-position note retained below.**
- **⏸ Phase 4 LIVE ACCEPTANCE DEFERRED (user choice 2026-06-22):** the live
  `flue run build` (writes real code, pushes a branch, opens a real PR, pauses at
  the gate for human approval) is user-gated and NOT to be run autonomously — run
  it later WITH THE USER supervising the gate. Until then, treat the build workflow
  as done-pending-live-proof. Also pending: Phase-6 GitHub-comment resume trigger.
- **Phase 4 detail (slices 1-6) below; archive has full notes.**
- **Phase 4 slice 6 DONE ✅ — durable gate RESUMABLE end-to-end + boot recovery.**
- **This slice (6) built:** the RESUME path wired to real triggers + boot recovery.
  - **Approvals server surface** (`src/admin/approvals.ts` + `createApp` routes) —
    replaced the `/admin/api/approvals` 501 stub. `GET /admin/api/approvals` lists
    PAUSED build runs (id=runId, gate, kind, workflowRunId, summary[repo#issue+plan/
    verdict pointer], restartCount, createdAt:null[Phase-7]); `POST /admin/api/
    approvals/:id/respond {decision:'approved'|'rejected'}` maps to
    `resume(runId,'approve'|'reject')`. Matches `src/cli.ts` cmdApprovals exactly.
    Operator-auth gated (mounted under the existing `/admin/api/*` requireOperator
    middleware — 401 without token). Thin `ApprovalsBackend` SEAM over the build
    run-store (+ injected `resume`/`reinvoke`) so routes test offline; default export
    wires `createDefaultApprovalsBackend()`. Added `BuildRunStore.listPaused()`.
  - **IDEMPOTENCY:** unchanged from slice 1 — `resume()` no-ops on an already-resolved
    run (double-approve = no second re-invoke; reject-after-complete = no-op). Backend
    404s an unknown runId; 400s an invalid decision. reinvoke seam stays injectable
    (default spawns `flue run build`, Spike-3 path). NO GitHub post in resume.
  - **BOOT recovery hook** (`src/app.ts` module scope) — `runBootRecovery()` calls
    `recoverOrphanRuns()`: re-invokes `active` orphans (crashed mid-phase, idempotent
    via phasesDone), LEAVES `paused` runs for a human (slice-1 + flue-ref §0
    Node-no-workflow-recovery). WHERE: app.ts module-eval (dist/server.mjs inlines it,
    owns serve()/listen) — run-ONCE (`bootRecoveryStarted` guard), NON-BLOCKING
    (detached `void` promise, listen not awaited), NON-FATAL (errors logged). Skipped
    under `VITEST`/`LASTLIGHT_SKIP_BOOT_RECOVERY=1` so unit imports don't trigger it.
    Restart-count BREAKER (≤3 in build.ts) caps a wedged run — boot re-invoke bumps it.
  **The build workflow's PHASES are now COMPLETE.**
- **This slice (5) built:** the three remaining phase bodies — guardrails + the
  deterministic gate-ask + the deterministic open-PR — behind the `BuildDeps` seam.
  - **guardrails** — `src/agent-lib/guardrails.ts` (`createGuardrailsAgent`: guardrails
    task key, persona, `building` skill, READ-ONLY github tools, sandbox REQUIRED, cwd
    /workspace — mirrors architect) + `guardrails-prompt.ts` (renders `guardrails.md`,
    issue text UNTRUSTED-wrapped via the architect snapshot builder). `runGuardrailsPhase`
    (mint→clone→session→READY/BLOCKED text + report pointer). **BLOCKED parity:**
    `bootstrapBypass(issueContext)` — `lastlight:bootstrap` label OR `guardrails:`/
    `[guardrails]` title prefix bypasses the BLOCK (build.yaml `unless_*`); build.ts
    fails the run on `^\s*BLOCKED` UNLESS bypassed. Added `labels?` to issue context.
  - **gate-ask** — `src/build-github-post.ts` `renderGateComment` (pure) +
    `postGateCommentDeterministically` (bound ref+issue, `issues.createComment`, NOT a
    model tool — mirrors github-post.ts). `runPostGateComment` wires mint→render→post;
    surfaces the plan (post_architect) / verdict+cycle (post_reviewer) + approve/reject
    cmds. build.ts records the comment id under `gateComment:<gate>` via new
    `store.recordScratch`; idempotent (build.ts guards on `pendingGate` → posts once).
  - **open-PR** — `renderPrBody`/`renderPrTitle` (pure; pr.md contract: Closes #N,
    only-present doc links, not-approved note) + `openPullRequestDeterministically`
    (bound ref, `pulls.list` head-filter → reuse OPEN PR else `pulls.create`
    head=branch base=default-branch). `runOpenPullRequest` reads the last `verdict:N`
    for approved-ness, records `prNumber`/`prUrl`. **Idempotent at TWO layers:**
    `shouldRunPhase('pr')` + the list-then-create reuse.
  - `gateEnabled` now POSITIVE-ENABLE from config (`approval[gate]===true`, build.yaml
    parity) instead of the `() => true` stub. defaultBuildDeps no longer stubs anything.
- **This slice (4) built:** the real REVIEWER-LOOP phase bodies (reviewer:N →
  [post_reviewer gate] → fix:N → recheck:N), wired into `defaultBuildDeps().runPhase`
  behind the `BuildDeps` seam — the existing build.ts loop control flow drives them.
  - `src/agent-lib/build-reviewer.ts` — `createBuildReviewerAgent` (review task key,
    persona, pr-review+building+code-review skills, sandbox REQUIRED, cwd /workspace;
    reviews the executor's COMMITTED diff in the checkout, NO GitHub post — internal
    build review) + `createFixAgent` (fix task key→default fallback, persona, building
    skill, READ-ONLY github tools, sandbox+cwd). Recheck = the SAME reviewer agent
    re-prompted with re-reviewer.md.
  - `src/agent-lib/reviewer-prompt.ts` — pure renderers for reviewer.md / re-reviewer.md
    / fix.md (`fixCycle` for the latter two). Reviewer NOTES are the handoff: committed
    `reviewer-verdict.md`, named in the fix prompt (read from checkout, NOT inlined).
  - `runReviewerPhase(cycle,isRecheck)` + `runFixPhase(cycle)` (build-phases.ts): mint
    repo-write → octokit → `withBuildSandbox` (pre-clone+checkout) → per-cycle named
    session (`reviewer:N`/`recheck:N`/`fix:N`) → verdict text returned to the loop →
    `parseReviewerVerdict` drives break/continue. Reviewer records the verdict POINTER;
    fix reads HEAD sha + PUSHES via the SAME mocked `pushBranch` seam as the executor.
  - `cycleFromPhaseName` parses the `:N` suffix; `runPhase` routes `reviewer:`/`recheck:`/
    `fix:` per-cycle. build.ts merges each phase's scratch pointer into `markPhaseDone`.
  - Prompts edited: reviewer/re-reviewer/fix no longer instruct the model to
    `git push` (the workflow pushes deterministically — mirrors executor.md).
- **This slice (3) built:** the real EXECUTOR phase body, wired into
  `defaultBuildDeps().runPhase('executor')` behind the `BuildDeps` seam (runs AFTER
  the post_architect gate). Mirrors the architect:
  - `src/agent-lib/executor.ts` — `createExecutorAgent(ref,octokit,sandbox)`:
    model=resolveModel('executor') (falls back to default), thinking='executor',
    persona instructions, READ-ONLY github tools, `building` skill, sandbox+cwd
    /workspace. Top-level NAMED session `executor` (NOT a subagent).
  - `src/agent-lib/executor-prompt.ts` — renders `src/prompts/executor.md`; NAMES
    `.lastlight/issue-<N>/architect-plan.md` (the plan is the handoff — read from
    the checkout, NOT inlined); optional untrusted-wrapped issue snapshot.
  - `runExecutorPhase` (build-phases.ts): mint repo-write token → octokit →
    `withBuildSandbox` (pre-clone+`checkout -B`, plan on branch) → session (agent
    implements + COMMITS in-sandbox via git CLI, NOT a tool) → `readHeadSha` →
    **`pushBranch` SEAM** (the controlled repo-write side effect). Scratch records
    executor-summary POINTER + commit sha (spec/10); `PhaseResult.scratch` carries
    them up to the workflow's `markPhaseDone`.
  - **PUSH = mockable seam:** `withBuildSandbox` now also hands the `BuildContainer`
    to the body so the workflow runs `git push origin <bound-branch>` in-sandbox
    after the session. MOCKED in all default tests (asserts it WOULD push the bound
    ref) — NO real push. Executor prompt no longer instructs the model to push.
- **This slice (2) built:** the real ARCHITECT phase body, wired into
  `defaultBuildDeps().runPhase('architect')` behind the `BuildDeps` seam.
  - `src/agent-lib/architect.ts` — `createArchitectAgent(ref,octokit,sandbox)`:
    model=resolveModel('architect'), thinkingLevel=resolveThinking('architect'),
    instructions=loadPersona() (carries security.md), read-only github tools (closed
    over ref/octokit), `building` skill, sandbox + cwd=/workspace. Top-level NAMED
    session `architect` (NOT a subagent — resume can re-open it).
  - `src/agent-lib/build-sandbox.ts` — `withBuildSandbox` (mirrors reviewer-sandbox;
    caller-owns-lifetime): creates a node+git container w/ repo-write token baked as
    env, FULL-clones the repo + `checkout -B <branch>`, ALWAYS `remove()`s in finally.
    NO tool-only fallback (architect needs the workspace → clone/checkout failure
    THROWS, token-redacted). EGRESS still deferred.
  - `src/agent-lib/architect-prompt.ts` — renders `src/prompts/architect.md`
    (build-time markdown import, inlined) w/ repo/branch/issueDir/issueNumber +
    a contextSnapshot. `src/engine/untrusted.ts` — ported `wrapUntrusted` markers:
    issue title/body/comment wrapped UNTRUSTED (spec/07); trigger metadata stays
    outside; injected markers stripped so hostile text can't escape the wrapper.
  - Plan PERSISTENCE: agent writes+commits `.lastlight/issue-<N>/architect-plan.md`
    on the branch (durable handoff); run-record scratch stores the POINTER only
    (spec/10 split rule), so the gate can surface it + the executor can consume it.
  - Architect's own seams (mintToken/makeOctokit/sandboxOps/runArchitectSession)
    injectable → default impl tested OFFLINE.
- **REMAINING for Phase 4 (user-gated):** (1) the **LIVE build acceptance** — a real
  `flue run build` end-to-end (clone→commit→PUSH→gate comment→PR→approve→resume→PR)
  on a real issue, run WITH THE USER (the mocked `pushBranch`/`postGateComment`/
  `openPullRequest` seams become live). NEXT SLICE. (2) The **Phase-6** channel/
  webhook resume entry — mapping a GitHub `@last-light approve`/`reject` COMMENT →
  `resume(runId,decision)` (the dashboard + CLI HTTP path is now LIVE this slice;
  the GitHub-comment trigger lands with channels, TODO(phase-4/channels) in resume.ts).
- **NO LIVE SIDE EFFECTS this slice** — approvals endpoints + boot recovery wired but
  exercised ONLY against fakes/temp sqlite in tests; resume's default reinvoke (spawn
  `flue run build`) is NEVER invoked live; no GitHub writes, no PR, no real
  `flue run build`, no branches/commits/pushes/comments posted.
- **Blockers:** none. CLI approvals contract met without Phase-7 data — only the
  paused build run-store rows are needed (createdAt is honestly null until Phase-7).
  Boot hook runs cleanly in the generated entry (module-eval, guarded/non-blocking/
  non-fatal); verified `flue build` green + no real vitest import in dist.

## Phase status
- [x] **0 — Spike & de-risk** (HARD GATE) ✅ — hello-world agent (openai/*); Docker
  SandboxFactory (clone+build, egress deferred); durable HITL + invoke/session
  unknowns answered (MIGRATION.md).
- [x] **1 — Shared core port** ✅ — config, git-auth/profiles, github tools, skills,
  persona, templates/verdict/loop-eval. Suite 159/3. Commit `eee7933` (closes into P2 s1).
- [x] **2 — Server + preserved API surface** ✅ — single Hono app + `flue()` mount
  (one port); `/health`+`/api/status`; thin `/admin/api/*` reads; operator-auth;
  CLI port; dashboard SPA under `/admin`. Suite 240/3. Last commit `a58f0d7`.
  (Trigger routes `/api/*` were blocked-on Phase 3 — delivered there.)
- [x] **3 — Vertical slice: pr-review** ✅ — pr-review workflow + reviewer agent +
  deterministic poster (verdict→createReview, self-PR→COMMENT fallback); Docker
  sandbox wired in (additive). LIVE proven (#941 COMMENT, #937 formal APPROVE).
  Suite **273 passed / 5 skipped**. Last commit: Phase 3 slice 2 (Docker sandbox).
- [~] **4 — build + durable approval gate** ← **IN PROGRESS** (slice 6 of N).
  Slices 1-5: control flow+gate+run-record; ARCHITECT; EXECUTOR; REVIEWER-LOOP;
  guardrails+gate-ask+open-PR (PHASES COMPLETE). **Slice 6 (this): durable gate is
  RESUMABLE end-to-end via the app + recovers on boot.** Approvals server surface
  (`GET /admin/api/approvals` lists paused runs; `POST :id/respond` → resume) matching
  the CLI contract, operator-auth gated, idempotent (resume no-ops), 404/400 guards;
  `ApprovalsBackend` seam over the build run-store (+`listPaused`). Boot orphan recovery
  hooked at app.ts module-eval (run-once/non-blocking/non-fatal; re-invokes active,
  leaves paused; breaker ≤3). New tests: approvals endpoints+auth+idempotency+default
  backend (10 in app.test) + boot-recovery breaker (1 in build.test). Suite
  **384 passed / 5 skipped** (+10). `flue build` green; discovery = agents{hello} +
  workflows{build,gated,pr-review}; `grep -c vitest dist/server.mjs` = 1 (the inlined
  guardrails prompt text — a test-runner example, NOT a vitest module import; verified
  no `import/require 'vitest'` in dist).
  **Next slice (user-gated, WITH THE USER):** the LIVE `flue run build` acceptance
  end-to-end on a real issue (the mocked push/gate-comment/open-PR seams go live).
- [~] 5 — Remaining workflows + crons + chat ← **IN PROGRESS** (slice 1: issue-triage ✅;
  slice 2: issue-comment ✅; slice 3: pr-fix ✅; slice 4: answer ✅; slice 5: web tools
  [web_search/web_fetch + server-side SSRF guard, gated-not-global] ✅; slice 6: explore
  [Socratic reply-gate loop + web-tools-gated + deterministic publish] ✅; slice 7: repo-health
  [repo-scoped cron/CLI scan → idempotent tracking-issue delivery] ✅ → next: security-review/
  security-feedback or chat or crons)
- [ ] 6 — Channels (replace connectors + router)
- [ ] 7 — Persistence + re-back admin API
- [ ] 8 — Deploy & cutover

### Verified runtime facts
Durable, reusable facts the loop/subagents rely on. Where a fact is also in
`spec/flue-reference.md §0`, that file is authoritative; keep the short version here.
- **Agent HTTP contract:** `POST /agents/<name>/<id>` body `{ message, images? }`;
  `?wait=result` → `200 { result:{ text, usage:{input,output,totalTokens,cost},
  model:{provider,id} }, streamUrl, offset, submissionId }`; bare POST → `202
  { streamUrl, offset }`. HTTP exposure REQUIRES a `route` export on the agent.
- **openai provider auto-authenticates** from `OPENAI_API_KEY` — no `registerProvider`.
  Default model = `openai/*` (no Anthropic key present).
- **Flue DISCOVERY RULE (empirically verified; flue-reference §0):** Flue discovers
  EVERY immediate file in `src/agents/` + `src/workflows/` (+ `channels/`) as an
  entry. `flue build` does **NOT error** on a bad immediate file — it silently lists
  it + **inlines its module-eval into `dist/server.mjs`** → crash at LOAD/runtime
  (not build). So: NO test files / NO non-entry helpers as immediate files there.
  Helpers live in `src/agent-lib/` (not discovered); co-located tests live in nested
  `__tests__/` (matches `src/**/*.test.ts`, not discovered). Sanity per slice:
  discovery = agents{hello} + workflows{gated,pr-review}; `grep -c vitest dist/server.mjs` = 0.
- **Build-time markdown/skill inlining:** import authored content via
  `import x from '../path/file.md' with { type: 'markdown' }` (skills use
  `with { type: 'skill' }`) — Flue inlines the STRING at build time. Do NOT
  `readFileSync(import.meta.url-path)` for AUTHORED source (it resolves into `dist/`
  at runtime + the `.md` isn't shipped → ENOENT). persona.ts uses the markdown-import
  form. (External runtime files read from cwd/deploy disk — config YAML, dashboard
  assets — are NOT this case; see carried unknowns.)
- **Sandbox-adapter contract (caller-owns-lifetime; docs/api/sandbox-api.md):** the
  adapter (`docker()`) is a PURE mapper — must NOT create/delete/kill the provider
  sandbox; the CALLER (workflow) owns container `create()`/`remove()` and must
  `remove()` in a `finally`. `createSandboxSessionEnv(api, cwd)` is synchronous →
  `SessionEnv`; `createSessionEnv({ id })` once per `init()` (id = ctx/runId). `exec`
  honors `{cwd, env, timeoutMs, signal}` (round timeoutMs UP; exit 124 on timeout).
  Image `node:22-bookworm` (slim lacks git). EGRESS DEFERRED (full network, no SSRF floor).
- **Live pr-review facts:** verdict→post = `APPROVED→APPROVE`,
  `REQUEST_CHANGES→REQUEST_CHANGES`; **bot's-own PR (`author == config.botLogin`,
  `selfAuthored:true`) → `COMMENT` always** (GitHub forbids self-review) via
  `issues.createComment`; non-self → formal `pulls.createReview`. owner/repo/
  pull_number/token are CLOSED OVER (bound ref), never model-chosen. Bot login =
  `last-light[bot]`. Token NEVER logged (`redact()` any occurrence in stderr).
- **serveStatic / dashboard mount (flue-reference §0):** `@hono/node-server`
  `serveStatic` (DIRECT dep, not hoisted by pnpm) serves prebuilt `dashboard/dist/`
  under `/admin` (Vite `base:/admin/`). Mounted LAST in `createApp()`, AFTER
  `/admin/api/*` + operator-auth → does NOT shadow API/health/Flue routes; PUBLIC
  shell (SPA logs in itself). serveStatic `next()`s on a miss → SPA `index.html`
  fallback. Built-server entry (`dist/server.mjs`) owns `serve()` + SIGINT/SIGTERM
  traps + `db.close()` (Node signal handlers are additive).

### Carried unknowns / follow-ups
- **runtime-file-read follow-up:** `src/config.ts` + `src/admin/dashboard.ts` use
  `import.meta.url` + `readFileSync` for EXTERNAL runtime files (config YAML from
  cwd; prebuilt dashboard assets) — legit on-disk at deploy, NOT the inlining bug.
  Re-confirm dashboard asset paths resolve from the BUILT entry when dashboard
  serving is wired live.
- **Egress hardening (DEFERRED, required before prod — spec/09, 00 risk #1):**
  allowlist + metadata-CIDR/SSRF floor, via re-hosted CoreDNS/nginx in the Docker
  factory or E2B `allowOut`/`denyOut` (fed by the ported `egress-allowlist.ts`).
  Dev containers currently have full network + no SSRF floor (known, recorded).
- **Graceful-shutdown finalize** — leaning toward additive
  `process.on('SIGTERM', () => crons.stop())` (fires alongside Flue's handler), NOT
  a forked server entry; finalize when crons land (Phase 5).
- **`TODO(phase-7)` admin routes:** `stats`/`sessions`/`approvals` still honest 501;
  RunPointer/RunRecord lacks `currentPhase`/`repo`/`issueNumber`/`restartCount`
  (app-run-store joins) → returned as explicit `null`, never fabricated.
- **Open Qs:** per-thread chat serialization + sandbox-less chat latency (Phase 5).
- **Substantive-review caveat:** both #941 (self→COMMENT) and #937 (formal APPROVE)
  proven; no further live PR posts without the user's say-so.

## Secrets status (`secrets/.env`, git-ignored)
- ✅ Present (from `~/work/lastlight/.env`): `OPENAI_API_KEY`, `TAVILY_API_KEY`,
  Slack tokens, GitHub App creds + PEM (`...PATH` repointed to `./secrets/...pem`),
  `WEBHOOK_SECRET`, `MODAL_TOKEN_ID/SECRET`, `ADMIN_SECRET`.
- ⚠ Gaps: no `E2B_API_KEY` (dev sandbox = Docker factory, none needed);
  `SLACK_SIGNING_SECRET` (Phase 6 HTTP Events API only); no `ANTHROPIC_API_KEY` →
  default model is `openai/*`; `ADMIN_PASSWORD` commented out (→ auth disabled in dev).

## ⚠ Beta drift (installed 1.0.0-beta.2 vs design docs) — see flue-reference §0
flue-reference §0 (verified-installed) OVERRIDES the older §2–§3 narrative researched
against `withastro/flue@main` (ahead of pin). Key: agents = `createAgent` (NO
`defineAgent`); workflows = `export async function run(ctx)` only (NO `defineWorkflow`/
object form); NO top-level `invoke` (`dispatch(agent,{id,input})` is the agent entry;
workflows via `flue run`/HTTP/`invokeWorkflowAttached`); `defineConfig` from
`@flue/cli/config`; `@flue/runtime/node` exports `local()` + `sqlite()` only;
bundled `node_modules/@flue/runtime/docs/**` is authoritative for this pin.
