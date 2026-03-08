/**
 * KodaX AI Types
 *
 * AI 层类型定义 - 所有 Provider 共享的类型接口
 */

// ============== 内容块类型 ==============

export interface KodaXTextBlock {
  type: 'text';
  text: string;
}

export interface KodaXToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface KodaXToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export interface KodaXThinkingBlock {
  type: 'thinking';
  thinking: string;
  signature?: string;
}

export interface KodaXRedactedThinkingBlock {
  type: 'redacted_thinking';
  data: string;
}

export type KodaXContentBlock =
  | KodaXTextBlock
  | KodaXToolUseBlock
  | KodaXToolResultBlock
  | KodaXThinkingBlock
  | KodaXRedactedThinkingBlock;

// ============== 消息类型 ==============

export interface KodaXMessage {
  role: 'user' | 'assistant' | 'system';
  content: string | KodaXContentBlock[];
}

// ============== 流式结果类型 ==============

export interface KodaXStreamResult {
  textBlocks: KodaXTextBlock[];
  toolBlocks: KodaXToolUseBlock[];
  thinkingBlocks: (KodaXThinkingBlock | KodaXRedactedThinkingBlock)[];
}

// ============== 工具定义 ==============

export interface KodaXToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

// ============== Provider 配置 ==============

export interface KodaXProviderConfig {
  apiKeyEnv: string;
  baseUrl?: string;
  model: string;
  supportsThinking: boolean;
  /** 模型的上下文窗口大小 (tokens) */
  contextWindow?: number;
}

export interface KodaXProviderStreamOptions {
  onTextDelta?: (text: string) => void;
  onThinkingDelta?: (text: string) => void;
  onThinkingEnd?: (thinking: string) => void;
  onToolInputDelta?: (toolName: string, partialJson: string) => void;
  /** 会话标识，用于多轮对话上下文恢复 */
  sessionId?: string;
  /** AbortSignal for cancelling the stream request */
  signal?: AbortSignal;
}
