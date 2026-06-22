import { describe, it, expect, vi } from "vitest";
import type { Octokit } from "octokit";
import type { Skill } from "@flue/runtime";
import {
  buildChatAgentConfig,
  parseChatThread,
  CHAT_TASK_KEY,
  CHAT_SUFFIX,
} from "../chat.ts";
import {
  resolveModel,
  resolveThinking,
  setRuntimeConfig,
  resetRuntimeConfigForTests,
} from "../../config.ts";
import { loadPersona } from "../persona.ts";

// Phase 5 — the READ-ONLY chat agent config, all offline (no live model /
// GitHub / server). The config builder is pure + DI; we assert model/thinking,
// persona + chat suffix, the read-only tool set (and the ABSENCE of any
// write/mutating tool + sandbox — the spec/11 hard invariant), the chat skill,
// and the per-thread id binding.

const FAKE_OCTOKIT = { __fake: "octokit" } as unknown as Octokit;
const FAKE_SKILL = { __fake: "chat-skill" } as unknown as Skill;

/** Build with a deterministic config + a fake per-repo octokit lookup. */
function build(
  id: string,
  octokitFor: (repo: { owner: string; repo: string }) => Octokit | undefined = () =>
    FAKE_OCTOKIT,
) {
  setRuntimeConfig({
    models: { default: "openai/gpt-5.1", chat: "openai/gpt-5.1-mini" },
    variants: { chat: "low" },
  } as never);
  try {
    return buildChatAgentConfig({ id, chatSkill: FAKE_SKILL, octokitFor });
  } finally {
    resetRuntimeConfigForTests();
  }
}

describe("parseChatThread — per-thread id → repo binding", () => {
  it("extracts owner/repo from a github thread key, dropping the #N", () => {
    expect(parseChatThread("github:cliftonc/widget#42").repo).toEqual({
      owner: "cliftonc",
      repo: "widget",
    });
  });

  it("extracts a trailing owner/repo binding from a slack thread key", () => {
    expect(
      parseChatThread("slack:T1:C2:171234.5|cliftonc/widget").repo,
    ).toEqual({ owner: "cliftonc", repo: "widget" });
  });

  it("returns no repo for a repo-less thread id (chat still works)", () => {
    const t = parseChatThread("slack:T1:C2:171234.5");
    expect(t.repo).toBeUndefined();
    expect(t.id).toBe("slack:T1:C2:171234.5");
  });

  it("ignores a reset generation suffix (it only changes the session key)", () => {
    expect(parseChatThread("github:cliftonc/widget#42#g2").repo).toEqual({
      owner: "cliftonc",
      repo: "widget",
    });
  });
});

describe("buildChatAgentConfig — chat model/thinking + persona + suffix + skill", () => {
  it("resolves model + thinking for the chat task key", () => {
    const cfg = build("github:cliftonc/widget#1");
    expect(cfg.model).toBe("openai/gpt-5.1-mini");
    expect(cfg.thinkingLevel).toBe("low");
    // And matches the resolver for the chat key.
    setRuntimeConfig({
      models: { default: "openai/gpt-5.1", chat: "openai/gpt-5.1-mini" },
      variants: { chat: "low" },
    } as never);
    try {
      expect(cfg.model).toBe(resolveModel(CHAT_TASK_KEY));
      expect(cfg.thinkingLevel).toBe(resolveThinking(CHAT_TASK_KEY));
    } finally {
      resetRuntimeConfigForTests();
    }
  });

  it("instructions = the ONE shared persona + the chat suffix appended", () => {
    const cfg = build("github:cliftonc/widget#1");
    expect(cfg.instructions).toBe(loadPersona({ suffix: CHAT_SUFFIX }));
    // It carries the chat-surface frame + the read-only / redirect rules.
    expect(cfg.instructions).toContain("Chat surface");
    expect(cfg.instructions).toContain("READ-ONLY on the world");
    expect(cfg.instructions).toContain("build owner/repo#N");
    // And the shared persona body (one source — not bifurcated).
    expect(cfg.instructions).toContain(loadPersona());
  });

  it("loads the chat skill (native progressive disclosure, no read_skill tool)", () => {
    const cfg = build("github:cliftonc/widget#1");
    expect(cfg.skills).toEqual([FAKE_SKILL]);
  });
});

