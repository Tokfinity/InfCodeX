/**
 * MessageList - History message list component - 历史消息列表组件
 *
 * Reference Gemini CLI's message display architecture implementation.
 * Support HistoryItem types: user, assistant, tool_group, thinking, error, info, hint - 参考 Gemini CLI 的消息显示架构实现，支持 HistoryItem 类型：user, assistant, tool_group, thinking, error, info, hint
 */

import React, { useMemo, memo, type ReactNode } from "react";
import { Box, Text, Static } from "ink";
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

// === Types ===

export interface MessageListProps {
  /** History item list - 历史项列表 */
  items: HistoryItem[];
  /** Whether loading - 是否加载中 */
  isLoading?: boolean;
  /** Maximum display lines (default 1000, avoid truncation) - 最大显示行数 (默认 1000，避免截断) */
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
  /** Tool input content (truncated, for display) - 工具输入内容（截断，用于显示） */
  toolInputContent?: string;
  /** Iteration history - 迭代历史 */
  iterationHistory?: IterationRecord[];
  /** Current iteration number - 当前迭代序号 */
  currentIteration?: number;
  /** Whether compacting context - 是否正在压缩上下文 */
  isCompacting?: boolean;
}

export interface HistoryItemRendererProps {
  item: HistoryItem;
  theme?: Theme;
  maxLines?: number;
}

// === Helpers ===

/**
 * Format timestamp - 格式化时间戳
 */
function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Truncate text to max lines - 截断文本到最大行数
 */
function truncateLines(text: string, maxLines: number): { lines: string[]; hasMore: boolean } {
  const lines = text.split("\n");
  const displayLines = lines.slice(0, maxLines);
  const hasMore = lines.length > maxLines;
  return { lines: displayLines, hasMore };
}

/**
 * Format tool execution duration - 格式化工具执行时间
 */
