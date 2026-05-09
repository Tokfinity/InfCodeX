import { describe, expect, it } from "vitest";
import {
  formatPendingInputsSummary,
  formatPendingInputsLines,
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
});