describe("buildChatAgentConfig — READ-ONLY invariant (spec/11)", () => {
  it("binds ONLY the GET-only github read tools to the thread's repo", () => {
    const cfg = build("github:cliftonc/widget#1");
    const names = (cfg.tools ?? []).map((t) => t.name);
    // The full read set is present...
    expect(names).toContain("github_get_repository");
    expect(names).toContain("github_get_issue");
    expect(names).toContain("github_search_code");
    // ...and EVERY tool name is a read (get/list/search) — no mutating verb.
    for (const name of names) {
      expect(name).toMatch(/^github_(get|list|search)_/);
    }
  });

  it("has NO write / mutating tool and NO sandbox", () => {
    const cfg = build("github:cliftonc/widget#1");
    const names = (cfg.tools ?? []).map((t) => t.name);
    // The hard invariant: every tool's ACTION verb (the `github_<verb>_…`
    // segment) is read-only — get/list/search. A mutating action verb
    // (create/update/add/remove/delete/close/merge/edit/push/commit/review/…)
    // as the leading segment would be a write tool; assert none exist.
    const MUTATING_VERBS =
      /^github_(create|update|add|remove|delete|close|merge|edit|write|push|commit|review|dispatch|set|put|patch|post|comment|label)_/;
    for (const name of names) {
      expect(name).not.toMatch(MUTATING_VERBS);
      // Belt-and-braces: the read verbs are the ONLY allowed action prefixes.
      expect(name).toMatch(/^github_(get|list|search)_/);
    }
    // No bash / shell / edit / write tools of any naming, either.
    for (const name of names) {
      expect(name).not.toMatch(/\b(bash|shell|exec|edit|write_file)\b/);
    }
    // The hard invariant: no sandbox / cwd → chat physically cannot run bash.
    expect(cfg.sandbox).toBeUndefined();
    expect(cfg.cwd).toBeUndefined();
  });

  it("scopes tools to THIS thread's repo (different id → different repo, still read-only)", () => {
    const seen: { owner: string; repo: string }[] = [];
    const octokitFor = (repo: { owner: string; repo: string }) => {
      seen.push(repo);
      return FAKE_OCTOKIT as Octokit;
    };
    const a = build("github:cliftonc/widget#1", octokitFor);
    const b = build("github:acme/gadget#9", octokitFor);
    // Each thread's tools were bound to its OWN repo.
    expect(seen).toEqual([
      { owner: "cliftonc", repo: "widget" },
      { owner: "acme", repo: "gadget" },
    ]);
    // Both remain read-only (all get/list/search).
    for (const cfg of [a, b]) {
      for (const t of cfg.tools ?? []) {
        expect(t.name).toMatch(/^github_(get|list|search)_/);
      }
    }
  });

  it("a repo-less thread gets NO github tools but still has persona + skill (no crash)", () => {
    const octokitFor = vi.fn(() => FAKE_OCTOKIT as Octokit);
    const cfg = build("slack:T1:C2:171234.5", octokitFor);
    expect(cfg.tools).toEqual([]);
    expect(octokitFor).not.toHaveBeenCalled(); // no repo → no token lookup
    expect(cfg.skills).toEqual([FAKE_SKILL]);
    expect(cfg.sandbox).toBeUndefined();
  });

  it("a repo whose octokit cannot be minted (undefined) gets NO github tools", () => {
    const cfg = build("github:cliftonc/widget#1", () => undefined);
    expect(cfg.tools).toEqual([]);
    expect(cfg.sandbox).toBeUndefined();
  });
});
