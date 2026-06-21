---
title: "Phase 8 — deploy & cutover"
phase: 8
status: "design complete"
flue_pin: "@flue/runtime 1.0.0-beta.2; build target node → dist/server.mjs (withastro/flue@main, 2026-06-21)"
date: 2026-06-21
---

# Phase 8 — deploy & cutover

## Scope

Production on the new stack (`01`, `09`). Run as a Node service on the current
host; cut the Slack/GitHub App webhooks over; **delete the docker egress stack**
(compose coredns/nginx sidecars, `egress-firewall-config.ts`, `nginx-*.conf`,
`Corefile.*`) once Phase 0's E2B egress option is enforced and signed off;
dual-run + diff against a test repo; keep the old stack parked one cycle for
rollback.

## Current Flue research

Re-verified `2026-06-21` against `apps/docs/.../ecosystem/deploy/node.md`
(`lastReviewedAt 2026-06-20`) + `docs/cli/overview` + the E2B sandbox blueprint.

### Node deploy = a built Hono server (carries P2)
- `flue build --target node` → **`./dist/server.mjs`**; start with `node
  dist/server.mjs`. Listens on **`PORT` (default 3000)** — set **`PORT=8644`** to
  preserve Last Light's port. **Reads env at process start** (`.env` is
  build-time only → production must supply env at boot, e.g. `source secrets/.env`
  or a systemd `EnvironmentFile`). `node_modules` required at runtime (deps are
  externalized, not bundled) → `npm ci --omit=dev` on the host.
- Single listener / single port (`01`) holds: `/health`, `/api/*`,
  `/admin/api/*`, `/channels/*`, Flue `/runs/*` all on `PORT`.

### Managed sandbox in prod = E2B (carries P0)
The `e2b()` `SandboxFactory` wraps `Sandbox.create({ envs, network:{ allowOut,
denyOut } })` — egress allowlist + metadata-CIDR floor enforced at the provider,
**no docker/coredns/nginx sidecars needed**. Needs `E2B_API_KEY` at boot; per-run
sandboxes (cold start sub-second, up to 24h). `local()` stays for dev.

### No Flue Studio (carries P2) — observability is OTEL + dashboard + `/runs/:id`.

## Design

### Deployment topology (replaces the docker-compose stack)
```
Host (the current production server)
  └─ node dist/server.mjs            (PORT=8644; env from secrets/.env at boot)
       • one Hono app: /health, /api/*, /admin/api/*, /channels/*, /runs/*
       • PersistenceAdapter → libsql/sqlite file under STATE_DIR
       • croner schedules in-process
  └─ E2B (managed, off-host)         per-run sandboxes; provider-enforced egress
  └─ (deleted) coredns-strict/open, nginx-egress-strict/open, otel-collector-as-sidecar
```
- **No sandbox-egress docker network, no SNI-peek nginx, no CoreDNS sinkhole** —
  E2B's `network.allowOut`/`denyOut` (sourced from the single ported
  `egress-allowlist.ts`) is the firewall (P0). The OTEL collector hop is no
  longer needed for sandbox telemetry (E2B runs off-host); `@flue/opentelemetry`
  exports directly (P7).
- **Process supervisor** (systemd unit / docker single-container) runs `node
  dist/server.mjs`; restarts on non-`78` exit, backs off on `78` (`01`).

### Secrets (carries `02`/`09`)
- GitHub App **PEM** on the host at a mode-600 path; `git-auth.ts` mints per-run
  tokens host-side and injects the **scoped token** into the E2B sandbox via
  `Sandbox.create({ envs })` — the **PEM never enters the sandbox** except the
  `repo-write` agent's controlled path (the PEM wall, `09`).
- Provider keys, `E2B_API_KEY`, Slack signing/bot, webhook secret, `ADMIN_*`,
  `OTEL_*` supplied at boot via the env file (not baked into the image).

### Cutover procedure
1. **Stand up** the new service alongside the old docker-compose stack (different
   port), pointing at a **copy** of `STATE_DIR` (or a fresh DB) and a **test**
   GitHub App install + test Slack workspace.
