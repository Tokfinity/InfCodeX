/**
 * Cell-level diff renderer entry point (FEATURE_057 Track F).
 *
 * This file holds the **`LogUpdate` orchestrator + Phase 3c incremental
 * loop**. The Phase 1-3a primitives (`renderFullFrame`, `VirtualScreen`,
 * `writeCellWithStyleStr`, `moveCursorTo`, `renderFrameSlice`, `readLine`,
 * `fullResetSequence_CAUSES_FLICKER`, style/hyperlink transitions, width
 * compensation, `CARRIAGE_RETURN` / `NEWLINE` constants) live in
 * `cell-renderer-primitives.ts`. The split keeps both files under KodaX's
 * 800-line cap; the import edge runs one way only (this file imports
 * primitives, primitives import nothing back) to avoid the circular
 * dependency forbidden by KodaX `CLAUDE.md`.
 *
 * Phase 6 (v0.7.30) made the cell renderer the sole render path; the
 * legacy `log-update.js` factory and the `KODAX_TRACK_F` opt-out gate are
 * gone. This file no longer carries a flag check — all callers route here
 * unconditionally.
 *
 * Architecturally aligned with `claudecode/src/ink/log-update.ts:LogUpdate`
 * (CC reference at `C:/Works/claudecode/src/ink/log-update.ts:43`).
 */

import { diffEach, shiftRowsRegion } from "./cell-screen.js";
import type { Diff, Frame, Patch } from "./frame.js";
import {
  CARRIAGE_RETURN,
  NEWLINE,
  VirtualScreen,
  fullResetSequence_CAUSES_FLICKER,
  moveCursorTo,
  readLine,
  renderFrameSlice,
  renderFullFrame,
  transitionHyperlink,
  transitionStyle,
  transitionStyleStr,
  writeCellWithStyleStr,
} from "./cell-renderer-primitives.js";
import {
  computeViewportState,
  shouldFullReset,
  shouldSkipDiff,
} from "./viewport-state.js";

// Re-export the primitives surface so existing consumers (and tests) that
// import from `./cell-renderer.js` continue to work without churning their
// import paths. Phase 4/5/6 may revisit if a tighter import boundary is
// preferred.
export {
  CARRIAGE_RETURN,
  NEWLINE,
  VirtualScreen,
  fullResetSequence_CAUSES_FLICKER,
  moveCursorTo,
  needsWidthCompensation,
  readLine,
  renderFrameSlice,
  renderFullFrame,
  transitionHyperlink,
  transitionStyle,
  transitionStyleStr,
  writeCellWithStyleStr,
  type HyperlinkTransition,
  type StyleTransition,
} from "./cell-renderer-primitives.js";

export interface LogUpdateOptions {
  readonly isTTY: boolean;
}

export class LogUpdate {
  constructor(private readonly options: LogUpdateOptions) {}

