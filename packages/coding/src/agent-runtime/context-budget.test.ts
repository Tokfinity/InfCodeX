import { describe, expect, it } from 'vitest';

import type { KodaXMessage, KodaXToolDefinition } from '@kodax-ai/llm';
import {
  createRuntimeContextBudgetSnapshot,
  partitionContextBudgetMessages,
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
      contextId: 's1/agent/%2Froot%2Freviewer',
      contextKind: 'child',
      parentContextId: 's1',
      agentId: '/root/reviewer',
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
    expect(snapshot).toMatchObject({
      contextId: 's1/agent/%2Froot%2Freviewer',
      contextKind: 'child',
      parentContextId: 's1',
      agentId: '/root/reviewer',
    });
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

  it('partitions transcript, pending input, and tool results without double counting', () => {
    const messages: KodaXMessage[] = [
      { role: 'user', content: 'old question', turnId: 'turn-old' },
      { role: 'assistant', content: 'old answer', turnId: 'turn-old' },
      {
        role: 'user',
        content: [
          'trusted current-run context',
          'SELECTED_SKILL_CONTENT',
          'MCP_CATALOG_CONTENT',
        ].join('\n'),
        turnId: 'turn-current',
        _synthetic: true,
      },
      { role: 'user', content: 'current question', turnId: 'turn-current' },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'read-1',
          content: 'bounded tool result',
        }],
      },
    ];
    const partition = partitionContextBudgetMessages(messages, {
      skillTexts: ['SELECTED_SKILL_CONTENT'],
      mcpTexts: ['MCP_CATALOG_CONTENT'],
    });
    const snapshot = createRuntimeContextBudgetSnapshot({
      contextWindow: 128_000,
      messageTokenBreakdown: partition,
      reservedResponseTokens: 4_000,
    });
    const { tokenBreakdown } = snapshot;
    const mutuallyExclusiveTotal =
      tokenBreakdown.systemPrompt
      + tokenBreakdown.toolSchemas
      + tokenBreakdown.skillCatalog
      + tokenBreakdown.mcpCatalog
      + tokenBreakdown.transcript
      + tokenBreakdown.pendingInput
      + tokenBreakdown.recentToolResults
      + tokenBreakdown.reservedResponse;

    expect(tokenBreakdown.transcript).toBeGreaterThan(0);
    expect(tokenBreakdown.pendingInput).toBeGreaterThan(0);
    expect(tokenBreakdown.recentToolResults).toBeGreaterThan(0);
    expect(tokenBreakdown.skillCatalog).toBeGreaterThan(0);
    expect(tokenBreakdown.mcpCatalog).toBeGreaterThan(0);
    expect(mutuallyExclusiveTotal).toBe(snapshot.usedTokens);
    expect(tokenBreakdown.total).toBe(snapshot.usedTokens);
  });

  it('moves answered current-turn input into transcript on a tool round', () => {
    const messages: KodaXMessage[] = [
      {
        role: 'user',
        content: 'managed context',
        turnId: 'turn-current',
        _synthetic: true,
      },
      { role: 'user', content: 'current question', turnId: 'turn-current' },
      {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'read-1',
          name: 'read',
          input: { path: 'src/index.ts' },
        }],
      },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'read-1',
          content: 'bounded tool result',
        }],
      },
    ];

    const partition = partitionContextBudgetMessages(messages);

    expect(partition.transcript).toBeGreaterThan(0);
    expect(partition.pendingInput).toBe(0);
    expect(partition.recentToolResults).toBeGreaterThan(0);
  });
});
