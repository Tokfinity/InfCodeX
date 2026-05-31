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
import type { Frame } from "./frame.js";

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
        this.cy = this.clampY(this.cy + 1); i++;
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
 * return the reconstructed top `next.height` rows. */
function applyRender(prev: Frame, next: Frame): string[] {
  const lu = new LogUpdate({ isTTY: true });
  const diff = lu.render(prev, next);
  const bytes = diff.map(patchToBytes).join("");
  const model = new TerminalModel(next.viewport.width, next.viewport.height, prev.screen);
  // Seed cursor where the previous frame left it (renderer's invariant).
  // Emulate by moving there from home — the model starts at (0,0); the diff's
  // first relative move assumes the cursor is at prev.cursor, so pre-position.
  model.apply(`${ESC}[${prev.cursor.y + 1};1H`);
  model.apply(bytes);
  return model.rows(next.screen.height);
}

describe("TerminalModel calibration vs trusted renderer (FEATURE_212 gate)", () => {
  const W = 5;
  const VH = 12;

  it("single-cell change reconstructs next", () => {
    const prev = frameFromRows(["aaaaa", "bbbbb", "ccccc"], W, VH);
    const next = frameFromRows(["aaaaa", "bXbbb", "ccccc"], W, VH);
    expect(applyRender(prev, next)).toEqual(screenRows(next.screen));
  });

  it("whole-row change reconstructs next", () => {
    const prev = frameFromRows(["aaaaa", "bbbbb", "ccccc"], W, VH);
    const next = frameFromRows(["aaaaa", "ZZZZZ", "ccccc"], W, VH);
    expect(applyRender(prev, next)).toEqual(screenRows(next.screen));
  });

  it("growing (append a row) reconstructs next", () => {
    const prev = frameFromRows(["aaaaa", "bbbbb"], W, VH);
    const next = frameFromRows(["aaaaa", "bbbbb", "ddddd"], W, VH);
    expect(applyRender(prev, next)).toEqual(screenRows(next.screen));
  });

  it("multi-row edit reconstructs next", () => {
    const prev = frameFromRows(["aaaaa", "bbbbb", "ccccc", "ddddd"], W, VH);
    const next = frameFromRows(["aaaaa", "11111", "ccccc", "22222"], W, VH);
    expect(applyRender(prev, next)).toEqual(screenRows(next.screen));
  });
});