  /**
   * Compute the terminal diff between `prev` and `next`.
   *
   * Routing:
   *   - **Non-TTY**: full-frame paint of `next` (parity with CC's
   *     `if (!this.options.isTTY) return this.renderFullFrame(next)` at
   *     `claudecode/src/ink/log-update.ts:129`).
   *   - **Reset cases** (resize, scrollback collisions, oversized shrinks):
   *     emit `clearTerminal` + fresh full render via
   *     `fullResetSequence_CAUSES_FLICKER`. Detection logic is the pure
   *     `shouldFullReset` decision function (Phase 3b).
   *   - **Incremental** (Phase 3c): walk `diffEach`, emit per-cell patches
   *     using Phase 3a primitives + Phase 3b skip predicates, then
   *     restore the cursor to `next.cursor` for the next render. **First
   *     render** (`prev.screen.height === 0`) flows through this path: the
   *     diff loop skips per-cell paints (every coordinate falls in the
   *     "growing, y >= prev.screen.height" branch), `renderFrameSlice`
   *     paints all rows with `\r\n` separators, and `restoreCursor` is a
   *     no-op when `next.cursor.y === next.screen.height`. Mirrors CC's
   *     `claudecode/src/ink/log-update.ts:199-466` — KodaX previously had
   *     a `prev.screen.height === 0` short-circuit through `renderFullFrame`
   *     here, but that path emitted content joined by `\n` (without
   *     trailing newline) and left the cursor mid-row, drifting subsequent
   *     incremental moves. The CC-aligned path leaves the cursor at
   *     `(0, screen.height)` deterministically.
   */
  render(
    prevRaw: Frame,
    nextRaw: Frame,
    opts: {
      altScreen?: boolean;
      decstbmSafe?: boolean;
      inlineBottomAnchored?: boolean;
    } = {},
  ): Diff {
    if (!this.options.isTTY) {
      return renderFullFrame(nextRaw);
    }
    // FEATURE_214 — the engine sets this for its inline main-screen path so the
    // resting cursor lands on the frame's own last row (no scrolled-in blank line
    // under the status bar when the frame is anchored to the terminal bottom).
    const inlineBottomAnchored = opts.inlineBottomAnchored ?? false;

    // FEATURE_212 (v0.7.45) — clamp the resting cursor to the last VISIBLE row.
    // `renderer.js` sets `cursor.y = screen.height` (one row PAST the last
    // content row) so the next diff starts deterministically. In managed
    // fullscreen the frame FILLS the viewport (`screen.height ===
    // viewport.height`), so that resting position is OFF-SCREEN — and the
    // `\n` `restoreCursor` emits to reach it scrolls the whole alt-screen up
    // one row (the visible "everything drifts up, banner top clipped, blank
    // row under the status bar"). Clamping the resting cursor to
    // `viewport.height - 1` makes `restoreCursor` take the no-scroll
    // `moveCursorTo` branch. Applied to BOTH prev and next so the virtual
    // cursor the diff is computed against stays in lock-step with the real
    // terminal cursor across renders (an inconsistent clamp desyncs them and
    // misplaces the spinner/input by a row). Inline frames (content shorter
    // than the viewport) are untouched — their cursor is already on-screen.
    const prev = clampRestingCursor(prevRaw, inlineBottomAnchored);
    const next = clampRestingCursor(nextRaw, inlineBottomAnchored);

    // Alt-screen can keep physical cells after shell transitions reset prevFrame.
    if (opts.altScreen === true && prevRaw.screen.height === 0 && next.screen.height > 0) {
      return fullResetSequence_CAUSES_FLICKER(next, "clear", inlineBottomAnchored);
    }

    // Reset short-circuit. Decision logic is in `shouldFullReset` (Phase 3b)
    // — see `viewport-state.ts` for the four-case taxonomy. `readLine` is
    // passed as a callback to break the would-be circular dependency
    // (viewport-state needs line read-back for trigger debug; the read-back
    // helper lives in `cell-renderer-primitives.ts` next to the other
    // rendering primitives).
    const decision = shouldFullReset(prev, next, readLine);
    if (decision.reset) {
      return fullResetSequence_CAUSES_FLICKER(next, decision.reason, inlineBottomAnchored);
    }

    // FEATURE_212 (v0.7.45) — DECSTBM scroll fast path. When the transcript
    // scrolled this render (scrollHint, captured in render-node-to-output) in
    // fullscreen with synchronized output, emit a hardware scroll for the
    // scrolled region + shift `prev` in memory by the same amount, so the
    // incremental diff below only paints the rows that scrolled IN — instead
    // of every shifted row (~6KB ConPTY write that blocks the event loop and
    // stutters streaming/scroll + the spinner animation). The scroll patch is
    // bracketed in DEC save/restore (see apply-diff) so the cursor returns to
    // `prev.cursor`, leaving `renderIncremental`'s relative moves valid.
    // Default OFF on every platform. No measured benefit anywhere — the
    // fullscreen-scroll bottleneck is the ConPTY write, not this fast path
    // (measured 2026-06-04) — and Windows ConPTY mis-renders the scroll region on
    // full-width (CJK) cells (错行). Opt back in with `KODAX_SCROLL_DECSTBM=1` only
    // to re-measure. FEATURE_214 deletes this whole path with the inline migration.
    const hint = next.scrollHint;
    if (
      hint &&
      opts.altScreen &&
      opts.decstbmSafe &&
      process.env.KODAX_SCROLL_DECSTBM === "1" &&
      hint.delta !== 0 &&
      hint.top >= 0 &&
      hint.bottom < prev.screen.height &&
      hint.bottom < next.screen.height &&
      Math.abs(hint.delta) <= hint.bottom - hint.top
    ) {
      const scrollPatch: Patch = {
        type: "scrollRegion",
        top: hint.top,
        bottom: hint.bottom,
        delta: hint.delta,
      };
      const shiftedPrev: Frame = {
        ...prev,
        screen: shiftRowsRegion(prev.screen, hint.top, hint.bottom, hint.delta),
      };
      return [scrollPatch, ...renderIncremental(shiftedPrev, next, inlineBottomAnchored)];
    }

    return renderIncremental(prev, next, inlineBottomAnchored);
  }

