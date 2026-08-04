/**
 * FEATURE_184 (v0.7.45) Phase D.2 — Sidecar verifier → recorder bridge tests.
 *
 * Pins the parity contract between the sidecar verifier's verdict and
 * the legacy Evaluator emit_verdict shape: identical recorder.verdict
 * structure, identical TodoStore side effects, identical observer
 * onRoleEmit emission.
 */

import { describe, expect, it, vi } from 'vitest';
import { setKodaXDiagnosticSink, type KodaXDiagnostic } from '@kodax-ai/agent';

import {
  applySidecarVerdictToRecorder,
  buildSidecarMessageEvent,
  buildSidecarVerdictMetadata,
  buildSidecarVerdictPayload,
  emitSidecarMessageEvent,
} from './verifier-recorder-bridge.js';
import type { SidecarVerifierVerdict } from './verifier.js';
import type { KodaXSidecarMessageEvent } from '../../../types.js';
import type {
  ObserverBridge,
  VerdictRecorder,
} from '../../../task-engine/_internal/managed-task/types.js';
import type { ManagedTaskBudgetController } from '../../../task-engine/_internal/managed-task/budget.js';
import type { BudgetExtensionContext } from '../../../task-engine/_internal/managed-task/verdict-recorder.js';
import type { TodoStore } from '../../../task-engine/todo-store.js';

function makeRecorder(): VerdictRecorder {
  return {};
}

function makeObserver(): ObserverBridge {
  return {
    onRoleEmit: vi.fn(),
    notifyBudgetApprovalRequest: vi.fn(),
    notifyChildFanout: vi.fn(),
    idleWaiting: vi.fn(),
    agentSwitched: vi.fn(),
    pinHarnessFromRouting: vi.fn(),
    scoutNarrative: vi.fn(),
    completed: vi.fn(),
  } as unknown as ObserverBridge;
}

function makeTodoStore(): TodoStore {
  return {
    autoCompleteOnAccept: vi.fn().mockReturnValue(0),
    markInProgressFailed: vi.fn(),
    reset: vi.fn(),
    init: vi.fn(),
    hasItems: vi.fn().mockReturnValue(false),
    resetFailed: vi.fn(),
    snapshot: vi.fn().mockReturnValue([]),
  } as unknown as TodoStore;
}

function makeBudgetExtension(
  askUser: NonNullable<BudgetExtensionContext['events']>['askUser'],
): BudgetExtensionContext {
  return {
    events: { askUser },
    originalTask: 'Finish the requested analysis.',
    roundRef: { current: 2 },
    maxRoundsRef: { current: 4 },
    budgetApprovalRef: { current: false },
    planRef: { current: undefined },
    degradedContinueRef: { current: false },
    harnessRef: { current: 'H0_DIRECT' },
  };
}

describe('buildSidecarVerdictPayload — shape parity with Evaluator emit_verdict', () => {
  it('builds an accept payload with empty followups when no suggestedFix', () => {
    const payload = buildSidecarVerdictPayload({
      verdict: 'accept',
      reason: '',
      trace: 'verifier_ok',
    });
    expect(payload.source).toBe('sidecar');
    expect(payload.status).toBe('accept');
    expect(payload.followups).toEqual([]);
  });

  it('packs suggestedFix into followups', () => {
    const payload = buildSidecarVerdictPayload({
      verdict: 'revise',
      reason: 'add tests',
      suggestedFix: 'see foo.ts:42',
      trace: 'verifier_ok',
    });
    expect(payload.followups).toEqual(['see foo.ts:42']);
    expect(payload.reason).toBe('add tests');
  });

  it('records focused strategy advice and fail-open degradation', () => {
    const payload = buildSidecarVerdictPayload({
      verdict: 'revise',
      reason: 'Resolve the unsupported claim.',
      reasonCode: 'unsupported_claim',
      recommendedPattern: 'adversarial-verification',
      targetEvidenceRefs: ['finding:auth-boundary'],
      trace: 'provider_error',
    });

    expect(payload).toMatchObject({
      strategyReasonCode: 'unsupported_claim',
      recommendedPattern: 'adversarial-verification',
      targetEvidenceRefs: ['finding:auth-boundary'],
      verificationDegraded: true,
    });
  });
});

