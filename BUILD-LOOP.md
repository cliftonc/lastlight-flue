# Build loop prompt

Launch with `/loop` (dynamic, self-paced) pointing at this file. The loop re-fires
this prompt each iteration; it is written to be resumable. See `PROGRESS.md` for
where the build currently is.

---

You are building Last Light on Flue in ~/work/lastlight-flue. The spec and design
are complete and authoritative — implement them phase by phase, verifying as you
go, and STOP at the decision points below. You are re-invoked repeatedly; be
resumable.

SOURCES OF TRUTH (re-read the relevant ones every iteration):
- spec/IMPLEMENTATION-PLAN.md — canonical phase sequence 0→8 and each phase's
  Work / Deliverable / Verify. This is the spine.
- spec/00-overview.md — locked decisions + risk register. Never violate one.
- spec/01..11 — per-layer requirements, Must-preserve invariants (never regress
  one), and Acceptance criteria (a phase isn't done until these pass).
- spec/flue-reference.md — the verified Flue API. Flue is BETA: re-verify every
  signature this slice uses against the INSTALLED package (node_modules types /
  flueframework.com/docs/<path>/index.md), and update this file if it drifted.
  Do not trust your memory of the API; read it or run it.
- design/overall-architecture.md + design/phase-N-*.md — the concrete how (module
  layout, code sketches, cross-cutting decisions, open Qs, local secrets).
- ~/work/lastlight/ — the running reference implementation = behavior to match.
  Port from it; don't reinvent.

LOOP DISCIPLINE:
1. Maintain PROGRESS.md (current phase, slice, done, next, blockers). FIRST thing
   each iteration: read PROGRESS.md + `git log` to locate yourself.
2. Advance ONE coherent slice per iteration: re-verify Flue signatures → implement
   → write & run the phase's Vitest acceptance tests → commit ONLY when green →
   update PROGRESS.md.
3. Use subagents to parallelize independent within-phase work; keep PHASE ORDER
   strictly serial.

HARD RULES:
- Phase 0 is a HARD GATE. Don't start Phase 1+ until its three proofs are
  committed: (a) defineAgent hello-world on our OpenAI key (default model = an
  openai/* specifier; there is no Anthropic key); (b) a custom Docker
  SandboxFactory (src/sandboxes/docker.ts — implement Flue's
  SandboxFactory→SandboxApi: container per run, workspace mounted, exec + file
  ops via docker) that does git clone + build in an ISOLATED CONTAINER and tears
  it down — EGRESS IS DEFERRED THIS PHASE (full network, no SSRF floor; a known,
  recorded, temporary risk — do not run untrusted input through it); (c) a
  workflow+session that pauses, survives a process restart, and resumes —
  empirically proving invoke(wf,{input:{runId}}) RE-RUNS run() (not a no-op; keep
  app-runId ≠ Flue-runId) and whether harness.session(name) reattaches across
  invokes.
- Flue sandboxes are bring-your-own: e2b/daytona/modal are BLUEPRINTS, not npm
  packages — only the SandboxFactory→SandboxApi interface (+ local()/virtual) is
  built in. So a Docker factory is as first-class as any provider; read the REAL
  SandboxFactory/SandboxApi types from node_modules/@flue/runtime before coding.
- Durability: Flue does NOT resume workflows and gives NO workflow crash recovery
  on Node. Durability = Flue session (context) + app-owned run record
  (run-store.ts: phasesDone cursor, pendingGate, restart_count≤3) + idempotency
  keys + boot-time orphan re-invoke. Never write code assuming Flue resumes a
  workflow.
- Honor: E2B egress (allowOut/denyOut + explicit metadata CIDR floor, fed by the
  ported egress-allowlist.ts); the PEM wall (only repo-write, controlled path);
  TDD (test with/before code).

SECRETS (in secrets/.env, git-ignored; see design/overall-architecture.md →
Configuration → "Local secrets"):
- ✅ Present (copied from the authoritative ~/work/lastlight/.env): OPENAI_API_KEY,
  TAVILY_API_KEY, SLACK_BOT_TOKEN/SLACK_APP_TOKEN/SLACK_ALLOWED_USERS, GitHub App
  creds + PEM (GITHUB_APP_PRIVATE_KEY_PATH=./secrets/...pem), WEBHOOK_SECRET.
- Load env in dev via `--env secrets/.env`. Default model = openai/* (no Anthropic).
- ⚠ Still missing (STOP and ask only if a slice actually needs one):
  SLACK_SIGNING_SECRET (Phase 6 HTTP Events API; source only has the Socket-Mode
  app token). E2B_API_KEY is NOT needed — the sandbox is the Docker factory.

STOP AND ASK THE HUMAN (don't fabricate or push past):
- A needed credential/account is absent (see SECRETS above).
- A step would cause a real external side effect you don't own: posting to a live
  PR/issue/Slack, repointing a production webhook, deleting the old docker stack,
  prod egress sign-off.
- A Flue beta signature drifted in a way that breaks a locked decision / invariant.
- An acceptance criterion won't pass after a reasonable attempt — report it with
  output; don't paper over it.

BOOTSTRAP (mostly done — verify, don't redo): git is initialised; .gitignore
exists (secrets/ ignored — confirm with `git check-ignore secrets/.env`);
package.json (pnpm, type:module, @flue/runtime 1.0.0-beta.2 + @flue/cli + valibot,
Vitest) and tsconfig.json (NodeNext ESM) exist. REMAINING: `pnpm install`; add
flue.config.ts (defineConfig target:'node'); add a vitest config; record pinned
versions in flue-reference.md; first commit.

Begin: read/create PROGRESS.md, then spec/IMPLEMENTATION-PLAN.md, then do the next
slice.
