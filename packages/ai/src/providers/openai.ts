/**
 * KodaX OpenAI Compatible Provider
 *
 * 支持 OpenAI API 格式的 Provider 基类
 */

import OpenAI from 'openai';
import { KodaXBaseProvider } from './base.js';
import { KodaXProviderError } from '../errors.js';
import {
  KodaXReasoningCapability,
  KodaXProviderConfig,
  KodaXMessage,
  KodaXToolDefinition,
  KodaXProviderStreamOptions,
  KodaXReasoningRequest,
  KodaXStreamResult,
  KodaXTextBlock,
  KodaXToolUseBlock,
} from '../types.js';
import { KODAX_MAX_TOKENS } from '../constants.js';
import {
  clampThinkingBudget,
  isReasoningEnabled,
  mapDepthToOpenAIReasoningEffort,
  resolveThinkingBudget,
} from '../reasoning.js';

export abstract class KodaXOpenAICompatProvider extends KodaXBaseProvider {
  abstract override readonly name: string;
  readonly supportsThinking = true;
  protected abstract override readonly config: KodaXProviderConfig;
  protected client!: OpenAI;

  protected initClient(): void {
    this.client = new OpenAI({ apiKey: this.getApiKey(), baseURL: this.config.baseUrl });
  }

  private applyReasoningCapability(
    createParams: OpenAI.Chat.ChatCompletionCreateParamsStreaming,
    capability: KodaXReasoningCapability,
    reasoning: Required<KodaXReasoningRequest>,
  ): void {
    // The OpenAI SDK types do not expose provider-specific extensions like
    // Qwen's extra_body or Zhipu's thinking block, so we intentionally attach
    // those fields on the raw request object here.
    const params = createParams as unknown as Record<string, unknown>;
    const maxOutputTokens =
      this.config.maxOutputTokens ?? KODAX_MAX_TOKENS;
    const requestedBudget = clampThinkingBudget(
      resolveThinkingBudget(
        this.config,
        reasoning.depth,
        reasoning.taskType,
      ),
      maxOutputTokens,
    );

    switch (capability) {
      case 'native-effort': {
        const reasoningEffort = mapDepthToOpenAIReasoningEffort(reasoning.depth);
        if (reasoningEffort) {
          params.reasoning_effort = reasoningEffort;
        }
        break;
      }
      case 'native-budget': {
        if (this.name === 'qwen') {
          params.extra_body = {
            enable_thinking: true,
            thinking_budget: requestedBudget,
          };
        } else if (this.name === 'zhipu') {
          params.thinking = {
            type: 'enabled',
            budget_tokens: requestedBudget,
          };
        }
        break;
      }
      case 'native-toggle': {
        if (this.name === 'qwen') {
          params.extra_body = {
            enable_thinking: true,
          };
        } else if (this.name === 'zhipu') {
          params.thinking = {
            type: 'enabled',
          };
        }
        break;
      }
      default:
        break;
    }
  }

  private getFallbackTerms(capability: KodaXReasoningCapability): string[] {
    switch (capability) {
      case 'native-budget':
        return ['thinking_budget', 'budget_tokens', 'thinking'];
      case 'native-effort':
        return ['reasoning_effort'];
      case 'native-toggle':
        return ['enable_thinking', 'thinking'];
      default:
        return [];
    }
  }

  async stream(
    messages: KodaXMessage[],
    tools: KodaXToolDefinition[],
    system: string,
    reasoning?: boolean | KodaXReasoningRequest,
    streamOptions?: KodaXProviderStreamOptions,
    signal?: AbortSignal
  ): Promise<KodaXStreamResult> {
    return this.withRateLimit(async () => {
      const fullMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
        { role: 'system', content: system },
        ...this.convertMessages(messages),
      ];
      const openaiTools = tools.map(t => ({ type: 'function' as const, function: { name: t.name, description: t.description, parameters: t.input_schema } }));

      // 检查是否已被取消
      if (signal?.aborted) {
        throw new DOMException('Request aborted', 'AbortError');
      }

      const toolCallsMap = new Map<number, { id: string; name: string; arguments: string }>();
      let textContent = '';

      // Issue 084 fix: Track stream completion
      let finishReason: string | null = null;
      const streamStartTime = Date.now();

      // 传递 signal 给 SDK，确保底层 HTTP 请求能被取消
      const normalizedReasoning = this.normalizeReasoning(reasoning);
      const model = streamOptions?.modelOverride ?? this.config.model;
      const initialCapability =
        isReasoningEnabled(normalizedReasoning)
          ? this.getReasoningCapability(model)
          : 'none';
      const attempts: Array<'native-budget' | 'native-effort' | 'native-toggle' | 'none'> = isReasoningEnabled(normalizedReasoning)
        ? this.getReasoningFallbackChain(initialCapability)
            .filter((capability): capability is 'native-budget' | 'native-effort' | 'native-toggle' | 'none' =>
              capability === 'native-budget' ||
              capability === 'native-effort' ||
              capability === 'native-toggle' ||
              capability === 'none',
            )
        : ['none'];
      const createParams: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
        model,
        messages: fullMessages,
        tools: openaiTools,
        max_completion_tokens:
          this.config.maxOutputTokens ?? KODAX_MAX_TOKENS,
        stream: true,
      };

      let stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk> | undefined;
      let lastError: unknown;

      for (const capability of attempts) {
        const attemptParams: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
          ...createParams,
        };

        this.applyReasoningCapability(attemptParams, capability, normalizedReasoning);

        try {
          stream = await this.client.chat.completions.create(
            attemptParams,
            signal ? { signal } : {},
          );
          if (capability !== initialCapability) {
            this.persistReasoningCapabilityOverride(capability, model);
          }
          break;
        } catch (error) {
          lastError = error;
          if (
            !this.shouldFallbackForReasoningError(
              error,
              ...this.getFallbackTerms(capability),
            )
          ) {
            throw error;
          }
        }
      }