describe('buildSidecarMessageEvent', () => {
  it('returns undefined for accept because no message is delivered', () => {
    const event = buildSidecarMessageEvent({
      verdict: 'accept',
      reason: 'looks good',
      trace: 'verifier_ok',
    });
    expect(event).toBeUndefined();
  });

  it('maps revise to a main-agent synthetic-user-message event', () => {
    const event = buildSidecarMessageEvent({
      verdict: 'revise',
      reason: 'Run the missing regression test.',
      suggestedFix: 'npm test -- foo.test.ts',
      trace: 'verifier_ok',
    });
    expect(event).toEqual({
      source: 'sidecar-verifier',
      verdict: 'revise',
      recipient: 'main-agent',
      delivery: 'synthetic-user-message',
      content: 'Run the missing regression test.',
      suggestedFix: 'npm test -- foo.test.ts',
      trace: 'verifier_ok',
    });
  });

  it('maps revise to budget-exhausted when no reanimate delivery can occur', () => {
    const event = buildSidecarMessageEvent(
      {
        verdict: 'revise',
        reason: 'Run the missing regression test.',
        trace: 'verifier_ok',
      },
      {
        reanimateCount: 2,
        reanimateBudget: 2,
      },
    );
    expect(event).toEqual({
      source: 'sidecar-verifier',
      verdict: 'revise',
      recipient: 'user',
      delivery: 'budget-exhausted',
      content: 'Run the missing regression test.',
      trace: 'verifier_ok',
    });
  });

  it('maps blocked to a terminal user-facing event', () => {
    const event = buildSidecarMessageEvent({
      verdict: 'blocked',
      reason: 'Need the target API version.',
      trace: 'verifier_ok',
    });
    expect(event).toMatchObject({
      verdict: 'blocked',
      recipient: 'user',
      delivery: 'terminal-block',
      content: 'Need the target API version.',
    });
  });

  it('returns undefined for empty revise or blocked reasons', () => {
    expect(buildSidecarMessageEvent({
      verdict: 'revise',
      reason: '  ',
      trace: 'verifier_ok',
    })).toBeUndefined();
    expect(buildSidecarMessageEvent({
      verdict: 'blocked',
      reason: '',
      trace: 'verifier_ok',
    })).toBeUndefined();
  });

  it('emits through KodaXEvents when an actionable sidecar message exists', () => {
    const observed: KodaXSidecarMessageEvent[] = [];
    emitSidecarMessageEvent(
      {
        onSidecarMessage: (event) => observed.push(event),
      },
      {
        verdict: 'revise',
        reason: 'Add the missing assertion.',
        trace: 'verifier_ok',
      },
    );
    expect(observed).toHaveLength(1);
    expect(observed[0]?.content).toBe('Add the missing assertion.');
  });

  it('does not let event sink failures change verifier behavior', () => {
    const onError = vi.fn();
    const diagnostics: KodaXDiagnostic[] = [];
    const restoreDiagnostics = setKodaXDiagnosticSink((diagnostic) => {
      diagnostics.push(diagnostic);
    });
    try {
      expect(() =>
        emitSidecarMessageEvent(
          {
            onSidecarMessage: () => {
              throw new Error('sink failed');
            },
            onError,
          },
          {
            verdict: 'revise',
            reason: 'Add the missing assertion.',
            trace: 'verifier_ok',
          },
        ),
      ).not.toThrow();
      expect(onError).not.toHaveBeenCalled();
      expect(diagnostics).toContainEqual(expect.objectContaining({
        source: 'coding:sidecar-verifier',
        level: 'error',
        message: 'Sidecar message event sink failed: sink failed',
      }));
    } finally {
      restoreDiagnostics();
    }
  });
});