function formatDuration(startTime: number, endTime?: number): string {
  if (!endTime) return "";
  const ms = endTime - startTime;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Get tool status icon - 获取工具状态图标
 */
function getToolStatusIcon(status: ToolCallStatus): string {
  switch (status) {
    case ToolCallStatus.Scheduled:
      return "○";
    case ToolCallStatus.Validating:
      return "◐";
    case ToolCallStatus.AwaitingApproval:
      return "⏸";
    case ToolCallStatus.Executing:
      return "●";
    case ToolCallStatus.Success:
      return "✓";
    case ToolCallStatus.Error:
      return "✗";
    case ToolCallStatus.Cancelled:
      return "⊘";
    default:
      return "?";
  }
}

/**
 * Get tool status color - 获取工具状态颜色
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
 * User message renderer - 用户消息渲染器
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
 * Assistant message renderer - 助手消息渲染器
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
 * System message renderer - 系统消息渲染器
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
 * Tool call renderer - 工具调用渲染器
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
 * Tool group renderer - 工具组渲染器
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
 * Thinking content renderer - 思考内容渲染器
 */
const ThinkingItemRenderer: React.FC<{ item: HistoryItemThinking; theme: Theme }> = memo(({ item, theme }) => (
  <Box flexDirection="column" marginBottom={1}>
    <Box>
      <Text color={theme.colors.dim} italic>
        Thinking
      </Text>
    </Box>
    <Box marginLeft={2}>
      <Text dimColor italic>
        {item.text}
      </Text>
    </Box>
  </Box>
));

/**
 * Error message renderer - 错误消息渲染器
 */
const ErrorItemRenderer: React.FC<{ item: HistoryItemError; theme: Theme }> = memo(({ item, theme }) => (
  <Box flexDirection="column" marginBottom={1}>
    <Box>
      <Text color={theme.colors.error} bold>
        ✗ Error
      </Text>
    </Box>
    <Box marginLeft={2}>
      <Text color={theme.colors.error}>{item.text}</Text>
    </Box>
  </Box>
));

/**
 * Info message renderer - 信息消息渲染器
 */
const InfoItemRenderer: React.FC<{ item: HistoryItemInfo; theme: Theme }> = memo(({ item, theme }) => (
  <Box flexDirection="column" marginBottom={1}>
    <Box>
      <Text color={theme.colors.info} bold>
        {item.icon ?? "ℹ"} Info
      </Text>
    </Box>
    <Box marginLeft={2}>
      <Text color={theme.colors.info}>{item.text}</Text>
    </Box>
  </Box>
));

/**
 * Hint message renderer - 提示消息渲染器
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
 * Dispatch to corresponding renderer based on type - 历史项渲染器，根据类型分发到对应的渲染器
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
 * MessageList - Message list component - 消息列表组件
 */
export const MessageList: React.FC<MessageListProps> = ({
  items,
  isLoading = false,
  maxLines = 1000, // Increased from 20 to avoid truncation (Issue 046)
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
}) => {
  const theme = useMemo(() => getTheme("dark"), []);

  // Find the last user prompt index for splitting static/dynamic content
  // 参考 Gemini CLI 的实现：将历史分为静态部分和最后响应部分
  const lastUserPromptIndex = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      const type = items[i]?.type;
      if (type === "user" || type === "system") {
        return i;
      }
    }
    return -1;
  }, [items]);

  // Split history into static and dynamic parts
  // 静态部分：最后一个用户输入之前的历史（使用 Static 包裹，不会重新渲染）
  const staticHistoryItems = useMemo(
    () => items.slice(0, lastUserPromptIndex + 1),
    [items, lastUserPromptIndex]
  );

  // 最后响应部分：最后一个用户输入之后的响应（静态但会更新）
  const lastResponseHistoryItems = useMemo(
    () => items.slice(lastUserPromptIndex + 1),
    [items, lastUserPromptIndex]
  );

  if (items.length === 0 && !isLoading) {
    return (
      <Box paddingY={1}>
        <Text dimColor>No messages yet. Start typing to begin.</Text>
      </Box>
    );
  }

  // Determine loading status text - 确定加载状态文本
  // Issue 068 Phase 4: Priority: compacting > toolInputContent (parameter preview) > toolInputCharCount (char count) > none
  let loadingText = "Thinking";
  let prefix = "";
  if (isCompacting) {
    // Show "Compacting" when compacting context - 压缩上下文时显示 "Compacting"
    loadingText = "Compacting";
  } else if (currentTool) {
    prefix = "[Tool] ";
    loadingText = toolInputContent
      ? `${currentTool} (${toolInputContent}...)`
      : toolInputCharCount > 0
        ? `${currentTool} (${toolInputCharCount} chars)`
        : `Executing ${currentTool}...`;
  } else if (isThinking) {
    // Show [Thinking] prefix when in thinking mode (with or without char count)
    prefix = "[Thinking] ";
    loadingText = thinkingCharCount > 0
      ? `(${thinkingCharCount} chars)`
      : "processing...";
  }

  // Render pending items (streaming content, loading indicators, etc.)
  // 待处理项目：流式内容、加载指示器等（不使用 Static，可以动态更新）
  const pendingItems = (
    <Box flexDirection="column">
      {/* Iteration history display - 迭代历史显示 */}
      {iterationHistory.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          {iterationHistory.map((record) => (
            <Box key={`iteration-${record.iteration}`} flexDirection="column" marginBottom={1}>
              {/* Iteration header - 迭代标题 */}
              <Box>
                <Text color={theme.colors.dim} bold>
                  ── Round {record.iteration} ──
                </Text>
              </Box>
              {/* Thinking summary - Thinking 摘要 */}
              {record.thinkingSummary && (
                <Box marginLeft={1}>
                  <Text color={theme.colors.dim} italic>
                    💭 {record.thinkingSummary}
                    {record.thinkingLength > 60 && <Text dimColor> ({record.thinkingLength} chars total)</Text>}
                  </Text>
                </Box>
              )}
              {/* Response snippet (first 200 chars) - 响应片段（前200字符） */}
              {record.response && (
                <Box marginLeft={1} flexDirection="column">
                  {record.response.slice(0, 200).split("\n").map((line, idx) => (
                    <Text key={idx} color={theme.colors.text} dimColor>{line || " "}</Text>
                  ))}
                  {record.response.length > 200 && (
                    <Text dimColor>... ({record.response.length} chars total)</Text>
                  )}
                </Box>
              )}
            </Box>
          ))}
        </Box>
      )}

      {/* Current iteration header (if multiple iterations) - 当前迭代标题（如果是多轮） */}
      {iterationHistory.length > 0 && (
        <Box marginBottom={1}>
          <Text color={theme.colors.accent} bold>
            ── Round {currentIteration} (current) ──
          </Text>
        </Box>
      )}

      {/* Thinking content display - light gray - Thinking 内容显示 - 淡灰色 */}
      {/* Display condition: response in progress + has thinking content - 显示条件：响应进行中 + 有 thinking 内容 */}
      {isLoading && thinkingContent && (
        <Box flexDirection="column" marginBottom={1}>
          <Box>
            <Text color={theme.colors.dim} italic>Thinking</Text>
          </Box>
          <Box marginLeft={2}>
            <Text dimColor italic>{thinkingContent}</Text>
          </Box>
        </Box>
      )}

      {/* Streaming response display - 流式响应显示 */}
      {streamingResponse && (
        <Box flexDirection="column" marginBottom={1}>
          <Box>
            <Text color={theme.colors.secondary} bold>Assistant</Text>
          </Box>
          <Box marginLeft={2} flexDirection="column">
            {streamingResponse.split("\n").map((line, index) => (
              <Text key={index} color={theme.colors.text}>{line || " "}</Text>
            ))}
          </Box>
        </Box>
      )}

      {/* Loading indicator - only show when no streaming content - 加载指示器 - 只在没有流式内容时显示 */}
      {isLoading && !streamingResponse && !thinkingContent && (
        <Box>
          <Spinner theme={theme} />
          {prefix && <Text color={theme.colors.dim}> {prefix}</Text>}
          <Text color={theme.colors.accent}> {loadingText}…</Text>
        </Box>
      )}

      {/* Show simplified loading indicator when has thinking content - 有 thinking 内容时显示简化的加载指示器 */}
      {isLoading && (streamingResponse || thinkingContent) && (
        <Box>
          <Spinner theme={theme} />
          {prefix && <Text color={theme.colors.dim}> {prefix}</Text>}
          <Text color={theme.colors.accent}> {loadingText}…</Text>
        </Box>
      )}
    </Box>
  );

  return (
    <Box flexDirection="column" paddingY={1}>
      {/* Static history items - won't re-render after initial render */}
      {/* 静态历史项 - 初始渲染后不会重新渲染 */}
      <Static items={[...staticHistoryItems, ...lastResponseHistoryItems]}>
        {(item) => (
          <HistoryItemRenderer
            key={item.id}
            item={item}
            theme={theme}
            maxLines={maxLines}
          />
        )}
      </Static>

      {/* Pending items - can update dynamically */}
      {/* 待处理项目 - 可以动态更新 */}
      {pendingItems}
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
 * Simplified message display - 简化消息显示
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