2. **Dual-run + diff** (the acceptance gate): drive triage / pr-review / build
   (with a gate) / chat / explore against a test repo on **both** stacks; diff
   the outcomes (labels, review verdicts, PR contents, chat answers, published
   specs). Investigate every divergence.
3. **Sign off egress** (P0/risk #1): confirm the E2B allowlist blocks an
   off-list host and the metadata CIDR in strict + open modes, on the real prod
   E2B account.
4. **Flip ingress:** repoint the production GitHub App webhook URL +
   `WEBHOOK_SECRET` and the Slack Events API request URL + signing secret to the
   new service; set `PORT=8644`.
5. **Delete the docker egress stack** only after sign-off: remove the
   `coredns-strict/open`, `nginx-egress-strict/open`, `otel-collector` services
   from compose, and delete `src/sandbox/{docker.ts,egress-firewall-config.ts}`,
   `nginx-*.conf`, `Corefile.*`. Keep `egress-allowlist.ts` (now feeds E2B).
6. **Park the old stack** one cycle (stopped, not deleted) for rollback; retire
   after a clean week.

### Boot resume on the new host (carries `01`/`04`)
`recoverOrphanRuns()` scans the app run-store for `status='active'` (not
`paused`) and idempotently re-`invoke`s each; durable Flue sessions reopen by
name; the restart breaker caps loops. `paused` runs (awaiting humans) persist
across the cutover via the shared DB.

## Cross-cutting concerns raised (mirror to overall-architecture.md)
- **Deployment & cutover (fills the _Pending_ section):** prod = `node
  dist/server.mjs` on the host, `PORT=8644`, env at boot, `node_modules`
  present; sandbox = the **Docker `SandboxFactory`** (hardened with egress before
  prod) **or** E2B off-host — decided at the egress-hardening phase. The old
  docker egress stack is **deleted only if prod moves to E2B**; if egress is
  hardened by re-hosting CoreDNS/nginx into the factory, it is **kept**. Process
  supervisor honors exit `78`.
- **Secrets:** PEM host-side, mode-600; scoped token into the sandbox via
  `Sandbox.create({envs})`; PEM wall for `repo-write`; all secrets at boot, not
  in the image.
- **Cutover gate = dual-run + behavioral diff** on a test repo across both
  stacks; **egress sign-off on the real E2B account** before deleting the docker
  firewall; old stack parked one cycle for rollback.
- **OTEL exports directly** (no in-network collector sidecar needed once
  sandboxes are off-host).

## Open questions / risks
- **Q8.1 — `dist/server.mjs` signal/listen control (carries Q2.2).** Confirm the
  built server honors our `SIGTERM` handlers + lets us run `recoverOrphanRuns`
  and register crons at module-eval before `listen`. If it traps signals first,
  wrap with a custom Node entry that imports the app and owns `listen`/shutdown.
- **Q8.2 — E2B egress fidelity vs the docker firewall (risk #1 final check).**
  Validate on the prod E2B account that domain `allowOut` is genuinely
  default-deny and the metadata CIDR `denyOut` holds in open mode — the residual
  SNI-without-TLS-termination caveat is identical to today and stays documented,
  not closed.
- **Q8.3 — STATE_DIR / DB migration.** Decide whether to migrate the existing
  `lastlight.db` (executions/approvals history) into the new app run-store schema
  or start fresh + keep the old DB read-only for history. Paused runs must
  survive if migrating live.
- **Q8.4 — E2B cost/latency at prod volume.** Per-run microVMs vs the reused
  docker workspaces (#107 per-PR reuse). Confirm cold-start + cost is acceptable;
  consider E2B custom templates / pausing to approximate workspace reuse.

## Acceptance hooks
- New service serves production on `PORT=8644`; `/health` green; GitHub + Slack
  ingress verified live (→ `01`, `03`).
- Dual-run diff on a test repo shows behavioral parity for
  triage/review/build/chat/explore before the old stack is retired.
- E2B egress sign-off: off-allowlist host blocked, metadata CIDR blocked
  (strict + open) on the prod account (→ `09`, risk #1).
- The docker egress stack (coredns/nginx/collector + configs) is deleted; the
  build still enforces egress via E2B (→ `09`).
- A `paused` build survives the cutover and resumes from a GitHub `@last-light
  approve` on the new stack (→ `01`, `06`).
