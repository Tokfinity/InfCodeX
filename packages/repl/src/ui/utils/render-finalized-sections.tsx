/**
 * FEATURE_214 — offline section→scrollback text renderer.
 *
 * Renders finalized `TranscriptSection`s to the ANSI `text` that the engine's
 * `commitInlineScrollback` writes into native scrollback. It REUSES the exact same
 * React render path as the live `<Static>` (`StaticTranscriptItemRenderer` →
 * `TranscriptRowRenderer`) through Ink's synchronous `renderToString` — NO
 * hand-rewritten styling, NO capturing of live `<Static>` output. Both the ledger's
 * `append` and `rebuild` plans use THIS one renderer.
 *
 * Output contract (so it is safe to inject into scrollback above the repainted live
 * frame, per the engine primitive's expectations):
 *   - ends with a newline;
 *   - styles are reset at the end (no style bleed into the live frame below);
 *   - contains ONLY content + SGR styling — never cursor-move / clear-screen /
 *     positioning control codes (those belong to the engine's live paint, not to
 *     committed scrollback text).
 *
 * transcript / fullscreen use the windowed owned viewport and never call this.
 */
import React from "react";
import { Box } from "../tui.js";
import renderToString from "../../tui/substrate/ink/render-to-string.js";
import { StaticTranscriptItemRenderer } from "../components/MessageList.js";
import type { TranscriptSection } from "./transcript-layout.js";
import type { Theme } from "../types.js";

// ESC[0m built from char code so the escape byte is unambiguous in source.
const STYLE_RESET = String.fromCharCode(27) + "[0m";

export function renderFinalizedSectionsToScrollbackText(
  sections: readonly TranscriptSection[],
  options: { width: number; theme: Theme },
): string {
  if (sections.length === 0) {
    return "";
  }
  const tree = (
    <Box flexDirection="column">
      {sections.map((section) => (
        <StaticTranscriptItemRenderer
          key={section.key}
          section={section}
          theme={options.theme}
          animateSpinners={false}
        />
      ))}
    </Box>
  );
  const rendered = renderToString(tree, { columns: options.width });
  const body = rendered.endsWith("\n") ? rendered.slice(0, -1) : rendered;
  return body + STYLE_RESET + "\n";
}
