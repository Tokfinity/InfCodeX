/**
 * KodaX OpenAI Compatible Provider
 *
 * 支持 OpenAI API 格式的 Provider 基类
 */
import OpenAI from 'openai';
import { KodaXBaseProvider } from './base.js';
import { KodaXProviderError } from '../errors.js';
import { KODAX_MAX_TOKENS } from '../constants.js';
import {
    clampThinkingBudget,
    isReasoningEnabled,
    mapDepthToOpenAIReasoningEffort,
    resolveThinkingBudget,
} from '../reasoning.js';
export class KodaXOpenAICompatProvider extends KodaXBaseProvider {
    supportsThinking = true;
    client;
    initClient() {
        this.client = new OpenAI({ apiKey: this.getApiKey(), baseURL: this.config.baseUrl });
    }
    applyReasoningCapability(createParams, capability, reasoning) {
        // The OpenAI SDK types do not expose provider-specific extensions like
        // Qwen's extra_body or Zhipu's thinking block, so we intentionally attach
        // those fields on the raw request object here.
        const params = createParams;
        const maxOutputTokens = this.config.maxOutputTokens ?? KODAX_MAX_TOKENS;
        const requestedBudget = clampThinkingBudget(resolveThinkingBudget(this.config, reasoning.depth, reasoning.taskType), maxOutputTokens);
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
                }
                else if (this.name === 'zhipu') {
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
                }
                else if (this.name === 'zhipu') {
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
    getFallbackTerms(capability) {
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
    async stream(messages, tools, system, reasoning = false, streamOptions, signal) {
        return this.withRateLimit(async () => {
            const fullMessages = [
                { role: 'system', content: system },
                ...this.convertMessages(messages),
            ];
            const openaiTools = tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
            if (signal?.aborted) {
                throw new DOMException('Request aborted', 'AbortError');
            }
            const toolCallsMap = new Map();
            let textContent = '';
            let finishReason = null;
            const streamStartTime = Date.now();
            const normalizedReasoning = this.normalizeReasoning(reasoning);
            const model = streamOptions?.modelOverride ?? this.config.model;
            const initialCapability = isReasoningEnabled(normalizedReasoning)
                ? this.getReasoningCapability(model)
                : 'none';
            const attempts = isReasoningEnabled(normalizedReasoning)
                ? this.getReasoningFallbackChain(initialCapability).filter((capability) => capability === 'native-budget' ||
                    capability === 'native-effort' ||
                    capability === 'native-toggle' ||
                    capability === 'none')
                : ['none'];
            const createParams = {
                model,
                messages: fullMessages,
                tools: openaiTools,
                max_completion_tokens: this.config.maxOutputTokens ?? KODAX_MAX_TOKENS,
                stream: true,
            };
            let stream;
            let lastError;
            for (const capability of attempts) {
                const attemptParams = { ...createParams };
                this.applyReasoningCapability(attemptParams, capability, normalizedReasoning);
                try {
                    stream = await this.client.chat.completions.create(attemptParams, signal ? { signal } : {});
                    if (capability !== initialCapability) {
                        this.persistReasoningCapabilityOverride(capability, model);
                    }
                    break;
                }
                catch (error) {
                    lastError = error;
                    if (!this.shouldFallbackForReasoningError(error, ...this.getFallbackTerms(capability))) {
                        throw error;
                    }
                }
            }
            if (!stream) {
                throw lastError ?? new KodaXProviderError('All reasoning capability attempts failed without a captured error', this.name);
            }
            for await (const chunk of stream) {
                if (signal?.aborted) {
                    throw new DOMException('Request aborted', 'AbortError');
                }
                const choice = chunk.choices[0];
                const delta = choice?.delta;
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
                        if (tc.id)
                            existing.id = tc.id;
                        if (tc.function?.name)
                            existing.name = tc.function.name;
                        if (tc.function?.arguments) {
                            existing.arguments += tc.function.arguments;
                            streamOptions?.onToolInputDelta?.(existing.name, tc.function.arguments);
                        }
                        toolCallsMap.set(tc.index, existing);
                    }
                }
            }
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
                const error = new Error(`Stream incomplete: finish_reason not received. ` +
                    `Duration: ${duration}ms. ` +
                    `This may indicate a network disconnection or API timeout.`);
                error.name = 'StreamIncompleteError';
                console.error('[Stream] Incomplete stream detected:', {
                    duration,
                    textContentLength: textContent.length,
                    toolCallsCount: toolCallsMap.size
                });
                throw error;
            }
            const textBlocks = textContent ? [{ type: 'text', text: textContent }] : [];
            const toolBlocks = [];
            for (const [, tc] of toolCallsMap) {
                if (tc.id && tc.name) {
                    try {
                        toolBlocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: JSON.parse(tc.arguments) });
                    }
                    catch {
                        toolBlocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: {} });
                    }
                }
            }
            return { textBlocks, toolBlocks, thinkingBlocks: [] };
        }, signal, 3, streamOptions?.onRateLimit);
    }
    convertMessages(messages) {
        return messages.map(m => {
            if (typeof m.content === 'string')
                return { role: m.role, content: m.content };
            const text = m.content.filter((b) => b.type === 'text').map(b => b.text).join('\n');
            return { role: m.role, content: text };
        });
    }
}
