import { describe, expect, it } from "vitest";
import {
  formatPendingInputsSummary,
  formatPendingInputsLines,
  formatPendingInputsBudgetText,
} from "./pending-inputs.js";

describe("pending-inputs", () => {
  it("returns undefined when there are no queued inputs", () => {
    expect(formatPendingInputsSummary([])).toBeUndefined();
  });

  it("formats a single queued input", () => {
    expect(formatPendingInputsSummary(["check tests too"])).toBe(
      "Queued 1 follow-up: check tests too (Esc removes it)"
    );
  });

  it("formats multiple queued inputs using the latest preview", () => {
    expect(formatPendingInputsSummary(["one", "two"])).toBe(
      "Queued 2 follow-ups. Latest: two (Esc removes latest)"
    );
  });

  it("normalizes whitespace and truncates long previews", () => {
    const summary = formatPendingInputsSummary([
      "one",
      "  this is a very long   queued input that should be trimmed and normalized before display because it keeps going  ",
    ]);

    expect(summary).toContain("Queued 2 follow-ups. Latest:");
    expect(summary).toContain("...");
  });

  // FEATURE_149 Phase 2.2/2.3 (v0.7.38) — multi-line render contract.
  describe("formatPendingInputsLines", () => {
    it("returns empty array when queue is empty", () => {
      expect(formatPendingInputsLines([])).toEqual([]);
    });

    it("emits one entry per queued input with 1-based index and total", () => {
      const lines = formatPendingInputsLines(["alpha", "beta", "gamma"]);
      expect(lines).toHaveLength(3);
      expect(lines[0]).toEqual({ index: 1, total: 3, preview: "alpha" });
      expect(lines[1]).toEqual({ index: 2, total: 3, preview: "beta" });
      expect(lines[2]).toEqual({ index: 3, total: 3, preview: "gamma" });
    });

    it("normalizes whitespace and truncates long previews per entry", () => {
      const lines = formatPendingInputsLines([
        "  this is a very long   queued input that should be trimmed and normalized before display because it keeps going  ",
        "short",
      ]);
      expect(lines[0].preview).toContain("...");
      expect(lines[0].preview.length).toBeLessThanOrEqual(72);
      expect(lines[1].preview).toBe("short");
    });
  });

  // v0.7.42 layout bugfix — budget text mirrors QueuedCommandsSurface row
  // count exactly (N items + 1 hint row).
  describe("formatPendingInputsBudgetText", () => {
    it("returns undefined when the queue is empty", () => {
      expect(formatPendingInputsBudgetText([])).toBeUndefined();
    });

    it("emits one line per item plus a trailing hint line", () => {
      const text = formatPendingInputsBudgetText(["alpha", "beta"]);
      expect(text).toBeDefined();
      const rows = (text ?? "").split("\n");
      expect(rows).toHaveLength(3);
      expect(rows[0]).toBe("⏳ [1/2] alpha");
      expect(rows[1]).toBe("⏳ [2/2] beta");
      // Verbatim match — any drift here vs. QueuedCommandsSurface hint row
      // re-opens the v0.7.42 layout bug (budget under-reserves by 1 row).
      expect(rows[2]).toBe("  ↑ pull all into editor · Esc drops latest");
    });

    it("scales with queue depth so budget reserves N+1 rows", () => {
      const single = formatPendingInputsBudgetText(["one"]) ?? "";
      const double = formatPendingInputsBudgetText(["one", "two"]) ?? "";
      const triple = formatPendingInputsBudgetText(["one", "two", "three"]) ?? "";
      expect(single.split("\n")).toHaveLength(2);
      expect(double.split("\n")).toHaveLength(3);
      expect(triple.split("\n")).toHaveLength(4);
    });
  });
});
