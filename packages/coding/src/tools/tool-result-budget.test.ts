import { describe, expect, it } from 'vitest';

import type { RuntimeContextBudgetSnapshot } from '../agent-runtime/context-budget.js';
import {
  buildToolResultBudget,
  buildToolResultBudgetFromUsage,
  clampToolResultPolicyToBudget,
} from './tool-result-budget.js';
import type { ToolResultPolicy } from './tool-result-policy.js';

function snapshot(overrides: Partial<RuntimeContextBudgetSnapshot>): RuntimeContextBudgetSnapshot {
  return {
    profile: 'report_only',
    contextWindow: 128_000,
    smallWindow: false,
    pressure: 'low',
    tokenBreakdown: {
      systemPrompt: 0,
      toolSchemas: 0,
      skillCatalog: 0,
      mcpCatalog: 0,
      transcript: 0,
      pendingInput: 0,
      recentToolResults: 0,
      reservedResponse: 0,
      total: 0,
    },
    usedTokens: 0,
    availableTokens: 128_000,
    usedRatio: 0,
    toolSchemaRatio: 0,
    recommendations: [],
    createdAt: '2026-07-08T00:00:00.000Z',
    ...overrides,
  };
}

describe('tool result budget', () => {
  it('keeps generous caps for low-pressure large-window sessions', () => {
    const budget = buildToolResultBudget(snapshot({}));

    expect(budget.pressure).toBe('low');
    expect(budget.aggregateInlineBytes).toBeGreaterThanOrEqual(96 * 1024);
    expect(budget.perResultInlineBytes).toBeGreaterThanOrEqual(32 * 1024);
  });

  it('tightens aggregate and per-result caps for small-window pressure', () => {
    const budget = buildToolResultBudget(snapshot({
      contextWindow: 16_000,
      smallWindow: true,
      pressure: 'high',
      availableTokens: 1_500,
      usedRatio: 0.9,
    }));

    expect(budget.aggregateInlineBytes).toBeLessThan(64 * 1024);
    expect(budget.perResultInlineBytes).toBeLessThanOrEqual(16 * 1024);
    expect(budget.reason).toBe('small_window_pressure');
  });

  it('builds the same pressure class from lightweight usage counters', () => {
    const budget = buildToolResultBudgetFromUsage({
      contextWindow: 16_000,
      currentTokens: 14_000,
    });

    expect(budget.pressure).toBe('high');
    expect(budget.reason).toBe('small_window_pressure');
    expect(budget.perResultInlineBytes).toBeLessThanOrEqual(16 * 1024);
  });

  it('never increases an existing per-tool policy', () => {
    const policy: ToolResultPolicy = {
      maxLines: 600,
      maxBytes: 32 * 1024,
      direction: 'tail',
      spillToFile: true,
    };
    const budget = buildToolResultBudget(snapshot({
      contextWindow: 16_000,
      smallWindow: true,
      pressure: 'critical',
      availableTokens: 600,
      usedRatio: 0.96,
    }));

    const clamped = clampToolResultPolicyToBudget(policy, budget);

    expect(clamped.direction).toBe('tail');
    expect(clamped.spillToFile).toBe(true);
    expect(clamped.maxBytes).toBeLessThan(policy.maxBytes);
    expect(clamped.maxLines).toBeLessThanOrEqual(policy.maxLines);
  });

  it('does not clamp when diagnostics are unavailable', () => {
    const policy: ToolResultPolicy = {
      maxLines: 120,
      maxBytes: 8 * 1024,
      direction: 'head',
      spillToFile: true,
    };

    expect(clampToolResultPolicyToBudget(policy, undefined)).toEqual(policy);
  });
});
