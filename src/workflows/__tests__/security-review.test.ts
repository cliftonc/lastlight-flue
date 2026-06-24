import { describe, it, expect, vi } from "vitest";
import type { FlueHarness } from "@flue/runtime";
import type { Octokit } from "octokit";
import {
  runSecurityReview,
  defaultDeps,
  type SecurityReviewDeps,
  type SecurityReviewInput,
  type SecurityReviewRunCtx,
  type RepoMeta,
  SECURITY_PROFILE,
} from "../security-review.ts";
import {
  fileSecurityScanIssue,
  applySecurityLabels,
  securityIssueTitle,
  SECURITY_LABEL,
  SECURITY_SCAN_LABEL,
  type FiledSecurityScan,
} from "../../security-review-post.ts";
import { GITHUB_PERMISSION_PROFILES } from "../../engine/profiles.ts";
import type { RepoRef } from "../../tools/github-read.ts";

const BOT = "last-light[bot]";
const SCAN_DATE = "2026-06-23";

const META: RepoMeta = {
  defaultBranch: "main",
  description: "A widget library.",
  topics: ["widgets"],
};

const REPORT =
  "<!-- lastlight-security-scan-version: 1 -->\n\n## Summary\n\n| Severity | Count |\n|----------|------:|\n| Critical | 1 |";

function fakeCtx(
  payload: SecurityReviewInput,
  harness?: FlueHarness,
): SecurityReviewRunCtx {
  return {
    input: payload,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    harness:
      harness ??
      ({
        name: "default",
        async session() {
          throw new Error("session must not be called — runSecurityAgent is injected in tests");
        },
      } as unknown as FlueHarness),
  };
}

const INPUT: SecurityReviewInput = {
  owner: "cliftonc",
  repo: "widget",
  triggerType: "cron",
};

function fakeDeps(opts: {
  report: string;
  meta?: RepoMeta;
  filed?: FiledSecurityScan;
}) {
  const mintToken = vi.fn(async () => "ghs_fake_security_token");
  const makeOctokit = vi.fn(() => ({}) as unknown as Octokit);
  const fetchRepoMeta = vi.fn(async () => opts.meta ?? META);
  let agentSaw:
    | { ref: RepoRef; meta: RepoMeta; token: string; scanDate: string }
    | undefined;
  const runSecurityAgent = vi.fn(
    async (
      _ctx: SecurityReviewRunCtx,
      ref: RepoRef,
      _octokit: Octokit,
      token: string,
      meta: RepoMeta,
      scanDate: string,
    ) => {
      agentSaw = { ref, meta, token, scanDate };
      return opts.report;
    },
  );
  const fileIssue = vi.fn(
    async (): Promise<FiledSecurityScan> =>
      opts.filed ?? {
        filed: true,
        issueNumber: 7,
        html_url: "https://gh/issues/7",
        labelled: true,
      },
  );
  const deps: SecurityReviewDeps = {
    mintToken,
    makeOctokit,
    fetchRepoMeta,
    runSecurityAgent,
    fileIssue,
  };
  return {
    deps,
    mintToken,
    makeOctokit,
    fetchRepoMeta,
    runSecurityAgent,
    fileIssue,
    agentSaw: () => agentSaw,
  };
}

