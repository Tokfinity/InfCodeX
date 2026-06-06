import React from "react";
import { describe, it, expect } from "vitest";
import { renderFinalizedSectionsToScrollbackText } from "./render-finalized-sections.js";
import { Box } from "../tui.js";
import renderToString from "../../tui/substrate/ink/render-to-string.js";
import { StaticTranscriptItemRenderer } from "../components/MessageList.js";
import { getTheme } from "../themes/index.js";
import type { TranscriptSection } from "./transcript-layout.js";

const ESC = String.fromCharCode(27);
const theme = getTheme();

const sec = (
  key: string,
  ...rows: Array<{ text: string; bold?: boolean }>
): TranscriptSection => ({
  key,
  rows: rows.map((r, i) => ({ key: `${key}-r${i}`, text: r.text, bold: r.bold })),
});

// Strip all CSI sequences to recover the visible text.
const stripAnsi = (s: string): string =>
  s.replace(new RegExp(ESC + "\\[[0-9;?]*[A-Za-z]", "g"), "");

describe("renderFinalizedSectionsToScrollbackText (FEATURE_214 offline section renderer)", () => {
  it("empty sections → empty string (nothing to commit)", () => {
    expect(renderFinalizedSectionsToScrollbackText([], { width: 80, theme })).toBe("");
  });

  it("renders the section's visible text", () => {
    const out = renderFinalizedSectionsToScrollbackText(
      [sec("a", { text: "hello world" }, { text: "second line" })],
      { width: 80, theme },
    );
    const visible = stripAnsi(out);
    expect(visible).toContain("hello world");
    expect(visible).toContain("second line");
  });

  it("ends with a newline", () => {
    const out = renderFinalizedSectionsToScrollbackText([sec("a", { text: "x" })], { width: 80, theme });
    expect(out.endsWith("\n")).toBe(true);
  });

  it("ends with a style reset (no style bleed into the repainted live frame)", () => {
    const out = renderFinalizedSectionsToScrollbackText([sec("a", { text: "x" })], { width: 80, theme });
    expect(out.endsWith(ESC + "[0m\n")).toBe(true);
  });

  it("contains NO cursor-move / clear-screen / positioning control codes (SGR only)", () => {
    const out = renderFinalizedSectionsToScrollbackText(
      [sec("a", { text: "line one" }, { text: "line two" })],
      { width: 80, theme },
    );
    // The renderer's own trailing reset is SGR ([0m). There must be no cursor moves
    // (A-G), home (H/f), or erase (J/K), and no cursor show/hide (?25).
    expect(out).not.toMatch(new RegExp(ESC + "\\[[0-9;]*[ABCDEFGHJKf]"));
    expect(out).not.toContain(ESC + "[?25");
    expect(out).not.toContain(ESC + "[3J");
  });

  it("matches StaticTranscriptItemRenderer's own render (visual text + key styles) via the same React path", () => {
    const section = sec("a", { text: "styled", bold: true }, { text: "plain row" });
    const mine = renderFinalizedSectionsToScrollbackText([section], { width: 80, theme });
    // Direct render of the SAME component the live <Static> uses.
    const direct = renderToString(
      <Box flexDirection="column">
        <StaticTranscriptItemRenderer section={section} theme={theme} animateSpinners={false} />
      </Box>,
      { columns: 80 },
    );
    const directBody = direct.endsWith("\n") ? direct.slice(0, -1) : direct;
    const mineBody = mine.slice(0, mine.length - (ESC + "[0m\n").length);
    // Identical body — same text AND same styling escape sequences (no hand-rewrite).
    expect(mineBody).toBe(directBody);
  });
});
