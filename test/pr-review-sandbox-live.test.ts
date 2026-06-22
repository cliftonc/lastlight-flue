import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  defaultReviewerSandboxOps,
  REVIEWER_IMAGE,
  REVIEWER_WORKSPACE,
} from "../src/agent-lib/reviewer-sandbox.ts";

// GATED live integration test for the agent-LESS sandbox + pre-clone path: create a
// real Docker container, clone a small PUBLIC repo at a ref, assert files land in
// /workspace and exec works, then teardown. This proves the workflow's
// create→clone→exec→remove lifecycle for real, WITHOUT a model and WITHOUT any
// GitHub write/PR post.
//
// Skipped by default. Run deliberately with:
//   PR_REVIEW_SANDBOX_LIVE=1 pnpm exec vitest run test/pr-review-sandbox-live.test.ts
// Requires a running Docker daemon. NO paid model. NO GitHub write.
//
// We clone via the public HTTPS URL (no token needed for a public repo), exercising
// the SAME ReviewerSandboxOps.createContainer + container.exec + container.remove
// path the workflow uses (just with an empty token, since the repo is public).

const exec = promisify(execFile);

async function dockerAvailable(): Promise<boolean> {
  try {
    await exec("docker", ["version", "--format", "{{.Server.Version}}"]);
    return true;
  } catch {
    return false;
  }
}

const LIVE = process.env.PR_REVIEW_SANDBOX_LIVE === "1";
const DOCKER_OK = LIVE ? await dockerAvailable() : false;

describe.skipIf(!LIVE || !DOCKER_OK)(
  "pr-review sandbox+clone (live, agent-less, public repo, no PR post)",
  () => {
    it("creates a container, clones a public repo into /workspace, exec works, then tears down", async () => {
      const ops = defaultReviewerSandboxOps();
      const container = await ops.createContainer({
        image: REVIEWER_IMAGE,
        env: {},
      });
      try {
        // Public repo — no auth needed. Mirrors the workflow's clone (minus the
        // x-access-token URL, which only differs by the credential, not the path).
        const clone = await container.exec(
          `git clone --depth 1 --branch master https://github.com/octocat/Hello-World.git ${REVIEWER_WORKSPACE}`,
          { timeoutMs: 120_000 },
        );
        expect(clone.exitCode).toBe(0);

        // Files landed in /workspace.
        const ls = await container.exec(`ls -A ${REVIEWER_WORKSPACE}`);
        expect(ls.exitCode).toBe(0);
        expect(ls.stdout).toContain("README");

        // The checkout is a real git repo and exec at cwd works.
        const status = await container.exec("git rev-parse --is-inside-work-tree", {
          cwd: REVIEWER_WORKSPACE,
        });
        expect(status.exitCode).toBe(0);
        expect(status.stdout.trim()).toBe("true");
      } finally {
        await container.remove();
      }
    }, 180_000);
  },
);
