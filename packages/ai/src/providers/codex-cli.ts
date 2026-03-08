import { KodaXBaseProvider } from './base.js';
import { CodexCLIExecutor } from '../cli-events/codex-parser.js';
import { CLISessionManager } from '../cli-events/session.js';
import { buildCLIPrompt } from '../cli-events/prompt-utils.js';
import type {
    KodaXMessage,
    KodaXStreamResult,
    KodaXProviderStreamOptions,
    KodaXToolDefinition,
    KodaXTextBlock
} from '../types.js';

// 全局 Session Manager
const sessionManager = new CLISessionManager();

export class KodaXCodexCliProvider extends KodaXBaseProvider {
    readonly name = 'codex-cli';
    readonly supportsThinking = false;
    protected readonly config: import('../types.js').KodaXProviderConfig = {
        apiKeyEnv: 'CODEX_CLI_API_KEY', // Dummy, not used but required by base
        model: 'codex',
        supportsThinking: false,
        contextWindow: 128000,
    };

    private executor: CodexCLIExecutor;

    constructor() {
        super();
        this.executor = new CodexCLIExecutor();
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
                'Codex CLI 未安装。\n\n' +
                '请运行:\n' +
                '  npm install -g @openai/codex\n' +
                '  codex login\n\n' +
                '登录后 KodaX 会自动使用。'
            );
        }

        const kodaxSessionId = streamOptions?.sessionId ?? 'default';
        const existingSessionId = sessionManager.get(kodaxSessionId);

        const prompt = buildCLIPrompt(messages, !!existingSessionId);

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
                        sessionManager.set(kodaxSessionId, event.sessionId);
                        break;

                    case 'message':
                        if (event.role === 'assistant' && event.content) {
                            currentText += event.content;
                            streamOptions?.onTextDelta?.(event.content);
                        }
                        break;

                    case 'tool_use':
                        streamOptions?.onToolInputDelta?.(event.toolName, JSON.stringify(event.parameters));
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
                        throw new Error(`Codex CLI error: ${event.message}`);
                }
            }
        } catch (err) {
            if (err instanceof Error && err.name === 'AbortError') {
                // 用户取消，作为正常返回
            } else {
                throw err;
            }
        }

        if (currentText) {
            textBlocks.push({ type: 'text', text: currentText });
        }

        return {
            textBlocks,
            toolBlocks: [],
            thinkingBlocks: [],
        };
    }

}
