import { describe, it, expect } from "vitest";

// Phase 1 acceptance (LIVE) — "a tool call mints a scoped token and reads a real
// issue" (spec/09-sandbox.md, design/phase-1-shared-core.md acceptance hooks).
//
// This makes REAL GitHub App calls (mints an installation token via the App PEM,
// then reads an issue), so it is GATED on env and skipped by default — keeping
// `pnpm test` green and offline (mirrors test/spike-1-hello.test.ts's gating).
//
// To run it live (with secrets/.env loaded):
//
//   GITHUB_LIVE_TEST=1 \
//   GITHUB_APP_ID=... \
//   GITHUB_APP_PRIVATE_KEY_PATH=./secrets/<app>.pem \
//   GITHUB_APP_INSTALLATION_ID=... \
//   GITHUB_TEST_OWNER=... GITHUB_TEST_REPO=... GITHUB_TEST_ISSUE=1 \
//   pnpm exec vitest run test/github-tools-live.test.ts
//
// STATUS: NOT YET RUN — gated, awaiting a deliberate live invocation (see PROGRESS.md).

import { configureGitAuth } from "../src/engine/git-auth.ts";
import { githubTools } from "../src/tools/github.ts";
import { GITHUB_PERMISSION_PROFILES } from "../src/engine/profiles.ts";

const LIVE = process.env.GITHUB_LIVE_TEST === "1";

describe.skipIf(!LIVE)("github tools (live) — scoped token reads a real issue", () => {
  it("mints a read-scoped installation token and reads an issue via the tool", async () => {
    const owner = process.env.GITHUB_TEST_OWNER!;
    const repo = process.env.GITHUB_TEST_REPO!;
    const issueNumber = Number(process.env.GITHUB_TEST_ISSUE ?? "1");

    // Mint a downscoped installation token for the `read` profile.
    const { token } = await configureGitAuth({
      appId: process.env.GITHUB_APP_ID!,
      privateKeyPath: process.env.GITHUB_APP_PRIVATE_KEY_PATH!,
      installationId: process.env.GITHUB_APP_INSTALLATION_ID!,
      permissions: GITHUB_PERMISSION_PROFILES.read,
      repositories: [repo],
    });
    expect(token).toMatch(/^ghs_/);

    const tools = githubTools({ owner, repo }, token, "read");
    const getIssue = tools.find((t) => t.name === "github_get_issue")!;
    const out = await getIssue.execute({ issue_number: issueNumber });
    const parsed = JSON.parse(out);
    expect(parsed.number).toBe(issueNumber);
    expect(typeof parsed.title).toBe("string");
  });
});
