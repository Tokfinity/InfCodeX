/**
 * FEATURE_172 v0.7.41 — Layer 0 G4 edge-case 补强 for hit-test.
 *
 * Existing hit-test.test.ts covers happy path (basic mapping, clamp,
 * CJK grapheme). These 9 boundary cases lock pixel-level behavior that
 * D2.C must preserve when migrating from TranscriptScreenBuffer to
 * claudecode nodeCache + raw cell read.
 *
 * Each test names the boundary it pins. If any of these change behavior
 * during Phases 1-5, the D2.C migration has produced a visible
 * regression — root-cause before updating the test.
 */
import { describe, expect, it } from "vitest";
import { buildTranscriptScreenBuffer } from "./screen.js";
import { clampTranscriptScreenHit, hitTestTranscriptScreen } from "./hit-test.js";

describe("transcript hit-test edge cases", () => {
  it("hit beyond rightmost text column clamps to text end", () => {
    const buffer = buildTranscriptScreenBuffer([{ key: "row-1", text: "hello" }]);
    // Row text "hello" occupies cols 1-5, textStartColumn=1
    // Click at column 999 (way beyond) should clamp to end-of-text index 5
    const hit = hitTestTranscriptScreen(buffer, 1, 999);
    expect(hit?.point.column).toBe(5);
  });

  it("hit at first text column returns column 0", () => {
    const buffer = buildTranscriptScreenBuffer([{ key: "row-1", text: "hello" }]);
    const hit = hitTestTranscriptScreen(buffer, 1, 1);
    expect(hit?.point.column).toBe(0);
  });

  it("hit at column 0 (before first text column) treats safe-min as col 1", () => {
    // hit-test internally Math.max(1, floor(column)) so column 0 == column 1
    const buffer = buildTranscriptScreenBuffer([{ key: "row-1", text: "hello" }]);
    const hit = hitTestTranscriptScreen(buffer, 1, 0);
    expect(hit?.point.column).toBe(0);
  });

  it("hit on indented row — clicking inside indent space resolves to col 0", () => {
    const buffer = buildTranscriptScreenBuffer([
      { key: "row-1", text: "hello", indent: 4 },
    ]);
    // textStartColumn = 1 + 4 indent = 5. Click at col 3 (inside indent gutter)
    // resolves to text col 0 (clamped to text-start).
    const hit = hitTestTranscriptScreen(buffer, 1, 3);
    expect(hit?.point.column).toBe(0);
  });

  it("hit on spinner row — clicking on spinner glyph resolves to col 0", () => {
    const buffer = buildTranscriptScreenBuffer([
      { key: "row-1", text: "loading", spinner: true },
    ]);
    // textStartColumn = 1 + 0 indent + 2 spinner = 3. Click on col 2 (spinner)
    // resolves to text col 0.
    const hit = hitTestTranscriptScreen(buffer, 1, 2);
    expect(hit?.point.column).toBe(0);
  });

  it("hit on row that doesn't exist returns undefined", () => {
    const buffer = buildTranscriptScreenBuffer([{ key: "row-1", text: "hello" }]);
    const hit = hitTestTranscriptScreen(buffer, 999, 3);
    expect(hit).toBeUndefined();
  });

  it("hit on empty buffer returns undefined", () => {
    const buffer = buildTranscriptScreenBuffer([]);
    expect(hitTestTranscriptScreen(buffer, 1, 1)).toBeUndefined();
    expect(clampTranscriptScreenHit(buffer, 1, 1)).toBeUndefined();
  });

  it("clamp above first row returns first-row hit at click column", () => {
    const buffer = buildTranscriptScreenBuffer([
      { key: "row-1", text: "alpha" },
      { key: "row-2", text: "beta" },
    ], { topOffsetRows: 5 });
    // topRow = 6. Click at row=1 (way above) clamps to first row.
    const hit = clampTranscriptScreenHit(buffer, 1, 3);
    expect(hit?.point.rowKey).toBe("row-1");
    expect(hit?.point.column).toBe(2);
  });

  it("clamp below last row returns last-row hit at click column", () => {
    const buffer = buildTranscriptScreenBuffer([
      { key: "row-1", text: "alpha" },
      { key: "row-2", text: "beta" },
    ]);
    // bottomRow = 2. Click at row=99 clamps to last row "beta".
    const hit = clampTranscriptScreenHit(buffer, 99, 2);
    expect(hit?.point.rowKey).toBe("row-2");
    expect(hit?.point.column).toBe(1);
  });

  it("hit on empty-text row resolves to column 0", () => {
    const buffer = buildTranscriptScreenBuffer([{ key: "row-1", text: "" }]);
    const hit = hitTestTranscriptScreen(buffer, 1, 5);
    expect(hit?.point.column).toBe(0);
  });
});
