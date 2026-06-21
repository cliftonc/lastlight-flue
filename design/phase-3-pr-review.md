---
title: "Phase 3 — Vertical slice: pr-review"
phase: 3
status: "design complete"
flue_pin: "@flue/runtime 1.0.0-beta.2 (withastro/flue@main, 2026-06-21); pi core ^0.79.4"
date: 2026-06-21
---

# Phase 3 — Vertical slice: `pr-review`

## Scope

Re-prove the Mastra port's live milestone — a real review on a throwaway PR — as
**one `defineWorkflow`** (`06`, `09`). Mint a `review-write` token → run a
reviewer `harness.session()` (read GitHub tools + managed sandbox + `pr-review`
skill) → the agent emits a `VERDICT:` marker → the **workflow posts the review
deterministically** (not the model) with the bot's-own-PR `COMMENT` fallback.
Deliverable: `lastlight review <pr>` end-to-end.

## Current Flue research

Re-verified `2026-06-21` against `withastro/flue@main` (`@flue/runtime`
1.0.0-beta.2) + docs `.../index.md` (`lastReviewedAt: 2026-06-20`).

### `defineWorkflow` — object form + `output` schema + harness (confirms `06`)
Source: `docs/guide/workflows/index.md`, `docs/api/workflow-api/`.
```ts
export default defineWorkflow({
  agent,                                  // a defineAgent (declares model + sandbox)
  input: v.object({...}),
  output: v.object({...}),                // NEW vs flue-reference §3: top-level output schema
  async run({ harness, input }) { … return result; },
});
```
- A file in `src/workflows/` becomes a discovered workflow; **filename = name**.
- `run({ harness, input })` is plain TS → DAG/loop/skip = ordinary control flow.
  **No drift** vs `06`.
- **`harness.fs.writeFile/readFile`** + **`harness.shell(cmd)`** operate in the
  agent's sandbox **without recording in the conversation** (good for git plumbing
  / handoff-file staging that shouldn't pollute the transcript). `harness.session()`
  opens the conversational context. (`docs/api/agent-api/` §Harness.)
- **`defineAction`** extracts reusable finite behavior callable by multiple
  workflows or by a model. Reserved (not needed for the single pr-review slice;
  candidate later for shared sub-behaviors).

### `session.prompt` — per-call `model`/`thinkingLevel`/`result`/`tools` (RESOLVES Q1.1)
Source: `docs/api/agent-api/` §`PromptOptions`.
```ts
interface PromptOptions {
  result?: ValibotSchema;     // resolve with validated response.data (PromptResultResponse<T>)
  tools?: ToolDefinition[];   // extra model-callable tools for THIS operation
  model?: string;             // per-operation model override
  thinkingLevel?: ThinkingLevel;
  signal?: AbortSignal;
  images?: PromptImage[];
}
interface PromptResponse { text: string; usage: PromptUsage; model: { provider; id }; }
```
- **Confirms Q1.1:** per-phase variant/model overrides are `session.prompt(text,
  { thinkingLevel: resolveThinking('review'), model: resolveModel('review') })`.
- **`response.usage` (PromptUsage)** = "aggregated token and cost usage for model
  work" → **the source for our per-phase executions/stats row** (tokens, cost),
  and `response.model` = the resolved `{provider,id}`. (Feeds `10`/Phase 7.)
- Structured output: `session.prompt(..., { result: schema })` → typed
  `response.data`; throws `ResultUnavailableError` when no validated data. We use
  this as a **robustness backstop** for the verdict while keeping the text marker
  as the canonical contract (`07` decision).
- `session.skill(ref|name, { args?, result? })` invokes a skill directly
  (`PromptResponse`). The `pr-review` skill is imported (`with {type:'skill'}`)
  and listed on the agent; the agent reads it via its read tool during the prompt
  (progressive disclosure), exactly as `08` requires.

### Agent + sandbox per run (confirms P0/`09`)
Source: `docs/api/agent-api/` §`defineAgent`, P0 e2b blueprint.
- `defineAgent(async () => ({ sandbox: e2b(await Sandbox.create({network,envs})),
  model, tools, skills, instructions, cwd }))` — the async initializer creates the
  E2B sandbox with the **review-write-scoped token + provider keys** baked into
  `envs`, and the **strict egress allowlist** in `network` (P0 decision). The
  reviewer is **read+review-write only** — it can post a review but **cannot push
  code** (token scope, `09` invariant).
