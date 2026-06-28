import { describe, expect, it, vi } from 'vitest';

const llmMock = vi.hoisted(() => ({
  resolveProvider: vi.fn(() => ({
    getModel: () => 'mock-model',
  })),
  sideQuery: vi.fn(async () => ({
    text: JSON.stringify({
      action: 'generate',
      manifest: {
        name: 'generated-test-workflow',
        description: 'Generated test workflow',
        phases: ['synthesize'],
        patterns: ['fan-out-and-synthesize'],
        readOnly: true,
        maxAgents: 1,
        maxConcurrency: 1,
      },
      source: 'async function run(wf, args) { return { synthesis: String(args.request || "") }; }',
      approvalSummary: 'Run generated test workflow',
    }),
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    stopReason: 'end_turn',
  })),
}));

vi.mock('@kodax-ai/llm', () => ({
  resolveProvider: llmMock.resolveProvider,
  sideQuery: llmMock.sideQuery,
}));

import { generateWorkflowFromOptions } from './generator.js';

describe('generateWorkflowFromOptions', () => {
  it('passes configured reasoning effort to the workflow generation side query', async () => {
    const result = await generateWorkflowFromOptions({
      request: 'Create a workflow to review several modules and synthesize findings.',
      options: {
        provider: 'mock-provider',
        model: 'base-model',
        modelOverride: 'active-model',
        effort: 'high',
      },
    });

    expect(result.kind).toBe('generated');
    expect(llmMock.sideQuery).toHaveBeenCalledWith(expect.objectContaining({
      model: 'active-model',
      querySource: 'workflow-generation',
      reasoning: { effort: 'high' },
    }));
  });
});
