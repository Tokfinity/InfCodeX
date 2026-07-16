import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  KodaXMessage,
  KodaXProviderConfig,
  KodaXProviderStreamOptions,
  KodaXReasoningRequest,
  KodaXStreamResult,
  KodaXToolDefinition,
} from '@kodax-ai/llm';
import {
  clearRuntimeModelProviders,
  KodaXBaseProvider,
  registerModelProvider,
} from '@kodax-ai/llm';
import { ContextCapacityError } from '@kodax-ai/agent';
import { runKodaX } from './agent.js';
import type { RuntimeContextBudgetSnapshot } from './agent-runtime/context-budget.js';
import type { RuntimeToolExposurePlan } from './agent-runtime/tool-exposure-planner.js';

const TEST_PROVIDER_NAME = 'context-diagnostics-provider';
const TEST_PROVIDER_API_KEY_ENV = 'CONTEXT_DIAGNOSTICS_PROVIDER_API_KEY';

class ContextDiagnosticsProvider extends KodaXBaseProvider {
  static calls: Array<{
    messages: KodaXMessage[];
    tools: KodaXToolDefinition[];
    streamOptions?: KodaXProviderStreamOptions;
  }> = [];

  readonly name = TEST_PROVIDER_NAME;
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: TEST_PROVIDER_API_KEY_ENV,
    model: 'diagnostic-model',
    supportsThinking: false,
    contextWindow: 32_000,
    maxOutputTokens: 1_000,
  };

  async stream(
    messages: KodaXMessage[],
    tools: KodaXToolDefinition[],
    _system: string,
    _reasoning?: boolean | KodaXReasoningRequest,
    streamOptions?: KodaXProviderStreamOptions,
    _signal?: AbortSignal,
  ): Promise<KodaXStreamResult> {
    ContextDiagnosticsProvider.calls.push({ messages, tools, streamOptions });
    streamOptions?.onTextDelta?.('diagnostics ok');
    return {
      textBlocks: [{ type: 'text', text: 'diagnostics ok' }],
      toolBlocks: [],
      thinkingBlocks: [],
      usage: {
        inputTokens: 42,
        outputTokens: 3,
        totalTokens: 45,
      },
    };
  }
}

describe('runKodaX context diagnostics', () => {
  beforeEach(() => {
    ContextDiagnosticsProvider.calls = [];
    process.env[TEST_PROVIDER_API_KEY_ENV] = 'test-key';
    registerModelProvider(TEST_PROVIDER_NAME, () => new ContextDiagnosticsProvider());
  });

  afterEach(() => {
    clearRuntimeModelProviders();
    delete process.env[TEST_PROVIDER_API_KEY_ENV];
  });

  it('does not compute or emit budget diagnostics unless explicitly enabled', async () => {
    const budgets: RuntimeContextBudgetSnapshot[] = [];
    const exposures: RuntimeToolExposurePlan[] = [];

    await runKodaX(
      {
        provider: TEST_PROVIDER_NAME,
        reasoningMode: 'off',
        maxIter: 1,
        context: { repoIntelligenceMode: 'off' },
        events: {
          onContextBudgetSnapshot: (event) => budgets.push(event),
          onToolExposurePlanned: (event) => exposures.push(event),
        },
      },
      'hello',
    );

    expect(budgets).toEqual([]);
    expect(exposures).toEqual([]);
  });

  it('emits bounded budget events and applies small-window bridge exposure when enabled', async () => {
    const budgets: RuntimeContextBudgetSnapshot[] = [];
    const exposures: RuntimeToolExposurePlan[] = [];

    await runKodaX(
      {
        provider: TEST_PROVIDER_NAME,
        reasoningMode: 'off',
        maxIter: 1,
        context: {
          contextDiagnostics: true,
          repoIntelligenceMode: 'off',
        },
        events: {
          onContextBudgetSnapshot: (event) => budgets.push(event),
          onToolExposurePlanned: (event) => exposures.push(event),
        },
      },
      'inspect this repository',
    );

    expect(budgets).toHaveLength(1);
    expect(budgets[0]?.sessionId).toBeDefined();
    expect(budgets[0]?.turnId).toBeDefined();
    expect(budgets[0]?.contextWindow).toBe(32_000);
    expect(budgets[0]?.profile).toBe('small_window');
    expect(budgets[0]?.tokenBreakdown.toolSchemas).toBeGreaterThan(0);
    expect(JSON.stringify(budgets[0])).not.toContain('inspect this repository');

    expect(exposures).toHaveLength(1);
    expect(exposures[0]?.profile).toBe('small_window');
    expect(exposures[0]?.reportOnly).toBe(false);
    expect(exposures[0]?.modelVisibleToolNames).toContain('read');
    expect(exposures[0]?.modelVisibleToolNames).toContain('tool_search');
    expect(exposures[0]?.modelVisibleToolNames).toContain('tool_call');
    expect(exposures[0]?.modelVisibleToolNames).not.toContain('web_fetch');
    expect(ContextDiagnosticsProvider.calls[0]?.tools.map((tool) => tool.name)).not.toContain('web_fetch');
    expect(exposures[0]?.estimatedTokensSaved).toBeGreaterThan(0);
  });

  it('propagates a typed capacity failure instead of returning success:false', async () => {
    await expect(runKodaX(
      {
        provider: TEST_PROVIDER_NAME,
        reasoningMode: 'off',
        maxIter: 1,
        compaction: { contextWindow: 1_000 },
        context: { repoIntelligenceMode: 'off' },
      },
      'hello',
    )).rejects.toBeInstanceOf(ContextCapacityError);

    expect(ContextDiagnosticsProvider.calls).toEqual([]);
  });
});
