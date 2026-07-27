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
        'candidate:2',
        'candidate:99',
        'candidate:1',
      ],
    });
    const runner = createCodingMemoryInterventionRunner({ provider });

    await expect(runner(candidateInput)).resolves.toEqual({
      selectedRefIds: ['memdir:procedure-npm', 'observation:failure-1'],
    });
    expect(provider.stream).toHaveBeenCalledOnce();
    const wire = JSON.stringify(vi.mocked(provider.stream).mock.calls[0]);
    expect(wire).toContain('candidate:1');
    expect(wire).toContain('candidate:2');
    expect(wire).not.toContain('observation:failure-1');
    expect(wire).not.toContain('memdir:procedure-npm');
    expect(wire).not.toContain('tool-result:edit-1');
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
          input: { selectedRefIds: ['candidate:2'] },
        }],
      }),
    } as unknown as KodaXBaseProvider;
    const runner = createCodingMemoryInterventionRunner({ provider });

    await expect(runner(candidateInput)).resolves.toEqual({ selectedRefIds: [] });
  });

  it('does not offer current objective or todo projections to semantic selection', async () => {
    const provider = providerWithToolInput({ selectedRefIds: ['candidate:1'] });
    const runner = createCodingMemoryInterventionRunner({ provider });

    await expect(runner({
      ...candidateInput,
      candidates: [
        {
          refId: 'current:objective',
          claim: 'Current objective is already visible.',
          claimKind: 'objective',
          source: 'current',
        },
        candidateInput.candidates[1]!,
      ],
    })).resolves.toEqual({
      selectedRefIds: ['memdir:procedure-npm'],
    });
    const wire = JSON.stringify(vi.mocked(provider.stream).mock.calls[0]);
    expect(wire).not.toContain('Current objective is already visible.');
    expect(wire).toContain('Use npm workspaces.');
  });
});
