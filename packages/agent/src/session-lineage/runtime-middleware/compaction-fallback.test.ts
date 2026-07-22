import { describe, expect, it } from 'vitest';
import type { KodaXMessage } from '@kodax-ai/llm';

import {
  calculateMaxContextInputTokens,
  exceedsContextCapacity,
} from '../../context-capacity.js';
import { estimateTokens } from '../../tokenizer.js';
import { gracefulCompactDegradation } from './compaction-fallback.js';

describe('gracefulCompactDegradation', () => {
  it('fits message history inside the physical input budget after fixed overhead', () => {
    const contextWindow = 10_000;
    const reservedResponseTokens = 2_000;
    const fixedOverheadTokens = 1_000;
    const messages: KodaXMessage[] = [
      { role: 'user', content: 'Keep this exact recovery request.' },
      ...Array.from({ length: 12 }, (_, index) => ({
        role: 'assistant' as const,
        content: `history-${index} ${'evidence '.repeat(800)}`,
      })),
    ];

    expect(fixedOverheadTokens + estimateTokens(messages)).toBeGreaterThan(
      calculateMaxContextInputTokens(contextWindow, reservedResponseTokens),
    );

    const degraded = gracefulCompactDegradation(
      messages,
      contextWindow,
      { enabled: true, triggerPercent: 90, pruningThresholdTokens: 500 },
      { fixedOverheadTokens, reservedResponseTokens },
    );

    expect(degraded.length).toBeLessThan(messages.length);
    expect(JSON.stringify(degraded)).toContain('Keep this exact recovery request.');
    expect(exceedsContextCapacity({
      contextWindow,
      currentTokens: fixedOverheadTokens + estimateTokens(degraded),
      reservedResponseTokens,
    })).toBe(false);
  });

  it('returns the original history when mandatory content cannot be reduced', () => {
    const messages: KodaXMessage[] = [
      { role: 'system', content: `immutable ${'policy '.repeat(2_000)}` },
    ];

    const degraded = gracefulCompactDegradation(
      messages,
      1_000,
      { enabled: true, triggerPercent: 90, pruningThresholdTokens: 100 },
      { reservedResponseTokens: 100 },
    );

    expect(degraded).toBe(messages);
    expect(estimateTokens(degraded)).toBe(estimateTokens(messages));
  });
});
