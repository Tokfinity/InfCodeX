import React from "react";

import { Box, Text } from "../tui.js";
import { getTheme } from "../themes/index.js";
import type {
  WorkflowLiveRow,
  WorkflowLiveSymbolColor,
  WorkflowLiveViewModel,
} from "../view-models/workflow-live.js";
import {
  padWorkflowLiveSymbol,
  WORKFLOW_LIVE_LABEL_WIDTH,
} from "../view-models/workflow-live.js";

const LABEL_WIDTH = WORKFLOW_LIVE_LABEL_WIDTH;

function resolveSymbolColor(color: WorkflowLiveSymbolColor): string | undefined {
  const theme = getTheme("dark");
  switch (color) {
    case "cyan":
      return theme.colors.primary;
    case "green":
      return theme.colors.success;
    case "red":
      return theme.colors.error;
    case "dim":
    default:
      return theme.colors.dim;
  }
}

interface WorkflowRunRowProps {
  readonly row: WorkflowLiveRow;
}

const WorkflowRunRow: React.FC<WorkflowRunRowProps> = ({ row }) => {
  const symbolColor = resolveSymbolColor(row.symbolColor);
  return (
    <Box flexDirection="row">
      <Box width={LABEL_WIDTH} flexShrink={0}>
        <Text color={symbolColor} bold={row.isActive} wrap="truncate">
          {padWorkflowLiveSymbol(row.symbol, LABEL_WIDTH)}
        </Text>
      </Box>
      <Text
        color={row.kind === "hint" ? getTheme("dark").colors.dim : undefined}
        bold={row.isActive}
        wrap="truncate"
      >
        {row.text}
      </Text>
    </Box>
  );
};

export interface WorkflowRunSurfaceProps {
  readonly viewModel: WorkflowLiveViewModel;
}

export function measureWorkflowRunSurfaceRows(
  viewModel: WorkflowLiveViewModel,
): number {
  if (!viewModel.shouldRender || viewModel.rows.length === 0) {
    return 0;
  }

  return viewModel.rows.length;
}

export const WorkflowRunSurface: React.FC<WorkflowRunSurfaceProps> = ({
  viewModel,
}) => {
  if (!viewModel.shouldRender) return null;
  if (viewModel.rows.length === 0) return null;
  return (
    <Box flexDirection="column" flexGrow={1}>
      {viewModel.rows.map((row, index) => (
        <WorkflowRunRow key={`${row.kind}-${row.id ?? index}`} row={row} />
      ))}
    </Box>
  );
};
