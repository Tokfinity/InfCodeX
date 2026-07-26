import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import type {
  KodaXBaseProvider,
  KodaXContentBlock,
  KodaXEphemeralSuffix,
  KodaXMessage,
  KodaXReasoningRequest,
  KodaXTokenUsage,
  KodaXToolDefinition,
} from '@kodax-ai/llm';
import {
  KodaXAnthropicCompatProvider,
  KodaXAcpProvider,
  KodaXOpenAICompatProvider,
} from '@kodax-ai/llm';
import type {
  CompactionProviderObserver,
  CompactionProviderRequest,
} from '@kodax-ai/agent';

import type {
  KodaXEvents,
  KodaXPromptCacheDiagnosticEvent,
} from '../types.js';
import { emitResilienceDebug } from './resilience-debug.js';

function hashPromptCacheValue(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value) ?? 'undefined').digest('hex');
}

function hashImageFile(path: string): string {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return `unreadable:${hashPromptCacheValue(path)}`;
  }
}

const IMAGE_MEDIA_TYPES: Readonly<Record<string, string>> = {
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

function resolveDiagnosticImageMediaType(filePath: string, fallback?: string): string {
  return fallback
    ?? IMAGE_MEDIA_TYPES[path.extname(filePath).toLowerCase()]
    ?? 'image/png';
}

function projectImage(block: Extract<KodaXContentBlock, { type: 'image' }>): unknown {
  return {
    type: 'image',
    mediaType: resolveDiagnosticImageMediaType(block.path, block.mediaType),
    dataHash: hashImageFile(block.path),
  };
}

function projectToolResultContent(
  block: Extract<KodaXContentBlock, { type: 'tool_result' }>,
): unknown {
  if (typeof block.content === 'string') return block.content;
  return block.content.map((item) => item.type === 'image'
    ? {
        type: 'image',
        mediaType: resolveDiagnosticImageMediaType(item.path, item.mediaType),
        dataHash: hashImageFile(item.path),
      }
    : { type: 'text', text: item.text });
}

function projectProviderVisibleBlock(block: KodaXContentBlock): unknown | undefined {
  switch (block.type) {
    case 'cache-boundary':
      return undefined;
    case 'image':
      return projectImage(block);
    case 'tool_use':
      return {
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: block.input,
      };
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: block.tool_use_id,
        content: projectToolResultContent(block),
        ...(block.is_error === true ? { is_error: true } : {}),
      };
    case 'text':
      return { type: 'text', text: block.text };
    case 'thinking':
      return {
        type: 'thinking',
        thinking: block.thinking,
        ...(block.signature !== undefined ? { signature: block.signature } : {}),
      };
    case 'redacted_thinking':
      return { type: 'redacted_thinking', data: block.data };
  }
}

function projectGenericMessages(messages: readonly KodaXMessage[]): readonly unknown[] {
  return messages.map((message) => ({
    role: message.role,
    content: typeof message.content === 'string'
      ? message.content
      : message.content
          .map(projectProviderVisibleBlock)
          .filter((block): block is unknown => block !== undefined),
  }));
}

interface DiagnosticOpenAIWireMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: unknown;
  readonly tool_call_id?: string;
  readonly tool_calls?: readonly {
    readonly id: string;
    readonly type: 'function';
    readonly function: {
      readonly name: string;
      readonly arguments: string;
    };
  }[];
  readonly reasoning_content?: string;
}

function projectOpenAIToolResultContent(
  block: Extract<KodaXContentBlock, { type: 'tool_result' }>,
): string {
  if (typeof block.content === 'string') return block.content;
  return block.content.map((item) => item.type === 'text'
    ? item.text
    : `[Image at ${item.path}${item.mediaType ? ` (${item.mediaType})` : ''}] (provider does not support image content in tool_result; if the image was previously visible to you in the conversation, refer to it directly via native vision)`)
    .join('\n');
}

