---
title: "Phase 1 — Shared core port"
phase: 1
status: "design complete"
flue_pin: "@flue/runtime 1.0.0-beta.2; pi-ai @earendil-works/pi-ai 0.79.9 (Flue pins ^0.79.4)"
date: 2026-06-21
---

# Phase 1 — Shared core port

## Scope

Bring across the runtime-independent pieces near-verbatim: `git-auth.ts` +
`profiles.ts` (token downscoping); GitHub tools as `defineTool`s (and/or MCP);
copy `skills/`, `prompts/`, `agent-context/`; port the template engine +
`verdict.ts` + `loop-eval.ts`; the typed config module + `resolveModel`/
`resolveVariant`. Deliverable: `@lastlight-flue/*` shared modules + `src/agents`
persona/skill wiring.

## Current Flue research

Re-verified `2026-06-21` against `withastro/flue@main` + docs `.../index.md`.

### Skills — native import contract (`examples/imported-skill`)
- `import review from '../skills/review/SKILL.md' with { type: 'skill' }` →
  pass to `defineAgent(() => ({ skills: [review] }))`. **Verified.**
- **Frontmatter contract is identical to Last Light:** `SKILL.md` has
  `name:` + `description:` YAML frontmatter; helper files (the example ships
  `CHECKLIST.txt`) live in the same dir and travel with the skill. Source:
  `examples/imported-skill/src/skills/review/{SKILL.md,CHECKLIST.txt}`.
- **`session.skill(ref)`** invokes a skill directly (returns `{ text }`); the
  skill ref also carries `.name`. Progressive disclosure is Pi-native (same model
  Last Light used). **No drift** vs `08`.
- **Confirm in implementation:** that helper subdirs (`scripts/`, `references/`,
  `assets/`) are materialized into the **sandbox** workspace for the agent's
  `read`/exec tools (the imported-skill example uses `InMemoryFs`, not a managed
  sandbox). If Flue doesn't stage them into E2B, stage via `harness.fs` at run
  start. → Open Q1.3.

### Models, reasoning effort, providers (`docs/guide/models.md`, reviewed 2026-05-29)
- **⚠ DRIFT CORRECTION vs `flue-reference.md` §2 / `02`:** reasoning effort is a
  **first-class `thinkingLevel`** agent option, **not** an opaque Pi `--variant`
  string. Levels: `'off' | 'minimal' | 'low' | 'medium'(default) | 'high' |
  'xhigh'` — these are **exactly** Last Light's variant vocabulary
  (`off|minimal|low|medium|high|xhigh`). So `resolveVariant()` maps 1:1 onto
  `thinkingLevel`. `thinkingLevel` is settable at the agent **and** overridable
  per `prompt`/`skill`/`task`.
- **Model specifier** is a plain `provider/model` string (`anthropic/…`,
  `openai/…`, `openrouter/<vendor>/<model>`, `cloudflare/…`), overridable per
  operation. Reports `{ provider, id }` on responses. Matches Last Light's
  `OPENCODE_MODEL`/`OPENCODE_MODELS` semantics → `resolveModel()` ports directly.
- **Provider auth env** matches Last Light: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
  `OPENROUTER_API_KEY`. Pi's catalog providers need no registration.
- **`registerProvider('anthropic', { baseUrl, apiKey, headers })`** in
  `src/app.ts` for gateway/proxy routing without changing model specifiers —
  the clean hook for the OTEL-collector / gateway story (Phase 7) and for
  Last Light's "direct provider routes avoid OpenRouter markup" preference.
- pi-ai npm latest is **`0.79.9`**; Flue beta.2 pins `^0.79.4` (compatible).

### Tools — `defineTool` + MCP (`docs/guide/tools`, `examples/github-channel`)
- `defineTool({ name, description, parameters, execute })`. `parameters` accepts
  **JSON-Schema** (github-channel example) **or** Valibot (`v.object`) — both
  documented. `execute` returns a string. **Verified.**
- **Bound-tool factory pattern** (load-bearing): `commentOnIssue(ref)` returns a
  tool whose `owner/repo/issueNumber` are **closed over from trusted code**, not
  model-selected. This is exactly how we scope GitHub tools to the run's
  repo+profile. Doc security rule: *"A tool's parameters are model-selected
  inputs, not an authorization boundary… do not put credentials, tenant
  identifiers, or unrestricted destinations into model-selected tool arguments."*
  Aligns with profile downscoping.
- **MCP:** `connectMcpServer(name, { url, headers })` — **HTTP transport** (URL +
  headers). Tool names are **prefixed with the connection name** (model-facing).
  → Last Light's `mcp-github-app` (stdio MCP today) must either (a) expose an
  HTTP endpoint, or (b) be reimplemented as `defineTool`s. **Decision below.**
