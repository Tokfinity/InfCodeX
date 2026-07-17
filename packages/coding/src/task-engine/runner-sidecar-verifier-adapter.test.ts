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
      getActiveDescendantTurnCount: () => 0,
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
      expect((result as { source?: string }).source).toBe('sidecar-verifier');
      expect((result as { reanimate: string }).reanimate).toContain('Run the missing regression test.');
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

  it('flips the REPL status-line label back to Worker on a revise reanimation (label-lag fix)', async () => {
    // The sidecar verdict emits onRoleEmit('evaluator') via onVerdict, flipping
    // the status-line label to [Evaluator]. A `revise` reanimates the SAME
    // Worker (no agent switch → onAgentSwitched never fires), so the label must
    // be flipped back here or the Worker's reanimated output renders under the
    // stale [Evaluator] label.
    const provider = fakeProvider(async () => ({
      textBlocks: [],
      thinkingBlocks: [],
      toolBlocks: [toolBlock({ verdict: 'revise', reason: 'Add the missing diff.' })],
    }));
    const observer = makeObserver();
    const adapter = buildRunnerSidecarVerifierAdapter({
      mainProvider: provider,
      mainProviderName: 'fake-verifier',
      mainModel: undefined,
      mutationTracker: makeMutationTracker(),
      observer,
      onVerdict: () => {},
      getSessionId: () => undefined,
      getActiveDescendantTurnCount: () => 0,
      getRoundCount: () => 1,
      getHasPlan: () => false,
    });

    const priorAlways = process.env.KODAX_VERIFIER_ALWAYS;
    process.env.KODAX_VERIFIER_ALWAYS = '1';
    try {
      const result = await adapter.composedStopHook({
        transcript: [
          { role: 'user', content: 'review the change' },
          { role: 'assistant', content: 'report' },
        ],
        lastAssistantText: 'report',
        signal: 'natural-end',
        reanimateCount: 0,
        reanimateBudget: 2,
      });
      expect((result as { reanimate?: string }).reanimate).toContain('Add the missing diff.');
    } finally {
      if (priorAlways === undefined) {
        delete process.env.KODAX_VERIFIER_ALWAYS;
      } else {
        process.env.KODAX_VERIFIER_ALWAYS = priorAlways;
      }
    }

    expect(observer.agentSwitched).toHaveBeenCalledWith('worker');
  });

  it('does NOT flip the label on a blocked verdict (terminal, no reanimation)', async () => {
    const provider = fakeProvider(async () => ({
      textBlocks: [],
      thinkingBlocks: [],
      toolBlocks: [toolBlock({ verdict: 'blocked', reason: 'Unsafe change; stopping.' })],
    }));
    const observer = makeObserver();
    const adapter = buildRunnerSidecarVerifierAdapter({
      mainProvider: provider,
      mainProviderName: 'fake-verifier',
      mainModel: undefined,
      mutationTracker: makeMutationTracker(),
      observer,
      onVerdict: () => {},
      getSessionId: () => undefined,
      getActiveDescendantTurnCount: () => 0,
      getRoundCount: () => 1,
      getHasPlan: () => false,
    });

    const priorAlways = process.env.KODAX_VERIFIER_ALWAYS;
    process.env.KODAX_VERIFIER_ALWAYS = '1';
    try {
      const result = await adapter.composedStopHook({
        transcript: [
          { role: 'user', content: 'review the change' },
          { role: 'assistant', content: 'report' },
        ],
        lastAssistantText: 'report',
        signal: 'natural-end',
        reanimateCount: 0,
        reanimateBudget: 2,
      });
      expect((result as { abort?: boolean }).abort).toBe(true);
    } finally {
      if (priorAlways === undefined) {
        delete process.env.KODAX_VERIFIER_ALWAYS;
      } else {
        process.env.KODAX_VERIFIER_ALWAYS = priorAlways;
      }
    }

    expect(observer.agentSwitched).not.toHaveBeenCalled();
  });
});
