/**
 * MessageList
 *
 * Reference Gemini CLI's message display architecture implementation.
 * Support HistoryItem types: user, assistant, tool_group, thinking, error, info, and hint.
 */

import React, { useMemo, memo } from "react";
import { Box, Text, useStdout } from "ink";
import { getTheme } from "../themes/index.js";
import { Spinner } from "./LoadingIndicator.js";
import type { Theme } from "../types.js";
import {
  ToolCallStatus,
  type HistoryItem,
  type HistoryItemUser,
  type HistoryItemAssistant,
  type HistoryItemToolGroup,
  type HistoryItemThinking,
  type HistoryItemError,
  type HistoryItemInfo,
  type HistoryItemHint,
  type HistoryItemSystem,
  type ToolCall,
} from "../types.js";
import type { IterationRecord } from "../contexts/StreamingContext.js";
import {
  buildTranscriptRows,
  getVisibleTranscriptRows,
  resolveTranscriptColor,
  type TranscriptRow,
} from "../utils/transcript-layout.js";

// === Types ===

export interface MessageListProps {
  /** History item list */
  items: HistoryItem[];
  /** Whether loading */
  isLoading?: boolean;
  /** Maximum display lines before truncation */
  maxLines?: number;
  /** Whether thinking - 是否正在 thinking */
  isThinking?: boolean;
  /** Thinking character count - Thinking 字符计数 */
  thinkingCharCount?: number;
  /** Thinking content (real-time display) - Thinking 内容 (实时显示) */
  thinkingContent?: string;
  /** Current streaming response text (real-time display) - 当前流式响应文本 (实时显示) */
  streamingResponse?: string;
  /** Current tool name - 当前工具名称 */
  currentTool?: string;
  /** Tool input character count - 工具输入字符计数 */
  toolInputCharCount?: number;
  /** Tool input content preview for display */
  toolInputContent?: string;
  /** Iteration history - 迭代历史 */
  iterationHistory?: IterationRecord[];
  /** Current iteration number - 当前迭代序号 */
  currentIteration?: number;
  /** Whether context compaction is in progress */
  isCompacting?: boolean;
  /** Visible viewport rows for transcript slicing */
  viewportRows?: number;
  /** Optional width override for deterministic transcript layout */
  viewportWidth?: number;
}

export interface HistoryItemRendererProps {
  item: HistoryItem;
  theme?: Theme;
  maxLines?: number;
}

// === Helpers ===

/**
 * Format timestamp
 */
function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Truncate text to the configured maximum number of lines.
 */
function truncateLines(text: string, maxLines: number): { lines: string[]; hasMore: boolean } {
  const lines = text.split("\n");
  const displayLines = lines.slice(0, maxLines);
  const hasMore = lines.length > maxLines;
  return { lines: displayLines, hasMore };
}

/**
 * Format tool execution duration.
 */
function formatDuration(startTime: number, endTime?: number): string {
  if (!endTime) return "";
  const ms = endTime - startTime;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Get the icon for a tool status.
 */
function getToolStatusIcon(status: ToolCallStatus): string {
  switch (status) {
    case ToolCallStatus.Scheduled:
      return "\u25CB";
    case ToolCallStatus.Validating:
      return "\u25D0";
    case ToolCallStatus.AwaitingApproval:
      return "\u23F8";
    case ToolCallStatus.Executing:
      return "\u25CF";
    case ToolCallStatus.Success:
      return "\u2713";
    case ToolCallStatus.Error:
      return "\u2717";
    case ToolCallStatus.Cancelled:
      return "\u2298";
    default:
      return "?";
  }
}

/**
 * Get the color for a tool status.
 */
function getToolStatusColor(status: ToolCallStatus, theme: Theme): string {
  switch (status) {
    case ToolCallStatus.Scheduled:
    case ToolCallStatus.Validating:
      return theme.colors.dim;
    case ToolCallStatus.AwaitingApproval:
      return theme.colors.accent;
    case ToolCallStatus.Executing:
      return theme.colors.primary;
    case ToolCallStatus.Success:
      return theme.colors.success;
    case ToolCallStatus.Error:
      return theme.colors.error;
    case ToolCallStatus.Cancelled:
      return theme.colors.dim;
    default:
      return theme.colors.text;
  }
}

// === Sub-Components ===

/**
 * User message renderer.
 */
const UserItemRenderer: React.FC<{ item: HistoryItemUser; theme: Theme }> = memo(({ item, theme }) => (
  <Box flexDirection="column" marginBottom={1}>
    <Box>
      <Text color={theme.colors.primary} bold>
        You
      </Text>
      <Text dimColor> [{formatTimestamp(item.timestamp)}]</Text>
    </Box>
    <Box marginLeft={2}>
      <Text color={theme.colors.text}>{item.text}</Text>
    </Box>
  </Box>
));

/**
 * Assistant message renderer.
 */
const AssistantItemRenderer: React.FC<{
  item: HistoryItemAssistant;
  theme: Theme;
  maxLines: number;
}> = memo(({ item, theme, maxLines }) => {
  const { lines, hasMore } = truncateLines(item.text, maxLines);

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color={theme.colors.secondary} bold>
          Assistant
        </Text>
        {item.isStreaming && (
          <>
            <Text> </Text>
            <Spinner color={theme.colors.accent} />
          </>
        )}
        <Text dimColor> [{formatTimestamp(item.timestamp)}]</Text>
      </Box>
      <Box marginLeft={2} flexDirection="column">
        {lines.map((line, index) => (
          <Text key={index} color={theme.colors.text}>
            {line || " "}
          </Text>
        ))}
        {hasMore && (
          <Text dimColor>... ({item.text.split("\n").length - maxLines} more lines)</Text>
        )}
      </Box>
    </Box>
  );
});

