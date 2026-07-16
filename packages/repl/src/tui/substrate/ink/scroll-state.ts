/**
 * Pure scroll-position computation for the `overflowY:'scroll'` render path
 * (FEATURE_214, v0.7.46 — extracted from `render-node-to-output.js`).
 *
 * `renderNodeToOutput` mutates the live DOM node + a module-level scroll-hint
 * during the tree walk, which makes the scroll math impossible to unit-test
 * faithfully (ink-testing-library does not reproduce the real scroll pipeline).
 * This isolates the math as a total, side-effect-free function so the
 * FEATURE_214 overscan/React-bypass refactor has a real differential gate.
 *
 * Behaviour is byte-for-byte the pre-extraction logic; the caller applies the
 * returned values to the node. The overscan refactor changes ONLY this function
 * (+ its tests), never the node-mutation glue.
 */

import type { ScrollHint } from "./frame.js";

export interface ScrollComputeInput {
  /** Raw requested scroll position (node.scrollTop ?? attr.scrollTop ?? 0). */
  readonly rawScrollTop: number;
  /** Total scrollable content height in rows (already floored by the caller). */
  readonly contentHeight: number;
  /** Visible inner height (rows), excluding borders. */
  readonly viewportHeight: number;
  /** The node's previously-cached scrollHeight (for sticky grow detection). */
  readonly previousScrollHeight: number;
  /** Follow-bottom flag. */
  readonly stickyScroll: boolean;
  /** Optional virtual-scroll clamp bounds. */
  readonly clampMin?: number;
  readonly clampMax?: number;
  /** True when only the visible window is rendered (managed transcript). */
  readonly virtualScrollWindowed: boolean;
  /**
   * FEATURE_214 (v0.7.46) — windowed-overscan in-block translation. When the
   * windowed content is an OVERSCAN BLOCK (visible rows + margin above/below),
   * this is how far down within that block the viewport sits (0..2*overscan).
   * Scrolling within the block changes ONLY this value → the block translates
   * via `scrollOffsetY` (→ scrollHint → DECSTBM) with no React re-render.
   * Ignored when not windowed. Defaults to 0 (= the pre-overscan behaviour where
   * the window == the viewport and never translates).
   */
  readonly inWindowScrollTop?: number;
  /** node.appliedScrollTop from the previous frame (undefined on first paint). */
  readonly previousAppliedScrollTop: number | undefined;
  /** Absolute screen row of the viewport's top (y + borderTop) — for the hint. */
  readonly regionTop: number;
}

export interface ScrollComputeResult {
  /** Value to write to node.scrollHeight. */
  readonly scrollHeight: number;
  /** Value to write to node.scrollViewportTop (the applied logical scroll). */
  readonly viewportTop: number;
  /** Value to write to node.appliedScrollTop. */
  readonly appliedScrollTop: number;
  /** Value to write to node.scrollTop. */
  readonly scrollTop: number;
  /** Vertical translation applied to children during paint (0 when windowed). */
  readonly scrollOffsetY: number;
  /** DECSTBM hint when the applied scroll position moved, else null. */
  readonly scrollHint: ScrollHint | null;
}

/**
 * Compute the applied scroll position + DECSTBM hint + child translation for a
 * scroll container. Pure: no node/DOM/global mutation.
 */
export function computeScrollState(input: ScrollComputeInput): ScrollComputeResult {
  const {
    rawScrollTop,
    contentHeight,
    viewportHeight,
    previousScrollHeight,
    stickyScroll,
    clampMin,
    clampMax,
    virtualScrollWindowed,
    inWindowScrollTop,
    previousAppliedScrollTop,
    regionTop,
  } = input;

  const maxScrollTop = Math.max(0, contentHeight - viewportHeight);
  const normalizedScrollTop = Math.max(0, Math.min(Math.floor(rawScrollTop), maxScrollTop));
  const shouldFollowBottom = stickyScroll && contentHeight >= previousScrollHeight;
  const logicalScrollTop = shouldFollowBottom ? maxScrollTop : normalizedScrollTop;
  const clampedViewportTop = clampMin !== undefined || clampMax !== undefined
    ? Math.max(clampMin ?? 0, Math.min(logicalScrollTop, Math.min(maxScrollTop, clampMax ?? maxScrollTop)))
    : logicalScrollTop;

  // Overscan is "active" only when the caller actually supplies an in-block
  // offset (the FEATURE_214 wiring). Until then every existing scroll box keeps
  // its pre-FEATURE_214 behaviour exactly.
  const overscanActive = virtualScrollWindowed && inWindowScrollTop !== undefined;
  const inWindowOffset = Math.max(0, Math.floor(inWindowScrollTop ?? 0));

  // The actual vertical translation applied to children during paint:
  // - non-windowed: translate the whole mounted content by the logical scroll.
  // - windowed-overscan: translate the rendered block by the in-block offset.
  // - windowed no-overscan: content renders at offset 0 (window == viewport).
  const scrollOffsetY = virtualScrollWindowed
    ? (overscanActive ? inWindowOffset : 0)
    : clampedViewportTop;

  // `appliedScrollTop` = the on-screen shift the DECSTBM hint reflects:
  // - non-windowed / windowed-overscan: equals the child translation.
  // - windowed no-overscan (FEATURE_212): the content renders at offset 0, but
  //   the re-windowed VIEW scrolled by `clampedViewportTop` (e.g. sticky follows
  //   the bottom while streaming) — the hint must track THAT shift so streaming
  //   scroll keeps its hardware-scroll fast path. MUST stay `clampedViewportTop`
  //   here or FEATURE_212's streaming DECSTBM silently regresses to full repaint.
  const appliedScrollTop = overscanActive ? scrollOffsetY : clampedViewportTop;

  let scrollHint: ScrollHint | null = null;
  if (
    previousAppliedScrollTop !== undefined &&
    previousAppliedScrollTop !== appliedScrollTop &&
    viewportHeight > 0
  ) {
    const regionBottom = regionTop + viewportHeight - 1;
    if (regionBottom >= regionTop) {
      scrollHint = {
        top: regionTop,
        bottom: regionBottom,
        delta: appliedScrollTop - previousAppliedScrollTop,
      };
    }
  }

  return {
    scrollHeight: contentHeight,
    viewportTop: clampedViewportTop,
    appliedScrollTop,
    scrollTop: clampedViewportTop,
    scrollOffsetY,
    scrollHint,
  };
}
