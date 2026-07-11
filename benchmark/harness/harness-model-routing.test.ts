import { beforeEach, describe, expect, it, vi } from 'vitest';

const stream = vi.fn();

vi.mock('@kodax-ai/llm', () => ({
  getProvider: () => ({ stream }),
}));

import { runBenchmark, runOneShot } from './harness.js';

describe('runOneShot alias fidelity', () => {
  beforeEach(() => {
    stream.mockReset();
    stream.mockResolvedValue({
      textBlocks: [{ type: 'text', text: 'ok' }],
      toolBlocks: [],
      thinkingBlocks: [],
      usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
    });
  });

  it('passes the alias model to the provider and preserves token usage', async () => {
    const result = await runOneShot('ark/v4flash', {
      systemPrompt: 'system',
      userMessage: 'user',
      maxOutputTokens: 2_048,
    });

    expect(stream).toHaveBeenCalledWith(
      [{ role: 'user', content: 'user' }],
      [],
      'system',
      undefined,
      { modelOverride: 'deepseek-v4-flash', maxOutputTokensOverride: 2_048 },
    );
    expect(result.target.model).toBe('deepseek-v4-flash');
    expect(result.usage).toEqual({ inputTokens: 7, outputTokens: 3, totalTokens: 10 });
  });

  it('rescored resumed raw output without another provider call', async () => {
    const result = await runBenchmark({
      variants: [{ id: 'proposed', systemPrompt: 'system', userMessage: 'user' }],
      models: ['ark/v4flash'],
      judges: [{ name: 'current-contract', judge: (output) => ({ passed: output === 'current' }) }],
      runs: 1,
      resumeRun: () => ({
        variantId: 'proposed', alias: 'ark/v4flash', runIndex: 0,
        text: 'current', toolCalls: [], durationMs: 10,
        usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
        judges: [],
        judgeAggregate: { passed: false, results: [], byCategory: {}, formatPassed: true },
        passed: false,
      }),
    });

    expect(stream).not.toHaveBeenCalled();
    expect(result.cells[0]?.passRate).toBe(100);
  });

  it('invalidates a resumed run that exceeded the frozen timeout', async () => {
    const result = await runBenchmark({
      variants: [{ id: 'proposed', systemPrompt: 'system', userMessage: 'user' }],
      models: ['ark/v4flash'],
      judges: [{ name: 'always', judge: () => ({ passed: true }) }],
      runs: 1,
      timeoutMs: 120_000,
      resumeRun: () => ({
        variantId: 'proposed', alias: 'ark/v4flash', runIndex: 0,
        text: 'current', toolCalls: [], durationMs: 120_001,
        usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
        judges: [],
        judgeAggregate: { passed: true, results: [], byCategory: {}, formatPassed: true },
        passed: true,
      }),
    });

    expect(result.cells[0]?.completed).toBe(0);
    expect(result.cells[0]?.runsRaw[0]?.error).toContain('exceeded frozen timeout');
  });

  it('runs different providers concurrently while serializing aliases on one provider', async () => {
    type ResolveStream = (value: {
      textBlocks: Array<{ type: 'text'; text: string }>;
      toolBlocks: never[];
      thinkingBlocks: never[];
      usage: { inputTokens: number; outputTokens: number; totalTokens: number };
    }) => void;
    const pending = new Map<string, ResolveStream>();
    stream.mockImplementation((
      _messages: unknown,
      _tools: unknown,
      _system: unknown,
      _reasoning: unknown,
      options: { modelOverride: string },
    ) => new Promise((resolve) => pending.set(options.modelOverride, resolve)));
    const resultPromise = runBenchmark({
      variants: [{ id: 'candidate', systemPrompt: 'system', userMessage: 'user' }],
      models: ['ark/v4pro', 'ark/v4flash', 'zhipu/glm51'],
      judges: [{ name: 'ok', judge: () => ({ passed: true }) }],
      runs: 1,
    });

    await vi.waitFor(() => expect(stream).toHaveBeenCalledTimes(2));
    expect(pending.has('deepseek-v4-pro')).toBe(true);
    expect(pending.has('glm-5.1')).toBe(true);
    expect(pending.has('deepseek-v4-flash')).toBe(false);

    const output = {
      textBlocks: [{ type: 'text' as const, text: 'ok' }],
      toolBlocks: [],
      thinkingBlocks: [],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    };
    pending.get('deepseek-v4-pro')!(output);
    await vi.waitFor(() => expect(stream).toHaveBeenCalledTimes(3));
    pending.get('deepseek-v4-flash')!(output);
    pending.get('glm-5.1')!(output);

    const result = await resultPromise;
    expect(result.cells).toHaveLength(3);
    expect(result.models).toEqual(['ark/v4pro', 'ark/v4flash', 'zhipu/glm51']);
  });
});