describe("runSecurityReview — full flow over injected deps (no live model / GitHub / Docker)", () => {
  it("mints a token, runs the sandboxed agent, files the dated summary issue via the deterministic filer", async () => {
    const { deps, mintToken, fileIssue } = fakeDeps({ report: REPORT });
    const res = await runSecurityReview(fakeCtx(INPUT), deps, SCAN_DATE);

    expect(mintToken).toHaveBeenCalledWith(INPUT);
    expect(res.filed).toBe(true);
    expect(res.issueNumber).toBe(7);
    expect(res.issueUrl).toBe("https://gh/issues/7");
    expect(res.labelled).toBe(true);

    // The filer got the BOUND ref (NOT model-selectable) + the scan date for the title.
    expect(fileIssue).toHaveBeenCalledWith(
      expect.anything(),
      { owner: "cliftonc", repo: "widget" },
      REPORT,
      { dateISO: SCAN_DATE },
    );
  });

  it("the SECURITY_PROFILE is issues-write (contents:read to clone + issues:write to file)", () => {
    expect(SECURITY_PROFILE).toBe("issues-write");
    const perms = GITHUB_PERMISSION_PROFILES[SECURITY_PROFILE];
    expect(perms.contents).toBe("read");
    expect(perms.issues).toBe("write");
  });

  it("the agent receives the BOUND ref, the scoped token, the fetched metadata, and the scan date", async () => {
    const t = fakeDeps({ report: "ok" });
    await runSecurityReview(fakeCtx(INPUT), t.deps, SCAN_DATE);
    expect(t.fetchRepoMeta).toHaveBeenCalled();
    const seen = t.agentSaw();
    expect(seen?.ref).toEqual({ owner: "cliftonc", repo: "widget" });
    expect(seen?.meta).toEqual(META);
    expect(seen?.token).toBe("ghs_fake_security_token");
    expect(seen?.scanDate).toBe(SCAN_DATE);
  });

  it("NO_FINDINGS sentinel → files NOTHING (cron is low-noise) and logs it", async () => {
    const { deps, fileIssue } = fakeDeps({ report: "NO_FINDINGS" });
    const ctx = fakeCtx(INPUT);
    const res = await runSecurityReview(ctx, deps, SCAN_DATE);
    expect(res.filed).toBe(false);
    expect(fileIssue).not.toHaveBeenCalled();
    expect(ctx.log.info).toHaveBeenCalled();
  });

  it("empty/whitespace report → files NOTHING", async () => {
    const { deps, fileIssue } = fakeDeps({ report: "   " });
    const res = await runSecurityReview(fakeCtx(INPUT), deps, SCAN_DATE);
    expect(res.filed).toBe(false);
    expect(fileIssue).not.toHaveBeenCalled();
  });

  it("does NOT log the scoped token", async () => {
    const { deps } = fakeDeps({ report: REPORT });
    const ctx = fakeCtx(INPUT);
    await runSecurityReview(ctx, deps, SCAN_DATE);
    const logged = [
      ...(ctx.log.info as ReturnType<typeof vi.fn>).mock.calls,
      ...(ctx.log.warn as ReturnType<typeof vi.fn>).mock.calls,
    ]
      .flat()
      .map((a) => JSON.stringify(a))
      .join(" ");
    expect(logged).not.toContain("ghs_fake_security_token");
  });
});

