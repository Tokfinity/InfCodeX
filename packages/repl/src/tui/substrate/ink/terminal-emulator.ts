/**
 * FEATURE_212 / FEATURE_214 — a deliberately small, TOTAL terminal emulator over
 * KodaX's emit vocabulary, plus the Frame builders the render-semantic tests share.
 *
 * It replays the exact bytes a Diff / the engine serializes (cursor moves, `eraseLines`,
 * `\r`, `\n` with bottom-of-region scroll, `CSI 2K/0K`, `CSI 2J`, DECSTBM region scroll,
 * save/restore) onto a char grid + cursor + scroll region, so a test can assert the
 * RECONSTRUCTED screen — not just the raw byte stream. Calibrated against the trusted
 * renderer in `terminal-model.test.ts`; reused by `engine.test.ts` to prove the inline
 * live-block repaint commits each `You [HH:MM]` header exactly once.
 *
 * NOT shipped: this module is build-excluded (see packages/repl/tsconfig.json `exclude`)
 * because only `*.test.ts` files import it. Kept out of a `*.test.ts` name so importing
 * test files do not double-register its suites.
 */

import {
  CellWidth,
  type Cell,
  type Screen,
  cellAt,
  createScreen,
  setCellAt,
} from "./cell-screen.js";
import { type Frame } from "./frame.js";

export const ESC = "\x1b";

/** A deliberately small, total terminal emulator over KodaX's emit vocabulary. */
export class TerminalModel {
  private readonly w: number;
  private readonly h: number;
  private grid: string[][];
  private cx = 0;
  private cy = 0;
  private top = 0;
  private bot: number;
  private savedX = 0;
  private savedY = 0;
  /**
   * FEATURE_214 — rows that scrolled off the TOP of the screen into native
   * scrollback (in emit order). Captured only when the scroll region starts at
   * the screen top (the only case where a row truly leaves the viewport upward).
   * Lets tests assert WHAT entered scrollback — it must be transcript content
   * only, never the input box / footer / status / separator, and never a
   * duplicated transcript block.
   */
  private scrollbackRows: string[] = [];

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
      // Rows leaving the top of a screen-top scroll region are lost upward into
      // native scrollback — record them (trailing spaces trimmed) before the shift.
      if (this.top === 0) {
        for (let y = 0; y < delta && y <= this.bot; y++) {
          this.scrollbackRows.push(this.grid[y]!.join("").replace(/\s+$/u, ""));
        }
      }
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

  /** Every row in the grid, trailing spaces trimmed — handy for substring/COUNT asserts. */
  allRows(): string[] {
    return this.grid.map((r) => r.join("").replace(/\s+$/u, ""));
  }

  /** Rows that scrolled off the top into native scrollback, in emit order. */
  scrollback(): string[] {
    return this.scrollbackRows.slice();
  }

  /** Current cursor position (0-based) — for asserting where a render parks it
   * (e.g. the input anchor after the suffix, or the resting row after a reset). */
  cursor(): { x: number; y: number } {
    return { x: this.cx, y: this.cy };
  }

  /** Scrollback rows + the visible grid — everything the user could scroll to see. */
  scrollbackPlusVisible(): string[] {
    return [...this.scrollbackRows, ...this.allRows()];
  }
}

export function cell(char: string): Cell {
  return { char, width: CellWidth.Single, style: "", hyperlink: undefined };
}

/** Build a Frame from an array of row strings. Cursor lands one past the last
 * content row (the renderer's convention); viewport is `vh` tall (>= height). */
export function frameFromRows(rows: string[], width: number, vh: number): Frame {
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

export function screenRows(screen: Screen): string[] {
  return Array.from({ length: screen.height }, (_, y) =>
    Array.from({ length: screen.width }, (_, x) => cellAt(screen, x, y)?.char ?? " ").join(""),
  );
}
