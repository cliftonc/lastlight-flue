import { describe, it, expect } from "vitest";
import { table, age, colorStatus, checkmark } from "./cli-format.ts";

// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("table", () => {
  it("renders an aligned text table with a header row", () => {
    const out = stripAnsi(
      table(
        [
          { id: "a", name: "alpha" },
          { id: "bb", name: "b" },
        ],
        [
          { key: "id", header: "ID" },
          { key: "name", header: "NAME" },
        ],
      ),
    );
    const lines = out.split("\n");
    expect(lines[0]).toContain("ID");
    expect(lines[0]).toContain("NAME");
    expect(lines).toHaveLength(3); // header + 2 rows
    // columns are padded to the widest cell (id column ≥ 2 wide)
    expect(lines[1]).toMatch(/^a /);
  });

  it("returns a dim placeholder for an empty table", () => {
    expect(stripAnsi(table([], [{ key: "x", header: "X" }]))).toBe("(none)");
  });

  it("ignores ANSI codes when measuring column width", () => {
    // a colored cell must not blow out alignment — width is measured on the
    // stripped string.
    const colored = "\x1b[32mok\x1b[39m"; // green "ok"
    const out = stripAnsi(
      table([{ s: colored }, { s: "longer-cell" }], [{ key: "s", header: "S" }]),
    );
    const lines = out.split("\n");
    // both data rows present, "ok" padded to the wider column
    expect(lines[1]).toContain("ok");
  });
});

describe("age", () => {
  it("formats relative ages from an ISO timestamp", () => {
    const now = Date.now();
    expect(age(new Date(now - 5_000).toISOString())).toMatch(/^\d+s ago$/);
    expect(age(new Date(now - 5 * 60_000).toISOString())).toMatch(/^\d+m ago$/);
    expect(age(new Date(now - 5 * 3_600_000).toISOString())).toMatch(/^\d+h ago$/);
    expect(age(new Date(now - 5 * 86_400_000).toISOString())).toMatch(/^\d+d ago$/);
  });

  it("accepts unix-seconds numbers", () => {
    const secs = Math.floor(Date.now() / 1000) - 120;
    expect(age(secs)).toMatch(/^\d+m ago$/);
  });

  it("returns empty for null/undefined/empty", () => {
    expect(age(null)).toBe("");
    expect(age(undefined)).toBe("");
    expect(age("")).toBe("");
  });

  it("echoes an unparseable value verbatim", () => {
    expect(age("not-a-date")).toBe("not-a-date");
  });
});

describe("colorStatus", () => {
  it("colors known statuses and passes unknown through unchanged", () => {
    expect(stripAnsi(colorStatus("succeeded"))).toBe("succeeded");
    expect(stripAnsi(colorStatus("failed"))).toBe("failed");
    expect(stripAnsi(colorStatus("running"))).toBe("running");
    expect(stripAnsi(colorStatus("weird"))).toBe("weird");
    expect(colorStatus(null)).toBe("");
  });
});

describe("checkmark", () => {
  it("maps success/failure/unknown to glyphs", () => {
    expect(stripAnsi(checkmark(true))).toBe("✓");
    expect(stripAnsi(checkmark(false))).toBe("✗");
    expect(stripAnsi(checkmark(undefined))).toBe("…");
  });
});
