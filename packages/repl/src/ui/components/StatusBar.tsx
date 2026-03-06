/**
 * StatusBar - Bottom status bar component - 底部状态栏组件
 */

import React, { useMemo } from "react";
import { Box, Text } from "ink";
import { getTheme } from "../themes/index.js";
import type { StatusBarProps } from "../types.js";

export const StatusBar: React.FC<StatusBarProps> = ({
  sessionId,
  permissionMode,
  provider,
  model,
  tokenUsage,
  currentTool,
  thinking,
  thinkingCharCount,
  toolInputCharCount,
  toolInputContent,
  currentIteration,
  maxIter,
}) => {
  const theme = useMemo(() => getTheme("dark"), []);

  const displaySessionId = sessionId;

  // Map permission mode to display string with color hint
  // Issue 068: Show thinking char count in mode display when available
  const modeDisplay = thinking
    ? `${permissionMode.toUpperCase()}+think${thinkingCharCount ? ` (${thinkingCharCount})` : ''}`
    : permissionMode.toUpperCase();

  // Color-code by permission mode
  const modeColor =
    permissionMode === "plan"
      ? "blue"
      : permissionMode === "default"
        ? "white"
        : permissionMode === "accept-edits"
          ? "cyan"
          : "magenta"; // auto-in-project

  // Issue 068: Build iteration display with color gradient
  // Color gradient: Green (safe) -> Yellow (warning) -> Red (critical)
  const iterationDisplay = currentIteration && maxIter
    ? `🔄 ${currentIteration}/${maxIter}`
    : null;

  // Calculate iteration color based on progress
  const iterationColor = useMemo(() => {
    if (!currentIteration || !maxIter) return "dim";

    const ratio = currentIteration / maxIter;

    if (ratio < 0.5) {
      return "green"; // Safe zone
    } else if (ratio < 0.8) {
      return "yellow"; // Warning zone
    } else {
      return "red"; // Critical zone
    }
  }, [currentIteration, maxIter]);

  // Issue 068 Phase 4: Build tool display with parameter summary
  // Priority: toolInputContent (parameter preview) > toolInputCharCount (char count) > none
  const toolDisplay = currentTool
    ? toolInputContent
      ? `⏳ ${currentTool} (${toolInputContent}...)`
      : toolInputCharCount
        ? `⏳ ${currentTool} (${toolInputCharCount} chars)`
        : `⏳ ${currentTool}`
    : null;

  return (
    <Box
      paddingX={1}
      justifyContent="space-between"
    >
      {/* Left side: session info - 左侧：会话信息 */}
      <Box>
        <Text color={theme.colors.primary} bold>
          KodaX
        </Text>
        <Text dimColor> | </Text>
        <Text color={modeColor}>{modeDisplay}</Text>
        {/* Iteration display - Issue 068: 显示迭代进度 */}
        {iterationDisplay && (
          <>
            <Text dimColor> | </Text>
            <Text color={iterationColor}>{iterationDisplay}</Text>
          </>
        )}
        <Text dimColor> | </Text>
        <Text dimColor>{displaySessionId}</Text>
      </Box>

      {/* Middle: current tool with char count - 中间：当前工具（含字符数） */}
      {toolDisplay && (
        <Box>
          <Text color={theme.colors.warning}>{toolDisplay}</Text>
        </Box>
      )}

      {/* Right side: model and token usage - 右侧：模型和 Token 使用 */}
      <Box>
        <Text dimColor> | </Text>
        <Text color={theme.colors.secondary}>
          {provider}/{model}
        </Text>
        {tokenUsage && (
          <>
            <Text dimColor> | </Text>
            <Text dimColor>
              {tokenUsage.input}→{tokenUsage.output} ({tokenUsage.total})
            </Text>
          </>
        )}
      </Box>
    </Box>
  );
};

/**
 * Simplified status bar - 简化版状态栏
 */
export const SimpleStatusBar: React.FC<{
  permissionMode: string;
  provider: string;
  model: string;
}> = ({ permissionMode, provider, model }) => {
  const theme = useMemo(() => getTheme("dark"), []);

  return (
    <Box>
      <Text color={theme.colors.primary} bold>
        [{permissionMode}]
      </Text>
      <Text dimColor>
        {" "}
        {provider}/{model}
      </Text>
    </Box>
  );
};

