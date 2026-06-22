/**
 * Build sandbox lifecycle — the CALLER-owned container around a build phase.
 *
 * Mirrors `reviewer-sandbox.ts` (the Spike-2 caller-owns-lifetime contract:
 * spec/flue-reference §0, docs/api/sandbox-api.md). The sandbox ADAPTER
 * (`docker()`) is a pure mapper and must NOT manage container lifetime; THIS
 * module is the caller: it `DockerContainer.create()`s a node+git image with the
 * scoped repo-write token baked as env, PRE-CLONES the repo into `/workspace`,
 * checks out (creating if absent) the build working branch, hands a
 * `docker(container)` factory to a `body` callback, and ALWAYS `remove()`s the
 * container in a `finally` — even on error.
 *
 * DIFFERENCE FROM the reviewer sandbox: the architect (and later executor/fix)
 * REQUIRES the workspace — it writes + commits `architect-plan.md` there. So
 * there is NO tool-only fallback: a provisioning/clone failure THROWS (the build
 * phase genuinely can't proceed), unlike the reviewer where the sandbox is
 * additive. The build branch may not exist yet → we clone the default branch and
 * `checkout -B <branch>` so a fresh build starts from a clean working branch.
 *
 * The repo-write token is baked at `docker run` (never on a logged command line),
 * the clone URL embeds it for HTTPS auth, and we NEVER log the token or the
 * tokenized URL (we redact it out of any stderr before throwing/logging).
 *
 * ⚠ EGRESS DEFERRED: the container has full network + no SSRF floor — the clone
 * reaches github.com over the open network. Do NOT run untrusted input through it.
 */
import { DockerContainer, docker } from "../sandboxes/docker.ts";
import type { SandboxFactory } from "@flue/runtime";

/** Image that ships node + npm + git (slim omits git, which the clone needs). */
export const BUILD_IMAGE = "node:22-bookworm";

/** The directory the repo is pre-cloned into (matches docker.ts WORKSPACE). */
export const BUILD_WORKSPACE = "/workspace";

/** Identify the repo + working branch to pre-clone + check out. */
export interface BuildCloneSpec {
  owner: string;
  repo: string;
  /** The build working branch to checkout -B (created from the default branch). */
  branch: string;
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
}

/** Container-provisioning ops, injected so tests mock Docker entirely. */
export interface BuildSandboxOps {
  createContainer(opts: {
    image: string;
    env: Record<string, string>;
  }): Promise<BuildContainer>;
}

/** Default ops: the real Docker container + `docker()` adapter (Spike 2). */
export function defaultBuildSandboxOps(): BuildSandboxOps {
  return {
    async createContainer(opts) {
      const container = await DockerContainer.create({ image: opts.image, env: opts.env });
      return {
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

/**
 * Create a container, bake the token, pre-clone the repo into `/workspace`, check
 * out (creating if absent) the build working branch, and invoke `body(sandbox)`.
 * The container is ALWAYS removed in a `finally`. Provisioning/clone failure
 * THROWS (the build phase needs the workspace; there is NO tool-only fallback) —
 * the error message is token-redacted. `body`'s own throws propagate (real phase
 * failures), but the container is still torn down.
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
  let container: BuildContainer | undefined;

  try {
    container = await ops.createContainer({
      image: BUILD_IMAGE,
      // Bake the token as env so in-container `git push`/`gh` can use it too.
      env: { GIT_TOKEN: token },
    });
    await preCloneRepo(container, spec, token);
    const sandbox = container.sandbox();
    // The container is handed to the body too (after the agent session) so the
    // workflow can run deterministic git steps — e.g. the executor's branch PUSH —
    // over the same checkout via the sandbox git CLI (not a model tool).
    return await body(sandbox, container);
  } finally {
    if (container) await safeRemove(container, deps.log);
  }
}

/** Clone the repo into `/workspace` and checkout -B the working branch. */
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
  // Check out (or create) the build working branch from the default branch.
  const checkout = await container.exec(
    `git checkout -B ${shellArg(spec.branch)}`,
    { cwd: BUILD_WORKSPACE, timeoutMs: 60_000 },
  );
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
