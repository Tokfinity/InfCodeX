import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  KodaXMessage,
  KodaXProviderConfig,
  KodaXReasoningRequest,
  KodaXStreamResult,
  KodaXToolDefinition,
} from '@kodax-ai/llm';
import {
  clearRuntimeModelProviders,
  KodaXBaseProvider,
  registerModelProvider,
} from '@kodax-ai/llm';
import type { Agent } from '@kodax-ai/agent';

import type { RuntimeContextBudgetSnapshot } from '../../../agent-runtime/context-budget.js';
import { buildRunnerLlmAdapter } from './llm-adapter.js';

const PROVIDER_NAME = 'managed-diagnostic-fail-open';
const PROVIDER_KEY_ENV = 'MANAGED_DIAGNOSTIC_FAIL_OPEN_KEY';

class ManagedDiagnosticFailOpenProvider extends KodaXBaseProvider {
  static calls = 0;

  readonly name = PROVIDER_NAME;
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: PROVIDER_KEY_ENV,
    model: 'diagnostic-model',
    supportsThinking: false,
    contextWindow: 32_000,
    maxOutputTokens: 1_000,
  };

  override getEffectiveContextWindow(): number {
    throw new Error('diagnostic context-window lookup failed');
  }

  async stream(
    _messages: KodaXMessage[],
    _tools: KodaXToolDefinition[],
    _system: string,
    _reasoning?: boolean | KodaXReasoningRequest,
  ): Promise<KodaXStreamResult> {
    ManagedDiagnosticFailOpenProvider.calls += 1;
    return {
      textBlocks: [{ type: 'text', text: 'provider still ran' }],
      toolBlocks: [],
      thinkingBlocks: [],
      usage: {
        inputTokens: 10,
        outputTokens: 2,
        totalTokens: 12,
      },
    };
  }
}

describe('managed LLM adapter context diagnostics', () => {
  beforeEach(() => {
    ManagedDiagnosticFailOpenProvider.calls = 0;
    process.env[PROVIDER_KEY_ENV] = 'test-key';
    registerModelProvider(PROVIDER_NAME, () => new ManagedDiagnosticFailOpenProvider());
  });

  afterEach(() => {
    clearRuntimeModelProviders();
    delete process.env[PROVIDER_KEY_ENV];
  });

  it('keeps the provider call fail-open when budget snapshot construction throws', async () => {
    const budgets: RuntimeContextBudgetSnapshot[] = [];
    const adapter = buildRunnerLlmAdapter({
      provider: PROVIDER_NAME,
      model: 'diagnostic-model',
      effort: 'none',
      context: { contextDiagnostics: true },
      events: {
        onContextBudgetSnapshot: (event) => budgets.push(event),
      },
    });
    const agent: Agent = {
      name: 'worker',
      instructions: 'work',
      tools: [],
      reasoning: { default: 'none', max: 'none' },
    };

    await expect(adapter([
      { role: 'system', content: 'stable rules' },
      { role: 'user', content: 'task' },
    ], agent)).resolves.toMatchObject({ text: 'provider still ran' });

    expect(ManagedDiagnosticFailOpenProvider.calls).toBe(1);
    expect(budgets).toEqual([]);
  });
});
