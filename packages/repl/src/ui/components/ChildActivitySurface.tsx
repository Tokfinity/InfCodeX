import React from "react";

import { Box, Text } from "../tui.js";
import { getTheme } from "../themes/index.js";
import type {
  ChildActivityRow,
  ChildActivitySymbolColor,
  ChildActivityViewModel,
} from "../view-models/child-activity.js";
import {
  CHILD_ACTIVITY_LABEL_WIDTH,
  padChildActivitySymbol,
} from "../view-models/child-activity.js";

const LABEL_WIDTH = CHILD_ACTIVITY_LABEL_WIDTH;

function resolveSymbolColor(color: ChildActivitySymbolColor): string | undefined {
  const theme = getTheme("dark");
  switch (color) {
    case "cyan":
      return theme.colors.primary;
    case "green":
      return theme.colors.success;
    case "dim":
    default:
      return theme.colors.dim;
  }
}

interface ChildActivityRowProps {
  readonly row: ChildActivityRow;
}

const ChildActivityRowView: React.FC<ChildActivityRowProps> = ({ row }) => {
  const symbolColor = resolveSymbolColor(row.symbolColor);
  return (
    <Box flexDirection="row">
      <Box width={LABEL_WIDTH} flexShrink={0}>
        <Text color={symbolColor} bold={row.isActive} wrap="truncate">
          {padChildActivitySymbol(row.symbol, LABEL_WIDTH)}
        </Text>
      </Box>
      <Text
        color={row.kind === "summary" ? getTheme("dark").colors.dim : undefined}
        bold={row.isActive}
        wrap="truncate"
      >
        {row.text}
      </Text>
    </Box>
  );
};

export interface ChildActivitySurfaceProps {
  readonly viewModel: ChildActivityViewModel;
}

export function measureChildActivitySurfaceRows(
  viewModel: ChildActivityViewModel,
): number {
  if (!viewModel.shouldRender || viewModel.rows.length === 0) {
    return 0;
  }

  return viewModel.rows.length;
}

export const ChildActivitySurface: React.FC<ChildActivitySurfaceProps> = ({
  viewModel,
}) => {
  if (!viewModel.shouldRender) return null;
  if (viewModel.rows.length === 0) return null;
  return (
    <Box flexDirection="column" flexGrow={1}>
      {viewModel.rows.map((row) => (
        <ChildActivityRowView key={`${row.kind}-${row.id}`} row={row} />
      ))}
    </Box>
  );
};
