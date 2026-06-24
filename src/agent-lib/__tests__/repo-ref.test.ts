import { describe, it, expect } from "vitest";
import { resolveRepoFromText, parseOwnerRepo } from "../repo-ref.ts";

describe("parseOwnerRepo", () => {
  it("splits owner/repo", () => {
    expect(parseOwnerRepo("cliftonc/drizzle-cube")).toEqual({ owner: "cliftonc", repo: "drizzle-cube" });
  });
  it("rejects malformed specs", () => {
    expect(parseOwnerRepo(undefined)).toBeUndefined();
    expect(parseOwnerRepo("noslash")).toBeUndefined();
    expect(parseOwnerRepo("a/b/c")).toBeUndefined();
    expect(parseOwnerRepo("/b")).toBeUndefined();
  });
});

describe("resolveRepoFromText", () => {
  const managed = ["cliftonc/drizzle-cube", "cliftonc/lastlight"];

  it("picks the first managed owner/repo named in the text", () => {
    expect(
      resolveRepoFromText("how does cliftonc/drizzle-cube handle joins?", { managedRepos: managed }),
    ).toEqual({ owner: "cliftonc", repo: "drizzle-cube" });
  });

  it("is case-insensitive against the allowlist", () => {
    expect(
      resolveRepoFromText("look at CliftonC/Drizzle-Cube", { managedRepos: managed }),
    ).toEqual({ owner: "CliftonC", repo: "Drizzle-Cube" });
  });

  it("ignores a named-but-UNMANAGED repo and uses the fallback", () => {
    expect(
      resolveRepoFromText("check evil/repo please", {
        managedRepos: managed,
        fallback: "cliftonc/drizzle-cube",
      }),
    ).toEqual({ owner: "cliftonc", repo: "drizzle-cube" });
  });

  it("uses the fallback when no repo is named", () => {
    expect(
      resolveRepoFromText("what is an ORM?", { managedRepos: managed, fallback: "cliftonc/lastlight" }),
    ).toEqual({ owner: "cliftonc", repo: "lastlight" });
  });

  it("returns undefined when nothing is named and no fallback", () => {
    expect(resolveRepoFromText("hello there", { managedRepos: managed })).toBeUndefined();
  });

  it("an unmanaged fallback is rejected (never scopes outside the allowlist)", () => {
    expect(
      resolveRepoFromText("hi", { managedRepos: managed, fallback: "evil/repo" }),
    ).toBeUndefined();
  });

  it("an empty allowlist means no restriction (first named token wins)", () => {
    expect(
      resolveRepoFromText("see foo/bar", { managedRepos: [] }),
    ).toEqual({ owner: "foo", repo: "bar" });
  });
});
