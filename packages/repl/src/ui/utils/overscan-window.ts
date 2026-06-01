/**
 * Overscan window math for transcript scroll (FEATURE_214, v0.7.46).
 *
 * The fullscreen transcript is a *windowed* renderer — it paints only the rows
 * near the viewport. Pre-FEATURE_214 the window == the viewport, so every wheel
 * tick re-resolved the window through React (the ~60ms/frame reconcile this
 * feature removes). FEATURE_214 renders a slightly larger OVERSCAN BLOCK
 * (viewport + margin above/below) and translates within it via the renderer's
 * `inWindowScrollTop`, so React only re-renders when the scroll crosses a
 * quantum boundary (a new block must be mounted). Mirrors claudecode's
 * `OVERSCAN_ROWS` / `SCROLL_QUANTUM` virtual-scroll model.
 *
 * This module is the PURE bridge: global viewport position → which block to
 * render + the in-block translation + the quantum bin React keys off. No React,
 * no DOM, no KodaX state — fully unit-testable (the wiring that consumes it is
 * not, since ink-testing-library can't reproduce the real scroll paint).
 *
 * Coordinate: `globalScrollTop` is the viewport's top row measured from the top
 * of the content (rows). The caller maps its own scroll model onto that.
 */

/**
 * Rows of margin rendered above AND below the viewport. MUST be >= SCROLL_QUANTUM
 * so the block keeps covering the viewport across an entire bin (proof in the
 * "block always covers the viewport within its bin" test). claudecode uses 80.
 */
export const OVERSCAN_ROWS = 80;

/**
 * Re-window granularity. React re-renders only when `floor(scrollTop/QUANTUM)`
 * changes; within a bin the scroll is a pure in-block translation (no React).
 * Larger = fewer React renders but a larger block to paint. claudecode uses 40.
 */
export const SCROLL_QUANTUM = 40;

export interface OverscanWindowInput {
  /** Viewport top row, from the top of the content (already the desired pos). */
  readonly globalScrollTop: number;
  /** Visible viewport height in rows. */
  readonly viewportHeight: number;
  /** Total scrollable content height in rows. */
  readonly contentHeight: number;
  /** Rows of margin above+below (defaults to OVERSCAN_ROWS). */
  readonly overscan?: number;
  /** Quantum bin size (defaults to SCROLL_QUANTUM). */
  readonly quantum?: number;
}

export interface OverscanWindow {
  /** First global row of the block to render. */
  readonly blockTop: number;
  /** Number of rows in the block (blockBottom - blockTop). */
  readonly blockHeight: number;
  /** Viewport top WITHIN the block — feeds renderer `inWindowScrollTop`. */
  readonly inBlockOffset: number;
  /** Quantum bin; React re-renders the block only when this changes. */
  readonly bin: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

/**
 * Resolve the overscan block + in-block translation + quantum bin for a global
 * viewport position. Pure.
 *
 * The block is anchored on the bin (not on the live scrollTop) so it stays fixed
 * while the viewport translates within a bin — only a bin change shifts it.
 */
export function computeOverscanWindow(input: OverscanWindowInput): OverscanWindow {
  const overscan = Math.max(0, Math.floor(input.overscan ?? OVERSCAN_ROWS));
  const quantum = Math.max(1, Math.floor(input.quantum ?? SCROLL_QUANTUM));
  const viewportHeight = Math.max(0, Math.floor(input.viewportHeight));
  const contentHeight = Math.max(0, Math.floor(input.contentHeight));

  const maxScroll = Math.max(0, contentHeight - viewportHeight);
  const clampedTop = clamp(Math.floor(input.globalScrollTop), 0, maxScroll);

  const bin = Math.floor(clampedTop / quantum);
  const anchor = bin * quantum; // the bin's base global row

  const blockTop = Math.max(0, anchor - overscan);
  const blockBottom = Math.min(contentHeight, anchor + viewportHeight + overscan);
  const blockHeight = Math.max(0, blockBottom - blockTop);
  const inBlockOffset = clampedTop - blockTop;

  return { blockTop, blockHeight, inBlockOffset, bin };
}

/**
 * Does moving the viewport to `nextGlobalScrollTop` stay within the SAME block
 * as `prevGlobalScrollTop`? When true the scroll is a pure in-block translation
 * (React-bypass fast path); when false the block must be re-rendered (React).
 *
 * Pure helper so the wiring's hot-path branch is itself gated.
 */
export function staysWithinOverscanBlock(
  prevGlobalScrollTop: number,
  nextGlobalScrollTop: number,
  input: Omit<OverscanWindowInput, "globalScrollTop">,
): boolean {
  const a = computeOverscanWindow({ ...input, globalScrollTop: prevGlobalScrollTop });
  const b = computeOverscanWindow({ ...input, globalScrollTop: nextGlobalScrollTop });
  return a.bin === b.bin;
}
