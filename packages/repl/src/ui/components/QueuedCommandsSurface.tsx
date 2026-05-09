import React from "react";
import { Box, Text } from "../tui.js";
import { getTheme } from "../themes/index.js";
import {
  formatPendingInputsLines,
} from "../utils/pending-inputs.js";

export interface QueuedCommandsSurfaceProps {
  pendingInputs: readonly string[];
}

export const QueuedCommandsSurface: React.FC<QueuedCommandsSurfaceProps> = ({
  pendingInputs,
}) => {
  // FEATURE_149 Phase 2.2 (v0.7.38) — render each queued item on its own line
  // so the user can see the order they will run in, plus a footer hint about
  // the editing keys (↑ pulls all back, Esc drops the latest).
  const lines = formatPendingInputsLines(pendingInputs);
  if (lines.length === 0) {
    return null;
  }

  const theme = getTheme("dark");
  return (
    <Box flexDirection="column">
      {lines.map((line) => (
        <Box key={line.index}>
          <Text color={theme.colors.hint}>{"⏳"} </Text>
          <Text color={theme.colors.dim}>
            [{line.index}/{line.total}] {line.preview}
          </Text>
        </Box>
      ))}
      <Box>
        <Text color={theme.colors.dim}>
          {"  "}↑ pull all into editor · Esc drops latest
        </Text>
      </Box>
    </Box>
  );
};