  /**
   * Re-seed internal state when the process resumes from suspension
   * (SIGCONT) so the next `render()` doesn't rely on stale output state
   * the terminal has since clobbered. Phase 2 carries no state to clear;
   * Phase 5 re-introduces a `previousOutput` field when the legacy diff
   * needs string-level continuity across resume.
   */
  reset(): void {
    // Phase 2 no-op; method shape preserved for engine integration.
  }
}

/**
 * Helper: emit a sequence of patches through `screen.txn` with zero
 * cursor delta. Used for style/hyperlink transition patches that don't
 * advance the virtual cursor on their own.
 *
 * TODO(Phase 6): inline these into a single txn closure for the hot
 * path. Phase 3 prioritizes correctness clarity (one txn per patch);
 * profiling will tell whether the closure-allocation cost matters.
 */
function emitPatches(
  screen: VirtualScreen,
  patches: ReadonlyArray<Patch>,
): void {
  for (const patch of patches) {
    screen.txn(() => [[patch], { dx: 0, dy: 0 }]);
  }
}

/**
 * Reset both style and hyperlink trackers + emit the corresponding patches.
 * Used at end-of-row, before grow rows, and before clearing a removed cell.
 * Returns the new (empty) tracker tuple.
 */
function resetStyleAndHyperlink(
  screen: VirtualScreen,
  currentStyle: string,
  currentHyperlink: string | undefined,
): { style: string; hyperlink: string | undefined } {
  if (currentStyle !== "") {
    const result = transitionStyle(currentStyle, "");
    emitPatches(screen, result.patches);
  }
  if (currentHyperlink !== undefined) {
    const result = transitionHyperlink(currentHyperlink, undefined);
    emitPatches(screen, result.patches);
  }
  return { style: "", hyperlink: undefined };
}

/**
 * Apply the shrink-emission step of `renderIncremental`.
 *
 * Emits `[clear(linesToClear), cursorMove(0, -1)]` atomically — the clear
 * lands the cursor at column 0 of the new bottom row's `eraseLines`
 * landing position, and the cursorMove(0, -1) walks one more row up
 * to the new bottom of content. CC reference lines 273-282.
 */
function applyShrink(screen: VirtualScreen, prev: Frame, next: Frame): void {
  const linesToClear = prev.screen.height - next.screen.height;
  screen.txn((prevCursor) => [
    [
      { type: "clear", count: linesToClear },
      { type: "cursorMove", x: 0, y: -1 },
    ],
    { dx: -prevCursor.x, dy: -linesToClear },
  ]);
}

interface DiffPassResult {
  readonly currentStyle: string;
  readonly currentHyperlink: string | undefined;
  readonly needsFullReset: boolean;
}