      if (!stream) {
        throw lastError ?? new KodaXProviderError(
          'All reasoning capability attempts failed without a captured error',
          this.name,
        );
      }

      for await (const chunk of stream) {
        // 检查是否被中断 (双重保险)
        if (signal?.aborted) {
          throw new DOMException('Request aborted', 'AbortError');
        }

        const choice = chunk.choices[0];
        const delta = choice?.delta;

        // Issue 084 fix: Track finish_reason to detect stream completion
        if (choice?.finish_reason) {
          finishReason = choice.finish_reason;
          if (process.env.KODAX_DEBUG_STREAM) {
            const duration = Date.now() - streamStartTime;
            console.error(`[Stream] finish_reason: ${finishReason} after ${duration}ms`);
          }
        }

        if (delta?.content) {
          textContent += delta.content;
          streamOptions?.onTextDelta?.(delta.content);
        }
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const existing = toolCallsMap.get(tc.index) ?? { id: '', name: '', arguments: '' };
            if (tc.id) existing.id = tc.id;
            if (tc.function?.name) existing.name = tc.function.name;
            if (tc.function?.arguments) {
              existing.arguments += tc.function.arguments;
              streamOptions?.onToolInputDelta?.(existing.name, tc.function.arguments);
            }
            toolCallsMap.set(tc.index, existing);
          }
        }
      }

      // Issue 084 fix: Validate stream completed successfully
      // If finish_reason was never received, the stream was likely interrupted
      if (!finishReason) {
        const duration = Date.now() - streamStartTime;

        if (signal?.aborted) {
          const reason = signal.reason instanceof Error
            ? signal.reason.message
            : typeof signal.reason === 'string'
              ? signal.reason
              : 'Request aborted';
          console.error('[Stream] Stream ended after abort before finish_reason:', {
            duration,
            reason,
            textContentLength: textContent.length,
            toolCallsCount: toolCallsMap.size
          });
          throw new DOMException(reason, 'AbortError');
        }

        const error = new Error(
          `Stream incomplete: finish_reason not received. ` +
          `Duration: ${duration}ms. ` +
          `This may indicate a network disconnection or API timeout.`
        );
        error.name = 'StreamIncompleteError';
        console.error('[Stream] Incomplete stream detected:', {
          duration,
          textContentLength: textContent.length,
          toolCallsCount: toolCallsMap.size
        });
        throw error;
      }

      const textBlocks: KodaXTextBlock[] = textContent ? [{ type: 'text', text: textContent }] : [];
      const toolBlocks: KodaXToolUseBlock[] = [];
      for (const [, tc] of toolCallsMap) {
        if (tc.id && tc.name) {
          try { toolBlocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: JSON.parse(tc.arguments) }); }
          catch { toolBlocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: {} }); }
        }
      }
      return { textBlocks, toolBlocks, thinkingBlocks: [] };
    }, signal, 3, streamOptions?.onRateLimit);
  }

  private convertMessages(messages: KodaXMessage[]): OpenAI.Chat.ChatCompletionMessageParam[] {
    return messages.map(m => {
      if (typeof m.content === 'string') return { role: m.role, content: m.content };
      const text = (m.content as { type: 'text'; text: string }[]).filter((b): b is { type: 'text'; text: string } => b.type === 'text').map(b => b.text).join('\n');
      return { role: m.role, content: text };
    });
  }
}
