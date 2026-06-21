---
title: "Sandbox, egress & tokens"
order: 9
traces: "lastlight/spec/09-sandbox.md"
---

# 09 — Sandbox, egress & tokens

> **#1 RISK PAGE.** Flue provides **no built-in egress firewall** (flue-reference
> §6). Last Light's default-deny SNI-allowlist is a real security control with no
> Flue analogue. The Mastra port dropped it and never recovered it — do not
> repeat that. The egress decision must be made and recorded in **Phase 0**.

## Requirement (from Last Light)

Every workflow agent session runs in an isolated sandbox that: (1) isolates the
agent from the host FS, (2) applies a **default-deny network egress allowlist**
(GitHub + provider + package-registry hosts; SNI-peek + CoreDNS sinkhole on
docker, VM HTTP interceptor on gondolin), with an **SSRF floor** that
hard-blocks cloud-metadata literals even in opt-in "open" mode, (3) receives a
**per-run GitHub App installation token downscoped** to the workflow's profile
(`read`/`issues-write`/`review-write`/`repo-write`), and (4) **never** sees the
App PEM except the one `repo-write` profile, via a controlled path. Provider keys
are forwarded unconditionally; web-search keys only when the phase opts in.

## Must-preserve invariants

- **Default-deny egress** — the agent reaches only allowlisted hosts; the
  allowlist is one source of truth.
- **SSRF floor** — `169.254.169.254` / `metadata.google.internal` blocked even
  in open mode.
- **Scoped token, not PEM** — the sandbox gets a downscoped installation token;
  triage literally cannot push code.
- **PEM gate is a wall, not a knob** — only `repo-write`, only via a controlled
  path; never env/args.
- **One sandbox per run's blast radius** — no host network reachable from it.
- **`unrestricted_egress` is opt-in per phase** — strict by default.
- **Provider keys unconditional; web-search keys gated.**

## Flue mechanism

- **Sandbox abstraction:** `defineAgent({ sandbox })` with a `SandboxFactory`.
  Flue sandboxes are **bring-your-own** — even e2b/daytona/modal ship as
  *blueprints* (scaffolded, user-owned code), not npm packages; only the
  `SandboxFactory`→`SandboxApi` interface (`exec`, `readFile`, `writeFile`, … with
  `timeoutMs`) and `local()`/virtual are built in. **Decision: a custom Docker
  `SandboxFactory`** (`src/sandboxes/docker.ts`) — a container per run, workspace
  mounted, `SandboxApi` methods implemented via `docker exec`/file I/O; `local()`
  remains for quick dev. The agent's bash/edit/read tools run inside the
  container. (flue-reference §6.)
- **Token scoping + tools:** GitHub App auth (`git-auth.ts`) and the permission
  profiles (`profiles.ts`) port **verbatim**; the minted scoped token is passed
  to the sandbox via `local({ env })` / E2B's `Sandbox.create({ envs })`, and to
  GitHub tools as **bound `defineTool` factories** (token + repo/owner closed
  over, never model-selected; `mcp-github-app` retired — Flue MCP is HTTP-only,
  `flue-reference §4`). Flue's security model explicitly favors **bounded
  application actions through tools** over broad sandbox capability — aligned with
  profile downscoping.
- **Web search** is **not** a built-in Flue/Pi tool. Implement `web_search`/
  `web_fetch` as **gated `defineTool`s** (Tavily › Exa › Brave) bound onto the
  `explorer` agent only, on phases that opt in. (flue-reference §6.)

## Gaps & decisions

- **⚠ EGRESS FIREWALL — no Flue analogue. DEFERRED for the current phase.** The
  custom Docker `SandboxFactory` provides **container isolation only**: this
  phase, containers run with **full network egress and no SSRF floor**. This is a
  **known, temporary, recorded risk** — the default-deny allowlist and the
  metadata-literal SSRF floor (Must-preserve invariants below) are **NOT yet
  enforced**. Do not point the sandbox at untrusted input or production
  credentials until egress is hardened.
  - **Egress hardening (required before prod, a later phase) — pick one:**
    1. **Re-host the docker firewall into the factory.** Run the container on the
       existing CoreDNS-sinkhole + nginx-SNI-peek network (`egress-allowlist.ts` +
       the metadata SSRF floor, ported verbatim). Most faithful; keeps everything
       local.
    2. **Switch the prod sandbox to E2B.** `Sandbox.create({ network: { allowOut,
       denyOut }, envs })` — default-deny + explicit `169.254.0.0/16` /
       `metadata.google.internal` in `denyOut`, fed by `egress-allowlist.ts`.
    3. Narrow capability via bounded `defineTool`s with no general egress.
  - **The SSRF floor (metadata literals) becomes non-negotiable once egress is
    turned on**, under whichever option. Record the chosen option + residual risk
    here and in `00`'s risk register when that phase lands.
- **PEM handling** — reproduce the "only `repo-write`, controlled path" wall via
  the sandbox env wiring; default agents get no PEM and an explicitly empty key
  path.
- **`none`/`gondolin`/`docker` selector** → the custom Docker `SandboxFactory`
  (with `local()` for quick dev); `gondolin` QEMU is dropped (no `/dev/kvm`
  dependency, like the Mastra port).

## Acceptance criteria

- **Phase 0 (this phase):** the custom Docker `SandboxFactory` runs `git clone` +
  a build command in an **isolated container**; `SandboxApi` file ops + `exec`
  work; container is torn down after the run. **Egress restriction is deferred**
  (full network) — documented, not tested here.
- **Egress-hardening phase (later):** an attempt to reach a non-allowlisted host
  is **blocked** under the chosen option; metadata IPs are blocked (strict AND
  open mode).
- A `read`/`issues-write` run cannot push code (token scope verified).
- The default agent has no readable PEM; only the `repo-write` agent does.
- A phase without `web_search` cannot reach search providers even with keys set.

## Source / target files

- Source: `lastlight/src/engine/{agent-executor.ts,profiles.ts,git-auth.ts}`,
  `src/sandbox/{index.ts,docker.ts,egress-allowlist.ts,egress-firewall-config.ts}`,
  `deploy/sandbox-entrypoint.sh`, `docker-compose.yml`.
- Target: `lastlight-flue/src/sandboxes/docker.ts` (custom Docker `SandboxFactory`),
  `src/engine/{git-auth.ts,profiles.ts}` (ported), `src/tools/github.ts`,
  `src/sandbox/egress-allowlist.ts` (ported now, **wired in at the egress-hardening
  phase**).
