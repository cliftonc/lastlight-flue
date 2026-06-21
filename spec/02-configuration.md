---
title: "Configuration"
order: 2
traces: "lastlight/spec/02-configuration.md"
---

# 02 — Configuration

## Requirement (from Last Light)

One typed, read-once config object holds every runtime knob: ports, webhook
secret, bot login, DB/state paths, base `model` + per-task `models` overrides,
per-task `variants` (reasoning effort), sandbox backend, GitHub App coordinates,
Slack config, approval-gate enablement, provider keys, opt-in web-search keys.
Validate the non-negotiable bits at the boundary (the GitHub App PEM must exist
and parse); malformed override JSON warns and falls back to `{}` rather than
crashing. Secrets stay env-only except the App PEM (a file).

## Must-preserve invariants

- **PEM never reaches the agent sandbox by default** — only the `repo-write`
  profile, and only via a controlled path (never env/args).
- **Defaults are dev-safe, not prod-safe** — e.g. the admin/HMAC secret default
  is explicitly a dev value; a prod check must refuse it.
- **Override JSON never fails closed** — a typo in the models/variants map logs
  and uses defaults; it never blocks boot.
- **Approval gates are positive-enable only** — a gate not listed is disabled;
  there is no "enable all".
- **Per-provider keys forwarded conservatively** — provider keys always
  available to the agent; web-search keys only when a phase opts in.
- **Per-task model/variant resolution** — `models[task] ?? models.default ??
  base`; same for variants (`off|minimal|low|medium|high|xhigh`).

## Flue mechanism

- **`flue.config.ts`** (`@flue/cli/config`, `defineConfig({ target: 'node' })`)
  for build/deploy target; runtime secrets via `.env` (`flue dev --env`,
  `flue run --env`). (flue-reference §9.)
- **Models/variants:** agents/workflows take a `model` router string
  (`provider/model`); a small typed config module reproduces the
  `models`/`variants` per-task resolver and feeds each `defineAgent`/`session`
  call. **`variant` maps to Flue's first-class `thinkingLevel`** (`off|minimal|
  low|medium|high|xhigh`), set per agent or per call via `session.prompt(text, {
  model?, thinkingLevel? })` — not an opaque Pi `--variant`. Provider keys
  resolved by Pi from env. (flue-reference §2.)
- **Persistence config:** `src/db.ts` exports the `PersistenceAdapter`
  (`sqlite()`/`postgres()`); its connection string is config. (flue-reference §7.)
- **Sandbox config:** the chosen managed-sandbox provider's creds (e.g.
  `E2B_API_KEY`) are env, wired in the agent initializer. (flue-reference §6.)

## Gaps & decisions

- **Layered overlay (`instance/`) → simplified.** Last Light layers
  `config/default.yaml` + an overlay + env. *Decision:* collapse to Flue config
  + `.env` + a single typed config module (matches the Mastra port's
  simplification and the locked "self-hosted Node" decision). Keep the per-task
  `models`/`variants` maps — they're load-bearing.
- **Keep legacy env aliases.** Continue accepting `LASTLIGHT_*` (and tolerate
  `OPENCODE_*`) names during migration so existing deploys don't break.
- **Sandbox backend selector.** Replace `LASTLIGHT_SANDBOX=gondolin|docker|none`
  with a Flue sandbox selector: `local()` for dev, the managed provider for
  prod (see `09-sandbox.md`).

## Acceptance criteria

- A single config module yields the same effective values the old harness
  produced for a representative `.env`.
- Malformed `LASTLIGHT_MODELS` JSON → warning + default model used, boot
  proceeds.
- An approval gate absent from the enabled set does not pause.
- Web-search keys are not visible to a phase that didn't opt in.

## Source / target files

- Source: `lastlight/src/config.ts`.
- Target: `lastlight-flue/flue.config.ts`, `src/config.ts` (typed loader +
  `resolveModel` / `resolveThinking` [variant→`thinkingLevel`]), `src/db.ts`.
