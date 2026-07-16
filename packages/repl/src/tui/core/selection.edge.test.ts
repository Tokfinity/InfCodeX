/**
 * FEATURE_172 v0.7.41 — Layer 0 G4 edge-case 补强 for selection.
 *
 * Pins selection state-machine behavior at boundaries that the existing
 * selection.test.ts happy-path 3-test set doesn't cover. D2.C must
 * preserve every behavior here when porting claudecode's screen-coord
 * selection state machine.
 */
import { describe, expect, it } from "vitest";
import { buildTranscriptScreenSelection, buildTranscriptScreenSelectionSummary } from "./selection.js";

describe("transcript selection edge cases", () => {
  const rows = [
    { key: "row-1", text: "Alpha" },
    { key: "row-2", text: "Beta" },
    { key: "row-3", text: "Gamma" },
  ];

  it("reverse selection (focus before anchor) produces same text as forward", () => {
    const forward = buildTranscriptScreenSelection(
      rows,
      { rowKey: "row-1", modelRowIndex: 0, column: 1 },
      { rowKey: "row-3", modelRowIndex: 2, column: 4 },
    );
    const reverse = buildTranscriptScreenSelection(
      rows,
      { rowKey: "row-3", modelRowIndex: 2, column: 4 },
      { rowKey: "row-1", modelRowIndex: 0, column: 1 },
    );
    expect(forward?.text).toBe(reverse?.text);
    expect(forward?.charCount).toBe(reverse?.charCount);
    expect(forward?.rowRanges.get("row-2")).toEqual(reverse?.rowRanges.get("row-2"));
  });

  it("selection of full text of single row matches text length", () => {
    const sel = buildTranscriptScreenSelection(
      rows,
      { rowKey: "row-2", modelRowIndex: 1, column: 0 },
      { rowKey: "row-2", modelRowIndex: 1, column: 4 },
    );
    expect(sel?.text).toBe("Beta");
    expect(sel?.charCount).toBe(4);
    expect(sel?.rowRanges.size).toBe(1);
    expect(sel?.rowRanges.get("row-2")).toEqual({ start: 0, end: 4 });
  });

  it("single-character selection produces charCount=1", () => {
    const sel = buildTranscriptScreenSelection(
      rows,
      { rowKey: "row-1", modelRowIndex: 0, column: 2 },
      { rowKey: "row-1", modelRowIndex: 0, column: 3 },
    );
    expect(sel?.text).toBe("p");
    expect(sel?.charCount).toBe(1);
    expect(buildTranscriptScreenSelectionSummary(sel)).toBe("Selected 1 char");
  });

  it("selection beyond row text length clamps to text length", () => {
    const sel = buildTranscriptScreenSelection(
      rows,
      { rowKey: "row-1", modelRowIndex: 0, column: 2 },
      { rowKey: "row-1", modelRowIndex: 0, column: 999 },
    );
    expect(sel?.text).toBe("pha");
    expect(sel?.rowRanges.get("row-1")).toEqual({ start: 2, end: 5 });
  });

  it("selection starting at negative column clamps to 0", () => {
    const sel = buildTranscriptScreenSelection(
      rows,
      { rowKey: "row-1", modelRowIndex: 0, column: -5 },
      { rowKey: "row-1", modelRowIndex: 0, column: 3 },
    );
    expect(sel?.text).toBe("Alp");
    expect(sel?.rowRanges.get("row-1")).toEqual({ start: 0, end: 3 });
  });

  it("collapsed point with selectFullRowOnCollapsed=false returns undefined", () => {
    const sel = buildTranscriptScreenSelection(
      rows,
      { rowKey: "row-2", modelRowIndex: 1, column: 2 },
      { rowKey: "row-2", modelRowIndex: 1, column: 2 },
    );
    expect(sel).toBeUndefined();
  });

  it("collapsed point with selectFullRowOnCollapsed=true selects whole row", () => {
    const sel = buildTranscriptScreenSelection(
      rows,
      { rowKey: "row-2", modelRowIndex: 1, column: 2 },
      { rowKey: "row-2", modelRowIndex: 1, column: 2 },
      { selectFullRowOnCollapsed: true },
    );
    expect(sel?.text).toBe("Beta");
    expect(sel?.charCount).toBe(4);
  });

  it("selection ending exactly at column 0 of last row excludes that row", () => {
    // Selection: row-1 col 2 → row-3 col 0
    // row-1 contributes "pha", row-2 contributes "Beta" (full), row-3 contributes "" (empty)
    // → row-3 has zero-range so rowRanges does NOT include row-3
    const sel = buildTranscriptScreenSelection(
      rows,
      { rowKey: "row-1", modelRowIndex: 0, column: 2 },
      { rowKey: "row-3", modelRowIndex: 2, column: 0 },
    );
    expect(sel?.text).toBe("pha\nBeta\n");
    expect(sel?.rowRanges.has("row-1")).toBe(true);
    expect(sel?.rowRanges.has("row-2")).toBe(true);
    expect(sel?.rowRanges.has("row-3")).toBe(false); // zero-range row not in map
    // rowCount counts segments (3 lines visited even if last had no chars)
    expect(sel?.rowCount).toBe(3);
  });

  it("selection across empty row in middle preserves empty row in text", () => {
    const rowsWithEmpty = [
      { key: "row-1", text: "Alpha" },
      { key: "row-2", text: "" },
      { key: "row-3", text: "Gamma" },
    ];
    const sel = buildTranscriptScreenSelection(
      rowsWithEmpty,
      { rowKey: "row-1", modelRowIndex: 0, column: 2 },
      { rowKey: "row-3", modelRowIndex: 2, column: 3 },
    );
    expect(sel?.text).toBe("pha\n\nGam");
    expect(sel?.charCount).toBe(6);
    expect(sel?.rowRanges.has("row-2")).toBe(false); // empty row → no range
  });

  it("selection on empty rows array returns undefined", () => {
    const sel = buildTranscriptScreenSelection(
      [],
      { rowKey: "x", modelRowIndex: 0, column: 0 },
      { rowKey: "x", modelRowIndex: 0, column: 1 },
    );
    expect(sel).toBeUndefined();
  });

  it("selection with invalid modelRowIndex (out of bounds) returns undefined", () => {
    const sel = buildTranscriptScreenSelection(
      rows,
      { rowKey: "phantom", modelRowIndex: 99, column: 0 },
      { rowKey: "phantom", modelRowIndex: 99, column: 1 },
    );
    expect(sel).toBeUndefined();
  });

  it("summary for empty selection returns undefined", () => {
    expect(buildTranscriptScreenSelectionSummary(undefined)).toBeUndefined();
  });
});
