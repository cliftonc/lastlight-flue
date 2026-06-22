import { describe, it, expect, vi } from "vitest";
import type { Octokit } from "octokit";
import {
  mintReadOctokitFor,
  type MintReadDeps,
} from "../chat-token.ts";
import { GITHUB_PERMISSION_PROFILES } from "../../engine/profiles.ts";
import type { LastLightConfig } from "../../config.ts";
import type { RepoRef } from "../../tools/github-read.ts";

// Phase 5 — the chat read-token mint, fully offline via the DI seam (no live
// GitHub App / token). Asserts: repo parsed from id, READ profile minted (never
// write), graceful undefined when no repo / no App config.

const FAKE_OCTOKIT = { __fake: "octokit" } as unknown as Octokit;

function cfgWithApp(): LastLightConfig {
  return {
    botLogin: "last-light[bot]",
    githubApp: { appId: "1", privateKeyPath: "/x.pem", installationId: "9" },
  } as unknown as LastLightConfig;
}

function makeDeps(
  cfg: LastLightConfig,
  overrides: Partial<MintReadDeps> = {},
): { deps: MintReadDeps; calls: { repos: RepoRef[]; cfgs: LastLightConfig[] } } {
  const calls = { repos: [] as RepoRef[], cfgs: [] as LastLightConfig[] };
  const deps: MintReadDeps = {
    loadConfig: () => cfg,
    async mintReadToken(c, repo) {
      calls.cfgs.push(c);
      calls.repos.push(repo);
      return "ghs_read_token";
    },
    makeOctokit: () => FAKE_OCTOKIT,
    ...overrides,
  };
  return { deps, calls };
}

describe("mintReadOctokitFor", () => {
  it("parses the repo from the id and mints a read-scoped octokit bound to it", async () => {
    const { deps, calls } = makeDeps(cfgWithApp());
    const bound = await mintReadOctokitFor("github:cliftonc/widget#42", deps);
    expect(bound).toEqual({ owner: "cliftonc", repo: "widget", octokit: FAKE_OCTOKIT });
    expect(calls.repos).toEqual([{ owner: "cliftonc", repo: "widget" }]);
  });

  it("returns undefined for a repo-less thread id (no token minted)", async () => {
    const { deps, calls } = makeDeps(cfgWithApp());
    const bound = await mintReadOctokitFor("slack:T1:C2:171234.5", deps);
    expect(bound).toBeUndefined();
    expect(calls.repos).toEqual([]);
  });

  it("returns undefined when no GitHub App is configured (never an unscoped client)", async () => {
    const noApp = { botLogin: "last-light[bot]" } as unknown as LastLightConfig;
    const minted = vi.fn(async () => "ghs_x");
    const { deps } = makeDeps(noApp, { mintReadToken: minted });
    const bound = await mintReadOctokitFor("github:cliftonc/widget#1", deps);
    expect(bound).toBeUndefined();
    expect(minted).not.toHaveBeenCalled();
  });

  it("the read profile is READ-only (defence-in-depth behind the read tool set)", () => {
    const profile = GITHUB_PERMISSION_PROFILES.read;
    for (const [, level] of Object.entries(profile)) {
      expect(level).toBe("read");
    }
  });
});