- Tools can also be supplied **per-operation** to `session.prompt/skill/task`.

### Subagents (`docs/guide/subagents` referenced)
- `defineAgent({ subagents })` exists — the architect/executor/reviewer split can
  be modeled as subagents OR as separate `harness.session()` calls in `run()`.
  Phase 3/4 chooses; recorded here so Phase 1's agent module shapes anticipate it.

### Config & secrets (`docs/guide/models.md` auth section)
- `.env` loaded by `flue build/dev/run/connect`; `--env` selects one alternate.
  Keep credential values out of agent modules. Matches `02`'s discipline.

## Design

### Module/file layout (`lastlight-flue/src`)
```
src/
  config.ts            Typed config loader; resolveModel(task) / resolveThinking(task);
                       LASTLIGHT_*/OPENCODE_* env aliases; positive-enable gates;
                       fail-open JSON parse for models/variants maps.
  engine/
    git-auth.ts        PORTED VERBATIM — JWT → installation token, downscope,
                       repo-name allowlist. (No runtime dependency.)
    profiles.ts        PORTED — GitAccessProfile, GITHUB_PERMISSION_PROFILES,
                       GitSandboxAccess; loadAgentContext kept but re-pointed.
    templates.ts       PORTED VERBATIM — {{var}}/{{#if}}/${phase.output} engine.
    verdict.ts         PORTED — parseReviewerVerdict (exact regex marker).
    loop-eval.ts       PORTED — until-expr eval + unrendered-{{}} injection guard.
  tools/
    github.ts          defineTool factories: scoped GitHub actions
                       (comment/createIssue/react/review) bound to (ref, token).
    github-read.ts     GET-only subset for chat / read profiles.
  agents/
    persona.ts         loadPersona(): concatenates agent-context/{soul,rules,security}.md
                       → instructions string (+ optional chat suffix).
    models.ts          modelFor(task)/thinkingFor(task) thin wrappers over config.
    (role agents land in P3+: architect.ts, executor.ts, reviewer.ts, chat.ts)
  db.ts                Flue PersistenceAdapter (libsql/sqlite) — wired P0/P7.
skills/                COPIED from lastlight/skills/* (directories as-is).
prompts/               COPIED from lastlight/workflows/prompts/*.md.
agent-context/         COPIED from lastlight/agent-context/*.md.
```

### `git-auth.ts` / `profiles.ts` — verbatim port
Both are pure TS over `jsonwebtoken` + GitHub's `/app/installations/.../access_tokens`
REST call — **no Last Light runtime coupling**, so they port unchanged. The
`GITHUB_PERMISSION_PROFILES` map (`read` / `issues-write` / `review-write` /
`repo-write`) and the repo-name allowlist on the minted token are the security
spine for `09`. The only edit: `profiles.ts:loadAgentContext()` is superseded by
`agents/persona.ts` (Flue `instructions`), so it's re-pointed or removed.

> **Naming collision to flag:** Flue has an **agent `profile`** option (reusable
> agent definition). Last Light's `GitAccessProfile` is a **GitHub-permission**
> profile. Keep them distinct in code: `GitAccessProfile` / `gitAccess`, never
> reuse Flue's `profile` key for it. Recorded in overall-architecture Auth.

### GitHub tools — `defineTool` factories (decision: reimplement, drop the MCP server)
*Decision:* **reimplement `mcp-github-app` as `defineTool` factories** in
`src/tools/github.ts`, not keep it as an MCP server. Rationale: (a) Flue MCP is
HTTP-only (`connectMcpServer({url})`) — the stdio server would need an HTTP
wrapper + a co-process; (b) `defineTool` factories give us the bound-credential
pattern the spec/`09` wants (token + repo closed over, not model-selected); (c)
removes a moving part for cutover. Shape:
```ts
export function githubTools(ref: RepoRef, token: string, profile: GitAccessProfile) {
  const octokit = new Octokit({ auth: token });
  const tools = [getIssue(ref, octokit), getPullRequest(ref, octokit), /* read */];
  if (profile !== 'read') tools.push(commentOnIssue(ref, octokit), reactToComment(...));
  if (profile === 'review-write') tools.push(createReview(ref, octokit));
  // repo-write code mutation happens via the sandbox git CLI, not a tool.
  return tools;
}
```
The agent is assembled with `tools: githubTools(ref, scopedToken, gitAccess)` —
profile gates which tools even exist (defense in depth beside the token scope).
> **Dashboard impact:** the old shim classified tool families by `mcp_github_*`
> name prefix. Our `defineTool` names won't carry that prefix; the Phase 7 admin
> re-back must classify on the new names. Noted for Phase 7.

