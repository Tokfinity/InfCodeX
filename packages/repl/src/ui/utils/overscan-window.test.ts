import { describe, expect, it } from "vitest";

import {
  computeOverscanWindow,
  staysWithinOverscanBlock,
  OVERSCAN_ROWS,
  SCROLL_QUANTUM,
} from "./overscan-window.js";

// FEATURE_214 (v0.7.46) — pure overscan-window math. The wiring that consumes
// it (InkREPL scroll handler + ScrollBox node mutation) is NOT unit-testable
// (ink-testing-library can't reproduce the scroll paint), so this is where the
// risky math gets gated: block placement, in-block translation, quantum binning,
// and the coverage invariant.

describe("computeOverscanWindow (FEATURE_214)", () => {
  const base = { viewportHeight: 20, contentHeight: 1000, overscan: 80, quantum: 40 };

  it("renders a block of viewport + overscan above and below (mid-content)", () => {
    const w = computeOverscanWindow({ ...base, globalScrollTop: 400 });
    // bin = floor(400/40) = 10, anchor = 400
    expect(w.bin).toBe(10);
    expect(w.blockTop).toBe(320); // 400 - 80
    expect(w.blockHeight).toBe(180); // (400 + 20 + 80) - 320
    expect(w.inBlockOffset).toBe(80); // 400 - 320 — viewport sits below the top margin
  });

  it("clamps the block to the top of content (no negative blockTop)", () => {
    const w = computeOverscanWindow({ ...base, globalScrollTop: 10 });
    // bin = 0, anchor = 0, blockTop clamped to 0
    expect(w.blockTop).toBe(0);
    expect(w.inBlockOffset).toBe(10); // 10 - 0, no top margin available
  });

  it("clamps the block to the bottom of content", () => {
    const w = computeOverscanWindow({ ...base, globalScrollTop: 99999 });
    const maxScroll = 1000 - 20; // 980
    // clampedTop = 980, bin = floor(980/40) = 24, anchor = 960
    expect(w.bin).toBe(24);
    expect(w.blockTop).toBe(880); // 960 - 80
    expect(w.blockHeight).toBe(120); // min(1000, 960+20+80=1060) - 880 = 1000 - 880
    expect(w.inBlockOffset).toBe(100); // 980 - 880
  });

  it("keeps the SAME block (fixed blockTop) while translating within a bin", () => {
    const a = computeOverscanWindow({ ...base, globalScrollTop: 400 }); // bin 10
    const b = computeOverscanWindow({ ...base, globalScrollTop: 430 }); // still bin 10
    expect(a.bin).toBe(b.bin);
    expect(a.blockTop).toBe(b.blockTop); // block fixed
    expect(b.inBlockOffset - a.inBlockOffset).toBe(30); // only the translation moved
  });

  it("shifts the block when crossing a quantum boundary", () => {
    const a = computeOverscanWindow({ ...base, globalScrollTop: 439 }); // bin 10
    const b = computeOverscanWindow({ ...base, globalScrollTop: 440 }); // bin 11
    expect(a.bin).toBe(10);
    expect(b.bin).toBe(11);
    expect(b.blockTop).toBe(a.blockTop + 40); // shifted by one quantum
  });

  // THE safety invariant: the fixed block must cover the viewport for EVERY
  // scroll position within its bin, or the bottom rows would be blank between
  // re-windows. This holds iff overscan >= quantum.
  it("block always covers the viewport across its entire bin (overscan >= quantum)", () => {
    const cfg = { viewportHeight: 20, contentHeight: 100000, overscan: 80, quantum: 40 };
    for (let bin = 5; bin < 9; bin++) {
      // reference block at the bin anchor
      const at = computeOverscanWindow({ ...cfg, globalScrollTop: bin * cfg.quantum });
      const blockBottom = at.blockTop + at.blockHeight;
      for (let top = bin * cfg.quantum; top < (bin + 1) * cfg.quantum; top++) {
        const w = computeOverscanWindow({ ...cfg, globalScrollTop: top });
        expect(w.bin).toBe(bin); // same bin
        expect(w.blockTop).toBe(at.blockTop); // same block
        // viewport [top, top+vh) fully inside [blockTop, blockBottom)
        expect(top).toBeGreaterThanOrEqual(at.blockTop);
        expect(top + cfg.viewportHeight).toBeLessThanOrEqual(blockBottom);
      }
    }
  });

  it("inBlockOffset + viewport stays inside the block (no clipping) at the boundaries", () => {
    const w = computeOverscanWindow({ ...base, globalScrollTop: 400 });
    expect(w.inBlockOffset).toBeGreaterThanOrEqual(0);
    expect(w.inBlockOffset + base.viewportHeight).toBeLessThanOrEqual(w.blockHeight);
  });

  it("handles content shorter than the viewport (single tiny block)", () => {
    const w = computeOverscanWindow({ viewportHeight: 50, contentHeight: 10, globalScrollTop: 0 });
    expect(w.blockTop).toBe(0);
    expect(w.blockHeight).toBe(10);
    expect(w.inBlockOffset).toBe(0);
  });

  it("exposes claudecode-parity defaults", () => {
    expect(OVERSCAN_ROWS).toBe(80);
    expect(SCROLL_QUANTUM).toBe(40);
    expect(OVERSCAN_ROWS).toBeGreaterThanOrEqual(SCROLL_QUANTUM); // the invariant
  });
});

describe("staysWithinOverscanBlock (FEATURE_214 fast-path gate)", () => {
  const cfg = { viewportHeight: 20, contentHeight: 1000, overscan: 80, quantum: 40 };

  it("true for a small scroll within the same bin (React-bypass path)", () => {
    expect(staysWithinOverscanBlock(400, 415, cfg)).toBe(true);
  });

  it("false when the scroll crosses a quantum boundary (re-window path)", () => {
    expect(staysWithinOverscanBlock(439, 441, cfg)).toBe(false);
  });

  it("true for a no-op scroll", () => {
    expect(staysWithinOverscanBlock(400, 400, cfg)).toBe(true);
  });

  it("treats clamped-equal positions as the same block (bottom edge)", () => {
    // both clamp to maxScroll = 980 → same bin
    expect(staysWithinOverscanBlock(5000, 6000, cfg)).toBe(true);
  });
});
