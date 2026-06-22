/**
 * Reviewer sandbox lifecycle — the CALLER-owned container around a reviewer run.
 *
 * Per the Spike-2 contract (spec/flue-reference §0, docs/api/sandbox-api.md), the
 * sandbox ADAPTER (`docker()`) is a pure mapper and must NOT manage container
 * lifetime. This module is the CALLER: it `DockerContainer.create()`s an image with
 * git+node, bakes the scoped GIT token into the run env, pre-clones the PR repo at
 * the PR's head ref into `/workspace`, and hands a `docker(container)` factory to a
 * `body` callback. The container is ALWAYS removed in a `finally`, even on error.
 *
 * The GIT token is read-scoped (review-write profile, but the clone only reads), is
 * baked at `docker run` (never passed on a command line that gets logged), and the
 * clone URL embeds it so `git clone` over HTTPS authenticates. We NEVER log the
 * token or the tokenized URL.
 *
 * ⚠ EGRESS DEFERRED: the container has full network and no SSRF floor — the clone
 * reaches github.com over the open network. Do NOT run untrusted input through it.
 */
import { DockerContainer, docker } from "../sandboxes/docker.ts";
import type { SandboxFactory } from "@flue/runtime";

/** Image that ships node + npm + git (slim omits git, which the clone needs). */
export const REVIEWER_IMAGE = "node:22-bookworm";

/** The directory the PR is pre-cloned into (matches docker.ts WORKSPACE). */
export const REVIEWER_WORKSPACE = "/workspace";

/** Identify the PR repo + head ref to pre-clone. */
export interface ReviewerCloneSpec {
  owner: string;
  repo: string;
  /** The PR head ref (branch name) to check out, e.g. from `pulls.get().head.ref`. */
  headRef: string;
}

/** Minimal container surface this module depends on (lets tests inject a fake). */
export interface ReviewerContainer {
  /** Run a command inside the container; returns exit code + streams. */
  exec(
    command: string,
    options?: { cwd?: string; timeoutMs?: number },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  /** Tear the container down. Idempotent. */
  remove(): Promise<void>;
  /** A Flue SandboxFactory adapting this container (pure mapper). */
  sandbox(): SandboxFactory;
}

/**
 * Operations the lifecycle needs, injected so the workflow run-test can mock Docker
 * entirely. The default (`defaultReviewerSandboxOps`) wires the real `DockerContainer`.
 */
export interface ReviewerSandboxOps {
  /** Create a container with the image + baked env (incl. the scoped GIT token). */
  createContainer(opts: {
    image: string;
    env: Record<string, string>;
  }): Promise<ReviewerContainer>;
}

/** Default ops: the real Docker container + `docker()` adapter (Spike 2). */
export function defaultReviewerSandboxOps(): ReviewerSandboxOps {
  return {
    async createContainer(opts) {
      const container = await DockerContainer.create({
        image: opts.image,
        env: opts.env,
      });
      return {
        exec: (command, options) =>
          // Drive the host docker CLI through the adapter's exec path via a
          // throwaway SandboxApi would be circular; instead exec straight on the
          // container by reusing its sandbox session env's exec.
          execInContainer(container, command, options),
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
  // The `docker()` factory's SessionEnv exposes `exec`; build one and call it.
  const env = await docker(container).createSessionEnv({ id: "reviewer-clone" });
  return env.exec(command, options);
}

/** Result of a guarded reviewer-sandbox run. */
export interface ReviewerSandboxOutcome<T> {
  result: T;
  /** True when the sandbox path ran; false when it fell back to tool-only. */
  usedSandbox: boolean;
}

/**
 * Create a container, bake the token, pre-clone the PR at its head ref into
 * `/workspace`, and invoke `body(sandbox)`. The container is ALWAYS removed in a
 * `finally`. If creation or the clone fails, the error is logged (without the
 * token) and the run FALLS BACK to tool-only by invoking `body(undefined)` — the
 * sandbox is ADDITIVE (the reviewer reviewed live tool-only), so a sandbox failure
 * must not fail an otherwise-reviewable PR. Errors thrown by `body` itself
 * propagate (they are real review failures, not sandbox-provisioning failures).
 */
export async function withReviewerSandbox<T>(
  spec: ReviewerCloneSpec,
  token: string,
  body: (sandbox: SandboxFactory | undefined) => Promise<T>,
  deps: {
    ops?: ReviewerSandboxOps;
    log?: { warn(msg: string, meta?: unknown): void };
  } = {},
): Promise<ReviewerSandboxOutcome<T>> {
  const ops = deps.ops ?? defaultReviewerSandboxOps();
  let container: ReviewerContainer | undefined;
  let sandbox: SandboxFactory | undefined;

  try {
    container = await ops.createContainer({
      image: REVIEWER_IMAGE,
      // Bake the token as env so a future in-container `git`/`gh` can use it too.
      // The clone below authenticates via the tokenized URL directly.
      env: { GIT_TOKEN: token },
    });
    await preClonePr(container, spec, token);
    sandbox = container.sandbox();
  } catch (err) {
    // Provisioning/clone failure → fall back to tool-only. NEVER log the token.
    deps.log?.warn(
      "pr-review: sandbox unavailable, falling back to tool-only review",
      { owner: spec.owner, repo: spec.repo, reason: redact(String(err), token) },
    );
    sandbox = undefined;
  }

  try {
    const result = await body(sandbox);
    return { result, usedSandbox: sandbox !== undefined };
  } finally {
    if (container) await safeRemove(container, deps.log);
  }
}

/** Clone the PR repo at its head ref into `/workspace` using a tokenized URL. */
async function preClonePr(
  container: ReviewerContainer,
  spec: ReviewerCloneSpec,
  token: string,
): Promise<void> {
  // x-access-token:<token>@ authenticates a GitHub App installation token over
  // HTTPS. `--branch <headRef>` checks out the PR head; `--depth 1` is sufficient
  // for review. The tokenized URL is NEVER logged (we don't echo the command).
  const url = `https://x-access-token:${token}@github.com/${spec.owner}/${spec.repo}.git`;
  const cmd = `git clone --depth 1 --branch ${shellArg(spec.headRef)} ${shellArg(url)} ${REVIEWER_WORKSPACE}`;
  const res = await container.exec(cmd, { timeoutMs: 5 * 60_000 });
  if (res.exitCode !== 0) {
    // Strip the token from any stderr before it reaches a log/throw.
    throw new Error(`git clone failed (${res.exitCode}): ${redact(res.stderr.trim(), token)}`);
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
  container: ReviewerContainer,
  log?: { warn(msg: string, meta?: unknown): void },
): Promise<void> {
  try {
    await container.remove();
  } catch (err) {
    log?.warn("pr-review: container teardown failed", { reason: String(err) });
  }
}
