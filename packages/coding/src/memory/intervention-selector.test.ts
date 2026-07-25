import { describe, expect, it, vi } from 'vitest';

import type { KodaXBaseProvider } from '@kodax-ai/llm';
import { createCodingMemoryInterventionRunner } from './intervention-selector.js';

function providerWithToolInput(input: Record<string, unknown>): KodaXBaseProvider {
  return {
    stream: vi.fn().mockResolvedValue({
      textBlocks: [],
      thinkingBlocks: [],
      toolBlocks: [{
        type: 'tool_use',
        id: 'selector-1',
        name: 'select_memory_candidates',
        input,
      }],
    }),
  } as unknown as KodaXBaseProvider;
}

const candidateInput = {
  objective: 'Fix the dependency update',
  decisionContext: 'A prior edit failed.',
  decisionIntent: 'dependency-update',
  triggers: ['tool_failure'] as const,
  candidates: [
    {
      refId: 'observation:failure-1',
      claim: 'The edit failed.',
      claimKind: 'outcome',
      source: 'session' as const,
      evidenceRefs: ['tool-result:edit-1'],
    },
    {
      refId: 'memdir:procedure-npm',
      claim: 'Use npm workspaces.',
      claimKind: 'procedure',
      source: 'durable' as const,
      evidenceRefs: ['memdir:procedure-npm'],
    },
  ],
  signal: new AbortController().signal,
};

describe('FEATURE_275 coding memory intervention selector', () => {
  it('returns only exact offered IDs from the forced tool call', async () => {
    const provider = providerWithToolInput({
      selectedRefIds: [
        'memdir:procedure-npm',
        'memdir:not-offered',
        'observation:failure-1',
      ],
    });
    const runner = createCodingMemoryInterventionRunner({ provider });

    await expect(runner(candidateInput)).resolves.toEqual({
      selectedRefIds: ['memdir:procedure-npm', 'observation:failure-1'],
    });
    expect(provider.stream).toHaveBeenCalledOnce();
  });

  it('fails silent when the selector uses a fuzzy tool name', async () => {
    const provider = {
      stream: vi.fn().mockResolvedValue({
        textBlocks: [],
        thinkingBlocks: [],
        toolBlocks: [{
          type: 'tool_use',
          id: 'selector-1',
          name: 'select_memory_candidate',
          input: { selectedRefIds: ['memdir:procedure-npm'] },
        }],
      }),
    } as unknown as KodaXBaseProvider;
    const runner = createCodingMemoryInterventionRunner({ provider });

    await expect(runner(candidateInput)).resolves.toEqual({ selectedRefIds: [] });
  });
});