/**
 * Walk `diffEach` over existing rows and emit per-cell paints / clears.
 *
 * Returns trackers + the early-exit flag. Phase 3b's `shouldSkipDiff`
 * handles spacer / empty-no-removed skip cases. Cell changes at
 * `y < viewportY` (scrollback) abort the incremental path with a flag.
 */
function diffPass(
  screen: VirtualScreen,
  prev: Frame,
  next: Frame,
  state: { readonly growing: boolean; readonly viewportY: number },
): DiffPassResult {
  let currentStyle = "";
  let currentHyperlink: string | undefined = undefined;
  let needsFullReset = false;

  for (const change of diffEach(prev.screen, next.screen)) {
    const { x, y, prev: removed, next: added } = change;

    // Skip new rows — `renderFrameSlice` handles those after this pass.
    if (state.growing && y >= prev.screen.height) continue;

    const isEmptyAdded = !!(
      added &&
      added.char === " " &&
      added.style === "" &&
      added.hyperlink === undefined
    );
    if (shouldSkipDiff(removed, added, isEmptyAdded)) continue;

    if (y < state.viewportY) {
      needsFullReset = true;
      break;
    }

    moveCursorTo(screen, x, y);

    if (added) {
      const linkResult = transitionHyperlink(currentHyperlink, added.hyperlink);
      emitPatches(screen, linkResult.patches);
      currentHyperlink = linkResult.current;

      const styleFlat = transitionStyleStr(currentStyle, added.style);
      if (writeCellWithStyleStr(screen, added, styleFlat.str)) {
        currentStyle = styleFlat.current;
      }
    } else if (removed) {
      // Cleared cell inherits no style — reset both trackers first.
      const reset = resetStyleAndHyperlink(screen, currentStyle, currentHyperlink);
      currentStyle = reset.style;
      currentHyperlink = reset.hyperlink;
      screen.txn(() => [
        [{ type: "stdout", content: " " }],
        { dx: 1, dy: 0 },
      ]);
    }
  }

  return { currentStyle, currentHyperlink, needsFullReset };
}

/**
 * Restore the terminal cursor to `next.cursor` for the next render's
 * relative-move starting point.
 *
 * Two branches (CC lines 423-451):
 *   - **Cursor past last content row** (`next.cursor.y >= next.screen.height`):
 *     CSI cursor-down cannot create new rows, so emit `\r + (\n × rowsToCreate)`
 *     to scroll the terminal. When `rowsToCreate <= 0` (cursor already at
 *     or past the target row), fall back to `\r + cursorMove`.
 *   - **Cursor within content** (`next.cursor.y < next.screen.height`):
 *     a plain `moveCursorTo` is sufficient since the row already exists.
 */
/**
 * FEATURE_212 (v0.7.45) / FEATURE_214 — clamp a frame's resting cursor to its
 * own last content row, never one past it. `renderer.js` parks `cursor.y =
 * screen.height` (one row PAST the last content row) so the next diff starts
 * deterministically, but that row does not physically exist until a scroll
 * creates it — and on a bottom-anchored frame that scroll pushes the whole
 * screen up one (drift / "blank row under the status bar"). Clamping to
 * `min(viewport.height - 1, screen.height - 1)` makes `restoreCursor` take the
 * no-scroll `moveCursorTo` branch:
 *   - fullscreen / viewport-FILLING (`screen.height === viewport.height`) and
 *     OFFSCREEN (`screen.height > viewport.height`) → `viewport.height - 1`,
 *     unchanged from the original FEATURE_212 clamp.
 *   - inline (`inlineBottomAnchored`, `screen.height < viewport.height`) →
 *     `screen.height - 1`, so the small main-screen frame rests on its own last
 *     row (the status bar) instead of one below — pairing with `renderFrameSlice`'s
 *     last-row `\n` suppression. The engine passes the flag only for its inline
 *     main-screen path (`!altScreenActive`); WITHOUT it the original FEATURE_212
 *     ceiling (`viewport.height - 1`) is used, so generic / non-engine callers and
 *     low-level tests keep the unchanged one-past-last resting convention.
 * Returns the frame unchanged when the cursor is already on/above that row, so a
 * non-resting cursor is untouched. Applied to BOTH prev and next so the virtual
 * cursor the diff is computed against stays in lock-step with the real terminal
 * cursor across renders. Pure; allocates a new frame only when clamping.
 *
 * Side effect on `computeViewportState`: a clamped `prev.cursor.y < screen.height`
 * makes `prevHadScrollback` read false / `cursorRestoreScroll` 0 for the next
 * diff. Correct for BOTH the viewport-filling frame (already at max height, never
 * grows) and the inline frame (its history lives in native scrollback, never in
 * the frame, so it genuinely has none) — the LF the `=1` accounting compensated
 * for is exactly the one the last-row suppression now removes.
 */
