import { describe, it, expect } from "vitest";
import { stripOuterBlankLines } from "./strip-outer-blank-lines.js";

const ESC = String.fromCharCode(27);
const cyan = (s: string) => `${ESC}[36m${s}${ESC}[39m`;

describe("stripOuterBlankLines", () => {
  it("leaves a clean single-line string untouched", () => {
    expect(stripOuterBlankLines("[Switched to x] (saved)")).toBe("[Switched to x] (saved)");
  });

  it("leaves a clean colored single-line string untouched", () => {
    const t = cyan("[Switched to x] (saved)");
    expect(stripOuterBlankLines(t)).toBe(t);
  });

  it("strips a bare leading newline", () => {
    expect(stripOuterBlankLines("\n[Switched to x]")).toBe("[Switched to x]");
  });

  it("strips a leading newline that sits behind a leading ANSI color code (the /model case)", () => {
    // chalk.cyan("\n[Switched ...]") => ESC[36m \n [Switched ...] ESC[39m
    const captured = cyan("\n[Switched to minimax-coding/MiniMax-M3] (saved)");
    const stripped = stripOuterBlankLines(captured);
    // color preserved, leading newline gone
    expect(stripped).toBe(`${ESC}[36m[Switched to minimax-coding/MiniMax-M3] (saved)${ESC}[39m`);
    // composing `${icon} ${text}` must now be a single logical line
    const composed = `ℹ ${stripped}`;
    expect(composed.split("\n")).toHaveLength(1);
  });

  it("strips multiple leading blank lines and whitespace-only lines", () => {
    expect(stripOuterBlankLines("\n  \n\t\nhello")).toBe("hello");
  });

  it("strips a CRLF leading blank line", () => {
    expect(stripOuterBlankLines("\r\n[msg]")).toBe("[msg]");
  });

  it("strips trailing blank lines", () => {
    expect(stripOuterBlankLines("hello\n\n")).toBe("hello");
  });

  it("strips trailing blank lines behind a trailing ANSI reset", () => {
    const t = `${ESC}[36mhello\n\n${ESC}[39m`;
    expect(stripOuterBlankLines(t)).toBe(`${ESC}[36mhello${ESC}[39m`);
  });

  it("preserves blank lines INSIDE a multi-line message", () => {
    const t = "line 1\n\nline 3";
    expect(stripOuterBlankLines(t)).toBe(t);
  });

  it("strips outer but keeps inner on a leading-blank multi-line message", () => {
    expect(stripOuterBlankLines("\nhead\n\nbody\n")).toBe("head\n\nbody");
  });
});
