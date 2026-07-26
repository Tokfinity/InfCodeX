import { describe, expect, it, vi } from 'vitest';
import type {
  KodaXMessage,
  KodaXProviderConfig,
  KodaXReasoningRequest,
  KodaXProviderStreamOptions,
  KodaXStreamResult,
  KodaXToolDefinition,
} from '@kodax-ai/llm';
import { KodaXBaseProvider } from '@kodax-ai/llm';
import {
  buildCompactionPromptSnapshot,
  generateSummary,
} from './summary-generator.js';

class RecordingSummaryProvider extends KodaXBaseProvider {
  readonly name = 'recording-summary';
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'FAKE_SUMMARY_API_KEY',
    model: 'recording-summary-model',
    supportsThinking: false,
    contextWindow: 200000,
  };

  public prompts: string[] = [];
  public systems: string[] = [];
  public modelOverrides: Array<string | undefined> = [];
  public messageBatches: KodaXMessage[][] = [];
  public toolBatches: KodaXToolDefinition[][] = [];
  public reasoningRequests: Array<boolean | KodaXReasoningRequest | undefined> = [];
  public ephemeralSuffixes: Array<string | undefined> = [];

  async stream(
    messages: KodaXMessage[],
    tools: KodaXToolDefinition[],
    system: string,
    thinking?: boolean | KodaXReasoningRequest,
    streamOptions?: KodaXProviderStreamOptions,
  ): Promise<KodaXStreamResult> {
    const prompt = messages[0];
    this.prompts.push(
      typeof prompt?.content === 'string'
        ? prompt.content
        : JSON.stringify(prompt?.content),
    );
    this.systems.push(system);
    this.modelOverrides.push(streamOptions?.modelOverride);
    this.messageBatches.push(messages);
    this.toolBatches.push(tools);
    this.reasoningRequests.push(thinking);
    this.ephemeralSuffixes.push(streamOptions?.ephemeralSuffix?.content);

    return {
      textBlocks: [{ type: 'text', text: '## Goal\nContinue safely.' }],
      toolBlocks: [],
      thinkingBlocks: [],
    };
  }
}

