import { describe, expect, it } from 'vitest';
import { exceedsContextCapacity } from '@kodax-ai/agent';
import type {
  RuntimeContextBudgetSnapshot,
  RuntimeContextPressure,
} from '../agent-runtime/context-budget.js';

import {
  buildToolResultBudget,
  buildToolResultBudgetFromUsage,
  clampToolResultPolicyToBudget,
} from './tool-result-budget.js';

function snapshot(input: {
  contextWindow: number;
  availableTokens: number;
  usedRatio: number;
  pressure: RuntimeContextPressure;
  smallWindow: boolean;
}): RuntimeContextBudgetSnapshot {
  return {
    ...input,
    profile: 'balanced',
    tokenBreakdown: {
      systemPrompt: 0,
      toolSchemas: 0,
      skillCatalog: 0,
      mcpCatalog: 0,
      transcript: 0,
      pendingInput: 0,
      recentToolResults: 0,
      reservedResponse: 0,
      total: input.contextWindow - input.availableTokens,
    },
    usedTokens: input.contextWindow - input.availableTokens,
    toolSchemaRatio: 0,
    recommendations: [],
    createdAt: '2026-07-15T00:00:00.000Z',
  };
}

describe('tool result budget', () => {
  it('preserves the public snapshot-budget compatibility API', () => {
    const budget = buildToolResultBudget(snapshot({
      contextWindow: 128_000,
      availableTokens: 64_000,
      usedRatio: 0.5,
      pressure: 'low',
      smallWindow: false,
    }));

    expect(budget.aggregateInlineTokens).toBe(64_000);
    expect(budget.aggregateInlineBytes).toBe(192 * 1024);
    expect(budget.reason).toBe('large_window');
  });

  it('preserves the opt-in legacy policy clamp without using it internally', () => {
    const budget = buildToolResultBudget(snapshot({
      contextWindow: 16_000,
      availableTokens: 1_600,
      usedRatio: 0.9,
      pressure: 'critical',
      smallWindow: true,
    }));
    const clamped = clampToolResultPolicyToBudget({
      maxLines: 1_200,
      maxBytes: 40 * 1024,
      direction: 'head',
      spillToFile: true,
    }, budget);

    expect(clamped.maxBytes).toBe(4 * 1024);
    expect(clamped.maxLines).toBe(120);
  });

  it('honors the safety floor when lightweight usage leaves no admissible batch space', () => {
    const budget = buildToolResultBudgetFromUsage({
      contextWindow: 16_000,
      currentTokens: 14_000,
    });

    expect(budget.aggregateInlineTokens).toBe(0);
  });

  it('subtracts response and canonical safety reserves from the final batch capacity', () => {
    const budget = buildToolResultBudgetFromUsage({
      contextWindow: 128_000,
      currentTokens: 20_000,
      reservedResponseTokens: 8_000,
    });

    expect(budget.aggregateInlineTokens).toBe(96_504);
    expect(exceedsContextCapacity({
      contextWindow: 128_000,
      currentTokens: 20_000 + budget.aggregateInlineTokens,
      reservedResponseTokens: 8_000,
    })).toBe(false);
    expect(exceedsContextCapacity({
      contextWindow: 128_000,
      currentTokens: 20_001 + budget.aggregateInlineTokens,
      reservedResponseTokens: 8_000,
    })).toBe(true);
  });

  it('keeps fixed-point token capacity alongside compatibility metadata', () => {
    const budget = buildToolResultBudgetFromUsage({
      contextWindow: 128_000,
      currentTokens: 20_000,
      reservedResponseTokens: 8_000,
    });

    expect(budget.aggregateInlineTokens).toBe(96_504);
    expect(budget.contextWindow).toBe(128_000);
    expect(budget.pressure).toBe('low');
  });
});