function clampRestingCursor(frame: Frame, inlineBottomAnchored: boolean): Frame {
  const maxY = inlineBottomAnchored
    ? Math.max(0, Math.min(frame.viewport.height - 1, frame.screen.height - 1))
    : Math.max(0, frame.viewport.height - 1);
  if (frame.cursor.y <= maxY) return frame;
  return { ...frame, cursor: { ...frame.cursor, y: maxY } };
}

function restoreCursor(screen: VirtualScreen, next: Frame): void {
  if (next.cursor.y >= next.screen.height) {
    screen.txn((prev) => {
      const rowsToCreate = next.cursor.y - prev.y;
      if (rowsToCreate > 0) {
        const patches: Patch[] = new Array<Patch>(1 + rowsToCreate);
        patches[0] = CARRIAGE_RETURN;
        for (let i = 0; i < rowsToCreate; i++) {
          patches[1 + i] = NEWLINE;
        }
        return [patches, { dx: -prev.x, dy: rowsToCreate }];
      }
      const dy = next.cursor.y - prev.y;
      if (dy !== 0 || prev.x !== next.cursor.x) {
        return [
          [CARRIAGE_RETURN, { type: "cursorMove", x: next.cursor.x, y: dy }],
          { dx: next.cursor.x - prev.x, dy },
        ];
      }
      return [[], { dx: 0, dy: 0 }];
    });
  } else {
    moveCursorTo(screen, next.cursor.x, next.cursor.y);
  }
}

/**
 * Phase 3c: main incremental render loop. Composes Phase 3a primitives
 * (`writeCellWithStyleStr` / `moveCursorTo` / `renderFrameSlice`) with
 * Phase 3b decisions (`computeViewportState` / `shouldSkipDiff`) into the
 * algorithm CC reference describes at `claudecode/src/ink/log-update.ts:199-466`.
 *
 * Caller MUST have already short-circuited the reset cases via
 * `shouldFullReset` — this function assumes the incremental path is safe.
 *
 * Decomposed into sub-functions to keep each piece under the 50-line rule:
 *   - `applyShrink` — clear + cursorMove for shrinking case
 *   - `diffPass` — walk diffEach and paint per-cell
 *   - `renderFrameSlice` — render new rows in the grow region
 *   - `restoreCursor` — move cursor to next.cursor for next render
 */
function renderIncremental(
  prev: Frame,
  next: Frame,
  inlineBottomAnchored = false,
): Diff {
  const state = computeViewportState(prev, next);
  const screen = new VirtualScreen(prev.cursor, next.viewport.width);

  if (state.shrinking) {
    applyShrink(screen, prev, next);
  }

  const passResult = diffPass(screen, prev, next, state);
  if (passResult.needsFullReset) {
    return fullResetSequence_CAUSES_FLICKER(next, "offscreen", inlineBottomAnchored);
  }

  // Reset open trackers before grow rows take over the row state.
  resetStyleAndHyperlink(screen, passResult.currentStyle, passResult.currentHyperlink);

  if (state.growing) {
    renderFrameSlice(screen, next, prev.screen.height, next.screen.height, inlineBottomAnchored);
  }

  restoreCursor(screen, next);

  return screen.diff;
}
