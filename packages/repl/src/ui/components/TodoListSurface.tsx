/**
 * TodoListSurface — FEATURE_097 (v0.7.34); embedded-spinner layout since
 * FEATURE_151 (v0.7.38) Slice G/H.
 *
 * Renders the todo list under the spinner / above the BackgroundTaskBar.
 * Pure presentational layer — every layout decision (anchor, window,
 * summary folds, failed-item priority, post-completion linger) lives in
 * `view-models/todo-plan.ts`. This component just walks the rows and
 * emits one `<Text>` per row.
 *
 * Visual structure (Slice H — mirrors Claude Code `MessageResponse` +
 * `TaskListV2 isStandalone=false`, see
 * c:/Works/claudecode/src/components/MessageResponse.tsx#L22 +
 * c:/Works/claudecode/src/components/TaskListV2.tsx#L210):
 *
 *   ```
 *                                   1/3 completed     ← right-aligned counter
 *     ⎿  ☐ Add unit test                              ← ⎿ ONLY on first row
 *        ● Run failing tests                          ← subsequent rows align
 *        ☐ Wire CI                                       under the row content
 *   ```
 *
 *   - **Counter line** (top, right-aligned, dim): "X/N completed". Kept
 *     per user feedback (2026-05-09): the counter is informational and
 *     not visually heavy. Does NOT contribute to the "panel feel" — that
 *     was the per-row gutter, which is removed below.
 *   - **⎿ as left-column connector** (Slice H): a flex-row Box with a
 *     fixed-width left column (`"  ⎿  "`, dim) that renders ONCE — Ink's
 *     row layout means subsequent rows in the right column align under
 *     the row content with no extra gutter glyph per row. This produces
 *     CC's "embedded-in-spinner" feel instead of the Slice G "small panel
 *     with left border" feel that per-row `▏` produced.
 *   - **Symbol colors** come from the view-model's `symbolColor` field;
 *     the row text is rendered in default text color (failed item
 *     content gets a dim suffix `(note)` from the view-model).
 *
 * Surface visibility:
 *   - `vm.shouldRender === false` → return `null` (component unmounts).
 *   - `vm.rows.length === 0` → return `null` (empty list, surface hidden).
 *
 * History note:
 *   - Slice G (initial cut) deleted the counter line entirely. User
 *     feedback (2026-05-09) corrected: the counter wasn't the problem,
 *     the per-row `▏` gutter was. Slice H restores the counter and
 *     replaces the per-row gutter with CC's once-only `⎿` connector.
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
  return (
    <Box flexDirection="row">
      <Text color={symbolColor} bold={row.isActive}>
        {row.symbol}
      </Text>
      <Text> </Text>
      <Text dimColor={isSummary} bold={row.isActive}>
        {row.text}
      </Text>
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
  const counter = `${viewModel.completedCount}/${viewModel.totalCount} completed`;
  const dimColor = getTheme("dark").colors.dim;
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" justifyContent="flex-end">
        <Text dimColor>{counter}</Text>
      </Box>
      <Box flexDirection="row">
        <Text color={dimColor}>{EMBEDDED_PREFIX}</Text>
        <Box flexDirection="column" flexGrow={1}>
          {viewModel.rows.map((row, idx) => (
            <TodoListRow key={`${row.kind}-${row.id ?? idx}`} row={row} />
          ))}
        </Box>
      </Box>
    </Box>
  );
};