describe('buildSidecarVerdictMetadata — synthetic ProtocolEmitterMetadata', () => {
  it('uses role="evaluator" for downstream-compat keying', () => {
    const meta = buildSidecarVerdictMetadata({
      verdict: 'accept',
      reason: '',
      trace: 'verifier_ok',
    });
    expect(meta.role).toBe('evaluator');
    expect(meta.handoffTarget).toBeUndefined();
    expect(meta.isTerminal).toBe(true);
  });

  it('embeds the verdict status under payload.verdict', () => {
    const meta = buildSidecarVerdictMetadata({
      verdict: 'blocked',
      reason: 'needs clarification',
      trace: 'verifier_ok',
    });
    expect(meta.payload.verdict?.status).toBe('blocked');
    expect(meta.payload.verdict?.reason).toBe('needs clarification');
  });
});

describe('applySidecarVerdictToRecorder — side effects', () => {
  it('writes recorder.verdict + fires observer.onRoleEmit("evaluator")', async () => {
    const recorder = makeRecorder();
    const observer = makeObserver();
    const verdict: SidecarVerifierVerdict = {
      verdict: 'accept',
      reason: '',
      trace: 'verifier_ok',
    };
    await applySidecarVerdictToRecorder({ recorder, observer, verdict });
    expect(recorder.verdict?.payload.verdict?.status).toBe('accept');
    expect(observer.onRoleEmit).toHaveBeenCalledWith('evaluator', recorder);
  });

  it('accept preserves open todo state instead of manufacturing completion', async () => {
    const recorder = makeRecorder();
    const observer = makeObserver();
    const todoStore = makeTodoStore();
    await applySidecarVerdictToRecorder({
      recorder,
      observer,
      todoStore,
      verdict: { verdict: 'accept', reason: '', trace: 'verifier_ok' },
    });
    expect(todoStore.autoCompleteOnAccept).not.toHaveBeenCalled();
    expect(todoStore.markInProgressFailed).not.toHaveBeenCalled();
  });

  it('accept emits no reconciliation diagnostic for open todos', async () => {
    const recorder = makeRecorder();
    const observer = makeObserver();
    const todoStore = makeTodoStore();
    vi.mocked(todoStore.autoCompleteOnAccept).mockReturnValue(3);
    const diagnostics: KodaXDiagnostic[] = [];
    const restoreDiagnostics = setKodaXDiagnosticSink((diagnostic) => {
      diagnostics.push(diagnostic);
    });

    try {
      await applySidecarVerdictToRecorder({
        recorder,
        observer,
        todoStore,
        verdict: { verdict: 'accept', reason: '', trace: 'verifier_ok' },
      });
    } finally {
      restoreDiagnostics();
    }

    expect(diagnostics).not.toContainEqual(expect.objectContaining({
      source: 'coding:sidecar-verifier',
      message: expect.stringContaining('reconciled'),
    }));
    expect(todoStore.autoCompleteOnAccept).not.toHaveBeenCalled();
  });

  it('revise → todoStore.markInProgressFailed + sets pendingFailedResetRef', async () => {
    const recorder = makeRecorder();
    const observer = makeObserver();
    const todoStore = makeTodoStore();
    const pendingFailedResetRef = { current: false };
    await applySidecarVerdictToRecorder({
      recorder,
      observer,
      todoStore,
      pendingFailedResetRef,
      verdict: { verdict: 'revise', reason: 'fix X', trace: 'verifier_ok' },
    });
    expect(todoStore.markInProgressFailed).toHaveBeenCalled();
    expect(pendingFailedResetRef.current).toBe(true);
    expect(todoStore.autoCompleteOnAccept).not.toHaveBeenCalled();
  });

  it('blocked → no todoStore side effect (terminal state preserves list)', async () => {
    const recorder = makeRecorder();
    const observer = makeObserver();
    const todoStore = makeTodoStore();
    await applySidecarVerdictToRecorder({
      recorder,
      observer,
      todoStore,
      verdict: { verdict: 'blocked', reason: 'cannot resolve', trace: 'verifier_ok' },
    });
    expect(todoStore.autoCompleteOnAccept).not.toHaveBeenCalled();
    expect(todoStore.markInProgressFailed).not.toHaveBeenCalled();
  });

  it('does not crash when todoStore is undefined', async () => {
    const recorder = makeRecorder();
    const observer = makeObserver();
    await applySidecarVerdictToRecorder({
      recorder,
      observer,
      verdict: { verdict: 'accept', reason: '', trace: 'verifier_ok' },
    });
    expect(recorder.verdict?.payload.verdict?.status).toBe('accept');
  });

  it.each([0, 95])(
    'does not announce budget approval for a blocked verdict at spentBudget=%i',
    async (spentBudget) => {
      const observer = makeObserver();
      const askUser = vi.fn().mockResolvedValue('continue');
      const budget: ManagedTaskBudgetController = {
        totalBudget: 100,
        spentBudget,
        currentHarness: 'H0_DIRECT',
      };

      await applySidecarVerdictToRecorder({
        recorder: makeRecorder(),
        observer,
        verdict: {
          verdict: 'blocked',
          reason: 'Need the target API version.',
          trace: 'verifier_ok',
        },
        budget,
        budgetExtension: makeBudgetExtension(askUser),
      });

      expect(observer.notifyBudgetApprovalRequest).not.toHaveBeenCalled();
      expect(askUser).not.toHaveBeenCalled();
    },
  );

  it('does not announce budget approval for revise below threshold', async () => {
    const observer = makeObserver();
    const askUser = vi.fn().mockResolvedValue('continue');
    const budget: ManagedTaskBudgetController = {
      totalBudget: 100,
      spentBudget: 0,
      currentHarness: 'H0_DIRECT',
    };

    await applySidecarVerdictToRecorder({
      recorder: makeRecorder(),
      observer,
      verdict: {
        verdict: 'revise',
        reason: 'Add the requested deployment comparison.',
        trace: 'verifier_ok',
      },
      budget,
      budgetExtension: makeBudgetExtension(askUser),
    });

    expect(observer.notifyBudgetApprovalRequest).not.toHaveBeenCalled();
    expect(askUser).not.toHaveBeenCalled();
  });

  it('does not announce a duplicate approval request at the current budget tier', async () => {
    const observer = makeObserver();
    const askUser = vi.fn().mockResolvedValue('continue');
    const budget: ManagedTaskBudgetController = {
      totalBudget: 100,
      spentBudget: 95,
      currentHarness: 'H0_DIRECT',
      lastApprovalBudgetTotal: 100,
    };

    await applySidecarVerdictToRecorder({
      recorder: makeRecorder(),
      observer,
      verdict: {
        verdict: 'revise',
        reason: 'Add the requested deployment comparison.',
        trace: 'verifier_ok',
      },
      budget,
      budgetExtension: makeBudgetExtension(askUser),
    });

    expect(observer.notifyBudgetApprovalRequest).not.toHaveBeenCalled();
    expect(askUser).not.toHaveBeenCalled();
  });

  it('announces budget approval immediately before an eligible revise prompt', async () => {
    const observer = makeObserver();
    const askUser = vi.fn().mockResolvedValue('continue');
    const budget: ManagedTaskBudgetController = {
      totalBudget: 100,
      spentBudget: 90,
      currentHarness: 'H0_DIRECT',
    };

    await applySidecarVerdictToRecorder({
      recorder: makeRecorder(),
      observer,
      verdict: {
        verdict: 'revise',
        reason: 'Add the requested deployment comparison.',
        trace: 'verifier_ok',
      },
      budget,
      budgetExtension: makeBudgetExtension(askUser),
    });

    expect(observer.notifyBudgetApprovalRequest).toHaveBeenCalledOnce();
    expect(askUser).toHaveBeenCalledOnce();
  });
});
