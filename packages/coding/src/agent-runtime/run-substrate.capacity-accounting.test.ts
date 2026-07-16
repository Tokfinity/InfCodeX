import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearRuntimeModelProviders,
  KodaXBaseProvider,
  registerModelProvider,
} from '@kodax-ai/llm';
import type {
  KodaXMessage,
  KodaXProviderConfig,
  KodaXReasoningRequest,
  KodaXStreamResult,
  KodaXToolDefinition,
} from '@kodax-ai/llm';

import { estimateTokens, countTokens } from '../tokenizer.js';
import { createRuntimeContextBudgetSnapshot } from './context-budget.js';
import type { RuntimeContextBudgetSnapshot } from './context-budget.js';
import { runSubstrate } from './run-substrate.js';

const PROVIDER_NAME = 'sa-capacity-accounting-test';
const API_KEY_ENV = 'SA_CAPACITY_ACCOUNTING_TEST_API_KEY';
const CONTEXT_WINDOW = 128_000;

interface CapturedRequest {
  readonly messages: KodaXMessage[];
  readonly tools: KodaXToolDefinition[];
  readonly systemPrompt: string;
}

class CapacityAccountingProvider extends KodaXBaseProvider {
  static requests: CapturedRequest[] = [];
  static mode: 'text' | 'tool' = 'text';
  static usage: KodaXStreamResult['usage'] = undefined;

  readonly name = PROVIDER_NAME;
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: API_KEY_ENV,
    model: 'capacity-model',
    supportsThinking: false,
    contextWindow: CONTEXT_WINDOW,
    maxOutputTokens: 1_000,
  };

  async stream(
    messages: KodaXMessage[],
    tools: KodaXToolDefinition[],
    systemPrompt: string,
    _reasoning?: boolean | KodaXReasoningRequest,
  ): Promise<KodaXStreamResult> {
    CapacityAccountingProvider.requests.push({
      messages: structuredClone(messages),
      tools: [...tools],
      systemPrompt,
    });
    if (CapacityAccountingProvider.mode === 'tool') {
      return {
        textBlocks: [],
        thinkingBlocks: [],
        toolBlocks: [{
          type: 'tool_use',
          id: 'read-1',
          name: 'read',
          input: { path: 'capacity-fixture.txt' },
        }],
        usage: CapacityAccountingProvider.usage,
      };
    }
    return {
      textBlocks: [{ type: 'text', text: 'done' }],
      thinkingBlocks: [],
      toolBlocks: [],
      usage: CapacityAccountingProvider.usage,
    };
  }
}

describe('runSubstrate physical request accounting', { timeout: 30_000 }, () => {
  beforeEach(() => {
    process.env[API_KEY_ENV] = 'test-key';
    CapacityAccountingProvider.requests = [];
    CapacityAccountingProvider.mode = 'text';
    CapacityAccountingProvider.usage = undefined;
    registerModelProvider(PROVIDER_NAME, () => new CapacityAccountingProvider());
  });

  afterEach(() => {
    delete process.env[API_KEY_ENV];
    clearRuntimeModelProviders();
  });

  it('does not count skills separately when systemPromptOverride is the complete wire prompt', async () => {
    const snapshots: RuntimeContextBudgetSnapshot[] = [];
    const systemPromptOverride = 'EXACT OVERRIDE PROMPT';

    await runSubstrate({
      provider: PROVIDER_NAME,
      model: 'capacity-model',
      maxIter: 1,
      reasoningMode: 'off',
      context: {
        systemPromptOverride,
        skillsPrompt: 'THIS SKILL CATALOG IS BYPASSED BY THE OVERRIDE',
        contextDiagnostics: true,
      },
      events: {
        onContextBudgetSnapshot: (snapshot) => snapshots.push(snapshot),
      },
    }, 'inspect capacity');

    expect(CapacityAccountingProvider.requests).toHaveLength(1);
    expect(CapacityAccountingProvider.requests[0]!.systemPrompt).toBe(systemPromptOverride);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.tokenBreakdown.systemPrompt).toBe(countTokens(systemPromptOverride));
    expect(snapshots[0]!.tokenBreakdown.skillCatalog).toBe(0);
  });

  it('rebases a no-usage snapshot from the final request envelope through assistant and tool appends', async () => {
    CapacityAccountingProvider.mode = 'tool';
    const result = await runSubstrate({
      provider: PROVIDER_NAME,
      model: 'capacity-model',
      maxIter: 1,
      reasoningMode: 'off',
      context: { systemPromptOverride: 'CAPACITY TEST PROMPT' },
      events: {
        beforeToolExecute: async () => 'complete tool evidence',
      },
    }, 'inspect capacity');

    const request = CapacityAccountingProvider.requests[0]!;
    const preCallEnvelopeTokens = createRuntimeContextBudgetSnapshot({
      contextWindow: CONTEXT_WINDOW,
      systemPrompt: request.systemPrompt,
      toolDefinitions: request.tools,
      messages: request.messages,
    }).usedTokens;
    const appendedTranscriptTokens = estimateTokens(result.messages) - estimateTokens(request.messages);
    const expectedCompletedTokens = preCallEnvelopeTokens + appendedTranscriptTokens;

    expect(result.contextTokenSnapshot).toMatchObject({
      currentTokens: expectedCompletedTokens,
      baselineEstimatedTokens: estimateTokens(result.messages),
      source: 'estimate',
    });
    expect(result.contextTokenSnapshot?.currentTokens).toBeGreaterThan(estimateTokens(result.messages));
  });

  it('keeps valid provider usage authoritative', async () => {
    CapacityAccountingProvider.usage = {
      inputTokens: 1_234,
      outputTokens: 56,
      totalTokens: 1_290,
    };

    const result = await runSubstrate({
      provider: PROVIDER_NAME,
      model: 'capacity-model',
      maxIter: 1,
      reasoningMode: 'off',
      context: { systemPromptOverride: 'CAPACITY TEST PROMPT' },
    }, 'inspect capacity');

    expect(result.contextTokenSnapshot).toMatchObject({
      currentTokens: 1_290,
      source: 'api',
      usage: CapacityAccountingProvider.usage,
    });
  });
});
