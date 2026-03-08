/**
 * CLI 执行事件 - 统一抽象层，屏蔽两个 CLI 的格式差异
 */
export type CLIEvent =
    | CLISessionStartEvent
    | CLIMessageEvent
    | CLIToolUseEvent
    | CLIToolResultEvent
    | CLIThinkingEvent
    | CLIErrorEvent
    | CLICompleteEvent;

export interface CLISessionStartEvent {
    type: 'session_start';
    timestamp: number;
    sessionId: string;
    model: string;
    raw: unknown;
}

export interface CLIMessageEvent {
    type: 'message';
    timestamp: number;
    role: 'user' | 'assistant';
    content: string;
    delta?: boolean;  // 是否为增量输出
    raw: unknown;
}

export interface CLIToolUseEvent {
    type: 'tool_use';
    timestamp: number;
    toolId: string;
    toolName: string;
    parameters: Record<string, unknown>;
    raw: unknown;
}

export interface CLIToolResultEvent {
    type: 'tool_result';
    timestamp: number;
    toolId: string;
    status: 'success' | 'error';
    output: string;
    raw: unknown;
}

export interface CLIThinkingEvent {
    type: 'thinking';
    timestamp: number;
    content: string;
    delta?: boolean;
    raw: unknown;
}

export interface CLIErrorEvent {
    type: 'error';
    timestamp: number;
    errorType: string;
    message: string;
    code?: number;
    raw: unknown;
}

export interface CLICompleteEvent {
    type: 'complete';
    timestamp: number;
    status: 'success' | 'failed';
    usage?: {
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
    };
    raw: unknown;
}

export interface CLIExecutorConfig {
    command: string;              // 'codex' 或 'gemini'
    baseArgs: string[];           // 基础参数
    timeout?: number;             // 超时时间 (ms)，默认 5 分钟
    cwd?: string;                 // 工作目录
    env?: Record<string, string>; // 额外环境变量
}

export interface CLIExecutionOptions {
    prompt: string;
    sessionId?: string;           // 恢复会话时提供
    signal?: AbortSignal;         // 取消信号
}
