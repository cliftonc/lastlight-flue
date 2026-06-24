import { describe, it, expect, vi, afterEach } from "vitest";
import type { FlueHarness, SandboxFactory } from "@flue/runtime";
import {
  withBuildSandbox,
  withPrFixSandbox,
  closeBuildWorkspace,
  resetBuildWorkspacesForTests,
  cloneRepoIntoHarness,
  BUILD_IMAGE,
  type BuildContainer,
  type BuildSandboxOps,
} from "../build-sandbox.ts";

// Phase 4 — the build sandbox lifecycle. The workspace is now SHARED per run
// (keyed by taskId): one container + checkout, REUSED across phases, torn down by
// closeBuildWorkspace at run end (NOT per phase). The clone continues the existing
// remote branch if present. Token is never logged; a failed open never leaks.

const SANDBOX = { __fake: true } as unknown as SandboxFactory;
const SPEC = { owner: "octocat", repo: "widget", branch: "lastlight/42", taskId: "widget-42-build" };
const TOKEN = "ghs_build_test_token";

// Each test starts from a clean registry (the registry is module-level state).
afterEach(() => resetBuildWorkspacesForTests());

function makeContainer(
  opts: {
    cloneExitCode?: number;
    /** Exit code of `git rev-parse` for the remote branch. 0 = branch exists. */
    revParseExitCode?: number;
    checkoutExitCode?: number;
    stderr?: string;
  } = {},
) {
  const execCalls: string[] = [];
  let removed = 0;
  const container: BuildContainer = {
    async exec(command) {
      execCalls.push(command);
      let exitCode = 0;
      if (command.includes("git clone")) exitCode = opts.cloneExitCode ?? 0;
      else if (command.includes("git rev-parse")) exitCode = opts.revParseExitCode ?? 1; // default: no remote branch
      else if (command.includes("git checkout")) exitCode = opts.checkoutExitCode ?? 0;
      return { stdout: "", stderr: opts.stderr ?? "", exitCode };
    },
    async remove() {
      removed += 1;
    },
    sandbox: () => SANDBOX,
  };
  return { container, execCalls, removed: () => removed };
}

