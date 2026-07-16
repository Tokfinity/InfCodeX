/**
 * TodoListSurface — FEATURE_097 (v0.7.34); embedded-spinner layout since
 * FEATURE_151 (v0.7.38) Slice H'.
 *
 * Renders the todo list under the spinner / above the BackgroundTaskBar.
 * Pure presentational layer — every layout decision (anchor, window,
 * summary folds, failed-item priority, post-completion linger) lives in
 * `view-models/todo-plan.ts`. This component just walks the rows and
 * emits one `<Text>` per row.
 *
 * Visual structure (Slice H' — mirrors Claude Code `MessageResponse`,
 * see c:/Works/claudecode/src/components/MessageResponse.tsx#L22):
 *
 *   ```
 *   ⠋ Running tests…                  1/3 completed   ← spinner row (rendered
 *     ⎿  ✓ Add unit test                                 by InkREPL activityBar
 *        ● Run failing tests                             slot, NOT this file)
 *        ☐ Wire CI                                    ← rows from this file
 *
 * Spinner glyph note: `⠋` shown above is one frame of KodaX's Braille
 * animation cycle (`["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"]`,
 * 80ms tick — see `LoadingIndicator.tsx:70`). KodaX does NOT use CC's
 * static `✻` sparkle; the spinner identity is preserved.
 *   ```
 *
 *   - **Counter rendering lives in `InkREPL.tsx` activityBar slot, NOT
 *     here.** Slice H' moved the `"X/N completed"` counter onto the
 *     spinner row (right-aligned, dim) per user feedback (2026-05-09)
 *     so spinner verb + counter share one line — saves vertical real
 *     estate, fewer "header lines" stacking. This component renders
 *     ONLY the `⎿` block + rows.
 *   - **⎿ as left-column connector**: a flex-row Box with a fixed-width
 *     left column (`"  ⎿  "`, dim) that renders ONCE — Ink's row layout
 *     means subsequent rows in the right column align under the first
 *     row's content position with no extra gutter glyph per row.
 *   - **Symbol colors** come from the view-model's `symbolColor` field;
 *     the row text is rendered in default text color (failed item
 *     content gets a dim suffix `(note)` from the view-model).
 *
 * Surface visibility:
 *   - `vm.shouldRender === false` → return `null` (component unmounts).
 *   - `vm.rows.length === 0` → return `null` (empty list, surface hidden).
 *
 * History note:
 *   - Slice G deleted the counter; user corrected — counter is fine,
 *     per-row `▏` gutter was the "panel" source.
 *   - Slice H replaced per-row `▏` with once-only `⎿`, kept counter as
 *     separate top line.
 *   - Slice H' (final) moved counter to the spinner row in InkREPL.tsx.
 *     `completedCount` / `totalCount` are still consumed — by the
 *     activityBar caller, not by this component.
 */

import React from "react";

import { Box, Text } from "../tui.js";
import { getTheme } from "../themes/index.js";
import type {
  TodoPlanViewModel,
  TodoRow,
  TodoSymbolColor,
} from "../view-models/todo-plan.js";

/**
 * CC `MessageResponse` left-column glyph (verbatim from
 * c:/Works/claudecode/src/components/MessageResponse.tsx#L22):
 * two leading spaces + `⎿` + two trailing spaces. The trailing spaces
 * give the right column a visual indent so subsequent rows line up
 * under the first row's content area.
 */
const EMBEDDED_PREFIX = "  ⎿  "; // ⎿ U+23BF

function resolveSymbolColor(
  color: TodoSymbolColor,
): string | undefined {
  const theme = getTheme("dark");
  switch (color) {
    case "cyan":
      return theme.colors.primary; // #01A4FF (Warp cyan)
    case "green":
      return theme.colors.success; // #19C37D
    case "red":
      return theme.colors.error; // #FF5F56
    case "gray":
    case "dim":
    default:
      return theme.colors.dim; // #666666
  }
}

interface TodoListRowProps {
  readonly row: TodoRow;
}

const TodoListRow: React.FC<TodoListRowProps> = ({ row }) => {
  const symbolColor = resolveSymbolColor(row.symbolColor);
  const isSummary = row.kind !== "item";
  // FEATURE_114 v0.7.36 Slice 4 — cancelled-status rows render with
  // strikethrough so the Worker-driven mid-task drop is visually
  // distinct from a Planner `skipped`. Ink `<Text>`'s `strikethrough`
  // prop wraps the text in chalk's strikethrough escape sequence;
  // ANSI terminals that don't support strikethrough (rare in
  // 2026 dev environments) downgrade gracefully — they simply render
  // without the line, which still leaves the `☒` symbol + dim color
  // as cues. The symbol itself is NOT struck through (would be
  // visually noisy and the U+2612 glyph already conveys cancelled).
  return (
    <Box flexDirection="row">
      <Text color={symbolColor} bold={row.isActive}>
        {row.symbol}
      </Text>
      <Text> </Text>
      <Text
        dimColor={isSummary}
        bold={row.isActive}
        strikethrough={row.isStrikethrough}
      >
        {row.text}
      </Text>
      {row.evaluatorBadge ? (
        <>
          <Text> </Text>
          <Text dimColor>{row.evaluatorBadge}</Text>
        </>
      ) : null}
    </Box>
  );
};

export interface TodoListSurfaceProps {
  readonly viewModel: TodoPlanViewModel;
}

export const TodoListSurface: React.FC<TodoListSurfaceProps> = ({
  viewModel,
}) => {
  if (!viewModel.shouldRender) return null;
  if (viewModel.rows.length === 0) return null;
  const dimColor = getTheme("dark").colors.dim;
  return (
    <Box flexDirection="row">
      <Text color={dimColor}>{EMBEDDED_PREFIX}</Text>
      <Box flexDirection="column" flexGrow={1}>
        {viewModel.rows.map((row, idx) => (
          <TodoListRow key={`${row.kind}-${row.id ?? idx}`} row={row} />
        ))}
      </Box>
    </Box>
  );
};
