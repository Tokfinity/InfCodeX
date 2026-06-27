import { describe, expect, it, vi } from 'vitest';

import type {
  KodaXBaseProvider,
  KodaXMessage,
  KodaXStreamResult,
  KodaXToolDefinition,
  KodaXToolUseBlock,
} from '@kodax-ai/llm';

import { buildRunnerSidecarVerifierAdapter } from './runner-sidecar-verifier-adapter.js';
import type { ManagedMutationTracker } from '../types.js';
import type { SidecarVerifierVerdict } from '../agent-runtime/middleware/sidecar-verifier/verifier.js';
import type { ObserverBridge } from './_internal/managed-task/types.js';

function fakeProvider(streamImpl: (
  messages: KodaXMessage[],
  tools: KodaXToolDefinition[],
  system: string,
) => Promise<KodaXStreamResult>): KodaXBaseProvider {
  return {
    name: 'fake-verifier',
    stream: streamImpl as unknown as KodaXBaseProvider['stream'],
  } as KodaXBaseProvider;
}

function toolBlock(input: Record<string, unknown>): KodaXToolUseBlock {
  return {
    type: 'tool_use',
    id: 'tu_fake',
    name: 'emit_sidecar_verdict',
    input,
  };
}

function makeObserver(): ObserverBridge {
  return {
    preflight: vi.fn(),
    onRoleEmit: vi.fn(),
    completed: vi.fn(),
    notifyBudgetApprovalRequest: vi.fn(),
    notifyChildFanout: vi.fn(),
    idleWaiting: vi.fn(),
    agentSwitched: vi.fn(),
    sidecarStarted: vi.fn(),
    sidecarFinished: vi.fn(),
    stallSidecarFired: vi.fn(),
    pinHarnessFromRouting: vi.fn(),
    scoutNarrative: vi.fn(),
  } as unknown as ObserverBridge;
}

function makeMutationTracker(): ManagedMutationTracker {
  return {
    files: new Map<string, number>(),
    totalOps: 0,
  };
}

describe('buildRunnerSidecarVerifierAdapter', () => {
  it('passes stop-hook reanimate budget context to the verdict side effect', async () => {
    const provider = fakeProvider(async () => ({
      textBlocks: [],
      thinkingBlocks: [],
      toolBlocks: [toolBlock({
        verdict: 'revise',
        reason: 'Run the missing regression test.',
      })],
    }));
    const seen: {
      verdict: SidecarVerifierVerdict;
      context: { reanimateCount: number; reanimateBudget: number };
    }[] = [];
    const adapter = buildRunnerSidecarVerifierAdapter({
      mainProvider: provider,
      mainProviderName: 'fake-verifier',
      mainModel: undefined,
      mutationTracker: makeMutationTracker(),
      observer: makeObserver(),
      onVerdict: (verdict, context) => {
        seen.push({
          verdict,
          context: {
            reanimateCount: context.reanimateCount,
            reanimateBudget: context.reanimateBudget,
          },
        });
      },
      getSessionId: () => undefined,
      getChildTaskRegistrySize: () => 0,
      getRoundCount: () => 1,
      getHasPlan: () => false,
    });

    const priorAlways = process.env.KODAX_VERIFIER_ALWAYS;
    process.env.KODAX_VERIFIER_ALWAYS = '1';
    try {
      const result = await adapter.composedStopHook({
        transcript: [
          { role: 'user', content: 'fix the failing test' },
          { role: 'assistant', content: 'done' },
        ],
        lastAssistantText: 'done',
        signal: 'natural-end',
        reanimateCount: 2,
        reanimateBudget: 2,
      });
      expect(result).toBe('Run the missing regression test.');
    } finally {
      if (priorAlways === undefined) {
        delete process.env.KODAX_VERIFIER_ALWAYS;
      } else {
        process.env.KODAX_VERIFIER_ALWAYS = priorAlways;
      }
    }

    expect(seen).toHaveLength(1);
    expect(seen[0]?.verdict).toMatchObject({
      verdict: 'revise',
      reason: 'Run the missing regression test.',
      trace: 'verifier_ok',
    });
    expect(seen[0]?.context).toEqual({
      reanimateCount: 2,
      reanimateBudget: 2,
    });
  });
});