describe("cloneRepoIntoHarness — post-clone dependency install (installDeps)", () => {
  /** A fake harness recording every shell command; clone/checkout succeed by default. */
  function fakeHarness(opts: { installExitCode?: number } = {}) {
    const shellCalls: { command: string; env?: Record<string, string> }[] = [];
    const harness = {
      async shell(command: string, options?: { env?: Record<string, string> }) {
        shellCalls.push({ command, env: options?.env });
        // The install script enables corepack + runs the PM install; let the caller
        // pick its exit code, everything else succeeds.
        const isInstall = command.includes("corepack enable");
        return {
          stdout: "",
          stderr: isInstall ? "boom" : "",
          exitCode: isInstall ? (opts.installExitCode ?? 0) : 0,
        };
      },
    } as unknown as FlueHarness;
    return { harness, shellCalls };
  }

  const SPEC_BASE = { owner: "octocat", repo: "widget", branch: "lastlight/42" };

  it("runs corepack + a lockfile-aware install when installDeps is set", async () => {
    const fh = fakeHarness();
    await cloneRepoIntoHarness(fh.harness, { ...SPEC_BASE, installDeps: true }, TOKEN);

    const install = fh.shellCalls.find((c) => c.command.includes("corepack enable"));
    expect(install).toBeDefined();
    expect(install!.command).toContain("pnpm install --frozen-lockfile");
    expect(install!.command).toContain("yarn install --immutable");
    expect(install!.command).toContain("npm ci");
    // The corepack download prompt is suppressed so the install can't hang.
    expect(install!.env).toMatchObject({ COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" });
  });

  it("does NOT install when installDeps is unset (read-only clone)", async () => {
    const fh = fakeHarness();
    await cloneRepoIntoHarness(fh.harness, { ...SPEC_BASE }, TOKEN);
    expect(fh.shellCalls.some((c) => c.command.includes("corepack enable"))).toBe(false);
  });

  it("a failed install does NOT throw — the clone still completes (best-effort)", async () => {
    const fh = fakeHarness({ installExitCode: 1 });
    await expect(
      cloneRepoIntoHarness(fh.harness, { ...SPEC_BASE, installDeps: true }, TOKEN),
    ).resolves.toBeUndefined();
  });
});

describe("withBuildSandbox — shared per-run workspace (created once, reused, closed at run end)", () => {
  it("creates the container (named + labelled, baked token), clones, checks out -B the branch, yields the sandbox, and REGISTERS it (no per-call removal)", async () => {
    const c = makeContainer();
    const createContainer = vi.fn(async () => c.container);
    const ops: BuildSandboxOps = { createContainer };

    let seen: SandboxFactory | undefined;
    const result = await withBuildSandbox(
      SPEC,
      TOKEN,
      async (sandbox) => {
        seen = sandbox;
        return "plan-text";
      },
      { ops },
    );

    expect(result).toBe("plan-text");
    expect(seen).toBe(SANDBOX);
    // Token baked as env (never on a logged command line); named + labelled for cleanup.
    expect(createContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        image: BUILD_IMAGE,
        env: { GIT_TOKEN: TOKEN },
        name: expect.stringContaining("lastlight-build-"),
        labels: { app: "lastlight", taskId: SPEC.taskId },
      }),
    );
    const clone = c.execCalls.find((x) => x.includes("git clone"))!;
    expect(clone).toContain("/workspace");
    // No remote branch (rev-parse fails by default) → fresh -B from default.
    const checkout = c.execCalls.find((x) => x.includes("git checkout -B"))!;
    expect(checkout).toContain("'lastlight/42'");
    expect(checkout).not.toContain("origin/lastlight/42");
    // NOT removed per call — the run owns teardown.
    expect(c.removed()).toBe(0);

    // closeBuildWorkspace tears it down.
    await closeBuildWorkspace(SPEC.taskId);
    expect(c.removed()).toBe(1);
  });

  it("REUSES the container for the same taskId — no 2nd create, no 2nd clone", async () => {
    const c = makeContainer();
    const createContainer = vi.fn(async () => c.container);
    const ops: BuildSandboxOps = { createContainer };

    await withBuildSandbox(SPEC, TOKEN, async () => "a", { ops });
    await withBuildSandbox(SPEC, TOKEN, async () => "b", { ops });

    expect(createContainer).toHaveBeenCalledTimes(1);
    expect(c.execCalls.filter((x) => x.includes("git clone")).length).toBe(1);
  });

  it("CONTINUES an existing remote branch (checkout -B <branch> origin/<branch>)", async () => {
    const c = makeContainer({ revParseExitCode: 0 }); // remote branch exists
    const ops: BuildSandboxOps = { createContainer: vi.fn(async () => c.container) };

    await withBuildSandbox(SPEC, TOKEN, async () => "x", { ops });

    const checkout = c.execCalls.find((x) => x.includes("git checkout -B"))!;
    expect(checkout).toContain("'lastlight/42'");
    expect(checkout).toContain("'origin/lastlight/42'");
  });

  it("clone failure THROWS (token-redacted), removes the half-created container, and does NOT register", async () => {
    const c = makeContainer({
      cloneExitCode: 128,
      stderr: `auth https://x-access-token:${TOKEN}@github.com failed`,
    });
    const createContainer = vi.fn(async () => c.container);
    const ops: BuildSandboxOps = { createContainer };

    await expect(
      withBuildSandbox(SPEC, TOKEN, async () => "unreached", { ops }),
    ).rejects.toThrow(/git clone failed/);
    // The failed container is removed, and nothing is registered.
    expect(c.removed()).toBe(1);
    await closeBuildWorkspace(SPEC.taskId);
    expect(c.removed()).toBe(1); // no-op — nothing was registered

    // Token never leaked in the error message.
    await withBuildSandbox(SPEC, TOKEN, async () => "x", { ops }).catch((err) => {
      expect(String(err)).not.toContain(TOKEN);
      expect(String(err)).toContain("<redacted-token>");
    });
  });

  it("checkout failure THROWS (token-redacted) and removes the half-created container", async () => {
    const c = makeContainer({ checkoutExitCode: 1, stderr: `fatal something ${TOKEN}` });
    const ops: BuildSandboxOps = { createContainer: vi.fn(async () => c.container) };
    await expect(
      withBuildSandbox(SPEC, TOKEN, async () => "x", { ops }),
    ).rejects.toThrow(/git checkout -B/);
    expect(c.removed()).toBe(1);
  });

  it("createContainer failure propagates; nothing registered", async () => {
    const createContainer = vi.fn(async () => {
      throw new Error("docker: cannot connect");
    });
    await expect(
      withBuildSandbox(SPEC, TOKEN, async () => "x", { ops: { createContainer } }),
    ).rejects.toThrow("docker: cannot connect");
  });

  it("body throw propagates BUT the container is KEPT (not removed) — closeBuildWorkspace removes it", async () => {
    const c = makeContainer();
    const ops: BuildSandboxOps = { createContainer: vi.fn(async () => c.container) };
    await expect(
      withBuildSandbox(SPEC, TOKEN, async () => {
        throw new Error("architect boom");
      }, { ops }),
    ).rejects.toThrow("architect boom");
    // Kept alive for the next phase / explicit teardown.
    expect(c.removed()).toBe(0);
    await closeBuildWorkspace(SPEC.taskId);
    expect(c.removed()).toBe(1);
  });

  it("closeBuildWorkspace is a no-op for an unknown taskId", async () => {
    await expect(closeBuildWorkspace("never-opened")).resolves.toBeUndefined();
  });
});

