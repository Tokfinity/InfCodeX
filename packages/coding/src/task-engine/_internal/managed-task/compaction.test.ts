import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@kodax-ai/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kodax-ai/agent')>();
  return { ...actual, compact: vi.fn() };
});

import {
  ContextCapacityError,
  Runner,
  compact as mockedCompact,
  createAgent,
  type AgentMessage,
  type CompactionResult,
} from '@kodax-ai/agent';
import type {
  KodaXMessage,
  KodaXReasoningRequest,
  KodaXToolDefinition,
} from '@kodax-ai/llm';
import { resolveProvider } from '../../../providers/index.js';
import { estimateTokens } from '../../../tokenizer.js';
import type { KodaXContextTokenSnapshot, KodaXOptions } from '../../../types.js';
import {
  buildManagedTaskCompactionHook,
  type ContextTokenSnapshotRef,
  type resolveManagedTaskContextCapacity,
} from './compaction.js';

const compactMock = mockedCompact as unknown as ReturnType<typeof vi.fn>;

function makeMessages(): KodaXMessage[] {
  return [{
    role: 'user',
    content: `FULL_EVIDENCE_SENTINEL\n${'evidence '.repeat(12_000)}`,
  }];
}

function snapshot(currentTokens: number, messages: KodaXMessage[]): KodaXContextTokenSnapshot {
  return {
    currentTokens,
    baselineEstimatedTokens: estimateTokens(messages),
    source: 'api',
  };
}

function compactedResult(messages: KodaXMessage[]): CompactionResult {
  const compacted = [{
    role: 'system' as const,
    content: '[对话历史摘要]\n\nComplete semantic summary with preserved decisions.',
  }];
  const tokensBefore = estimateTokens(messages);
  const tokensAfter = estimateTokens(compacted);
  return {
    compacted: true,
    messages: compacted,
    summary: 'Complete semantic summary with preserved decisions.',
    tokensBefore,
    tokensAfter,
    entriesRemoved: messages.length,
    report: {
      strategy: 'full_prefix',
      triggerSource: 'percentage',
      effectiveTriggerTokens: 75_000,
      protectedBudgetTokens: 15_000,
      fixedInputTokens: 0,
      eligibleTokens: tokensBefore,
      rawTailTokens: 0,
      summaryTokens: tokensAfter,
      queryLedgerTokens: 0,
    },
    anchor: {
      summary: 'Complete semantic summary with preserved decisions.',
      tokensBefore,
      tokensAfter,
      entriesRemoved: messages.length,
      reason: 'automatic',
    },
  };
}

function resolvedCapacity(
  triggerPercent: number,
  contextWindow = 100_000,
  reservedResponseTokens = 10_000,
): Awaited<ReturnType<typeof resolveManagedTaskContextCapacity>> {
  const provider = resolveProvider('anthropic');
  vi.spyOn(provider, 'getEffectiveMaxOutputTokens').mockReturnValue(
    reservedResponseTokens,
  );
  return {
    provider,
    activeModel: 'claude-test',
    compactionConfig: { enabled: true, triggerPercent },
    contextWindow,
  };
}

function options(events: KodaXOptions['events'] = {}): KodaXOptions {
  return { provider: 'anthropic', model: 'claude-test', events } as KodaXOptions;
}

beforeEach(() => {
  compactMock.mockReset();
});

