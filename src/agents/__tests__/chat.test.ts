import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Octokit } from "octokit";
import type { AgentInitializerContext } from "@flue/runtime";
import {
  setRuntimeConfig,
  resetRuntimeConfigForTests,
} from "../../config.ts";
import type { BoundReadOctokit } from "../../agent-lib/chat-token.ts";

// Mock the read-token mint so the discovered agent's `initialize` runs fully
// offline (no live GitHub App / token). The chat agent under test is otherwise
// the REAL discovered shell (default export createAgent + route + description).
const mintReadOctokitFor = vi.fn<(id: string) => Promise<BoundReadOctokit | undefined>>();
vi.mock("../../agent-lib/chat-token.ts", () => ({
  mintReadOctokitFor: (id: string) => mintReadOctokitFor(id),
}));

const FAKE_OCTOKIT = { __fake: "octokit" } as unknown as Octokit;

const ctx = (id: string) => ({ id }) as unknown as AgentInitializerContext<{ text?: string }>;

beforeEach(() => {
  mintReadOctokitFor.mockReset();
  setRuntimeConfig({
    models: { default: "openai/gpt-5.1", chat: "openai/gpt-5.1-mini" },
    variants: { chat: "low" },
  } as never);
});
afterEach(() => resetRuntimeConfigForTests());

describe("src/agents/chat.ts — discovered agent shape", () => {
  it("exports a default createAgent, an open route, and a description", async () => {
    const mod = await import("../chat.ts");
    expect((mod.default as { __flueAgentDefinition?: true }).__flueAgentDefinition).toBe(true);
    expect(typeof mod.route).toBe("function");
    expect(mod.description).toMatch(/read-only/i);
    // The route is open for now (Phase 6 channel auth) — it just calls next().
    const next = vi.fn();
    await mod.route({} as never, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("initialize binds read-only tools for a repo thread; NO write tools, NO sandbox", async () => {
    mintReadOctokitFor.mockResolvedValue({
      owner: "cliftonc",
      repo: "widget",
      octokit: FAKE_OCTOKIT,
    });
    const mod = await import("../chat.ts");
    const cfg = await mod.default.initialize(ctx("github:cliftonc/widget#42"));

    expect(mintReadOctokitFor).toHaveBeenCalledWith("github:cliftonc/widget#42");
    expect(cfg.model).toBe("openai/gpt-5.1-mini");
    expect(cfg.thinkingLevel).toBe("low");
    expect((cfg.skills ?? []).length).toBe(1);
    expect(cfg.sandbox).toBeUndefined();
    expect(cfg.cwd).toBeUndefined();

    const names = (cfg.tools ?? []).map((t) => t.name);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(name).toMatch(/^github_(get|list|search)_/);
  });

  it("initialize yields NO github tools when the mint returns undefined (still read-only)", async () => {
    mintReadOctokitFor.mockResolvedValue(undefined);
    const mod = await import("../chat.ts");
    const cfg = await mod.default.initialize(ctx("slack:T1:C2:171234.5"));
    expect(cfg.tools).toEqual([]);
    expect(cfg.sandbox).toBeUndefined();
    expect((cfg.skills ?? []).length).toBe(1);
  });
});