/**
 * System message renderer.
 */
const SystemItemRenderer: React.FC<{ item: HistoryItemSystem; theme: Theme }> = memo(({ item, theme }) => (
  <Box flexDirection="column" marginBottom={1}>
    <Box>
      <Text color={theme.colors.dim} bold>
        System
      </Text>
      <Text dimColor> [{formatTimestamp(item.timestamp)}]</Text>
    </Box>
    <Box marginLeft={2}>
      <Text dimColor>{item.text}</Text>
    </Box>
  </Box>
));

/**
 * Tool call renderer.
 */
const ToolCallRenderer: React.FC<{ tool: ToolCall; theme: Theme }> = memo(({ tool, theme }) => {
  const icon = getToolStatusIcon(tool.status);
  const color = getToolStatusColor(tool.status, theme);
  const duration = formatDuration(tool.startTime, tool.endTime);

  return (
    <Box flexDirection="column" marginLeft={2}>
      <Box>
        <Text color={color}>{icon} </Text>
        <Text color={theme.colors.text} bold>
          {tool.name}
        </Text>
        {tool.input && (
          <Text dimColor>
            {" "}
            {JSON.stringify(tool.input).slice(0, 50)}
            {JSON.stringify(tool.input).length > 50 ? "..." : ""}
          </Text>
        )}
      </Box>
      {tool.progress !== undefined && tool.status === ToolCallStatus.Executing && (
        <Box marginLeft={2}>
          <Text dimColor>Progress: {tool.progress}%</Text>
        </Box>
      )}
      {tool.error && (
        <Box marginLeft={2}>
          <Text color={theme.colors.error}>{tool.error}</Text>
        </Box>
      )}
      {duration && (
        <Box marginLeft={2}>
          <Text dimColor>Completed in {duration}</Text>
        </Box>
      )}
    </Box>
  );
});

/**
 * Tool group renderer
 */
const ToolGroupRenderer: React.FC<{ item: HistoryItemToolGroup; theme: Theme }> = memo(({ item, theme }) => (
  <Box flexDirection="column" marginBottom={1}>
    <Box>
      <Text color={theme.colors.accent} bold>
        Tools
      </Text>
      <Text dimColor> [{formatTimestamp(item.timestamp)}]</Text>
    </Box>
    {item.tools.map((tool) => (
      <ToolCallRenderer key={tool.id} tool={tool} theme={theme} />
    ))}
  </Box>
));

/**
 * Thinking content renderer
 */
const ThinkingItemRenderer: React.FC<{ item: HistoryItemThinking; theme: Theme }> = memo(({ item, theme }) => (
  <Box flexDirection="column" marginBottom={1}>
    <Box>
      <Text color={theme.colors.thinking} italic>
        Thinking
      </Text>
    </Box>
    <Box marginLeft={2}>
      <Text color={theme.colors.thinking} italic>
        {item.text}
      </Text>
    </Box>
  </Box>
));

/**
 * Error message renderer.
 */
const ErrorItemRenderer: React.FC<{ item: HistoryItemError; theme: Theme }> = memo(({ item, theme }) => (
  <Box flexDirection="column" marginBottom={1}>
    <Box>
      <Text color={theme.colors.error} bold>
        {"\u2717"} Error
      </Text>
    </Box>
    <Box marginLeft={2}>
      <Text color={theme.colors.error}>{item.text}</Text>
    </Box>
  </Box>
));

/**
 * Info message renderer.
 */
const InfoItemRenderer: React.FC<{ item: HistoryItemInfo; theme: Theme }> = memo(({ item, theme }) => (
  <Box flexDirection="column" marginBottom={1}>
    <Box>
      <Text color={theme.colors.info} bold>
        {item.icon ?? "\u2139"} Info
      </Text>
    </Box>
    <Box marginLeft={2}>
      <Text color={theme.colors.info}>{item.text}</Text>
    </Box>
  </Box>
));

/**
 * Hint message renderer.
 */
const HintItemRenderer: React.FC<{ item: HistoryItemHint; theme: Theme }> = memo(({ item, theme }) => (
  <Box flexDirection="column" marginBottom={1}>
    <Box>
      <Text color={theme.colors.hint} bold>
        💡 Hint
      </Text>
    </Box>
    <Box marginLeft={2}>
      <Text dimColor>{item.text}</Text>
    </Box>
  </Box>
));

// === Main Components ===

/**
 * History item renderer
 * Dispatch to corresponding renderer based on type
 */
