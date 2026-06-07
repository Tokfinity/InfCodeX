import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { LogUpdate } from "./cell-renderer.js";
import { patchToBytes } from "./apply-diff.js";
import { emptyFrame, type Frame } from "./frame.js";
import {
  ESC,
  TerminalModel,
  frameFromRows,
  screenRows,
} from "./terminal-emulator.js";

// FEATURE_212 (v0.7.45) — cursor+grid terminal model (the differential-test
// gate for the DECSTBM scroll optimization).
//
// The TerminalModel emulator + Frame builders now live in ./terminal-emulator.ts
// (shared with engine.test.ts's inline live-block tests). This file keeps the
// LogUpdate-driven calibration + scroll-gate + fullscreen-drift drivers below.
//
// It replays the exact bytes a Diff serializes to (`patchToBytes`) onto a char
// grid + cursor + scroll region, then we assert the reconstructed grid equals
// `next.screen`. First it is CALIBRATED on non-scroll frames against the TRUSTED
// existing renderer: if `apply(render(prev,next), prev) === next` holds there, the
// model is faithful to KodaX's real emit vocabulary — only then is it trustworthy
// as the gate for the scroll path (step 3), where it proves the hardware-scroll
// path reconstructs the same final screen (cursor included — the garble risk).

// ---- LogUpdate drivers -----------------------------------------------------

/** Render prev→next, replay the emitted bytes onto a model seeded with prev,
 * return the reconstructed top `next.height` rows + the raw diff. */
function applyRender(
  prev: Frame,
  next: Frame,
  opts: { altScreen?: boolean; decstbmSafe?: boolean } = {},
): { rows: string[]; diff: ReturnType<LogUpdate["render"]> } {
  const lu = new LogUpdate({ isTTY: true });
  const diff = lu.render(prev, next, opts);
  const bytes = diff.map(patchToBytes).join("");
  const model = new TerminalModel(next.viewport.width, next.viewport.height, prev.screen);
  // Seed cursor where the previous frame left it (renderer's invariant).
  // Emulate by moving there from home — the model starts at (0,0); the diff's
  // first relative move assumes the cursor is at prev.cursor, so pre-position.
  model.apply(`${ESC}[${prev.cursor.y + 1};1H`);
  model.apply(bytes);
  return { rows: model.rows(next.screen.height), diff };
}

function withScrollHint(frame: Frame, top: number, bottom: number, delta: number): Frame {
  return { ...frame, scrollHint: { top, bottom, delta } };
}

describe("TerminalModel calibration vs trusted renderer (FEATURE_212 gate)", () => {
  const W = 5;
  const VH = 12;

  it("single-cell change reconstructs next", () => {
    const prev = frameFromRows(["aaaaa", "bbbbb", "ccccc"], W, VH);
    const next = frameFromRows(["aaaaa", "bXbbb", "ccccc"], W, VH);
    expect(applyRender(prev, next).rows).toEqual(screenRows(next.screen));
  });

  it("whole-row change reconstructs next", () => {
    const prev = frameFromRows(["aaaaa", "bbbbb", "ccccc"], W, VH);
    const next = frameFromRows(["aaaaa", "ZZZZZ", "ccccc"], W, VH);
    expect(applyRender(prev, next).rows).toEqual(screenRows(next.screen));
  });

  it("growing (append a row) reconstructs next", () => {
    const prev = frameFromRows(["aaaaa", "bbbbb"], W, VH);
    const next = frameFromRows(["aaaaa", "bbbbb", "ddddd"], W, VH);
    expect(applyRender(prev, next).rows).toEqual(screenRows(next.screen));
  });

  it("multi-row edit reconstructs next", () => {
    const prev = frameFromRows(["aaaaa", "bbbbb", "ccccc", "ddddd"], W, VH);
    const next = frameFromRows(["aaaaa", "11111", "ccccc", "22222"], W, VH);
    expect(applyRender(prev, next).rows).toEqual(screenRows(next.screen));
  });
});

// ---- step 3: the DECSTBM scroll gate -------------------------------------
//
// These are the payload tests the calibrated model exists for. A scroll-up is
// `prev` (8 distinct rows) → `next` (rows shifted up by 1, new row at bottom),
// stamped with a `scrollHint`. With `{altScreen, decstbmSafe}` set, `render()`
// takes the DECSTBM fast path: a `scrollRegion` patch + an incremental diff
// against the *shifted* prev. The gate proves that path's serialized bytes
// replayed on a real cursor+grid emulator reconstruct EXACTLY `next.screen`
// (cursor included — the garble risk), AND that without the opts the path is
// inert (no `scrollRegion` patch) yet still correct.

