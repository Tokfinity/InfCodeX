import { describe, it, expect } from "vitest";

import { LogUpdate } from "./cell-renderer.js";
import { patchToBytes } from "./apply-diff.js";
import {
  CellWidth,
  type Cell,
  type Screen,
  cellAt,
  createScreen,
  setCellAt,
} from "./cell-screen.js";
import { emptyFrame, type Frame } from "./frame.js";

// FEATURE_212 (v0.7.45) — cursor+grid terminal model (the differential-test
// gate for the DECSTBM scroll optimization).
//
// It replays the exact bytes a Diff serializes to (`patchToBytes`) onto a
// char grid + cursor + scroll region, then we assert the reconstructed grid
// equals `next.screen`. First it is CALIBRATED on non-scroll frames against
// the TRUSTED existing renderer: if `apply(render(prev,next), prev) === next`
// holds there, the model is faithful to KodaX's real emit vocabulary — only
// then is it trustworthy as the gate for the scroll path (step 3), where it
// will prove the hardware-scroll path reconstructs the same final screen
// (cursor included — the garble risk).

const ESC = "\x1b";

/** A deliberately small, total terminal emulator over KodaX's emit vocabulary. */
class TerminalModel {
  private readonly w: number;
  private readonly h: number;
  private grid: string[][];
  private cx = 0;
  private cy = 0;
  private top = 0;
  private bot: number;
  private savedX = 0;
  private savedY = 0;

  constructor(width: number, height: number, init?: Screen) {
    this.w = width;
    this.h = height;
    this.bot = height - 1;
    this.grid = Array.from({ length: height }, () => Array.from({ length: width }, () => " "));
    if (init) {
      for (let y = 0; y < Math.min(init.height, height); y++) {
        for (let x = 0; x < width; x++) {
          this.grid[y]![x] = cellAt(init, x, y)?.char ?? " ";
        }
      }
    }
  }

  private clampX(x: number): number { return Math.max(0, Math.min(this.w - 1, x)); }
  private clampY(y: number): number { return Math.max(0, Math.min(this.h - 1, y)); }

  apply(bytes: string): void {
    let i = 0;
    while (i < bytes.length) {
      const ch = bytes[i]!;
      if (ch === ESC) {
        i = this.applyEscape(bytes, i + 1);
      } else if (ch === "\r") {
        this.cx = 0; i++;
      } else if (ch === "\n") {
        // Real-terminal LF: at the bottom of the scroll region a line-feed
        // scrolls the region up one row rather than moving the cursor off
        // screen. This is the exact behavior the fullscreen drift trips on —
        // a row-final/cursor-restore `\n` emitted while the cursor sits on the
        // last viewport row pushes the whole screen up one line.
        if (this.cy >= this.bot) {
          this.scroll(1);
        } else {
          this.cy = this.clampY(this.cy + 1);
        }
        i++;
      } else if (ch >= " ") {
        if (this.cy >= 0 && this.cy < this.h && this.cx >= 0 && this.cx < this.w) {
          this.grid[this.cy]![this.cx] = ch;
        }
        this.cx++; i++;
      } else {
        i++;
      }
    }
  }

  private applyEscape(bytes: string, i: number): number {
    const n = bytes[i];
    if (n === "[") {
      i++;
      let priv = false;
      if (bytes[i] === "?") { priv = true; i++; }
      let params = "";
      while (i < bytes.length && /[0-9;]/.test(bytes[i]!)) { params += bytes[i]; i++; }
      const final = bytes[i]; i++;
      if (!priv && final) this.csi(final, params);
      return i;
    }
    if (n === "7") { this.savedX = this.cx; this.savedY = this.cy; return i + 1; }
    if (n === "8") { this.cx = this.savedX; this.cy = this.savedY; return i + 1; }
    if (n === "]") {
      i++;
      while (i < bytes.length && bytes[i] !== "\x07" && !(bytes[i] === ESC && bytes[i + 1] === "\\")) i++;
      if (bytes[i] === "\x07") return i + 1;
      if (bytes[i] === ESC) return i + 2;
      return i;
    }
    return i + 1;
  }

  private csi(final: string, params: string): void {
    const ps = params.split(";").map((p) => (p === "" ? undefined : parseInt(p, 10)));
    const n = ps[0];
    switch (final) {
      case "A": this.cy = this.clampY(this.cy - (n ?? 1)); break;
      case "B": this.cy = this.clampY(this.cy + (n ?? 1)); break;
      case "C": this.cx = this.clampX(this.cx + (n ?? 1)); break;
      case "D": this.cx = this.clampX(this.cx - (n ?? 1)); break;
      case "G": this.cx = this.clampX((n ?? 1) - 1); break;
      case "H": this.cy = this.clampY((ps[0] ?? 1) - 1); this.cx = this.clampX((ps[1] ?? 1) - 1); break;
      case "K": {
        const mode = n ?? 0;
        if (mode === 2) for (let x = 0; x < this.w; x++) this.grid[this.cy]![x] = " ";
        else if (mode === 0) for (let x = this.cx; x < this.w; x++) this.grid[this.cy]![x] = " ";
        break;
      }
      case "J": if ((n ?? 0) === 2) { for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) this.grid[y]![x] = " "; this.cx = 0; this.cy = 0; } break;
      case "r": this.top = (ps[0] ?? 1) - 1; this.bot = (ps[1] ?? this.h) - 1; this.cx = 0; this.cy = 0; break;
      case "S": this.scroll(n ?? 1); break;
      case "T": this.scroll(-(n ?? 1)); break;
      case "s": this.savedX = this.cx; this.savedY = this.cy; break;
      case "u": this.cx = this.savedX; this.cy = this.savedY; break;
      case "m": break; // SGR — ignored for the char-grid comparison
      default: break;
    }
  }

  /** Scroll the region [top, bot] by `delta` (>0 = up). */
  private scroll(delta: number): void {
    const blank = (): string[] => Array.from({ length: this.w }, () => " ");
    if (delta > 0) {
      for (let y = this.top; y <= this.bot; y++) {
        const src = y + delta;
        this.grid[y] = src <= this.bot ? this.grid[src]!.slice() : blank();
      }
    } else {
      const d = -delta;
      for (let y = this.bot; y >= this.top; y--) {
        const src = y - d;
        this.grid[y] = src >= this.top ? this.grid[src]!.slice() : blank();
      }
    }
  }

  rows(count: number): string[] {
    return this.grid.slice(0, count).map((r) => r.join(""));
  }
}

// ---- test helpers ----------------------------------------------------------

function cell(char: string): Cell {
  return { char, width: CellWidth.Single, style: "", hyperlink: undefined };
}

/** Build a Frame from an array of row strings. Cursor lands one past the last
 * content row (the renderer's convention); viewport is `vh` tall (>= height). */
function frameFromRows(rows: string[], width: number, vh: number): Frame {
  let screen = createScreen(width, rows.length);
  rows.forEach((row, y) => {
    for (let x = 0; x < width; x++) {
      const c = row[x] ?? " ";
      screen = setCellAt(screen, x, y, cell(c));
    }
  });
  return {
    screen,
    viewport: { width, height: vh },
    cursor: { x: 0, y: rows.length, visible: true },
  };
}

function screenRows(screen: Screen): string[] {
  return Array.from({ length: screen.height }, (_, y) =>
    Array.from({ length: screen.width }, (_, x) => cellAt(screen, x, y)?.char ?? " ").join(""),
  );
}

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
