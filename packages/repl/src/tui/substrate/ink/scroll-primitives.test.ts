import { describe, it, expect } from "vitest";

import { setScrollRegion, scrollUp, scrollDown } from "./csi.js";
import {
  CellWidth,
  type Cell,
  type Screen,
  cellAt,
  createScreen,
  setCellAt,
  shiftRowsRegion,
} from "./cell-screen.js";

// FEATURE_212 (v0.7.45) — DECSTBM scroll primitives. These are the pure
// building blocks of the fullscreen scroll optimization; the render() wiring
// (step 3) and the grid-differential test gate it.

const ESC = "\x1b";

function cell(char: string): Cell {
  return { char, width: CellWidth.Single, style: "", hyperlink: undefined };
}

/** Build a width-1 screen whose row y holds the single char `rows[y]`. */
function column(rows: string[]): Screen {
  let s = createScreen(1, rows.length);
  rows.forEach((ch, y) => {
    s = setCellAt(s, 0, y, cell(ch));
  });
  return s;
}

function readColumn(s: Screen): string[] {
  return Array.from({ length: s.height }, (_, y) => cellAt(s, 0, y)?.char ?? "?");
}

describe("csi scroll helpers (FEATURE_212)", () => {
  it("setScrollRegion emits DECSTBM with 1-based inclusive rows", () => {
    expect(setScrollRegion(1, 57)).toBe(`${ESC}[1;57r`);
    expect(setScrollRegion(3, 10)).toBe(`${ESC}[3;10r`);
  });
  it("scrollUp / scrollDown emit CSI n S / CSI n T", () => {
    expect(scrollUp(3)).toBe(`${ESC}[3S`);
    expect(scrollDown(2)).toBe(`${ESC}[2T`);
    expect(scrollUp()).toBe(`${ESC}[1S`);
    expect(scrollDown()).toBe(`${ESC}[1T`);
  });
});

describe("shiftRowsRegion (FEATURE_212)", () => {
  const base = ["a", "b", "c", "d", "e"]; // height 5

  it("delta 0 returns the same screen (identity)", () => {
    const s = column(base);
    expect(shiftRowsRegion(s, 1, 3, 0)).toBe(s);
  });

  it("scrolls a region UP, blanks the region bottom, leaves outside rows intact", () => {
    // region rows [1,3] = b,c,d scroll up by 1 → c,d,(blank); rows 0,4 untouched
    const out = readColumn(shiftRowsRegion(column(base), 1, 3, 1));
    expect(out).toEqual(["a", "c", "d", " ", "e"]);
  });

  it("scrolls a region DOWN, blanks the region top, leaves outside rows intact", () => {
    // region rows [1,3] = b,c,d scroll down by 1 → (blank),b,c; rows 0,4 untouched
    const out = readColumn(shiftRowsRegion(column(base), 1, 3, -1));
    expect(out).toEqual(["a", " ", "b", "c", "e"]);
  });

  it("blanks the whole region when |delta| >= region height", () => {
    const out = readColumn(shiftRowsRegion(column(base), 1, 3, 5));
    expect(out).toEqual(["a", " ", " ", " ", "e"]);
  });

  it("clamps the region to the screen and never touches rows outside it", () => {
    // bottom beyond screen → clamped; top row 0 included; row 4 (e) stays.
    const out = readColumn(shiftRowsRegion(column(base), 0, 99, 2));
    // full-screen-ish region [0,4] scroll up 2 → c,d,e,blank,blank
    expect(out).toEqual(["c", "d", "e", " ", " "]);
  });

  it("does not mutate the input screen (immutable)", () => {
    const s = column(base);
    shiftRowsRegion(s, 1, 3, 1);
    expect(readColumn(s)).toEqual(base);
  });
});