describe('buildCompactionPromptSnapshot', () => {
  it('builds a specialist prompt snapshot with ordered sections and provenance', () => {
    const snapshot = buildCompactionPromptSnapshot({
      messages: [{ role: 'user', content: 'continue the work' }],
      details: {
        readFiles: ['a.ts'],
        modifiedFiles: ['b.ts'],
      },
      customInstructions: 'Focus on risks',
      previousSummary: 'Previous summary',
      systemPrompt: 'CUSTOM SYSTEM',
    });

    expect(snapshot.variant).toBe('update-summary');
    expect(snapshot.systemPrompt).toBe('CUSTOM SYSTEM');
    expect(snapshot.hash).toHaveLength(64);
    expect(
      snapshot.sections.map(({ id, slot, feature, order }) => ({
        id,
        slot,
        feature,
        order,
      })),
    ).toMatchInlineSnapshot(`
      [
        {
          "feature": "FEATURE_050",
          "id": "conversation",
          "order": 100,
          "slot": "conversation",
        },
        {
          "feature": "FEATURE_050",
          "id": "previous-summary",
          "order": 200,
          "slot": "history",
        },
        {
          "feature": "FEATURE_044",
          "id": "update-instructions",
          "order": 300,
          "slot": "instructions",
        },
        {
          "feature": "FEATURE_050",
          "id": "custom-instructions",
          "order": 350,
          "slot": "instructions",
        },
        {
          "feature": "FEATURE_044",
          "id": "file-tracking",
          "order": 400,
          "slot": "tracking",
        },
      ]
    `);
    expect(snapshot.userPrompt).toContain('<conversation>');
    expect(snapshot.userPrompt).toContain('<previous-summary>');
    expect(snapshot.userPrompt).toContain('Additional instructions: Focus on risks');
    expect(snapshot.userPrompt).toContain('Read files: a.ts');
    expect(snapshot.userPrompt).toContain('Modified files: b.ts');
  });

  it('generateSummary uses the specialist prompt snapshot output', async () => {
    const provider = new RecordingSummaryProvider();
    const args = {
      messages: [{ role: 'user' as const, content: 'continue the work' }],
      details: {
        readFiles: ['a.ts'],
        modifiedFiles: ['b.ts'],
      },
      customInstructions: 'Focus on risks',
      systemPrompt: 'CUSTOM SYSTEM',
      previousSummary: 'Previous summary',
    };
    const snapshot = buildCompactionPromptSnapshot(args);

    await generateSummary(
      args.messages,
      provider,
      args.details,
      args.customInstructions,
      args.systemPrompt,
      args.previousSummary,
    );

    expect(provider.systems[0]).toBe(snapshot.systemPrompt);
    expect(provider.prompts[0]).toBe(snapshot.userPrompt);
  });

  it('generateSummary forwards the active model override', async () => {
    const provider = new RecordingSummaryProvider();

    await generateSummary(
      [{ role: 'user', content: 'continue the work' }],
      provider,
      { readFiles: [], modifiedFiles: [] },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'active-model',
    );

    expect(provider.modelOverrides[0]).toBe('active-model');
  });

  it('reuses the exact main-request prefix through an ephemeral summary suffix', async () => {
    const provider = new RecordingSummaryProvider();
    const onRequest = vi.fn();
    const onResponse = vi.fn();
    const messages: KodaXMessage[] = [
      { role: 'user', content: 'first request' },
      { role: 'assistant', content: 'first response' },
    ];
    const tools: KodaXToolDefinition[] = [{
      name: 'read',
      description: 'Read a file',
      input_schema: { type: 'object', properties: { path: { type: 'string' } } },
    }];
    const reasoning: KodaXReasoningRequest = { effort: 'high' };

    await generateSummary(
      messages,
      provider,
      { readFiles: [], modifiedFiles: [] },
      undefined,
      'MAIN SYSTEM',
      undefined,
      undefined,
      undefined,
      'active-model',
      {
        tools,
        reasoning,
        protectedTailMessageCount: 1,
        observer: { onRequest, onResponse },
      },
    );

    expect(provider.messageBatches[0]).toEqual(messages);
    expect(provider.toolBatches[0]).toEqual(tools);
    expect(provider.systems[0]).toBe('MAIN SYSTEM');
    expect(provider.reasoningRequests[0]).toEqual(reasoning);
    expect(provider.ephemeralSuffixes[0]).toContain('TEXT ONLY');
    expect(provider.ephemeralSuffixes[0]).toContain('final 1 message');
    expect(provider.ephemeralSuffixes[0]).not.toContain('<conversation>');
    expect(onRequest).toHaveBeenCalledWith(expect.objectContaining({
      messages,
      tools,
      system: 'MAIN SYSTEM',
      reasoning,
      ephemeralSuffix: expect.objectContaining({ content: expect.stringContaining('TEXT ONLY') }),
    }));
    expect(onResponse).toHaveBeenCalledWith(
      expect.objectContaining({ messages }),
      undefined,
    );
  });

  it('rejects tool use even when the provider also returns text', async () => {
    class ToolUsingProvider extends RecordingSummaryProvider {
      override async stream(): Promise<KodaXStreamResult> {
        return {
          textBlocks: [{ type: 'text', text: 'A plausible summary' }],
          toolBlocks: [{ type: 'tool_use', id: 'tool-1', name: 'read', input: {} }],
          thinkingBlocks: [],
        };
      }
    }

    await expect(generateSummary(
      [{ role: 'user', content: 'continue' }],
      new ToolUsingProvider(),
      { readFiles: [], modifiedFiles: [] },
    )).rejects.toThrow(/tool_use/i);
  });

  it('generateSummary throws when the provider returns no usable text', async () => {
    class EmptyTextProvider extends KodaXBaseProvider {
      readonly name = 'empty-summary';
      readonly supportsThinking = false;
      protected readonly config: KodaXProviderConfig = {
        apiKeyEnv: 'FAKE_SUMMARY_API_KEY',
        model: 'empty-summary-model',
        supportsThinking: false,
        contextWindow: 200000,
      };

      async stream(): Promise<KodaXStreamResult> {
        // Simulate provider returning only whitespace / analysis block — the
        // case where a tool-calling-heavy model emits no real summary text.
        return {
          textBlocks: [{ type: 'text', text: '<analysis>thinking only</analysis>' }],
          toolBlocks: [],
          thinkingBlocks: [],
        };
      }
    }

    const provider = new EmptyTextProvider();

    await expect(
      generateSummary(
        [{ role: 'user', content: 'continue' }],
        provider,
        { readFiles: [], modifiedFiles: [] },
        undefined,
        undefined,
        undefined,
      ),
    ).rejects.toThrow(/did not contain valid text/i);
  });
});
