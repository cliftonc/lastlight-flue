/**
 * Build sandbox lifecycle — ONE shared workspace per run, reused across phases.
 *
 * Mirrors the original Last Light model (spec/06-workflow-engine.md: "`taskId`
 * scopes one persistent sandbox workspace across phases" — the executor reads the
 * architect's plan "from the same checkout"). A build is several phases
 * (guardrails → architect → executor → reviewer loop), and they MUST operate on
 * the SAME checkout: each phase commits onto the working branch and the next
 * builds on top. So the container + clone is created ONCE per `taskId` (a tiny
 * in-process registry) and REUSED by every phase; it is torn down by
 * `closeBuildWorkspace(taskId)` at the end of the run (build.ts / explore.ts
 * `run()` finally), NOT per phase.
 *
 * WHY (regression fixed): the prior version called `withBuildSandbox` per phase,
 * each time spinning a fresh container + `git clone` + `git checkout -B <branch>`
 * from the DEFAULT branch — discarding the prior phase's commit (which lives only
 * on the remote branch) and leaking one unnamed container per phase. That caused
 * non-fast-forward push failures in the executor and a pile of orphaned
 * containers. Now: one container per run, and the clone CONTINUES the existing
 * remote branch if present.
 *
 * The repo-write token is baked at `docker run` (never on a logged command line),
 * the clone URL embeds it for HTTPS auth, and we NEVER log the token or the
 * tokenized URL (we redact it out of any stderr before throwing/logging).
 *
 * CONTAINER HYGIENE: every container is named `lastlight-build-<taskId>-<t>` and
 * labelled `app=lastlight`, so leaks are identifiable. A process exit/signal
 * handler force-removes tracked containers on a clean shutdown, and
 * `reapStaleBuildContainers()` (called at server boot) sweeps stragglers left by
 * a hard kill (SIGKILL skips the handler).
 *
 * ⚠ EGRESS DEFERRED: the container has full network + no SSRF floor — the clone
 * reaches github.com over the open network. Do NOT run untrusted input through it.
 */
import { spawn, spawnSync } from "node:child_process";
import { DockerContainer, docker } from "../sandboxes/docker.ts";
import type { FlueHarness, SandboxFactory } from "@flue/runtime";

/** Image that ships node + npm + git (slim omits git, which the clone needs). */
export const BUILD_IMAGE = "node:22-bookworm";

/** The directory the repo is pre-cloned into (matches docker.ts WORKSPACE). */
export const BUILD_WORKSPACE = "/workspace";

/** Docker label applied to every build container (for cleanup/identification). */
export const BUILD_CONTAINER_LABEL = "app=lastlight";

// ── beta.3 harness-owned clone (Option A) ─────────────────────────────────────
//
// In beta.3 the HARNESS owns the sandbox (the agent declares `sandbox:
// dockerSandbox()`, so Flue stands an empty container up at init). The workflow
// `run()` then populates `/workspace` here via `harness.shell`, the documented
// per-input pattern. This REPLACES the beta.2 `withBuildSandbox`/`withPrFixSandbox`
// flow (which created the container in the workflow and passed it to the agent —
// impossible now that the agent is static and pre-initialized). The token is
// passed as a shell ENV VAR referenced as `"$REPO_URL"`, so it never appears in
// argv/logs; for read-only flows that never push, `scrubRemote` strips the token
// from `.git/config` after cloning.

/** Repo + branch to clone into the harness sandbox's `/workspace`. */
export interface HarnessCloneSpec {
  owner: string;
  repo: string;
  /** Working branch — continued from its remote tip if it exists, else created with `-B`. */
  branch: string;
  /** Strip the tokenized remote after clone (read-only flows that never push). */
  scrubRemote?: boolean;
  /**
   * Install dependencies after checkout so the agent lands in a READY repo
   * (`node_modules/.bin` populated). Build opts in — its executor runs the repo's
   * build/test/typecheck gate, which needs deps installed; without this the executor
   * hit `tsc: not found` and flailed until the run timed out. Read-only flows
   * (explore/security-review) leave it off. Best-effort: a failed install warns and
   * continues (the env may be incomplete) rather than aborting the clone.
   */
  installDeps?: boolean;
}

/** Wall-clock cap for the post-clone dependency install (kept well under the run cap). */
const DEP_INSTALL_TIMEOUT_MS = 8 * 60_000;

