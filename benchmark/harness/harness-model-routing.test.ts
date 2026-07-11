import { beforeEach, describe, expect, it, vi } from 'vitest';

const stream = vi.fn();

vi.mock('@kodax-ai/llm', () => ({
  getProvider: () => ({ stream }),
}));

import { runOneShot } from './harness.js';

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
});
