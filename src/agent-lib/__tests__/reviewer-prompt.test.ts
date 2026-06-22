import { describe, it, expect } from "vitest";
import {
  renderReviewerPrompt,
  renderReReviewerPrompt,
  renderFixPrompt,
  reviewerVerdictPath,
} from "../reviewer-prompt.ts";

// Phase 4 — reviewer-loop prompt assembly is a set of PURE functions: golden-render
// (the reviewer/re-reviewer emit the VERDICT marker the loop parses; the fix names
// the committed reviewer-verdict handoff path). No model, no GitHub.

const BASE = { owner: "cliftonc", repo: "widget", issue: 42, branch: "lastlight/42" };

describe("reviewer-prompt — handoff paths", () => {
  it("derives the reviewer-verdict path from the issue number", () => {
    expect(reviewerVerdictPath(42)).toBe(".lastlight/issue-42/reviewer-verdict.md");
  });
});

describe("renderReviewerPrompt — first review of the committed changes", () => {
  it("fills repo / branch / issueDir / issueNumber and asks for the VERDICT marker", () => {
    const out = renderReviewerPrompt(BASE);
    expect(out).toContain("inside the widget repo at branch lastlight/42");
    expect(out).toContain(".lastlight/issue-42/architect-plan.md");
    // The marker contract the durable loop parses.
    expect(out).toContain("VERDICT: APPROVED");
    expect(out).toContain("VERDICT: REQUEST_CHANGES");
    // Reviews the committed diff in the checkout (internal build review).
    expect(out).toContain("git diff main...HEAD");
    // No unrendered placeholders survive.
    expect(out).not.toMatch(/\{\{[^}]+\}\}/);
  });

  it("does NOT instruct the model to push (the harness pushes deterministically)", () => {
    const out = renderReviewerPrompt(BASE);
    expect(out).toContain("Do NOT push");
    expect(out).not.toContain("git push origin HEAD");
  });
});

describe("renderReReviewerPrompt — re-review after a fix cycle", () => {
  it("names the fix cycle + the prior verdict file and re-emits the VERDICT marker", () => {
    const out = renderReReviewerPrompt(BASE, 0);
    expect(out).toContain("RE-REVIEW after fix cycle 0");
    expect(out).toContain(".lastlight/issue-42/reviewer-verdict.md");
    expect(out).toContain("VERDICT: APPROVED");
    expect(out).not.toMatch(/\{\{[^}]+\}\}/);
  });

  it("interpolates a non-zero fix cycle into the section headings", () => {
    const out = renderReReviewerPrompt(BASE, 1);
    expect(out).toContain("RE-REVIEW after fix cycle 1");
    expect(out).toContain("Re-review after Fix Cycle 1");
  });
});

describe("renderFixPrompt — addresses ONLY the reviewer notes", () => {
  it("names the committed reviewer-verdict handoff + the fix cycle", () => {
    const out = renderFixPrompt(BASE, 0);
    expect(out).toContain("EXECUTOR (fix cycle 0)");
    // The reviewer notes are the handoff — read from the committed file, not inlined.
    expect(out).toContain(".lastlight/issue-42/reviewer-verdict.md");
    expect(out).toContain("address review feedback for #42 (cycle 0)");
    expect(out).not.toMatch(/\{\{[^}]+\}\}/);
  });

  it("does NOT instruct the model to push (the harness pushes deterministically)", () => {
    const out = renderFixPrompt(BASE, 0);
    expect(out).toContain("Do NOT push");
    expect(out).not.toContain("git push origin HEAD");
  });
});
