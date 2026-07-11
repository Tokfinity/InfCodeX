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
    });

    expect(stream).toHaveBeenCalledWith(
      [{ role: 'user', content: 'user' }],
      [],
      'system',
      undefined,
      { modelOverride: 'deepseek-v4-flash' },
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
});
