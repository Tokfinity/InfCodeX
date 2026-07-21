import { describe, expect, it } from 'vitest';
import type { KodaXMessage } from '@kodax-ai/llm';
import type { CompactionConfig } from '@kodax-ai/agent';
import { shouldCompact } from '@kodax-ai/agent';

const messages: KodaXMessage[] = [{ role: 'user', content: 'hello' }];

function config(triggerPercent = 100, enabled = true): CompactionConfig {
  return { enabled, triggerPercent };
}

describe('CAP-059 physical compaction trigger', () => {
  it('normalizes the legacy disabled flag to always-on compaction', () => {
    expect(shouldCompact({
      messages,
      compactionConfig: config(100, false),
      contextWindow: 100_000,
      currentTokens: 90_000,
      reservedResponseTokens: 10_000,
    })).toBe(true);
  });

  it('does not compact while request, response reserve, and safety fit', () => {
    expect(shouldCompact({
      messages,
      compactionConfig: config(),
      contextWindow: 100_000,
      currentTokens: 75_000,
      reservedResponseTokens: 10_000,
    })).toBe(false);
  });

  it('compacts when the physical request envelope exceeds capacity', () => {
    expect(shouldCompact({
      messages,
      compactionConfig: config(),
      contextWindow: 100_000,
      currentTokens: 88_000,
      reservedResponseTokens: 10_000,
    })).toBe(true);
  });

  it('retains percentage-based early compaction only as explicit opt-in', () => {
    expect(shouldCompact({
      messages,
      compactionConfig: config(70),
      contextWindow: 100_000,
      currentTokens: 75_000,
      reservedResponseTokens: 10_000,
    })).toBe(true);
  });
});
