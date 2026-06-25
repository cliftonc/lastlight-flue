import { describe, it, expect } from "vitest";
import { renderPrAuthorPrompt, parsePrAuthoring } from "../pr-author-prompt.ts";

// The PR-author prompt is rendered offline (pure) and its output contract is parsed
// here. The PR is still opened deterministically — these cover the LLM↔code handoff.

describe("renderPrAuthorPrompt", () => {
  const ctx = {
    owner: "cliftonc",
    repo: "widget",
    issue: 42,
    branch: "lastlight/42",
    base: "main",
    reviewerOpenIssues: false,
  };

  it("renders branch metadata + full branchUrl doc links", () => {
    const out = renderPrAuthorPrompt(ctx);
    expect(out).toContain("branch `lastlight/42`");
    expect(out).toContain("cliftonc/widget");
    expect(out).toContain("#42");
    // branchUrl helper expands to the full blob URL under the issue dir.
    expect(out).toContain(
      "https://github.com/cliftonc/widget/blob/lastlight%2F42/.lastlight/issue-42/executor-summary.md",
    );
    // The PR_TITLE / PR_BODY output contract is spelled out for the agent.
    expect(out).toContain("PR_TITLE:");
    expect(out).toContain("PR_BODY:");
  });

  it("omits the open-issues note when the review approved", () => {
    expect(renderPrAuthorPrompt(ctx)).not.toContain("unresolved reviewer issues");
  });

  it("includes the open-issues note when the review did NOT approve", () => {
    const out = renderPrAuthorPrompt({ ...ctx, reviewerOpenIssues: true });
    expect(out).toContain("unresolved reviewer issues");
  });
});

describe("parsePrAuthoring", () => {
  it("parses a well-formed PR_TITLE + PR_BODY block", () => {
    const text = [
      "PR_TITLE: Add retry/backoff to webhook ingest (#42)",
      "PR_BODY:",
      "Closes #42",
      "",
      "## Summary",
      "- Did the thing",
    ].join("\n");
    const { title, body } = parsePrAuthoring(text);
    expect(title).toBe("Add retry/backoff to webhook ingest (#42)");
    expect(body).toBe("Closes #42\n\n## Summary\n- Did the thing");
  });

  it("strips an accidental wrapping code fence around the body", () => {
    const text = "PR_TITLE: T\nPR_BODY:\n```markdown\nCloses #1\n```";
    expect(parsePrAuthoring(text).body).toBe("Closes #1");
  });

  it("returns null fields when markers are absent (caller falls back)", () => {
    const { title, body } = parsePrAuthoring("just some chatter, no markers");
    expect(title).toBeNull();
    expect(body).toBeNull();
  });

  it("returns null body when PR_BODY marker is present but empty", () => {
    const { title, body } = parsePrAuthoring("PR_TITLE: Only a title\nPR_BODY:\n   ");
    expect(title).toBe("Only a title");
    expect(body).toBeNull();
  });
});