// ---------------------------------------------------------------------------
// Sandbox clone + ALWAYS-teardown: exercise the REAL runSecuritySession (default deps)
// over a fake Docker container, asserting clone happened, the agent saw the sandbox/cwd,
// and the container is torn down in finally — INCLUDING when the session throws.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// beta.3: the HARNESS owns the (self-terminating) sandbox. The default
// runSecurityAgent clones the repo into /workspace via `harness.shell`
// (cloneRepoIntoHarness) then prompts the bound session — NO per-run teardown.
// ---------------------------------------------------------------------------
describe("runSecurityReview — harness-clone path (default runSecurityAgent, fake harness)", () => {
  /** A fake harness recording shell commands + a session whose prompt returns canned text. */
  function fakeHarness(opts: { promptText?: string; promptThrows?: Error } = {}) {
    const shellCalls: string[] = [];
    const harness = {
      name: "default",
      async shell(command: string) {
        shellCalls.push(command);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      async session() {
        return {
          async prompt() {
            if (opts.promptThrows) throw opts.promptThrows;
            return { text: opts.promptText ?? REPORT };
          },
        };
      },
      fs: {},
    } as unknown as FlueHarness;
    return { harness, shellCalls };
  }

  /** Default deps but with the GitHub/token seams faked — keeps the DEFAULT clone path. */
  function cloneDeps(): SecurityReviewDeps {
    return {
      ...defaultDeps(),
      mintToken: async () => "ghs_clone_token",
      makeOctokit: () => ({}) as unknown as Octokit,
      fetchRepoMeta: async () => META,
      fileIssue: async () => ({
        filed: true,
        issueNumber: 7,
        html_url: "https://gh/issues/7",
        labelled: true,
      }),
    };
  }

  it("clones the repo into the harness sandbox via git CLI, then files the report", async () => {
    const fh = fakeHarness({ promptText: REPORT });
    const ctx = fakeCtx(INPUT, fh.harness);
    const res = await runSecurityReview(ctx, cloneDeps(), SCAN_DATE);

    // A clone command was issued into the harness sandbox.
    expect(fh.shellCalls.some((c) => c.includes("git clone"))).toBe(true);
    expect(res.filed).toBe(true);
  });

  it("a prompt throw surfaces (no swallow)", async () => {
    const fh = fakeHarness({ promptThrows: new Error("model exploded mid-security-review") });
    const ctx = fakeCtx(INPUT, fh.harness);
    await expect(runSecurityReview(ctx, cloneDeps(), SCAN_DATE)).rejects.toThrow(
      "model exploded mid-security-review",
    );
  });
});

// ---------------------------------------------------------------------------
// Deterministic filer: NEW dated snapshot issue each run (never update-in-place),
// EXACT title + labels on the BOUND ref.
// ---------------------------------------------------------------------------
describe("fileSecurityScanIssue — bound ref, dated snapshot, exact title + labels", () => {
  const REF: RepoRef = { owner: "cliftonc", repo: "widget" };

  function fakeOctokit(labelOpts: { createLabelError?: { status: number } } = {}) {
    const create = vi.fn(async () => ({
      data: { number: 100, html_url: "https://gh/issues/100" },
    }));
    const update = vi.fn(async () => ({ data: {} }));
    const createLabel = vi.fn(async () => {
      if (labelOpts.createLabelError) throw labelOpts.createLabelError;
      return { data: {} };
    });
    const addLabels = vi.fn(async () => ({ data: [] }));
    const octokit = {
      rest: { issues: { create, update, createLabel, addLabels } },
    } as unknown as Octokit;
    return { octokit, create, update, createLabel, addLabels };
  }

  it("CREATES a NEW issue with the EXACT em-dash title + both labels on the BOUND ref", async () => {
    const o = fakeOctokit();
    const res = await fileSecurityScanIssue(o.octokit, REF, "Report body.", {
      dateISO: SCAN_DATE,
    });
    expect(res.filed).toBe(true);
    expect(res.issueNumber).toBe(100);
    expect(res.labelled).toBe(true);
    expect(o.create).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "cliftonc", repo: "widget" }),
    );
    const call = (o.create.mock.calls as unknown as Array<[{ title?: string; body?: string; labels?: string[] }]>)[0]?.[0] ?? {};
    expect(call.title).toBe(securityIssueTitle(SCAN_DATE));
    expect(call.title).toBe("Security scan — 2026-06-23"); // em-dash, single spaces
    expect(call.body).toContain("Report body.");
    expect(call.labels).toEqual([SECURITY_LABEL, SECURITY_SCAN_LABEL]);
    // NEVER updates a prior scan (point-in-time snapshot).
    expect(o.update).not.toHaveBeenCalled();
    expect(o.addLabels).toHaveBeenCalledWith(
      expect.objectContaining({ labels: [SECURITY_LABEL, SECURITY_SCAN_LABEL] }),
    );
  });

  it("files a SECOND issue on a same-day re-scan (never edits the prior — snapshot semantics)", async () => {
    const o = fakeOctokit();
    await fileSecurityScanIssue(o.octokit, REF, "First.", { dateISO: SCAN_DATE });
    await fileSecurityScanIssue(o.octokit, REF, "Second.", { dateISO: SCAN_DATE });
    expect(o.create).toHaveBeenCalledTimes(2);
    expect(o.update).not.toHaveBeenCalled();
  });

  it("empty/whitespace report → nothing filed", async () => {
    const o = fakeOctokit();
    const res = await fileSecurityScanIssue(o.octokit, REF, "   ", { dateISO: SCAN_DATE });
    expect(res.filed).toBe(false);
    expect(o.create).not.toHaveBeenCalled();
  });

  it("label creation 403 → still files, applies labels best-effort", async () => {
    const o = fakeOctokit({ createLabelError: { status: 403 } });
    const res = await fileSecurityScanIssue(o.octokit, REF, "body", { dateISO: SCAN_DATE });
    expect(res.filed).toBe(true);
    // 403 is tolerated (labels may pre-exist) → addLabels still attempted.
    expect(o.addLabels).toHaveBeenCalled();
  });

  it("applySecurityLabels: 422 (already exists) still applies both labels", async () => {
    const o = fakeOctokit({ createLabelError: { status: 422 } });
    const labelled = await applySecurityLabels(o.octokit, REF, 100);
    expect(labelled).toBe(true);
    expect(o.addLabels).toHaveBeenCalled();
  });
});
