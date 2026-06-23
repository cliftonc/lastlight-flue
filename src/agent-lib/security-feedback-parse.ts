/**
 * Deterministic parser for the security-scan summary issue — APPLICATION code, never a
 * model tool.
 *
 * The scan-issue grammar is the CONTRACT between `security-review` (producer) and
 * `security-feedback` (consumer), defined in
 * `~/work/lastlight/skills/security-review/references/issue-format.md` and mirrored in the
 * `security-feedback` SKILL.md (§1). The reference skill parses this itself (it is staged
 * into a workspace and carries its own regex copy). Here we keep the parse DETERMINISTIC
 * in workflow code — the model classifies intent / selects findings, but the row/severity
 * grammar and the version check are machine-applied, not LLM-inferred (the same split as
 * triage's marker / pr-review's verdict: judgment is agent-side, the structured contract
 * is code).
 *
 * The grammar copy below is byte-faithful to the SKILL.md §1 regexes — if the grammar in
 * `src/skills/security-review/...` / `security-feedback/SKILL.md` changes, update this in
 * lockstep (the skill says so explicitly).
 */

/** The version marker every scan-summary body MUST start with (SKILL.md §1, issue-format §Block 1). */
export const SCAN_VERSION_MARKER = "<!-- lastlight-security-scan-version: 1 -->";

/** Severity roles, mapped from the section headers (SKILL.md §1 severity table). */
export type Severity = "p0-critical" | "p1-high" | "p2-medium" | "p3-low";

/**
 * The canonical finding-row regex (SKILL.md §1 / issue-format §Finding-row grammar) — covers
 * all three states (pending / user-ticked / broken-out). Multiline, case-sensitive.
 *
 * Captures: checkbox(` `|`x`), item, fp, title, file, line, tool, rule, subIssueNumber?.
 */
export const FINDING_ROW_RE =
  /^- \[([ x])\] <!-- item:(\d+) fp:([0-9a-f]{8,}) --> (?:~~)?\*\*(.+?)\*\* — `([^`]+):(\d+)` \(([a-z][a-z0-9-]*) · `([^`]+)`\)(?:~~ → #(\d+))?$/gm;

/**
 * The section-header regex (SKILL.md §1 / issue-format §Block 8) — tolerates a trailing
 * truncation suffix like `(showing first 7 of 25)`.
 */
export const SEVERITY_HEADER_RE =
  /^### (🔴|🟠|🟡|🟢) (Critical|High|Medium|Low) \((\d+)\)(?:\s.*)?$/gm;

/** Map a header severity word → the canonical severity label (SKILL.md §1). */
const SEVERITY_WORD_TO_LABEL: Readonly<Record<string, Severity>> = {
  Critical: "p0-critical",
  High: "p1-high",
  Medium: "p2-medium",
  Low: "p3-low",
};

/** A single parsed finding (SKILL.md §1 "Store each finding as …"). */
export interface ParsedFinding {
  /** 1-based item number from the `<!-- item:N -->` marker. */
  item: number;
  /** The finding fingerprint (lowercase hex, ≥ 8 chars). */
  fp: string;
  /** The finding title (plain text). */
  title: string;
  /** The file path. */
  file: string;
  /** The line number (0 when not line-scoped). */
  line: number;
  /** The tool that produced the finding (lowercase, hyphenated). */
  tool: string;
  /** The tool's native rule id. */
  rule: string;
  /** The severity, from the nearest preceding section header. */
  severity: Severity;
  /** True when this row has already been broken out to a sub-issue (immutable). */
  alreadyBrokenOut: boolean;
  /** The sub-issue number, present only when alreadyBrokenOut. */
  subIssueNumber?: number;
  /** The maintainer ticked the box AND it is not already broken out — the primary selection signal. */
  userTicked: boolean;
}

/** The outcome of parsing a scan-summary issue body. */
export interface ParsedScan {
  /** True when the body carries the supported version marker (SCAN_VERSION_MARKER). */
  versionOk: boolean;
  /** All findings parsed from the body, in document order. */
  findings: ParsedFinding[];
}

/**
 * Build the offset→severity index from the section headers, so each finding row can be
 * assigned the severity of its NEAREST preceding header (SKILL.md §1).
 */
function severityAtOffsets(body: string): { offset: number; severity: Severity }[] {
  const headers: { offset: number; severity: Severity }[] = [];
  // Fresh regex state per call (the shared RE is global/stateful).
  const re = new RegExp(SEVERITY_HEADER_RE.source, "gm");
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const label = SEVERITY_WORD_TO_LABEL[m[2]!];
    if (label) headers.push({ offset: m.index, severity: label });
  }
  return headers;
}

/** The severity of the nearest header preceding `offset` (default p3-low if none — defensive). */
function severityForOffset(
  headers: { offset: number; severity: Severity }[],
  offset: number,
): Severity {
  let sev: Severity = "p3-low";
  for (const h of headers) {
    if (h.offset <= offset) sev = h.severity;
    else break;
  }
  return sev;
}

/**
 * Parse the scan-summary issue body into a version flag + the findings.
 *
 * - `versionOk` is false when the body does not START with SCAN_VERSION_MARKER (after
 *   leading whitespace) — the workflow then refuses to parse further and replies with the
 *   SKILL.md §1 "unknown scan-summary format" message.
 * - Each finding's severity is derived from its nearest preceding section header.
 * - `userTicked` / `alreadyBrokenOut` are derived exactly per SKILL.md §1.
 *
 * Pure: same body → same result. Never throws.
 */
export function parseScanIssue(body: string): ParsedScan {
  const text = body ?? "";
  const versionOk = text.trimStart().startsWith(SCAN_VERSION_MARKER);
  if (!versionOk) return { versionOk: false, findings: [] };

  const headers = severityAtOffsets(text);
  const findings: ParsedFinding[] = [];
  const re = new RegExp(FINDING_ROW_RE.source, "gm");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const checkbox = m[1]!;
    const item = Number(m[2]);
    const fp = m[3]!;
    const title = m[4]!;
    const file = m[5]!;
    const line = Number(m[6]);
    const tool = m[7]!;
    const rule = m[8]!;
    const subIssueNumber = m[9] != null ? Number(m[9]) : undefined;
    const alreadyBrokenOut = subIssueNumber != null;
    const userTicked = checkbox === "x" && !alreadyBrokenOut;
    findings.push({
      item,
      fp,
      title,
      file,
      line,
      tool,
      rule,
      severity: severityForOffset(headers, m.index),
      alreadyBrokenOut,
      subIssueNumber,
      userTicked,
    });
  }
  return { versionOk: true, findings };
}

/** Count findings by severity (for the empty-selection summary message). */
export function severityCounts(findings: ParsedFinding[]): {
  critical: number;
  high: number;
  medium: number;
  low: number;
} {
  const c = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of findings) {
    if (f.severity === "p0-critical") c.critical++;
    else if (f.severity === "p1-high") c.high++;
    else if (f.severity === "p2-medium") c.medium++;
    else if (f.severity === "p3-low") c.low++;
  }
  return c;
}
