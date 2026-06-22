import { describe, it, expect, vi } from "vitest";
import type { SandboxFactory } from "@flue/runtime";
import {
  withReviewerSandbox,
  type ReviewerContainer,
  type ReviewerSandboxOps,
} from "../reviewer-sandbox.ts";

const SANDBOX = { __fake: true } as unknown as SandboxFactory;
const SPEC = { owner: "octocat", repo: "Hello-World", headRef: "main" };
const TOKEN = "ghs_unit_test_token";

function makeContainer(opts: { cloneExitCode?: number; cloneStderr?: string } = {}) {
  const execCalls: string[] = [];
  let removed = 0;
  const container: ReviewerContainer = {
    async exec(command) {
      execCalls.push(command);
      return {
        stdout: "",
        stderr: opts.cloneStderr ?? "",
        exitCode: opts.cloneExitCode ?? 0,
      };
    },
    async remove() {
      removed += 1;
    },
    sandbox: () => SANDBOX,
  };
  return { container, execCalls, removed: () => removed };
}

describe("withReviewerSandbox — caller-owned lifetime + token hygiene", () => {
  it("creates the container with baked token, clones the head ref, yields the sandbox, removes in finally", async () => {
    const c = makeContainer();
    const createContainer = vi.fn(async () => c.container);
    const ops: ReviewerSandboxOps = { createContainer };

    const got: (SandboxFactory | undefined)[] = [];
    const outcome = await withReviewerSandbox(
      SPEC,
      TOKEN,
      async (sandbox) => {
        got.push(sandbox);
        return "review-text";
      },
      { ops },
    );

    expect(outcome.result).toBe("review-text");
    expect(outcome.usedSandbox).toBe(true);
    expect(got[0]).toBe(SANDBOX);

    // Token baked as env, never on a logged command line.
    expect(createContainer).toHaveBeenCalledWith({
      image: "node:22-bookworm",
      env: { GIT_TOKEN: TOKEN },
    });
    const clone = c.execCalls.find((x) => x.includes("git clone"))!;
    expect(clone).toContain("--branch 'main'");
    expect(clone).toContain("/workspace");
    expect(c.removed()).toBe(1);
  });

  it("clone failure → tool-only fallback, warning is TOKEN-FREE, container still removed", async () => {
    const c = makeContainer({ cloneExitCode: 128, cloneStderr: `auth https://x-access-token:${TOKEN}@github.com failed` });
    const ops: ReviewerSandboxOps = { createContainer: vi.fn(async () => c.container) };
    const warn = vi.fn();

    const got: (SandboxFactory | undefined)[] = [];
    const outcome = await withReviewerSandbox(
      SPEC,
      TOKEN,
      async (sandbox) => {
        got.push(sandbox);
        return "tool-only-review";
      },
      { ops, log: { warn } },
    );

    expect(got[0]).toBeUndefined();
    expect(outcome.usedSandbox).toBe(false);
    expect(outcome.result).toBe("tool-only-review");
    expect(c.removed()).toBe(1);
    expect(warn).toHaveBeenCalled();
    // The token (even though it appeared in the clone stderr) must be redacted.
    for (const call of warn.mock.calls) {
      expect(JSON.stringify(call)).not.toContain(TOKEN);
    }
  });

  it("createContainer failure → tool-only fallback, nothing to remove", async () => {
    const createContainer = vi.fn(async () => {
      throw new Error("docker: cannot connect");
    });
    const warn = vi.fn();
    const outcome = await withReviewerSandbox(
      SPEC,
      TOKEN,
      async (sandbox) => {
        expect(sandbox).toBeUndefined();
        return "ok";
      },
      { ops: { createContainer }, log: { warn } },
    );
    expect(outcome.usedSandbox).toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it("body throw propagates BUT container is removed in finally", async () => {
    const c = makeContainer();
    const ops: ReviewerSandboxOps = { createContainer: vi.fn(async () => c.container) };
    await expect(
      withReviewerSandbox(SPEC, TOKEN, async () => {
        throw new Error("body boom");
      }, { ops }),
    ).rejects.toThrow("body boom");
    expect(c.removed()).toBe(1);
  });
});