describe("DECSTBM scroll gate (FEATURE_212)", () => {
  // FEATURE_214 (v0.7.46): DECSTBM hardware scroll is now opt-in (default OFF —
  // ConPTY mis-renders the scroll region on full-width cells). This gate still
  // verifies the path's byte-level correctness WHEN enabled, so it opts in
  // explicitly. Phase 1 deletes the path (and this block) with the inline migration.
  let _prevDecstbm: string | undefined;
  beforeEach(() => {
    _prevDecstbm = process.env.KODAX_SCROLL_DECSTBM;
    process.env.KODAX_SCROLL_DECSTBM = "1";
  });
  afterEach(() => {
    if (_prevDecstbm === undefined) delete process.env.KODAX_SCROLL_DECSTBM;
    else process.env.KODAX_SCROLL_DECSTBM = _prevDecstbm;
  });

  const W = 5;
  const VH = 12; // viewport taller than the 8-row screen ⇒ no offscreen reset

  const ROWS = ["r0aaa", "r1bbb", "r2ccc", "r3ddd", "r4eee", "r5fff", "r6ggg", "r7hhh"];

  function scrolledUpBy1(): { prev: Frame; next: Frame } {
    const prev = frameFromRows(ROWS, W, VH);
    // Content scrolls up by 1: rows[1..7] move to [0..6], a new row enters at 7.
    const next = frameFromRows([...ROWS.slice(1), "NEW77"], W, VH);
    return { prev, next };
  }

  it("scroll-up fast path reconstructs next exactly", () => {
    const { prev, next } = scrolledUpBy1();
    const nextHinted = withScrollHint(next, 0, 7, 1);
    const { rows, diff } = applyRender(prev, nextHinted, {
      altScreen: true,
      decstbmSafe: true,
    });
    // The screen the bytes reconstruct must be byte-for-byte `next`.
    expect(rows).toEqual(screenRows(next.screen));
    // And it must have actually taken the hardware-scroll path.
    expect(diff.some((p) => p.type === "scrollRegion")).toBe(true);
  });

  it("scroll-down fast path reconstructs next exactly", () => {
    // Content scrolls down by 1: a new row enters at the top, rows[0..6] move down.
    const prev = frameFromRows(ROWS, W, VH);
    const next = frameFromRows(["NEW00", ...ROWS.slice(0, 7)], W, VH);
    const nextHinted = withScrollHint(next, 0, 7, -1);
    const { rows, diff } = applyRender(prev, nextHinted, {
      altScreen: true,
      decstbmSafe: true,
    });
    expect(rows).toEqual(screenRows(next.screen));
    expect(diff.some((p) => p.type === "scrollRegion")).toBe(true);
  });

  it("no-regression: without opts the scroll path is inert but still correct", () => {
    const { prev, next } = scrolledUpBy1();
    const nextHinted = withScrollHint(next, 0, 7, 1);
    // No opts ⇒ altScreen/decstbmSafe undefined ⇒ DECSTBM branch skipped.
    const { rows, diff } = applyRender(prev, nextHinted);
    expect(rows).toEqual(screenRows(next.screen));
    expect(diff.some((p) => p.type === "scrollRegion")).toBe(false);
  });

  it("no-regression: decstbmSafe=false keeps the path inert", () => {
    const { prev, next } = scrolledUpBy1();
    const nextHinted = withScrollHint(next, 0, 7, 1);
    const { rows, diff } = applyRender(prev, nextHinted, {
      altScreen: true,
      decstbmSafe: false,
    });
    expect(rows).toEqual(screenRows(next.screen));
    expect(diff.some((p) => p.type === "scrollRegion")).toBe(false);
  });

  it("guard: a frame with no scrollHint never takes the fast path", () => {
    const { prev, next } = scrolledUpBy1();
    const { rows, diff } = applyRender(prev, next, {
      altScreen: true,
      decstbmSafe: true,
    });
    expect(rows).toEqual(screenRows(next.screen));
    expect(diff.some((p) => p.type === "scrollRegion")).toBe(false);
  });
});

// ---- the fullscreen viewport-fill drift (real engine sequence) -----------
//
// Reproduces the user-visible "whole managed viewport drifts up one row" in the
// cell-diff fullscreen path. Mirrors the engine sequence: a first paint from an
// EMPTY prev into a viewport-FILLING frame (banner + flex middle + input +
// status = full height), then a steady-state render that changes only the
// bottom (status) row. On a real terminal the first paint's row-final `\n`
// after the LAST row (and `restoreCursor`'s `\n`) land on the bottom row and
// SCROLL the screen up one line — the banner's top row is lost and a blank row
// appears at the bottom. The gate drives the ACTUAL emitted bytes through the
// scroll-faithful model and asserts the full viewport (banner row 0 included)
// is reconstructed across the whole sequence.

/** Replay a sequence of frames through ONE persistent terminal (as the engine
 * does — the alt-screen survives between renders), starting from an empty prev
 * at cursor home. Returns the final terminal state. */
function driveFullscreenSequence(frames: Frame[]): TerminalModel {
  const vh = frames[0]!.viewport.height;
  const w = frames[0]!.viewport.width;
  const lu = new LogUpdate({ isTTY: true });
  const model = new TerminalModel(w, vh); // blank screen, cursor home (0,0)
  let prev: Frame = emptyFrame(vh, w); // screen.height 0 — engine's seed prev
  for (const frame of frames) {
    const diff = lu.render(prev, frame);
    model.apply(diff.map((p) => patchToBytes(p)).join(""));
    prev = frame;
  }
  return model;
}

describe("fullscreen viewport-fill drift (real engine sequence)", () => {
  const W = 6;
  const VH = 7; // the frame fills the viewport exactly (screen.height === VH)

  function full(rows: string[]): Frame {
    return frameFromRows(rows, W, VH); // cursor.y === rows.length === VH
  }

  const ROWS_1 = ["BANNER", "body01", "body02", "body03", "      ", "inputX", "STAT_1"];
  // Steady-state render: only the bottom (status) row changes.
  const ROWS_2 = ["BANNER", "body01", "body02", "body03", "      ", "inputX", "STAT_2"];

  it("first paint + steady-state keep the banner (row 0) — no upward drift", () => {
    const model = driveFullscreenSequence([full(ROWS_1), full(ROWS_2)]);
    expect(model.rows(VH)).toEqual(screenRows(full(ROWS_2).screen));
  });

  it("first paint alone keeps the banner (row 0)", () => {
    const model = driveFullscreenSequence([full(ROWS_1)]);
    expect(model.rows(VH)).toEqual(screenRows(full(ROWS_1).screen));
  });
});
