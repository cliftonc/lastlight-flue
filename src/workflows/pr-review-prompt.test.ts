import { describe, it, expect } from "vitest";
import { renderReviewPrompt } from "./pr-review-prompt.ts";
import { parseReviewerVerdict } from "../engine/verdict.ts";

describe("renderReviewPrompt — thin review-request assembly", () => {
  it("renders the PR context block from the input", () => {
    const p = renderReviewPrompt({ owner: "cliftonc", repo: "drizzle-cube", prNumber: 941 });
    expect(p).toContain("repository: cliftonc/drizzle-cube");
    expect(p).toContain("prNumber: 941");
  });

  it("includes the trigger line only when triggerType is set", () => {
    const withTrigger = renderReviewPrompt({
      owner: "o",
      repo: "r",
      prNumber: 1,
      triggerType: "webhook",
    });
    expect(withTrigger).toContain("trigger: webhook");

    const without = renderReviewPrompt({ owner: "o", repo: "r", prNumber: 1 });
    expect(without).not.toContain("trigger:");
  });

  it("pins the exact VERDICT output contract that parseReviewerVerdict consumes", () => {
    const p = renderReviewPrompt({ owner: "o", repo: "r", prNumber: 1 });
    expect(p).toContain("VERDICT: APPROVED");
    expect(p).toContain("VERDICT: REQUEST_CHANGES");
    // The marker strings the prompt instructs must be parseable by the contract.
    expect(parseReviewerVerdict("VERDICT: APPROVED").verdict).toBe("APPROVED");
    expect(parseReviewerVerdict("VERDICT: REQUEST_CHANGES").verdict).toBe("REQUEST_CHANGES");
  });

  it("is pure — same input yields identical output", () => {
    const a = renderReviewPrompt({ owner: "o", repo: "r", prNumber: 7 });
    const b = renderReviewPrompt({ owner: "o", repo: "r", prNumber: 7 });
    expect(a).toBe(b);
  });

  it("instructs the agent NOT to post the review itself (workflow posts deterministically)", () => {
    const p = renderReviewPrompt({ owner: "o", repo: "r", prNumber: 1 });
    expect(p).toMatch(/do not post the review yourself/i);
  });
});
