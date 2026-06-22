/**
 * The triage classification contract — the prompt↔code seam for `issue-triage`.
 *
 * WHY a marker + deterministic post (rather than the reference's agent-applies-
 * labels-via-tools shape):
 *   The reference `issue-triage` (~/work/lastlight) is an AGENT-DRIVEN single pass
 *   — the agent calls `github_*` write tools to add labels / comment / close inside
 *   the session. We keep the JUDGMENT agent-side (it reads the issue, searches for
 *   duplicates, decides the state machine), but pull the SIDE EFFECT out of the
 *   model surface: the agent ends with a `CLASSIFICATION:` marker (category + state
 *   + optional close/duplicate-of), and the WORKFLOW applies the labels / close
 *   deterministically over the bound, repo-scoped `issues-write` token — mirroring
 *   the pr-review `VERDICT:`→deterministic-post split (spec/09 security spine:
 *   owner/repo/issue/token are NEVER model-selectable; only the classification
 *   payload is). This keeps the label set the skill defines (the canonical state
 *   machine) and makes the action fully offline-testable.
 *
 * The canonical label vocabulary is the `issue-triage` SKILL.md state machine:
 *   category: bug | enhancement                                   (exactly one, or
 *             question — a question is neither a bug nor an enhancement)
 *   state:    needs-triage | needs-info | ready-for-agent |
 *             ready-for-human | wontfix                           (exactly one)
 *   + `duplicate` (dedupe) / `question` (question) as needed.
 *
 * Parsing mirrors `parseReviewerVerdict`: the marker is matched on the FIRST
 * matching line; everything after the marker is the human-facing comment body.
 */

/** Canonical category roles (SKILL.md). `question` is the not-work category. */
export type TriageCategory = "bug" | "enhancement" | "question";

/** Canonical state roles (SKILL.md). */
export type TriageState =
  | "needs-triage"
  | "needs-info"
  | "ready-for-agent"
  | "ready-for-human"
  | "wontfix";

const CATEGORIES: readonly TriageCategory[] = ["bug", "enhancement", "question"];
const STATES: readonly TriageState[] = [
  "needs-triage",
  "needs-info",
  "ready-for-agent",
  "ready-for-human",
  "wontfix",
];

/**
 * A parsed triage classification — the structured decision the workflow applies.
 */
export interface TriageClassification {
  /** The category role. `question` carries no separate state. */
  category: TriageCategory;
  /** The state role. Absent for a pure `question` (a question is not work). */
  state?: TriageState;
  /** Whether the issue is a duplicate (adds the `duplicate` label). */
  duplicate: boolean;
  /** Whether the workflow should close the issue (duplicate / already-implemented). */
  close: boolean;
}

export interface ParsedTriage {
  classification: TriageClassification;
  /** The marker was missing / unparseable → conservative `needs-triage` fallback. */
  viaFallback: boolean;
}

/**
 * The marker line the triage prompt asks the agent to emit, e.g.
 *
 *     CLASSIFICATION: category=bug state=ready-for-agent
 *     CLASSIFICATION: category=enhancement state=needs-info
 *     CLASSIFICATION: category=question
 *     CLASSIFICATION: category=bug state=wontfix duplicate close
 *
 * Keys are `category=<role>` and (unless a pure question) `state=<role>`; the bare
 * flags `duplicate` and `close` are optional. Matched on the first matching line,
 * case-insensitive on the keyword.
 */
const MARKER_RE = /^\s*CLASSIFICATION:\s*(.+?)\s*$/im;

/** Conservative fallback when the marker is missing — leave it for evaluation. */
const FALLBACK: TriageClassification = {
  category: "bug",
  state: "needs-triage",
  duplicate: false,
  close: false,
};

/**
 * Parse the triage classification marker. Returns the structured decision plus a
 * `viaFallback` flag when the marker was absent or unparseable (mirrors
 * `parseReviewerVerdict`). Never throws — an unparseable agent output degrades to
 * a safe `needs-triage` classification the workflow can still act on.
 */
export function parseTriageClassification(output: string): ParsedTriage {
  const m = output.match(MARKER_RE);
  if (!m) return { classification: { ...FALLBACK }, viaFallback: true };

  const rest = m[1]!;
  const categoryMatch = rest.match(/\bcategory=([a-z-]+)/i);
  const stateMatch = rest.match(/\bstate=([a-z-]+)/i);
  const duplicate = /\bduplicate\b/i.test(rest);
  const close = /\bclose\b/i.test(rest);

  const category = categoryMatch?.[1]?.toLowerCase() as TriageCategory | undefined;
  const state = stateMatch?.[1]?.toLowerCase() as TriageState | undefined;

  if (!category || !CATEGORIES.includes(category)) {
    return { classification: { ...FALLBACK }, viaFallback: true };
  }

  // A question is not work: it carries no state role (SKILL.md §1.3).
  if (category === "question") {
    return {
      classification: { category, duplicate, close },
      viaFallback: false,
    };
  }

  if (!state || !STATES.includes(state)) {
    // Category present but state missing/invalid → conservative needs-triage.
    return {
      classification: { category, state: "needs-triage", duplicate, close },
      viaFallback: true,
    };
  }

  return { classification: { category, state, duplicate, close }, viaFallback: false };
}

/**
 * The deterministic classification→label mapping. Returns the FULL set of triage
 * labels to apply, in a stable order: category label first, then state label, then
 * `duplicate`. `question` maps to the `question` label (and no state label).
 *
 * Canonical label STRINGS are the SKILL.md §0 vocabulary. The workflow applies
 * these idempotently (GitHub's addLabels is a no-op for already-present labels);
 * create-if-missing is handled by the deterministic poster (matching the skill's
 * "ensure the labels exist" step).
 */
export function classificationToLabels(c: TriageClassification): string[] {
  const labels: string[] = [];
  if (c.category === "question") {
    labels.push("question");
  } else {
    labels.push(c.category);
    if (c.state) labels.push(c.state);
  }
  if (c.duplicate) labels.push("duplicate");
  return labels;
}

/**
 * Strip the `CLASSIFICATION:` marker line from the agent output, leaving the
 * human-facing triage comment body (mirrors `extractReviewBody`). Removes exactly
 * the first matching marker line; the remainder (trimmed) is the comment the
 * workflow posts when the classification calls for one (needs-info, duplicate,
 * out-of-scope reasoning, etc.).
 */
export function extractTriageComment(output: string): string {
  const lines = output.split(/\r?\n/);
  const idx = lines.findIndex((l) => /^\s*CLASSIFICATION:\s*\S/i.test(l));
  if (idx >= 0) lines.splice(idx, 1);
  return lines.join("\n").trim();
}

/** The canonical label color map (SKILL.md §0) — used for create-if-missing. */
export const TRIAGE_LABEL_COLORS: Readonly<Record<string, string>> = {
  bug: "d73a4a",
  enhancement: "a2eeef",
  "needs-triage": "ededed",
  "needs-info": "fbca04",
  "ready-for-agent": "0e8a16",
  "ready-for-human": "1d76db",
  wontfix: "ffffff",
  duplicate: "cfd3d7",
  question: "d876e3",
};