describe('managed history compaction', () => {
  it('builds the automatic hook even when a legacy caller passes enabled false', async () => {
    const capacity = resolvedCapacity(75);
    capacity.compactionConfig.enabled = false;

    await expect(buildManagedTaskCompactionHook(options(), {
      resolvedContextCapacity: capacity,
    })).resolves.toBeTypeOf('function');
  });

  it('does nothing while the complete request fits physical capacity', async () => {
    const messages = makeMessages();
    const ref: ContextTokenSnapshotRef = { current: snapshot(70_000, messages) };
    const hook = await buildManagedTaskCompactionHook(options(), {
      resolvedContextCapacity: resolvedCapacity(100),
      contextTokenSnapshotRef: ref,
    });

    await expect(hook?.(messages)).resolves.toBeUndefined();
    expect(compactMock).not.toHaveBeenCalled();
  });

  it('passes the complete evidence to semantic compaction at hard pressure', async () => {
    const messages = makeMessages();
    const ref: ContextTokenSnapshotRef = { current: snapshot(88_000, messages) };
    compactMock.mockResolvedValue(compactedResult(messages));
    const hook = await buildManagedTaskCompactionHook(options(), {
      resolvedContextCapacity: resolvedCapacity(100),
      contextTokenSnapshotRef: ref,
    });

    const result = await hook?.(messages);
    expect(compactMock).toHaveBeenCalledTimes(1);
    expect(compactMock.mock.calls[0]?.[0]).toBe(messages);
    expect(JSON.stringify(compactMock.mock.calls[0]?.[0])).toContain(
      'FULL_EVIDENCE_SENTINEL',
    );
    expect(result).toEqual(compactedResult(messages).messages);
  });

  it('keeps Runner\'s immutable Worker system prompt outside semantic compaction', async () => {
    const immutableSystem: KodaXMessage = {
      role: 'system',
      content: 'IMMUTABLE_WORKER_SYSTEM_PROMPT_BYTE_SENTINEL',
    };
    const mutableMessages = makeMessages();
    const messages = [immutableSystem, ...mutableMessages];
    const ref: ContextTokenSnapshotRef = { current: snapshot(88_000, messages) };
    compactMock.mockResolvedValue(compactedResult(mutableMessages));
    const reasoning: KodaXReasoningRequest = { enabled: true, effort: 'high' };
    const hook = await buildManagedTaskCompactionHook(options(), {
      resolvedContextCapacity: resolvedCapacity(100),
      contextTokenSnapshotRef: ref,
      activeToolDefinitions: [],
      reasoning,
    });

    const result = await hook?.(messages);

    expect(compactMock.mock.calls[0]?.[0]).toEqual(mutableMessages);
    expect(compactMock.mock.calls[0]?.[5]).toBe(immutableSystem.content);
    expect(compactMock.mock.calls[0]?.[12]).toEqual({
      tools: [],
      reasoning,
    });
    expect(result?.[0]).toEqual(immutableSystem);
    expect(result?.[1]?.content).toContain('Complete semantic summary');
  });

  it('preserves the exact Runner system message for the next LLM turn while adding a summary', async () => {
    const systemText = 'IMMUTABLE_WORKER_SYSTEM_PROMPT_BYTE_SENTINEL';
    const agent = createAgent({
      name: 'managed-compaction-worker',
      instructions: systemText,
    });
    const originalMessages: KodaXMessage[] = [
      { role: 'system', content: systemText },
      { role: 'user', content: `start\n${'reducible history '.repeat(2_000)}` },
    ];
    const currentTokens = estimateTokens(originalMessages) + 20_000;
    const contextWindow = currentTokens
      + 10_000
      + Math.max(2_048, Math.ceil(currentTokens * 0.03))
      - 1;
    const ref: ContextTokenSnapshotRef = {
      current: snapshot(currentTokens, originalMessages),
    };
    compactMock.mockImplementation(async (mutable: KodaXMessage[]) => (
      compactedResult(mutable)
    ));
    const hook = await buildManagedTaskCompactionHook(options(), {
      resolvedContextCapacity: resolvedCapacity(100, contextWindow),
      contextTokenSnapshotRef: ref,
    });
    let nextLlmMessages: readonly AgentMessage[] = [];

    await Runner.run(agent, String(originalMessages[1]!.content), {
      compactionHook: hook,
      llm: async (messages) => {
        nextLlmMessages = messages;
        return 'done';
      },
      tracer: null,
    });

    expect(nextLlmMessages[0]).toEqual({ role: 'system', content: systemText });
    expect(nextLlmMessages.some((message, index) => (
      index > 0
      && message.role === 'system'
      && String(message.content).includes('Complete semantic summary')
    ))).toBe(true);
  });

  it('counts active tool schemas before the first provider usage snapshot exists', async () => {
    const messages: KodaXMessage[] = [
      { role: 'system', content: 'worker system' },
      { role: 'user', content: `RESTORED_HISTORY_SENTINEL\n${'history '.repeat(8_000)}` },
    ];
    const activeToolDefinitions: KodaXToolDefinition[] = [{
      name: 'large_schema_tool',
      description: 'schema '.repeat(20_000),
      input_schema: {
        type: 'object',
        properties: { query: { type: 'string', description: 'query '.repeat(4_000) } },
      },
    }];
    const transcriptTokens = estimateTokens(messages);
    const ref: ContextTokenSnapshotRef = { current: undefined };
    compactMock.mockResolvedValue(compactedResult(messages.slice(1)));
    const hook = await buildManagedTaskCompactionHook(options(), {
      resolvedContextCapacity: resolvedCapacity(
        100,
        30_000,
        2_000,
      ),
      contextTokenSnapshotRef: ref,
      activeToolDefinitions,
    });

    await hook?.(messages);

    expect(compactMock).toHaveBeenCalledTimes(1);
    expect(compactMock.mock.calls[0]?.[6]).toBeGreaterThan(transcriptTokens);
  });

  it('preserves fixed envelope overhead when rebasing the compacted snapshot', async () => {
    const messages = makeMessages();
    const beforeEstimate = estimateTokens(messages);
    const ref: ContextTokenSnapshotRef = {
      current: snapshot(beforeEstimate + 20_000, messages),
    };
    const compacted = compactedResult(messages);
    compactMock.mockResolvedValue(compacted);
    const hook = await buildManagedTaskCompactionHook(options(), {
      resolvedContextCapacity: resolvedCapacity(20),
      contextTokenSnapshotRef: ref,
    });

    await hook?.(messages);
    expect(ref.current?.baselineEstimatedTokens).toBe(estimateTokens(compacted.messages));
    expect(ref.current?.currentTokens).toBe(
      20_000 + estimateTokens(compacted.messages),
    );
  });

  it('fails explicitly and leaves canonical history untouched when hard-pressure summary fails', async () => {
    const messages = makeMessages();
    const original = structuredClone(messages);
    const ref: ContextTokenSnapshotRef = { current: snapshot(88_000, messages) };
    compactMock.mockRejectedValue(new Error('summary provider unavailable'));
    const hook = await buildManagedTaskCompactionHook(options(), {
      resolvedContextCapacity: resolvedCapacity(100),
      contextTokenSnapshotRef: ref,
    });

    await expect(hook?.(messages)).rejects.toBeInstanceOf(ContextCapacityError);
    expect(messages).toEqual(original);
  });

  it('fails open for an explicit early policy while physical capacity remains', async () => {
    const messages = makeMessages();
    const ref: ContextTokenSnapshotRef = { current: snapshot(75_000, messages) };
    compactMock.mockRejectedValue(new Error('temporary summary failure'));
    const hook = await buildManagedTaskCompactionHook(options(), {
      resolvedContextCapacity: resolvedCapacity(70),
      contextTokenSnapshotRef: ref,
    });

    await expect(hook?.(messages)).resolves.toBeUndefined();
    expect(messages[0]?.content).toContain('FULL_EVIDENCE_SENTINEL');
  });

  it('uses the circuit breaker only while physical capacity still exists', async () => {
    const messages = makeMessages();
    const ref: ContextTokenSnapshotRef = { current: snapshot(75_000, messages) };
    compactMock.mockRejectedValue(new Error('temporary summary failure'));
    const hook = await buildManagedTaskCompactionHook(options(), {
      resolvedContextCapacity: resolvedCapacity(70),
      contextTokenSnapshotRef: ref,
    });

    await hook?.(messages);
    await hook?.(messages);
    await hook?.(messages);
    await hook?.(messages);
    expect(compactMock).toHaveBeenCalledTimes(3);

    ref.current = snapshot(88_000, messages);
    compactMock.mockResolvedValueOnce(compactedResult(messages));
    await hook?.(messages);
    expect(compactMock).toHaveBeenCalledTimes(4);
  });

  it('fires lifecycle events and post-compact invalidation only after a real rewrite', async () => {
    const messages = makeMessages();
    const onCompactStart = vi.fn();
    const onCompactEnd = vi.fn();
    const onCompactedMessages = vi.fn();
    const onCompact = vi.fn();
    const onContextCompactionFinished = vi.fn();
    const onPostCompact = vi.fn();
    compactMock.mockResolvedValue(compactedResult(messages));
    const hook = await buildManagedTaskCompactionHook(options({
      onCompactStart,
      onCompactEnd,
      onCompact,
      onCompactedMessages,
      onContextCompactionFinished,
    }), {
      resolvedContextCapacity: resolvedCapacity(100),
      contextTokenSnapshotRef: { current: snapshot(88_000, messages) },
      onPostCompact,
    });

    await hook?.(messages);
    expect(onCompactStart).toHaveBeenCalledTimes(1);
    expect(onCompactEnd).toHaveBeenCalledTimes(1);
    expect(onCompactedMessages).toHaveBeenCalledTimes(1);
    const finalMessages = onCompactedMessages.mock.calls[0]?.[0] as KodaXMessage[];
    const finalTokens = 88_000 - estimateTokens(messages) + estimateTokens(finalMessages);
    expect(onCompact).toHaveBeenCalledWith(finalTokens);
    expect(onCompactedMessages.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      anchor: expect.objectContaining({ tokensAfter: finalTokens }),
      preCompactionMessages: messages,
      report: compactedResult(messages).report,
    }));
    expect(onContextCompactionFinished).toHaveBeenCalledWith(expect.objectContaining({
      source: 'physical_capacity',
      tokensBefore: 88_000,
      tokensAfter: finalTokens,
      committed: true,
      strategy: 'full_prefix',
    }));
    expect(onCompactedMessages.mock.invocationCallOrder[0]).toBeLessThan(
      onContextCompactionFinished.mock.invocationCallOrder[0]!,
    );
    expect(onPostCompact).toHaveBeenCalledTimes(1);
  });
});