function projectOpenAIMessages(
  messages: readonly KodaXMessage[],
  provider: KodaXOpenAICompatProvider,
  model?: string,
): readonly DiagnosticOpenAIWireMessage[] {
  const projected: DiagnosticOpenAIWireMessage[] = [];
  for (const message of messages) {
    if (typeof message.content === 'string') {
      projected.push({ role: message.role, content: message.content });
      continue;
    }
    const blocks = message.content.filter((block) => block.type !== 'cache-boundary');
    if (message.role === 'system') {
      const text = blocks
        .filter((block): block is Extract<KodaXContentBlock, { type: 'text' }> =>
          block.type === 'text')
        .map((block) => block.text)
        .join('\n');
      if (text) projected.push({ role: 'system', content: text });
      continue;
    }
    if (message.role === 'assistant') {
      const textBlocks = blocks.filter(
        (block): block is Extract<KodaXContentBlock, { type: 'text' }> =>
          block.type === 'text',
      );
      const text = textBlocks.map((block) => block.text).join('\n');
      const toolCalls = blocks
        .filter((block): block is Extract<KodaXContentBlock, { type: 'tool_use' }> =>
          block.type === 'tool_use')
        .map((block) => ({
          id: block.id,
          type: 'function' as const,
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input ?? {}),
          },
        }));
      const thinkingBlocks = blocks.filter(
        (block): block is Extract<KodaXContentBlock, { type: 'thinking' }> =>
          block.type === 'thinking',
      );
      const hasThinkingBlock = blocks.some(
        (block) => block.type === 'thinking' || block.type === 'redacted_thinking',
      );
      if (!text && toolCalls.length === 0 && !hasThinkingBlock && textBlocks.length === 0) {
        continue;
      }
      projected.push({
        role: 'assistant',
        content: text || (toolCalls.length > 0 ? null : '...'),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        ...(provider.getEffectiveReplayReasoningContent(model)
          ? { reasoning_content: thinkingBlocks.map((block) => block.thinking).join('\n\n') }
          : {}),
      });
      continue;
    }
    for (const block of blocks) {
      if (block.type !== 'tool_result') continue;
      projected.push({
        role: 'tool',
        tool_call_id: block.tool_use_id,
        content: projectOpenAIToolResultContent(block),
      });
    }
    const text = blocks
      .filter((block): block is Extract<KodaXContentBlock, { type: 'text' }> =>
        block.type === 'text')
      .map((block) => block.text)
      .join('\n');
    const images = blocks.filter(
      (block): block is Extract<KodaXContentBlock, { type: 'image' }> =>
        block.type === 'image',
    );
    if (images.length === 0) {
      if (text) projected.push({ role: 'user', content: text });
      continue;
    }
    projected.push({
      role: 'user',
      content: [
        ...(text ? [{ type: 'text', text }] : []),
        ...images.map((block) => ({
          type: 'image_url',
          mediaType: resolveDiagnosticImageMediaType(block.path, block.mediaType),
          dataHash: hashImageFile(block.path),
        })),
      ],
    });
  }
  return repairOpenAIToolHistory(projected);
}

function repairOpenAIToolHistory(
  messages: readonly DiagnosticOpenAIWireMessage[],
): readonly DiagnosticOpenAIWireMessage[] {
  const repaired: DiagnosticOpenAIWireMessage[] = [];
  let index = 0;
  while (index < messages.length) {
    const message = messages[index]!;
    if (message.tool_calls === undefined) {
      if (message.role !== 'tool') repaired.push(message);
      index += 1;
      continue;
    }
    const validToolCalls = message.tool_calls.filter((call) => call.id.trim().length > 0);
    const expectedIds = new Set(validToolCalls.map((call) => call.id));
    const matchedTools: DiagnosticOpenAIWireMessage[] = [];
    const seenIds = new Set<string>();
    let nextIndex = index + 1;
    while (nextIndex < messages.length && messages[nextIndex]!.role === 'tool') {
      const toolMessage = messages[nextIndex]!;
      if (
        toolMessage.tool_call_id !== undefined
        && expectedIds.has(toolMessage.tool_call_id)
        && !seenIds.has(toolMessage.tool_call_id)
      ) {
        seenIds.add(toolMessage.tool_call_id);
        matchedTools.push(toolMessage);
      }
      nextIndex += 1;
    }
    const matchedToolCalls = validToolCalls.filter((call) => seenIds.has(call.id));
    if (matchedToolCalls.length === validToolCalls.length && validToolCalls.length > 0) {
      repaired.push(message);
    } else if (matchedToolCalls.length > 0) {
      repaired.push({ ...message, tool_calls: matchedToolCalls });
    } else {
      const { tool_calls: _toolCalls, ...withoutToolCalls } = message;
      repaired.push({
        ...withoutToolCalls,
        content: message.content == null || message.content === '' ? '...' : message.content,
      });
    }
    if (matchedToolCalls.length > 0) repaired.push(...matchedTools);
    index = nextIndex;
  }
  return repaired;
}

interface DiagnosticAnthropicWireMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string | readonly Readonly<Record<string, unknown>>[];
}

function projectAnthropicMessages(
  messages: readonly KodaXMessage[],
  provider: KodaXAnthropicCompatProvider,
  model?: string,
): readonly DiagnosticAnthropicWireMessage[] {
  const strictSignature = provider.getEffectiveStrictThinkingSignature(model);
  const supportsThinking = provider.getProviderSupportsThinking();
  const projected: DiagnosticAnthropicWireMessage[] = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    const role = message.role === 'user' ? 'user' : 'assistant';
    if (typeof message.content === 'string') {
      projected.push({ role, content: message.content });
      continue;
    }
    const blocks = message.content.filter((block) => block.type !== 'cache-boundary');
    const content: Array<Readonly<Record<string, unknown>>> = [];
    const crossProviderReasoning: string[] = [];
    for (const block of blocks) {
      if (block.type === 'thinking') {
        const trusted = !strictSignature
          || (typeof block.signature === 'string' && block.signature.length > 0);
        if (trusted) {
          content.push({
            type: 'thinking',
            thinking: block.thinking,
            signature: block.signature ?? '',
          });
        } else if (block.thinking) {
          crossProviderReasoning.push(block.thinking);
        }
      } else if (block.type === 'redacted_thinking' && !strictSignature) {
        content.push({ type: 'redacted_thinking', data: block.data });
      }
    }
    if (crossProviderReasoning.length > 0 && role === 'assistant') {
      content.push({
        type: 'text',
        text: `<prior_reasoning>\n${crossProviderReasoning.join('\n\n')}\n</prior_reasoning>`,
      });
    }
    if (role === 'user') {
      for (const block of blocks) {
        if (block.type !== 'tool_result') continue;
        content.push({
          type: 'tool_result',
          tool_use_id: block.tool_use_id,
          content: projectToolResultContent(block),
          ...(block.is_error === true ? { is_error: true } : {}),
        });
      }
    } else {
      for (const block of blocks) {
        if (block.type !== 'tool_use') continue;
        content.push({
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: block.input,
        });
      }
    }
    for (const block of blocks) {
      if (block.type === 'text') {
        content.push({ type: 'text', text: block.text });
      } else if (block.type === 'image' && role === 'user') {
        content.push(projectImage(block) as Readonly<Record<string, unknown>>);
      }
    }
    if (
      role === 'assistant'
      && supportsThinking
      && !strictSignature
      && content.some((block) => block.type === 'tool_use')
      && !content.some((block) =>
        block.type === 'thinking' || block.type === 'redacted_thinking')
    ) {
      content.unshift({ type: 'thinking', thinking: '...', signature: '' });
    }
    const effectivelyEmpty = content.length === 0 || content.every((block) =>
      (block.type === 'thinking' && !block.thinking)
      || (block.type === 'text' && !block.text));
    projected.push({
      role,
      content: effectivelyEmpty ? [{ type: 'text', text: '...' }] : content,
    });
  }
  return repairAnthropicToolHistory(projected);
}

function repairAnthropicToolHistory(
  messages: readonly DiagnosticAnthropicWireMessage[],
): readonly DiagnosticAnthropicWireMessage[] {
  const ids = (
    message: DiagnosticAnthropicWireMessage | undefined,
    type: 'tool_use' | 'tool_result',
  ): Set<string> => {
    if (!message || typeof message.content === 'string') return new Set();
    return new Set(message.content.flatMap((block) => {
      if (block.type !== type) return [];
      const value = type === 'tool_use' ? block.id : block.tool_use_id;
      return typeof value === 'string' && value.length > 0 ? [value] : [];
    }));
  };
  return messages.map((message, index) => {
    if (typeof message.content === 'string') return message;
    const adjacentIds = message.role === 'assistant'
      ? ids(messages[index + 1], 'tool_result')
      : ids(messages[index - 1], 'tool_use');
    const type = message.role === 'assistant' ? 'tool_use' : 'tool_result';
    const filtered = message.content.filter((block) => {
      if (block.type !== type) return true;
      const value = type === 'tool_use' ? block.id : block.tool_use_id;
      return typeof value === 'string' && adjacentIds.has(value);
    });
    if (filtered.length === message.content.length) return message;
    return {
      ...message,
      content: filtered.length > 0 ? filtered : [{ type: 'text', text: '...' }],
    };
  });
}

