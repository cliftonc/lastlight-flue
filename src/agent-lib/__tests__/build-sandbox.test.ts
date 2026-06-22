import { describe, it, expect, vi } from "vitest";
import type { SandboxFactory } from "@flue/runtime";
import {
  withBuildSandbox,
  withPrFixSandbox,
  BUILD_IMAGE,
  type BuildContainer,
  type BuildSandboxOps,
} from "../build-sandbox.ts";

// Phase 4 — the build sandbox lifecycle: caller-owned container, pre-clone +
// checkout of the working branch, ALWAYS torn down, token never logged, and (unlike
// the additive reviewer sandbox) NO tool-only fallback — a clone failure THROWS.

const SANDBOX = { __fake: true } as unknown as SandboxFactory;
const SPEC = { owner: "octocat", repo: "widget", branch: "lastlight/42" };
const TOKEN = "ghs_build_test_token";

function makeContainer(
  opts: { cloneExitCode?: number; checkoutExitCode?: number; stderr?: string } = {},
) {
  const execCalls: string[] = [];
  let removed = 0;
  const container: BuildContainer = {
    async exec(command) {
      execCalls.push(command);
      const isClone = command.includes("git clone");
      const exitCode = isClone
        ? opts.cloneExitCode ?? 0
        : opts.checkoutExitCode ?? 0;
      return { stdout: "", stderr: opts.stderr ?? "", exitCode };
    },
    async remove() {
      removed += 1;
    },
    sandbox: () => SANDBOX,
  };
  return { container, execCalls, removed: () => removed };
}

describe("withBuildSandbox — caller-owned lifetime + pre-clone", () => {
  it("creates the container w/ baked token, clones, checks out -B the branch, yields the sandbox, removes in finally", async () => {
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
    // Token baked as env, never on a logged command line.
    expect(createContainer).toHaveBeenCalledWith({
      image: BUILD_IMAGE,
      env: { GIT_TOKEN: TOKEN },
    });
    const clone = c.execCalls.find((x) => x.includes("git clone"))!;
    expect(clone).toContain("/workspace");
    const checkout = c.execCalls.find((x) => x.includes("git checkout -B"))!;
    expect(checkout).toContain("'lastlight/42'");
    expect(c.removed()).toBe(1);
  });

  it("clone failure THROWS (no tool-only fallback) — token-redacted — container still removed", async () => {
    const c = makeContainer({
      cloneExitCode: 128,
      stderr: `auth https://x-access-token:${TOKEN}@github.com failed`,
    });
    const ops: BuildSandboxOps = { createContainer: vi.fn(async () => c.container) };

    await expect(
      withBuildSandbox(SPEC, TOKEN, async () => "unreached", { ops }),
    ).rejects.toThrow(/git clone failed/);
    // The error message must NOT leak the token.
    await withBuildSandbox(SPEC, TOKEN, async () => "x", { ops }).catch((err) => {
      expect(String(err)).not.toContain(TOKEN);
      expect(String(err)).toContain("<redacted-token>");
    });
    expect(c.removed()).toBeGreaterThanOrEqual(1);
  });

  it("checkout failure THROWS (token-redacted)", async () => {
    const c = makeContainer({
      checkoutExitCode: 1,
      stderr: `fatal something ${TOKEN}`,
    });
    const ops: BuildSandboxOps = { createContainer: vi.fn(async () => c.container) };
    await expect(
      withBuildSandbox(SPEC, TOKEN, async () => "x", { ops }),
    ).rejects.toThrow(/git checkout -B/);
    expect(c.removed()).toBe(1);
  });

  it("createContainer failure propagates; nothing to remove", async () => {
    const createContainer = vi.fn(async () => {
      throw new Error("docker: cannot connect");
    });
    await expect(
      withBuildSandbox(SPEC, TOKEN, async () => "x", { ops: { createContainer } }),
    ).rejects.toThrow("docker: cannot connect");
  });

  it("body throw propagates BUT container is removed in finally", async () => {
    const c = makeContainer();
    const ops: BuildSandboxOps = { createContainer: vi.fn(async () => c.container) };
    await expect(
      withBuildSandbox(SPEC, TOKEN, async () => {
        throw new Error("architect boom");
      }, { ops }),
    ).rejects.toThrow("architect boom");
    expect(c.removed()).toBe(1);
  });
});

// pr-fix variant: clone + check out the EXISTING PR head branch (NOT `checkout -B`),
// hand the container to the body (for the deterministic push), no tool-only fallback.
const PR_SPEC = { owner: "octocat", repo: "widget", headRef: "feature/login" };

describe("withPrFixSandbox — pre-clone the EXISTING PR head branch", () => {
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
    expect(createContainer).toHaveBeenCalledWith({
      image: BUILD_IMAGE,
      env: { GIT_TOKEN: TOKEN },
    });
    const clone = c.execCalls.find((x) => x.includes("git clone"))!;
    // Clones the existing branch — NOT a `checkout -B` that would create a new one.
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