### Config module (`resolveModel` / `resolveThinking`)
Ports Last Light's resolver, mapping variant→`thinkingLevel`:
```ts
export function resolveThinking(task: string): ThinkingLevel {     // 'off'|...|'xhigh'
  return VARIANTS[task] ?? VARIANTS.default ?? BASE_THINKING;      // fail-open parse
}
export function resolveModel(task: string): string {
  return MODELS[task] ?? MODELS.default ?? BASE_MODEL;             // 'provider/model'
}
```
Each role agent calls `model: resolveModel('architect')`,
`thinkingLevel: resolveThinking('architect')`. Per-phase override (a phase that
wants `high`) uses the per-operation override on `session.prompt(text, { thinkingLevel })`.
Positive-enable gates + fail-open JSON parsing reproduced verbatim. Legacy
`OPENCODE_*` aliases tolerated.

### Persona (`agent-context` → `instructions`)
`persona.ts` concatenates `agent-context/{soul,rules,security}.md` into one
`instructions` string, shared by **every** agent (workflow + chat). The chat
agent appends its chat suffix (`11`). One canonical persona source — no
bifurcation. `security.md` is the untrusted-content rule that pairs with the
`contextSnapshot` wrapping in `07`.

### Skills — per-agent `skills:` arrays
Drop the `.lastlight-skills/<phase>/` staging. Each role agent imports exactly
the `SKILL.md`s its role needs (`with { type: 'skill' }`) and lists them in
`skills:`. A frontmatter-audit Vitest test parses every `skills/*/SKILL.md` and
fails on a missing `name`/`description` (replacing the prod "silent drop").

## Cross-cutting concerns raised (mirrored into overall-architecture.md)
- **Config:** typed `config.ts` with `resolveModel`/`resolveThinking`;
  variant→**`thinkingLevel`** (six levels, 1:1); model = `provider/model`;
  `.env` via `flue --env`; `OPENCODE_*` aliases tolerated; positive-enable gates;
  fail-open override-JSON parse. `registerProvider()` reserved for gateway/proxy.
- **Auth & security:** `git-auth.ts`/`profiles.ts` port verbatim — the GitHub App
  token downscoping + repo-name allowlist is the security spine; **`GitAccessProfile`
  is NOT Flue's agent `profile`** (keep distinct). GitHub mutations exposed as
  **bound `defineTool` factories** (credential/ref closed over, not model-selected);
  profile gates which tools exist. `mcp-github-app` retired → `defineTool`s.
- **Skills & persona:** native Flue skill imports replace bespoke staging;
  one `agent-context`-derived persona for both surfaces; frontmatter-audit test.
- **Observability (seed):** new `defineTool` names break the old `mcp_github_*`
  tool-family classifier → Phase 7 re-classifies on new names.
- **Testing:** `SKILL.md` frontmatter audit; `templates.ts` golden-render test;
  `verdict.ts` regex test; `git-auth`/`profiles` unit tests.

## Open questions / risks
- **Q1.1 — per-operation `thinkingLevel`/`model` override signature.** Docs say
  override is possible per `prompt`/`skill`/`task`; confirm the exact option key
  on `session.prompt(text, { thinkingLevel?, model? })` against the installed
  Agent API before Phase 3. (Affects per-phase variant overrides.)
- **Q1.2 — MCP vs defineTool final call.** Defaulting to `defineTool`s; if a
  later need for the full `mcp-github-app` surface appears, the HTTP-MCP route
  stays open. (risk #2.)
- **Q1.3 — skill helper-dir staging into E2B.** Verify Flue copies `scripts/`/
  `references/`/`assets/` into the managed sandbox; else stage via `harness.fs`
  at run start. (Ties to `08` "scripts runnable inside the sandbox".)
- **Q1.4 — `loadAgentContext` removal blast radius.** It's imported by the old
  runner/chat/executor; the Flue agents use `persona.ts` instead. Ensure nothing
  ported still calls the old signature.

## Acceptance hooks
- `git-auth`/`profiles` unit tests pass; a tool call mints a `read`-scoped token
  and reads a real issue (→ `09` "scoped token reads an issue").
- Every `SKILL.md` parses (frontmatter audit) — malformed caught by test, not
  prod silent-drop (→ `08` Acceptance).
- `templates.ts` renders `architect.md` byte-identically to Last Light for a
  fixed fixture (→ `07` Acceptance).
- `resolveModel`/`resolveThinking` yield the same effective values as the old
  harness for a representative `.env`; malformed `LASTLIGHT_MODELS` → warn +
  default (→ `02` Acceptance).
- The same `agent-context/*.md` drives a workflow agent and the chat agent
  (→ `08` Acceptance).