export function hashProviderVisibleMessages(
  messages: readonly KodaXMessage[],
  provider?: KodaXBaseProvider,
  model?: string,
): string {
  const projected = provider instanceof KodaXOpenAICompatProvider
    ? projectOpenAIMessages(messages, provider, model)
    : provider instanceof KodaXAnthropicCompatProvider
      ? projectAnthropicMessages(messages, provider, model)
      : provider instanceof KodaXAcpProvider
        ? provider.getDiagnosticPromptText(messages)
      : projectGenericMessages(messages);
  return hashPromptCacheValue(projected);
}

function serializeSystemContentForDiagnostics(
  content: KodaXMessage['content'],
  trimInlineSystem: boolean,
): string {
  if (typeof content === 'string') return trimInlineSystem ? content.trim() : content;
  const text = content
    .filter((block): block is Extract<KodaXContentBlock, { type: 'text' }> =>
      block.type === 'text')
    .map((block) => trimInlineSystem ? block.text.trim() : block.text)
    .filter((value) => !trimInlineSystem || value.length > 0)
    .join('\n');
  return text.trim().length > 0 ? text : '';
}

export function normalizeDiagnosticEnvelope(
  system: string,
  messages: readonly KodaXMessage[],
  provider?: KodaXBaseProvider,
): { readonly system: string; readonly messages: readonly KodaXMessage[] } {
  const trimInlineSystem = provider instanceof KodaXAnthropicCompatProvider;
  const systemParts = system.trim().length > 0 ? [system] : [];
  const nonSystemMessages: KodaXMessage[] = [];
  for (const message of messages) {
    if (message.role !== 'system') {
      nonSystemMessages.push(message);
      continue;
    }
    const text = serializeSystemContentForDiagnostics(message.content, trimInlineSystem);
    if (text.length > 0) systemParts.push(text);
  }
  return {
    system: systemParts.join('\n\n'),
    messages: nonSystemMessages,
  };
}

function findCurrentTurnStart(messages: readonly KodaXMessage[]): number {
  const currentTurnId = [...messages]
    .reverse()
    .find((message) => message.turnId !== undefined)
    ?.turnId;
  if (currentTurnId !== undefined) {
    const turnStart = messages.findIndex((message) => message.turnId === currentTurnId);
    if (turnStart >= 0) return turnStart;
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'user' || message._synthetic === true) continue;
    let start = index;
    while (start > 0 && messages[start - 1]?.role === 'user') start -= 1;
    return start;
  }
  return messages.length;
}

function sanitizeProviderEndpoint(
  endpoint: string | undefined,
): { readonly origin: string; readonly pathHash: string } | undefined {
  if (!endpoint) return undefined;
  try {
    const parsed = new URL(endpoint);
    return {
      origin: parsed.origin,
      pathHash: hashPromptCacheValue(`${parsed.pathname}${parsed.search}`),
    };
  } catch {
    return undefined;
  }
}

export interface PromptCacheDiagnosticRequestInput {
  readonly events: KodaXEvents | undefined;
  readonly enabled: boolean;
  readonly provider: KodaXBaseProvider;
  readonly providerName: string;
  readonly contextKind?: 'root' | 'child';
  readonly agentId?: string;
  readonly model: string;
  readonly reasoning: boolean | KodaXReasoningRequest | undefined;
  readonly disablePromptCache: boolean | undefined;
  readonly system: string;
  readonly tools: readonly KodaXToolDefinition[];
  readonly messages: readonly KodaXMessage[];
  readonly ephemeralSuffix?: KodaXEphemeralSuffix;
  readonly attempt: number;
  readonly transport?: 'stream' | 'complete';
}

export interface CompactionPromptCacheObserverInput {
  readonly events: KodaXEvents | undefined;
  readonly enabled: boolean;
  readonly provider: KodaXBaseProvider;
  readonly providerName: string;
  readonly model: string;
  readonly disablePromptCache: boolean | undefined;
}

export function createCompactionPromptCacheObserver(
  input: CompactionPromptCacheObserverInput,
): CompactionProviderObserver | undefined {
  if (!input.enabled) return undefined;
  const pending = new WeakMap<object, KodaXPromptCacheDiagnosticEvent>();
  return {
    onRequest(request: CompactionProviderRequest) {
      const event = emitPromptCacheDiagnosticRequest({
        events: input.events,
        enabled: true,
        provider: input.provider,
        providerName: input.providerName,
        model: request.modelOverride ?? input.model,
        reasoning: request.reasoning,
        disablePromptCache: input.disablePromptCache,
        system: request.system,
        tools: request.tools,
        messages: request.messages,
        ...(request.ephemeralSuffix ? { ephemeralSuffix: request.ephemeralSuffix } : {}),
        attempt: 1,
      });
      if (event) pending.set(request, event);
    },
    onResponse(request: CompactionProviderRequest, usage: KodaXTokenUsage | undefined) {
      emitPromptCacheDiagnosticResponse(input.events, pending.get(request), usage);
      pending.delete(request);
    },
  };
}

