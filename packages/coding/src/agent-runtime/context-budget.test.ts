import { describe, expect, it } from 'vitest';

import type { KodaXMessage, KodaXToolDefinition } from '@kodax-ai/llm';
import {
  createRuntimeContextBudgetSnapshot,
  estimateToolSchemaTokens,
} from './context-budget.js';

const sampleTool: KodaXToolDefinition = {
  name: 'module_context',
  description: 'Build a compact module capsule for dependency exploration.',
  input_schema: {
    type: 'object',
    properties: {
      modulePath: {
        type: 'string',
        description: 'Path to the module entry file.',
      },
      includeTests: {
        type: 'boolean',
        description: 'Whether related tests should be included.',
      },
    },
    required: ['modulePath'],
  },
};

describe('runtime context budget snapshot', () => {
  it('computes a bounded token breakdown without retaining raw prompt text', () => {
    const messages: KodaXMessage[] = [
      { role: 'user', content: 'Please inspect the module and summarize the risks.' },
      { role: 'assistant', content: [{ type: 'text', text: 'I will inspect it.' }] },
    ];

    const snapshot = createRuntimeContextBudgetSnapshot({
      sessionId: 's1',
      runId: 'r1',
      turnId: 't1',
      provider: 'test',
      model: 'test-model',
      contextWindow: 128_000,
      systemPrompt: 'You are KodaX.',
      toolDefinitions: [sampleTool],
      messages,
      pendingInput: 'Focus on public API drift.',
      reservedResponseTokens: 4_000,
      profile: 'report_only',
    });

    expect(snapshot.sessionId).toBe('s1');
    expect(snapshot.profile).toBe('report_only');
    expect(snapshot.pressure).toBe('low');
    expect(snapshot.tokenBreakdown.toolSchemas).toBe(estimateToolSchemaTokens(sampleTool));
    expect(snapshot.tokenBreakdown.total).toBeGreaterThan(snapshot.tokenBreakdown.toolSchemas);
    expect(snapshot.usedTokens).toBe(snapshot.tokenBreakdown.total);
    expect(snapshot.availableTokens).toBeGreaterThan(0);
    expect(JSON.stringify(snapshot)).not.toContain('Focus on public API drift');
  });

  it('treats small windows as pressure-sensitive before the absolute ceiling is hit', () => {
    const repeated = 'history '.repeat(9_000);
    const snapshot = createRuntimeContextBudgetSnapshot({
      contextWindow: 16_000,
      systemPrompt: repeated,
      messages: [{ role: 'user', content: repeated }],
      reservedResponseTokens: 1_000,
      profile: 'small_window',
    });

    expect(snapshot.smallWindow).toBe(true);
    expect(['high', 'critical']).toContain(snapshot.pressure);
    expect(snapshot.usedRatio).toBeGreaterThan(0.55);
  });

  it('marks an invalid or exhausted window as critical instead of under-reporting risk', () => {
    const snapshot = createRuntimeContextBudgetSnapshot({
      contextWindow: 0,
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(snapshot.pressure).toBe('critical');
    expect(snapshot.availableTokens).toBe(0);
    expect(snapshot.usedRatio).toBe(1);
  });
});