// pr-fix variant: clone + check out the EXISTING PR head branch (NOT `checkout -B`),
// SINGLE-phase so it keeps the simple per-call create + remove-in-finally contract.
const PR_SPEC = { owner: "octocat", repo: "widget", headRef: "feature/login" };

describe("withPrFixSandbox — pre-clone the EXISTING PR head branch (single-phase, per-call lifetime)", () => {
  it("clones --branch <headRef> (not -B), yields sandbox+container, removes in finally", async () => {
    const c = makeContainer();
    const createContainer = vi.fn(async () => c.container);
    const ops: BuildSandboxOps = { createContainer };

    let seenSandbox: SandboxFactory | undefined;
    let seenContainer: BuildContainer | undefined;
    const out = await withPrFixSandbox(
      PR_SPEC,
      TOKEN,
      async (sandbox, container) => {
        seenSandbox = sandbox;
        seenContainer = container;
        return "fixed";
      },
      { ops },
    );

    expect(out).toBe("fixed");
    expect(seenSandbox).toBe(SANDBOX);
    expect(seenContainer).toBe(c.container);
    expect(createContainer).toHaveBeenCalledWith(
      expect.objectContaining({ image: BUILD_IMAGE, env: { GIT_TOKEN: TOKEN } }),
    );
    const clone = c.execCalls.find((x) => x.includes("git clone"))!;
    expect(clone).toContain("--branch 'feature/login'");
    expect(c.execCalls.some((x) => x.includes("git checkout -B"))).toBe(false);
    expect(c.removed()).toBe(1);
  });

  it("clone failure THROWS (no tool-only fallback) — token-redacted — still removed", async () => {
    const c = makeContainer({
      cloneExitCode: 128,
      stderr: `auth https://x-access-token:${TOKEN}@github.com failed`,
    });
    const ops: BuildSandboxOps = { createContainer: vi.fn(async () => c.container) };
    await withPrFixSandbox(PR_SPEC, TOKEN, async () => "x", { ops }).catch((err) => {
      expect(String(err)).toMatch(/git clone --branch feature\/login failed/);
      expect(String(err)).not.toContain(TOKEN);
      expect(String(err)).toContain("<redacted-token>");
    });
    expect(c.removed()).toBeGreaterThanOrEqual(1);
  });

  it("body throw propagates BUT container is removed in finally", async () => {
    const c = makeContainer();
    const ops: BuildSandboxOps = { createContainer: vi.fn(async () => c.container) };
    await expect(
      withPrFixSandbox(PR_SPEC, TOKEN, async () => {
        throw new Error("fix boom");
      }, { ops }),
    ).rejects.toThrow("fix boom");
    expect(c.removed()).toBe(1);
  });
});
