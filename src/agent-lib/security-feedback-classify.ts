/**
 * The security-feedback classification contract — the prompt↔code seam.
 *
 * WHY a marker + deterministic action (rather than the reference's agent-calls-github_*-
 * tools shape): the reference `security-feedback` skill is an AGENT-DRIVEN pass — the agent
 * parses the parent issue, classifies the comment, and calls `github_create_issue` /
 * `github_update_issue` itself. We keep the JUDGMENT agent-side (classify the comment's
 * intent, read the selection the maintainer expressed), but pull the SIDE EFFECTS out of
 * the model surface: the agent ends with a `FEEDBACK:` marker (intent + selection), and the
 * WORKFLOW creates the sub-issues / rewrites the parent / posts the summary deterministically
 * over the bound `issues-write` token (spec/09: owner/repo/issue/token are NEVER
 * model-selectable). This mirrors the pr-review `VERDICT:`→post and issue-triage
 * `CLASSIFICATION:`→apply splits and makes the action fully offline-testable.
 *
 * The selection grammar follows SKILL.md §3 create-issues "Resolve the selection".
 */
import type { ParsedFinding } from "./security-feedback-parse.ts";

/** The single best-fit comment intent (SKILL.md §2). */
export type FeedbackIntent =
  | "create-issues"
  | "accept-risk"
  | "false-positive"
  | "reopen"
  | "discuss"
  | "ignore";

/** The selection qualifier for a create-issues request (SKILL.md §3 "Resolve the selection"). */
export type SelectionKind = "ticked" | "all" | "severity" | "items";

/** A parsed feedback classification — the structured decision the workflow acts on. */
export interface FeedbackClassification {
  intent: FeedbackIntent;
  /** For create-issues: how findings were selected. */
  selection?: SelectionKind;
  /** For selection=severity: the chosen severity label. */
  severity?: "p0-critical" | "p1-high" | "p2-medium" | "p3-low";
  /** For selection=items: the explicit 1-based item numbers. */
  items?: number[];
  /** The original selection text (for the empty-selection message). */
  selectionText?: string;
}

export interface ParsedFeedback {
  classification: FeedbackClassification;
  /** The marker was missing / unparseable → conservative `discuss` fallback. */
  viaFallback: boolean;
}

/** The marker line the feedback prompt asks the agent to emit. First matching line wins. */
const MARKER_RE = /^\s*FEEDBACK:\s*(.+?)\s*$/im;

const INTENTS: readonly FeedbackIntent[] = [
  "create-issues",
  "accept-risk",
  "false-positive",
  "reopen",
  "discuss",
  "ignore",
];

const SEVERITY_WORD: Readonly<Record<string, FeedbackClassification["severity"]>> = {
  criticals: "p0-critical",
  critical: "p0-critical",
  "p0-critical": "p0-critical",
  highs: "p1-high",
  high: "p1-high",
  "p1-high": "p1-high",
  mediums: "p2-medium",
  medium: "p2-medium",
  "p2-medium": "p2-medium",
  lows: "p3-low",
  low: "p3-low",
  "p3-low": "p3-low",
};

/**
 * Parse the `FEEDBACK:` marker. Returns the structured decision plus `viaFallback` when the
 * marker is absent/unparseable (degrades to `discuss` — the safe conversational branch, per
 * SKILL.md §2 "fall through to discuss if unresolved"). Never throws.
 *
 * Shape examples:
 *   FEEDBACK: intent=create-issues selection=ticked
 *   FEEDBACK: intent=create-issues selection=all
 *   FEEDBACK: intent=create-issues selection=severity severity=p0-critical
 *   FEEDBACK: intent=create-issues selection=items items=1,3,5
 *   FEEDBACK: intent=accept-risk item=2
 *   FEEDBACK: intent=discuss
 *   FEEDBACK: intent=ignore
 */
export function parseFeedbackMarker(output: string): ParsedFeedback {
  const m = output.match(MARKER_RE);
  if (!m) return { classification: { intent: "discuss" }, viaFallback: true };

  const rest = m[1]!;
  const intentMatch = rest.match(/\bintent=([a-z-]+)/i);
  const intent = intentMatch?.[1]?.toLowerCase() as FeedbackIntent | undefined;
  if (!intent || !INTENTS.includes(intent)) {
    return { classification: { intent: "discuss" }, viaFallback: true };
  }

  if (intent !== "create-issues") {
    return { classification: { intent }, viaFallback: false };
  }

  // create-issues: resolve the selection grammar.
  const selectionRaw = rest.match(/\bselection=([a-z-]+)/i)?.[1]?.toLowerCase();
  const itemsRaw = rest.match(/\bitems=([0-9, ]+)/i)?.[1];
  const sevRaw = rest.match(/\bseverity=([a-z0-9-]+)/i)?.[1]?.toLowerCase();

  if (selectionRaw === "all" || selectionRaw === "every") {
    return {
      classification: { intent, selection: "all", selectionText: "all" },
      viaFallback: false,
    };
  }
  if (selectionRaw === "items" && itemsRaw) {
    const items = itemsRaw
      .split(/[, ]+/)
      .map((s) => Number(s))
      .filter((n) => Number.isInteger(n) && n > 0);
    return {
      classification: { intent, selection: "items", items, selectionText: `items ${items.join(", ")}` },
      viaFallback: false,
    };
  }
  if (selectionRaw === "severity" && sevRaw && SEVERITY_WORD[sevRaw]) {
    return {
      classification: {
        intent,
        selection: "severity",
        severity: SEVERITY_WORD[sevRaw],
        selectionText: sevRaw,
      },
      viaFallback: false,
    };
  }
  // Default / unqualified → treat as ticked (SKILL.md §3 "Default (no qualifier) → ticked").
  return {
    classification: { intent, selection: "ticked", selectionText: "ticked" },
    viaFallback: false,
  };
}

/**
 * Resolve which findings a create-issues classification selects, per SKILL.md §3
 * "Resolve the selection". Findings already broken out are SILENTLY dropped (returned in
 * `skipped`) regardless of the selection — broken-out rows are immutable.
 *
 * Returns the candidate findings to break out + the ones dropped because they're already
 * broken out (for the summary message).
 */
export function resolveSelection(
  classification: FeedbackClassification,
  findings: ParsedFinding[],
): { selected: ParsedFinding[]; skippedAlreadyBrokenOut: ParsedFinding[] } {
  const candidates = (() => {
    switch (classification.selection) {
      case "all":
        return findings.slice();
      case "severity":
        return findings.filter((f) => f.severity === classification.severity);
      case "items": {
        const wanted = new Set(classification.items ?? []);
        return findings.filter((f) => wanted.has(f.item));
      }
      case "ticked":
      default:
        return findings.filter((f) => f.userTicked);
    }
  })();

  const skippedAlreadyBrokenOut = candidates.filter((f) => f.alreadyBrokenOut);
  const selected = candidates.filter((f) => !f.alreadyBrokenOut);
  return { selected, skippedAlreadyBrokenOut };
}

/** Strip the `FEEDBACK:` marker line from the agent output, leaving the human-facing reply body. */
export function extractFeedbackReply(output: string): string {
  const lines = output.split(/\r?\n/);
  const idx = lines.findIndex((l) => /^\s*FEEDBACK:\s*\S/i.test(l));
  if (idx >= 0) lines.splice(idx, 1);
  return lines.join("\n").trim();
}
