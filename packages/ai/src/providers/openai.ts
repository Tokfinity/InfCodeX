/**
 * KodaX OpenAI Compatible Provider
 *
 * 支持 OpenAI API 格式的 Provider 基类
 */

import OpenAI from 'openai';
import { KodaXBaseProvider } from './base.js';
import { KodaXProviderConfig, KodaXMessage, KodaXToolDefinition, KodaXProviderStreamOptions, KodaXStreamResult, KodaXTextBlock, KodaXToolUseBlock } from '../types.js';
import { KODAX_MAX_TOKENS } from '../constants.js';

export abstract class KodaXOpenAICompatProvider extends KodaXBaseProvider {
  abstract override readonly name: string;
  readonly supportsThinking = false;
  protected abstract override readonly config: KodaXProviderConfig;
  protected client!: OpenAI;

  protected initClient(): void {
    this.client = new OpenAI({ apiKey: this.getApiKey(), baseURL: this.config.baseUrl });
  }

  async stream(
    messages: KodaXMessage[],
    tools: KodaXToolDefinition[],
    system: string,
    _thinking = false,
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
      const stream = await this.client.chat.completions.create({
        model: this.config.model,
        messages: fullMessages,
        tools: openaiTools,
        max_tokens: KODAX_MAX_TOKENS,
        stream: true,
      }, signal ? { signal } : {});

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