export const HistoryItemRenderer: React.FC<HistoryItemRendererProps> = memo(({
  item,
  theme: themeProp,
  maxLines = 1000, // Increased from 20 to avoid truncation (Issue 046)
}) => {
  const theme = themeProp ?? useMemo(() => getTheme("dark"), []);

  switch (item.type) {
    case "user":
      return <UserItemRenderer item={item} theme={theme} />;
    case "assistant":
      return <AssistantItemRenderer item={item} theme={theme} maxLines={maxLines} />;
    case "system":
      return <SystemItemRenderer item={item} theme={theme} />;
    case "tool_group":
      return <ToolGroupRenderer item={item} theme={theme} />;
    case "thinking":
      return <ThinkingItemRenderer item={item} theme={theme} />;
    case "error":
      return <ErrorItemRenderer item={item} theme={theme} />;
    case "info":
      return <InfoItemRenderer item={item} theme={theme} />;
    case "hint":
      return <HintItemRenderer item={item} theme={theme} />;
    default:
      return (
        <Box>
          <Text dimColor>Unknown item type</Text>
        </Box>
      );
  }
});

/**
 * MessageList
 */
const TranscriptRowRenderer: React.FC<{ row: TranscriptRow; theme: Theme }> = memo(({ row, theme }) => {
  const color = resolveTranscriptColor(theme, row.color);

  return (
    <Box marginLeft={row.indent ?? 0}>
      {row.spinner && (
        <>
          <Spinner color={theme.colors.accent} theme={theme} />
          <Text> </Text>
        </>
      )}
      <Text color={color} bold={row.bold} italic={row.italic} dimColor={row.color === "dim"}>
        {row.text || " "}
      </Text>
    </Box>
  );
});

export const MessageList: React.FC<MessageListProps> = ({
  items,
  isLoading = false,
  maxLines = 1000,
  isThinking = false,
  thinkingCharCount = 0,
  thinkingContent = "",
  streamingResponse = "",
  currentTool,
  toolInputCharCount = 0,
  toolInputContent = "",
  iterationHistory = [],
  currentIteration = 1,
  isCompacting = false,
  viewportRows,
  viewportWidth,
}) => {
  const theme = useMemo(() => getTheme("dark"), []);
  const { stdout } = useStdout();
  const terminalWidth = viewportWidth ?? stdout?.columns ?? 80;

  if (items.length === 0 && !isLoading) {
    return (
      <Box paddingY={1}>
        <Text dimColor>No messages yet. Start typing to begin.</Text>
      </Box>
    );
  }

  const transcriptRows = useMemo(
    () => buildTranscriptRows({
      items,
      viewportWidth: terminalWidth,
      isLoading,
      maxLines,
      isThinking,
      thinkingCharCount,
      thinkingContent,
      streamingResponse,
      currentTool,
      toolInputCharCount,
      toolInputContent,
      iterationHistory,
      currentIteration,
      isCompacting,
    }),
    [
      items,
      terminalWidth,
      isLoading,
      maxLines,
      isThinking,
      thinkingCharCount,
      thinkingContent,
      streamingResponse,
      currentTool,
      toolInputCharCount,
      toolInputContent,
      iterationHistory,
      currentIteration,
      isCompacting,
    ]
  );

  const visibleRows = useMemo(
    () => getVisibleTranscriptRows(transcriptRows, viewportRows),
    [transcriptRows, viewportRows]
  );

  return (
    <Box flexDirection="column" paddingY={1}>
      {visibleRows.map((row) => (
        <TranscriptRowRenderer key={row.key} row={row} theme={theme} />
      ))}
    </Box>
  );
};

// === Legacy Exports (for backward compatibility) ===

import type { LegacyMessageListProps, Message } from "../types.js";

/**
 * @deprecated Use MessageList with items prop instead
 */
export const LegacyMessageList: React.FC<LegacyMessageListProps> = ({ messages, isLoading }) => {
  // Convert legacy Message to HistoryItem
  const items: HistoryItem[] = messages.map((msg: Message) => {
    const base = {
      id: msg.id,
      timestamp: msg.timestamp,
    };

    switch (msg.role) {
      case "user":
        return { ...base, type: "user" as const, text: msg.content };
      case "assistant":
        return { ...base, type: "assistant" as const, text: msg.content };
      case "system":
        return { ...base, type: "system" as const, text: msg.content };
      default:
        return { ...base, type: "info" as const, text: msg.content };
    }
  });

  return <MessageList items={items} isLoading={isLoading} />;
};

/**
 * Simplified message display.
 */
export const SimpleMessageDisplay: React.FC<{
  role: "user" | "assistant" | "system";
  content: string;
}> = ({ role, content }) => {
  const theme = useMemo(() => getTheme("dark"), []);

  const color = {
    user: theme.colors.primary,
    assistant: theme.colors.secondary,
    system: theme.colors.dim,
  }[role];

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={color} bold>
        {role === "user" ? ">" : role === "assistant" ? "<" : "#"}
      </Text>
      <Text>{content}</Text>
    </Box>
  );
};
