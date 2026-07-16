import { describe, expect, it } from "vitest";

import { computeScrollState, type ScrollComputeInput } from "./scroll-state.js";

// FEATURE_214 (v0.7.46) — differential gate for the scroll-position math the
// overscan / React-bypass refactor will modify. These pin the EXACT current
// behaviour (extracted byte-for-byte from render-node-to-output.js) so the
// refactor can't silently change clamping, sticky-follow, child translation,
// or DECSTBM-hint capture. ink-testing-library can't reproduce the real scroll
// pipeline, so this pure function is the faithful unit gate.

const base: ScrollComputeInput = {
  rawScrollTop: 0,
  contentHeight: 100,
  viewportHeight: 20,
  previousScrollHeight: 100,
  stickyScroll: false,
  virtualScrollWindowed: false,
  previousAppliedScrollTop: undefined,
  regionTop: 5,
};

describe("computeScrollState (FEATURE_214 gate)", () => {
  it("non-windowed translates children by the applied scroll (scrollOffsetY)", () => {
    const r = computeScrollState({ ...base, rawScrollTop: 30 });
    expect(r.scrollOffsetY).toBe(30);
    expect(r.viewportTop).toBe(30);
    expect(r.scrollTop).toBe(30);
    expect(r.appliedScrollTop).toBe(30);
    expect(r.scrollHeight).toBe(100);
  });

  it("windowed without an in-block offset does not translate (back-compat)", () => {
    const r = computeScrollState({ ...base, rawScrollTop: 30, virtualScrollWindowed: true });
    expect(r.scrollOffsetY).toBe(0); // content renders at offset 0
    // FEATURE_212: appliedScrollTop tracks the WINDOW shift (not 0), so the
    // streaming-scroll DECSTBM hint keeps firing. Regressing this to 0 silently
    // drops FEATURE_212's hardware scroll — the tui suite does NOT catch it.
    expect(r.appliedScrollTop).toBe(30);
    expect(r.viewportTop).toBe(30);
  });

  it("windowed no-overscan still emits the streaming-shift hint (FEATURE_212 preserved)", () => {
    // Sticky-follow during streaming: clampedViewportTop grew from 22 → 30.
    const r = computeScrollState({
      ...base,
      rawScrollTop: 30,
      virtualScrollWindowed: true,
      previousAppliedScrollTop: 22,
      regionTop: 5,
    });
    expect(r.scrollHint).toEqual({ top: 5, bottom: 24, delta: 8 });
  });

  it("windowed-overscan translates the block by the in-block offset", () => {
    const r = computeScrollState({
      ...base,
      rawScrollTop: 30,
      virtualScrollWindowed: true,
      inWindowScrollTop: 12,
    });
    expect(r.scrollOffsetY).toBe(12); // block translated by the in-block offset
    expect(r.appliedScrollTop).toBe(12);
    expect(r.viewportTop).toBe(30); // global position (for hit-test) unchanged
  });

  it("windowed-overscan hint tracks the in-block translation, not the global scroll", () => {
    const r = computeScrollState({
      ...base,
      rawScrollTop: 30,
      virtualScrollWindowed: true,
      inWindowScrollTop: 12,
      previousAppliedScrollTop: 5,
      regionTop: 5,
    });
    expect(r.scrollHint).toEqual({ top: 5, bottom: 24, delta: 7 }); // 12 - 5
  });

  it("clamps the requested scroll to [0, contentHeight - viewportHeight]", () => {
    expect(computeScrollState({ ...base, rawScrollTop: 9999 }).viewportTop).toBe(80); // 100 - 20
    expect(computeScrollState({ ...base, rawScrollTop: -50 }).viewportTop).toBe(0);
  });

  it("sticky follows the bottom (max scroll) when content did not shrink", () => {
    const r = computeScrollState({ ...base, rawScrollTop: 10, stickyScroll: true });
    expect(r.viewportTop).toBe(80); // pinned to max regardless of rawScrollTop
  });

  it("sticky does NOT follow when content shrank below the cached height", () => {
    const r = computeScrollState({
      ...base,
      rawScrollTop: 10,
      stickyScroll: true,
      contentHeight: 100,
      previousScrollHeight: 200, // shrank → don't snap to bottom
    });
    expect(r.viewportTop).toBe(10);
  });

  it("honours clampMin / clampMax bounds", () => {
    expect(computeScrollState({ ...base, rawScrollTop: 0, clampMin: 15 }).viewportTop).toBe(15);
    expect(computeScrollState({ ...base, rawScrollTop: 70, clampMax: 40 }).viewportTop).toBe(40);
  });

  it("emits a DECSTBM hint when the applied scroll position moved", () => {
    const r = computeScrollState({ ...base, rawScrollTop: 30, previousAppliedScrollTop: 22, regionTop: 5 });
    expect(r.scrollHint).toEqual({ top: 5, bottom: 24, delta: 8 }); // bottom = 5 + 20 - 1
  });

  it("no hint on first paint (previousAppliedScrollTop undefined)", () => {
    expect(computeScrollState({ ...base, rawScrollTop: 30 }).scrollHint).toBeNull();
  });

  it("no hint when the applied position is unchanged", () => {
    expect(
      computeScrollState({ ...base, rawScrollTop: 30, previousAppliedScrollTop: 30 }).scrollHint,
    ).toBeNull();
  });

  it("no hint when the viewport is empty", () => {
    expect(
      computeScrollState({ ...base, rawScrollTop: 30, viewportHeight: 0, previousAppliedScrollTop: 10 }).scrollHint,
    ).toBeNull();
  });
});