/**
 * Install JS dependencies in the harness `/workspace` after checkout. Enables
 * `corepack` (so the repo's pinned pnpm/yarn from `packageManager` is on PATH — the
 * base `node:*` image ships only npm), then installs with the package manager implied
 * by the lockfile (frozen for reproducibility, falling back to a normal install if the
 * lockfile is out of sync). Best-effort: a non-zero exit WARNS (it does not throw) so a
 * registry hiccup or a depless repo never aborts a build before the agent runs.
 */
export async function installDepsInHarness(
  harness: FlueHarness,
  log?: { warn(msg: string, meta?: unknown): void },
): Promise<void> {
  // `corepack enable` activates the pinned pnpm/yarn; COREPACK_ENABLE_DOWNLOAD_PROMPT=0
  // suppresses the first-run download prompt. Detection is lockfile-first (matches what
  // the repo actually committed); `--frozen`/`ci` keep the install reproducible, with a
  // plain install fallback so a stale lockfile degrades instead of hard-failing.
  const script = [
    'corepack enable >/dev/null 2>&1 || true',
    'if [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile || pnpm install',
    'elif [ -f yarn.lock ]; then yarn install --immutable || yarn install',
    'elif [ -f package-lock.json ]; then npm ci || npm install',
    'elif [ -f package.json ]; then npm install',
    'else echo "lastlight: no package.json in /workspace — skipping dependency install"',
    'fi',
  ].join('\n');
  let res: { exitCode: number; stderr: string };
  try {
    res = await harness.shell(script, {
      cwd: BUILD_WORKSPACE,
      env: { COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' },
      timeoutMs: DEP_INSTALL_TIMEOUT_MS,
    });
  } catch (err) {
    log?.warn('build: dependency install errored (continuing; env may be incomplete)', {
      reason: String(err),
    });
    return;
  }
  if (res.exitCode !== 0) {
    log?.warn('build: dependency install failed (continuing; env may be incomplete)', {
      exitCode: res.exitCode,
      stderr: res.stderr.slice(-800),
    });
  }
}

/**
 * Clone `spec` into the harness sandbox at `/workspace` and check out `spec.branch`
 * (continuing its remote tip if present). The scoped token is passed ONLY as the
 * `REPO_URL` env var (referenced as `"$REPO_URL"`), so it is never in argv or logs;
 * errors are token-redacted. Throws on clone/checkout failure (sandboxed flows need
 * the workspace — no fallback). Reused by build / explore / security-review.
 */
export async function cloneRepoIntoHarness(
  harness: FlueHarness,
  spec: HarnessCloneSpec,
  token: string,
): Promise<void> {
  const repoUrl = `https://x-access-token:${token}@github.com/${spec.owner}/${spec.repo}.git`;
  // `"$REPO_URL"` expands inside `sh -lc`; the token lives only in env, not argv.
  const clone = await harness.shell(`git clone "$REPO_URL" ${BUILD_WORKSPACE}`, {
    env: { REPO_URL: repoUrl },
  });
  if (clone.exitCode !== 0) {
    throw new Error(`git clone failed (${clone.exitCode}): ${redact(clone.stderr.trim(), token)}`);
  }
  // Continue the working branch from its remote tip if it exists; else create fresh.
  const remoteRef = `refs/remotes/origin/${spec.branch}`;
  const exists = await harness.shell(`git rev-parse --verify --quiet ${shellArg(remoteRef)}`, {
    cwd: BUILD_WORKSPACE,
  });
  const checkoutCmd =
    exists.exitCode === 0
      ? `git checkout -B ${shellArg(spec.branch)} ${shellArg(`origin/${spec.branch}`)}`
      : `git checkout -B ${shellArg(spec.branch)}`;
  const checkout = await harness.shell(checkoutCmd, { cwd: BUILD_WORKSPACE });
  if (checkout.exitCode !== 0) {
    throw new Error(
      `git checkout -B ${spec.branch} failed (${checkout.exitCode}): ${redact(checkout.stderr.trim(), token)}`,
    );
  }
  if (spec.scrubRemote) {
    // Read-only flow: remove the token from the persisted remote URL.
    const tokenless = `https://github.com/${spec.owner}/${spec.repo}.git`;
    await harness.shell(`git remote set-url origin ${shellArg(tokenless)}`, { cwd: BUILD_WORKSPACE });
  }
  if (spec.installDeps) {
    // Land the agent in a READY repo (deps installed). Best-effort — never aborts the clone.
    await installDepsInHarness(harness);
  }
}

/** Identify the repo + working branch + the run this workspace belongs to. */
export interface BuildCloneSpec {
  owner: string;
  repo: string;
  /** The build working branch — continued from its remote tip if it exists. */
  branch: string;
  /** The run key the workspace is scoped to (one shared container per taskId). */
  taskId: string;
}

/** Minimal container surface this module depends on (lets tests inject a fake). */
export interface BuildContainer {
  exec(
    command: string,
    options?: { cwd?: string; timeoutMs?: number },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  /** Tear the container down. Idempotent. */
  remove(): Promise<void>;
  /** A Flue SandboxFactory adapting this container (pure mapper). */
  sandbox(): SandboxFactory;
  /** Docker container id, when known — used for synchronous exit-time cleanup. */
  id?: string;
}

/** Container-provisioning ops, injected so tests mock Docker entirely. */
export interface BuildSandboxOps {
  createContainer(opts: {
    image: string;
    env: Record<string, string>;
    name?: string;
    labels?: Record<string, string>;
  }): Promise<BuildContainer>;
}

/** Default ops: the real Docker container + `docker()` adapter (Spike 2). */
export function defaultBuildSandboxOps(): BuildSandboxOps {
  return {
    async createContainer(opts) {
      const container = await DockerContainer.create({
        image: opts.image,
        env: opts.env,
        name: opts.name,
        labels: opts.labels,
      });
      return {
        id: container.id,
        exec: (command, options) => execInContainer(container, command, options),
        remove: () => container.remove(),
        sandbox: () => docker(container),
      };
    },
  };
}

/** Run a command in a real `DockerContainer` via its `docker()` session env. */
async function execInContainer(
  container: DockerContainer,
  command: string,
  options?: { cwd?: string; timeoutMs?: number },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const env = await docker(container).createSessionEnv({ id: "build-clone" });
  return env.exec(command, options);
}

// ── Per-run workspace registry (one shared container per taskId) ───────────────

/** Live workspaces in THIS process, keyed by taskId. */
const workspaces = new Map<string, BuildContainer>();

/** Sanitize a taskId into a docker-name-safe segment. */
function sanitizeName(s: string): string {
  return s.replace(/[^a-zA-Z0-9_.-]+/g, "-").slice(0, 100) || "run";
}

/**
 * Get-or-create the shared workspace container for `spec.taskId`, then run
 * `body(sandbox, container)` over it. The FIRST call for a taskId creates the
 * container + clones (continuing the existing remote branch); later calls REUSE
 * it (no new container, no re-clone), so every phase shares one checkout. The
 * container is NOT removed here — `closeBuildWorkspace(taskId)` owns teardown at
 * run end. A provisioning/clone failure THROWS (no tool-only fallback; the build
 * needs the workspace) — token-redacted — and the half-created container is
 * removed so a failed open never leaks.
 */
export async function withBuildSandbox<T>(
  spec: BuildCloneSpec,
  token: string,
  body: (sandbox: SandboxFactory, container: BuildContainer) => Promise<T>,
  deps: {
    ops?: BuildSandboxOps;
    log?: { warn(msg: string, meta?: unknown): void };
  } = {},
): Promise<T> {
  const ops = deps.ops ?? defaultBuildSandboxOps();

  let container = workspaces.get(spec.taskId);
  if (!container) {
    const created = await ops.createContainer({
      image: BUILD_IMAGE,
      // Bake the token as env so in-container `git push`/`gh` can use it too.
      env: { GIT_TOKEN: token },
      name: `lastlight-build-${sanitizeName(spec.taskId)}-${Date.now().toString(36)}`,
      labels: { app: "lastlight", taskId: spec.taskId },
    });
    try {
      await preCloneRepo(created, spec, token);
    } catch (err) {
      // A failed open must not leak the container or register a broken workspace.
      await safeRemove(created, deps.log);
      throw err;
    }
    container = created;
    workspaces.set(spec.taskId, container);
    ensureExitCleanup();
  }

  const sandbox = container.sandbox();
  // The container is handed to the body too (after the agent session) so the
  // workflow can run deterministic git steps — e.g. the executor's branch PUSH —
  // over the same checkout via the sandbox git CLI (not a model tool).
  return body(sandbox, container);
}

/**
 * Tear down the shared workspace container for `taskId`. Idempotent +
 * best-effort: a teardown error is swallowed (logged) so it never masks a real
 * phase result. Call this in the workflow's `run()` finally.
 */
export async function closeBuildWorkspace(
  taskId: string,
  log?: { warn(msg: string, meta?: unknown): void },
): Promise<void> {
  const container = workspaces.get(taskId);
  if (!container) return;
  workspaces.delete(taskId);
  await safeRemove(container, log);
}

/** Drop all registered workspaces WITHOUT touching Docker — test isolation only. */
export function resetBuildWorkspacesForTests(): void {
  workspaces.clear();
}

/**
 * The pr-fix variant: pre-clone the repo and check out an EXISTING PR head branch
 * (NOT `checkout -B`). pr-fix is a SINGLE-phase workflow, so it does NOT share a
 * workspace — it keeps the simple caller-owns-lifetime contract: create here,
 * ALWAYS `remove()` in a `finally`. The `headRef` is workflow-resolved
 * (`pulls.get().head.ref`), never model-chosen.
 *
 * ⚠ EGRESS DEFERRED: the container has full network + no SSRF floor — do not run
 * untrusted input through it.
 */
export async function withPrFixSandbox<T>(
  spec: { owner: string; repo: string; headRef: string },
  token: string,
  body: (sandbox: SandboxFactory, container: BuildContainer) => Promise<T>,
  deps: {
    ops?: BuildSandboxOps;
    log?: { warn(msg: string, meta?: unknown): void };
  } = {},
): Promise<T> {
  const ops = deps.ops ?? defaultBuildSandboxOps();
  let container: BuildContainer | undefined;

  try {
    container = await ops.createContainer({
      image: BUILD_IMAGE,
      env: { GIT_TOKEN: token },
      name: `lastlight-prfix-${sanitizeName(spec.headRef)}-${Date.now().toString(36)}`,
      labels: { app: "lastlight" },
    });
    await preCloneHeadBranch(container, spec, token);
    const sandbox = container.sandbox();
    return await body(sandbox, container);
  } finally {
    if (container) await safeRemove(container, deps.log);
  }
}

/** Clone the repo at the EXISTING PR head branch into `/workspace`. */
async function preCloneHeadBranch(
  container: BuildContainer,
  spec: { owner: string; repo: string; headRef: string },
  token: string,
): Promise<void> {
  // x-access-token:<token>@ authenticates a GitHub App installation token over
  // HTTPS. `--branch <headRef>` checks out the PR's existing head branch so the fix
  // commits land on it; a FULL clone (not --depth 1) so `git push origin <branch>`
  // is fast-forwardable. The tokenized URL is NEVER logged (we don't echo it).
  const url = `https://x-access-token:${token}@github.com/${spec.owner}/${spec.repo}.git`;
  const clone = await container.exec(
    `git clone --branch ${shellArg(spec.headRef)} ${shellArg(url)} ${BUILD_WORKSPACE}`,
    { timeoutMs: 10 * 60_000 },
  );
  if (clone.exitCode !== 0) {
    throw new Error(
      `git clone --branch ${spec.headRef} failed (${clone.exitCode}): ${redact(clone.stderr.trim(), token)}`,
    );
  }
}

/**
 * Clone the repo into `/workspace` and check out the build working branch,
 * CONTINUING it from its remote tip if it already exists (so a later phase /
 * resume builds on the prior phase's commit instead of resetting to the default
 * branch). A brand-new branch is created from the default branch with `-B`.
 */
async function preCloneRepo(
  container: BuildContainer,
  spec: BuildCloneSpec,
  token: string,
): Promise<void> {
  // x-access-token:<token>@ authenticates a GitHub App installation token over
  // HTTPS. The tokenized URL is NEVER logged (we don't echo the command). Full
  // clone (not --depth 1) so the architect can read history if needed and the
  // executor can commit/push the working branch.
  const url = `https://x-access-token:${token}@github.com/${spec.owner}/${spec.repo}.git`;
  const clone = await container.exec(
    `git clone ${shellArg(url)} ${BUILD_WORKSPACE}`,
    { timeoutMs: 10 * 60_000 },
  );
  if (clone.exitCode !== 0) {
    throw new Error(`git clone failed (${clone.exitCode}): ${redact(clone.stderr.trim(), token)}`);
  }
  // Continue the working branch from its remote tip if it exists; otherwise create
  // it fresh from the default branch. `git clone` already fetched all remote heads,
  // so `refs/remotes/origin/<branch>` is present iff the remote branch exists.
  const remoteRef = `refs/remotes/origin/${spec.branch}`;
  const exists = await container.exec(
    `git rev-parse --verify --quiet ${shellArg(remoteRef)}`,
    { cwd: BUILD_WORKSPACE, timeoutMs: 60_000 },
  );
  const checkoutCmd =
    exists.exitCode === 0
      ? `git checkout -B ${shellArg(spec.branch)} ${shellArg(`origin/${spec.branch}`)}`
      : `git checkout -B ${shellArg(spec.branch)}`;
  const checkout = await container.exec(checkoutCmd, {
    cwd: BUILD_WORKSPACE,
    timeoutMs: 60_000,
  });
  if (checkout.exitCode !== 0) {
    throw new Error(
      `git checkout -B ${spec.branch} failed (${checkout.exitCode}): ${redact(checkout.stderr.trim(), token)}`,
    );
  }
}

/** Single-quote for safe `sh -c` interpolation (matches docker.ts shq). */
function shellArg(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Replace any occurrence of the token in a string with a redaction marker. */
function redact(s: string, token: string): string {
  if (!token) return s;
  return s.split(token).join("<redacted-token>");
}

/** Remove the container, swallowing teardown errors after logging them. */
async function safeRemove(
  container: BuildContainer,
  log?: { warn(msg: string, meta?: unknown): void },
): Promise<void> {
  try {
    await container.remove();
  } catch (err) {
    log?.warn("build: container teardown failed", { reason: String(err) });
  }
}

// ── Container hygiene: exit-time cleanup + stale reaper ────────────────────────

let exitCleanupArmed = false;

/**
 * Arm a process `'exit'` handler (once) that SYNCHRONOUSLY force-removes any
 * still-registered containers — the last-resort net for a workspace that wasn't
 * closed via `closeBuildWorkspace` (a crash/interrupt before `run()`'s finally).
 *
 * Only `'exit'` is hooked — deliberately NOT SIGINT/SIGTERM: this app's signal
 * handling is owned by Flue's generated entry, and app.ts's own handlers are
 * ADDITIVE and never call `process.exit` (Flue owns exit ordering — see app.ts).
 * A signal-driven shutdown still ends with `process.exit`, which fires `'exit'`,
 * so this net runs then too — without us racing Flue's agent/db teardown. SIGKILL
 * can't be caught at all; those leaks are swept by `reapStaleBuildContainers` at
 * the next boot. Skipped under VITEST so the runner's lifecycle is untouched.
 */
function ensureExitCleanup(): void {
  if (exitCleanupArmed || process.env.VITEST) return;
  exitCleanupArmed = true;

  process.once("exit", () => {
    const ids = [...workspaces.values()]
      .map((c) => c.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    workspaces.clear();
    if (ids.length === 0) return;
    try {
      spawnSync("docker", ["rm", "-f", ...ids], { stdio: "ignore", timeout: 30_000 });
    } catch {
      /* best-effort — nothing useful to do during shutdown */
    }
  });
}

/** Run the host `docker` CLI, resolving stdout/exit code. Best-effort (never rejects). */
function dockerCli(args: string[], timeoutMs = 30_000): Promise<{ stdout: string; exitCode: number }> {
  return new Promise((resolve) => {
    try {
      const child = spawn("docker", args, { stdio: ["ignore", "pipe", "ignore"] });
      const out: Buffer[] = [];
      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      child.stdout.on("data", (d: Buffer) => out.push(d));
      child.on("error", () => {
        clearTimeout(timer);
        resolve({ stdout: "", exitCode: 1 });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ stdout: Buffer.concat(out).toString("utf8"), exitCode: code ?? 1 });
      });
    } catch {
      resolve({ stdout: "", exitCode: 1 });
    }
  });
}

/**
 * Sweep stale `app=lastlight` build containers older than `maxAgeMs` (default 2h).
 * Catches leaks from a hard kill (SIGKILL) that skipped the exit handler. Fully
 * best-effort + non-fatal: any docker error is swallowed. Run at server boot.
 */
export async function reapStaleBuildContainers(maxAgeMs = 2 * 60 * 60_000): Promise<number> {
  let reaped = 0;
  try {
    const list = await dockerCli([
      "ps",
      "-aq",
      "--filter",
      `label=${BUILD_CONTAINER_LABEL}`,
    ]);
    if (list.exitCode !== 0) return 0;
    const ids = list.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
    const now = Date.now();
    for (const id of ids) {
      const insp = await dockerCli(["inspect", "-f", "{{.State.StartedAt}}", id]);
      const startedAt = Date.parse(insp.stdout.trim());
      // If we can't read the age, treat it as stale (a leak worth removing).
      const age = Number.isNaN(startedAt) ? Infinity : now - startedAt;
      if (age > maxAgeMs) {
        const rm = await dockerCli(["rm", "-f", id]);
        if (rm.exitCode === 0) reaped += 1;
      }
    }
  } catch {
    /* best-effort — never throw at boot */
  }
  return reaped;
}