- ⚠ `defineAgent`'s initializer "runs whenever a runner initializes a root
  harness… do not treat it as a one-time constructor for a persistent instance."
  → **a fresh sandbox is created per run** (per `invoke`). For pr-review's
  per-PR workspace reuse (Last Light's `PER_TARGET_REUSE`), the sandbox is short-
  lived per run; reuse is a later optimization, not required for the slice.

### Verdict marker — ported parser is the prompt↔code contract (confirms `06`/`07`)
`parseReviewerVerdict` (ported verbatim from `lastlight/src/workflows/verdict.ts`):
`/^\s*VERDICT:\s*(APPROVED|REQUEST_CHANGES)\s*$/im` on the **first matching
line**, with the fragile fallback (`viaFallback` warns). No Flue dependency.

### ⚠ Behavioral change from reference: WHO posts the review
**Reference (`~/work/lastlight`):** the **agent** posts the review itself via the
`github_create_pull_request_review` MCP tool (event `APPROVE`/`REQUEST_CHANGES`/
`COMMENT`), and the dispatcher reads it back (`getLatestBotReview`) for status.
**Phase 3 design (per `03`/`06`/plan):** the **workflow posts deterministically**.
The agent's job ends at emitting the `VERDICT:` marker + the review body; the
**workflow code** (not the model) calls `octokit.pulls.createReview(...)`. Rationale:
Flue's security rule — *"a tool's parameters are model-selected inputs, not an
authorization boundary"* — and `03`'s "keep deterministic posts as application
code." This removes the review-submit tool from the model's surface entirely. The
agent retains **read** GitHub tools (list reviews/comments/files) to do its job.

## Design

### Module/file layout (`lastlight-flue/src`)
```
src/
  workflows/
    pr-review.ts        defineWorkflow: review-write token → reviewer session →
                        parse VERDICT → workflow posts review deterministically.
  agents/
    reviewer.ts         defineAgent(async () => ({ sandbox: e2b(...), model,
                        thinkingLevel, tools: githubReadTools(ref, token),
                        skills: [prReview, building, codeReview], instructions: persona }))
  tools/
    github-read.ts      (P1) GET-only tools: listReviews, listIssueComments,
                        listReviewCommentThreads, getPullRequest, getFiles.
  engine/
    verdict.ts          (P1) parseReviewerVerdict — ported verbatim.
    templates.ts        (P1) prompt render.
  github-post.ts        deterministic post helpers: submitReview(ref, token,
                        {event, body}); selfAuthored(ref): boolean (COMMENT fallback).
prompts/                review prompt(s) copied; the skill carries the procedure.
skills/pr-review,building,code-review/   (P1) imported with {type:'skill'}.
```

### `src/workflows/pr-review.ts` — the slice
```ts
export default defineWorkflow({
  agent: reviewerAgent,
  input: v.object({ owner: v.string(), repo: v.string(), pr: v.number(),
                    _triggerType: v.optional(v.string()) }),
  output: v.object({ verdict: v.picklist(['APPROVED','REQUEST_CHANGES']),
                     posted: v.boolean(), reviewUrl: v.optional(v.string()) }),
  async run({ harness, input }) {
    const ref = { owner: input.owner, repo: input.repo, pr: input.pr };

    // 1. Self-review guard (defense in depth; channels also drop it, `03`).
    if (await selfAuthored(ref, harnessToken)) {
      // bot's own PR → never a formal APPROVE/REQUEST_CHANGES; COMMENT-only path.
    }

    // 2. Reviewer session: checkout + read + assess. Skill drives the procedure.
    const session = await harness.session();
    await harness.shell(`git fetch origin pull/${input.pr}/head && git checkout FETCH_HEAD`);
    const res = await session.prompt(renderReviewPrompt(ref), {
      model: resolveModel('review'),
      thinkingLevel: resolveThinking('review'),     // per-phase override (Q1.1 resolved)
    });

    // 3. Parse the VERDICT marker (code↔prompt contract).
    const { verdict, viaFallback } = parseReviewerVerdict(res.text);
    if (viaFallback) log.warn('verdict via fallback heuristic', { runId });

    // 4. DETERMINISTIC post (workflow, not the model).
    const event = mapVerdictToEvent(verdict, { selfAuthored });   // self → COMMENT
    const reviewBody = extractReviewBody(res.text);               // strip the marker line
    const review = await submitReview(ref, scopedToken, { event, body: reviewBody });

    recordStats(runId, { tokens: res.usage, model: res.model });  // → executions/stats (P7)
    return { verdict, posted: !!review, reviewUrl: review?.html_url };
  },
});
```
- **`pr-review` has a single phase** (no loop, no gate) → simplest workflow; ideal
  vertical slice. No run-record/resume machinery exercised here (that's Phase 4).
- **Deterministic posting** (`mapVerdictToEvent` + `submitReview`):
  `APPROVED`→`APPROVE`, `REQUEST_CHANGES`→`REQUEST_CHANGES`, **bot's own PR →
  `COMMENT`** (GitHub forbids approving your own PR; matches reference's COMMENT
  fallback). `submitReview` is plain Octokit (`pulls.createReview`) over the
  review-write token — never a model-callable tool.
- **Skill-driven procedure:** the agent loads `pr-review` (procedure) + `building`
  (install/test gate) + `code-review` (rubric) via the read tool; the prompt is
  thin (render `ref` + "produce findings and end with `VERDICT: …`"). Building/
  testing happens via the agent's bash tool inside the E2B sandbox (egress
  allowlist lets it reach the package registry).

### Token + sandbox wiring (`09`)
- `gitSandboxAccessForWorkflow('pr-review')` → **`review-write`** profile →
  `git-auth.ts` mints a downscoped installation token with a repo-name allowlist.
- Token + provider keys → `Sandbox.create({ envs })` at agent-init (P0). The
  reviewer **cannot push** (no `contents:write`), satisfying `09`.
- Read GitHub tools (`github-read.ts`) are bound to `(ref, token)` — closed over,
  not model-selected (`09`/P1 pattern). The review-submit action is **not** a tool.
- Egress: strict allowlist (P0 `egress-allowlist.ts`) + metadata CIDR floor; the
  reviewer is **not** `unrestricted_egress`.

### Metrics capture (feeds `10`/Phase 7)
`res.usage` (PromptUsage: tokens + cost) and `res.model` are written to the
app-owned stats table per phase completion. Phase 3 just **captures** them; the
admin re-back consumes them in Phase 7. This validates early that per-phase
cost/token rollups have a native source (no shim).

## Cross-cutting concerns raised (mirrored into overall-architecture.md)
- **Workflow engine:** a phase = a `harness.session()` + `session.prompt(text,
  {model, thinkingLevel})`; per-call overrides resolve Q1.1 (`PromptOptions.model/
  thinkingLevel`). `defineWorkflow` gains a top-level **`output` schema**
  (validated result) vs the §3 sketch. `harness.shell`/`harness.fs` do git
  plumbing off-transcript.
- **Side-effects are deterministic application code, not model tools:** review
  submission moves from the agent's MCP tool to **workflow code** calling Octokit
  over the scoped token. Read-only GitHub access stays as bound `defineTool`s.
  (Strengthens `03`/`09`; a deliberate change from the reference's model-posts
  behavior — logged.)
- **Observability:** `PromptResponse.usage`/`.model` is the **native source** for
  per-phase token/cost/model stats — no jsonl shim needed for metrics. (Feeds the
  P7 re-back; reduces risk #3.)
- **Sandbox:** fresh E2B sandbox per `invoke` (the agent initializer is not a
  singleton constructor); per-PR workspace reuse is a later optimization.

## Open questions / risks
- **Q3.1 — harness token visibility to `git`/bash in the sandbox.** Carries P0's
  Q0.1: confirm the `review-write` token baked into `Sandbox.create({envs})` is
  visible to the agent's bash tool (`git fetch`, `gh`) and to `harness.shell`,
  i.e. Pi's per-`exec` env doesn't clobber session `envs`. **Verify before the
  live PR test.** (Blocks the build/test gate.)
- **Q3.2 — how does the workflow obtain the scoped token at post time?** The token
  is minted before agent-init (to bake into `envs`). The workflow's deterministic
  `submitReview` needs the same token. Decide the carrier: mint once in `run()`
  pre-`session()` and pass to both the sandbox `envs` and `submitReview` (closure
  in `run()` scope), since the agent definition and the workflow run share the
  `invoke` call. Confirm the agent initializer can read a value the workflow `run`
  also holds (closure or a per-run context object).
- **Q3.3 — extracting the review body vs the marker.** `extractReviewBody` must
  strip exactly the `VERDICT:` line and post the rest; define the contract
  (everything except the first matching marker line). Golden test.
- **Q3.4 — `?wait=result` vs fire-and-forget for `lastlight review`.** The CLI
  likely wants the run to complete and report the verdict. Use `invoke` then poll
  `/admin/api/runs/:id`, or `POST /workflows/pr-review?wait=result` — but our
  modules omit `route` (P2). Decide: CLI polls the run record, OR pr-review opts
  into `route`+`runs` with operator auth. (Affects the `lastlight review` UX.)

## Acceptance hooks
- `lastlight review owner/repo#N` runs end-to-end: reviewer session checks out the
  PR, builds/tests in the E2B sandbox, emits a `VERDICT:` marker; the workflow
  posts a **real `COMMENTED` review** to a throwaway test PR (→ plan's "Verify").
- The `review-write` token **cannot push code** to the repo (scope test, → `09`).
- A **bot-authored PR** yields a `COMMENT` (never `APPROVE`/`REQUEST_CHANGES`),
  and is dropped from auto-review at the channel (→ `03` self-review guard).
- `parseReviewerVerdict` parses the agent output by the exact regex; a missing
  marker logs `viaFallback` (→ `06`/`07`).
- `res.usage`/`res.model` recorded for the phase (→ `10` metrics source).
