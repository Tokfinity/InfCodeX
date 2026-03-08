import { KodaXBaseProvider } from './base.js';
import { GeminiCLIExecutor } from '../cli-events/gemini-parser.js';
import { CLISessionManager } from '../cli-events/session.js';
import { buildCLIPrompt } from '../cli-events/prompt-utils.js';
import type {
    KodaXMessage,
    KodaXStreamResult,
    KodaXProviderStreamOptions,
    KodaXToolDefinition,
    KodaXTextBlock
} from '../types.js';

// 全局 Session Manager 实例，跨流式调用保持生命周期
const sessionManager = new CLISessionManager();

export class KodaXGeminiCliProvider extends KodaXBaseProvider {
    readonly name = 'gemini-cli';
    readonly supportsThinking = false;
    protected readonly config: import('../types.js').KodaXProviderConfig = {
        apiKeyEnv: 'GEMINI_CLI_API_KEY', // Dummy, not used but required by base
        model: 'gemini-2.5-pro',
        supportsThinking: false,
        contextWindow: 1048576, // Gemini 1M context
    };

    private executor: GeminiCLIExecutor;

    constructor() {
        super();
        this.executor = new GeminiCLIExecutor();
    }

    override isConfigured(): boolean {
        return true;
    }

    async stream(
        messages: KodaXMessage[],
        _tools: KodaXToolDefinition[],
        _system: string,
        _thinking: boolean,
        streamOptions?: KodaXProviderStreamOptions,
        signal?: AbortSignal
    ): Promise<KodaXStreamResult> {

        // 检查 CLI 安装
        if (!await this.executor.isInstalled()) {
            throw new Error(
                'Gemini CLI 未安装。\n\n' +
                '请运行:\n' +
                '  npm install -g geminicli\n' +
                '  gemini login\n\n' +
                '登录后 KodaX 会自动使用。'
            );
        }

        // 获取对应的 CLI session id
        const kodaxSessionId = streamOptions?.sessionId ?? 'default';
        const existingSessionId = sessionManager.get(kodaxSessionId);

        // 将 KodaX 的多轮历史扁平化成单轮 prompt
        // 如果是首轮，传全部文本；如果是多轮（有 resume ID），只传最后一条用户输入
        const prompt = buildCLIPrompt(messages, !!existingSessionId);

        // 执行 CLI 子进程
        const textBlocks: KodaXTextBlock[] = [];
        let currentText = '';

        const executionOptions = {
            prompt,
            sessionId: existingSessionId,
            signal,
        };

        try {
            for await (const event of this.executor.execute(executionOptions)) {
                switch (event.type) {
                    case 'session_start':
                        // 绑定会话
                        sessionManager.set(kodaxSessionId, event.sessionId);
                        break;

                    case 'message':
                        if (event.role === 'assistant' && event.content) {
                            currentText += event.content;
                            // 触发 KodaX 的打字机动画
                            if (event.delta) {
                                streamOptions?.onTextDelta?.(event.content);
                            }
                        }
                        break;

                    case 'tool_use':
                        // 【Delegate 模式核心】
                        // 触发 UI 动画，但绝不把具体的 tool 执行交给 Agent
                        streamOptions?.onToolInputDelta?.(event.toolName, JSON.stringify(event.parameters));

                        // 顺便把工具调用的日志拼接进文本里，让用户能看到历史
                        const logEntry = `\n> [Tool Use] ${event.toolName}: ${JSON.stringify(event.parameters)}\n`;
                        currentText += logEntry;
                        streamOptions?.onTextDelta?.(logEntry);
                        break;

                    case 'tool_result':
                        const resEntry = `> [Tool Result] ${event.status}\n\n`;
                        currentText += resEntry;
                        streamOptions?.onTextDelta?.(resEntry);
                        break;

                    case 'error':
                        throw new Error(`Gemini CLI error: ${event.message}`);
                }
            }
        } catch (err) {
            if (err instanceof Error && err.name === 'AbortError') {
                // 用户取消，吞掉错误，作为正常返回
            } else {
                throw err;
            }
        }

        if (currentText) {
            textBlocks.push({ type: 'text', text: currentText });
        }

        // 【Delegate 模式核心】
        // toolBlocks 永远为空，欺骗 agent.ts 不让它本地执行工具
        return {
            textBlocks,
            toolBlocks: [],
            thinkingBlocks: [],
        };
    }

}