export function emitPromptCacheDiagnosticRequest(
  input: PromptCacheDiagnosticRequestInput,
): KodaXPromptCacheDiagnosticEvent | undefined {
  if (!input.enabled) return undefined;
  let event: KodaXPromptCacheDiagnosticEvent;
  try {
    if (!input.events?.onPromptCacheDiagnostics) return undefined;
    const diagnosticEnvelope = normalizeDiagnosticEnvelope(
      input.system,
      input.messages,
      input.provider,
    );
    const messagePrefixCount = findCurrentTurnStart(diagnosticEnvelope.messages);
    const endpointIdentity = sanitizeProviderEndpoint(input.provider.getBaseUrl());
    const ignoresSystemAndTools = input.provider instanceof KodaXAcpProvider;
    const systemPromptHash = hashPromptCacheValue(
      ignoresSystemAndTools ? null : diagnosticEnvelope.system,
    );
    const toolSchemaHash = hashPromptCacheValue(ignoresSystemAndTools ? null : input.tools);
    const requestMessagesHash = hashProviderVisibleMessages(
      diagnosticEnvelope.messages,
      input.provider,
      input.model,
    );
    const ephemeralSuffixHash = input.ephemeralSuffix?.content
      ? hashPromptCacheValue(input.ephemeralSuffix.content)
      : undefined;
    event = {
      phase: 'request',
      transport: input.transport ?? 'stream',
      requestId: randomUUID(),
      requestedAt: new Date().toISOString(),
      provider: input.providerName,
      ...(input.contextKind !== undefined ? { contextKind: input.contextKind } : {}),
      ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
      model: input.model,
      wireModel: input.provider.getWireModel(input.model),
      reasoningHash: hashPromptCacheValue(input.reasoning ?? null),
      maxOutputTokens: input.provider.getEffectiveMaxOutputTokens(input.model),
      kodaxPromptCacheEnabled: input.disablePromptCache === true
        ? false
        : input.disablePromptCache === false
          ? true
          : process.env.KODAX_DISABLE_PROMPT_CACHE !== '1',
      endpoint: endpointIdentity?.origin,
      endpointPathHash: endpointIdentity?.pathHash,
      attempt: input.attempt,
      systemPromptHash,
      toolSchemaHash,
      messagePrefixHash: hashProviderVisibleMessages(
        diagnosticEnvelope.messages.slice(0, messagePrefixCount),
        input.provider,
        input.model,
      ),
      messagePrefixCount,
      requestMessagesHash,
      requestEnvelopeHash: hashPromptCacheValue({
        systemPromptHash,
        toolSchemaHash,
        requestMessagesHash,
        ephemeralSuffixHash: ephemeralSuffixHash ?? null,
      }),
      ...(ephemeralSuffixHash !== undefined
        ? { ephemeralSuffixHash }
        : {}),
      messageCount: diagnosticEnvelope.messages.length,
      toolCount: input.tools.length,
    };
  } catch (error) {
    emitResilienceDebug('[context-diagnostics:cache-request-error]', {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
  try {
    input.events.onPromptCacheDiagnostics(event);
  } catch (error) {
    emitResilienceDebug('[context-diagnostics:cache-callback-error]', {
      phase: event.phase,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return event;
}

export function emitPromptCacheDiagnosticResponse(
  events: KodaXEvents | undefined,
  request: KodaXPromptCacheDiagnosticEvent | undefined,
  usage: KodaXTokenUsage | undefined,
): void {
  try {
    if (!request || !events?.onPromptCacheDiagnostics) return;
    const event: KodaXPromptCacheDiagnosticEvent = {
      ...request,
      phase: 'response',
      completedAt: new Date().toISOString(),
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
      cachedReadTokens: usage?.cachedReadTokens,
      cachedWriteTokens: usage?.cachedWriteTokens,
    };
    events.onPromptCacheDiagnostics(event);
  } catch (error) {
    emitResilienceDebug('[context-diagnostics:cache-callback-error]', {
      phase: 'response',
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
