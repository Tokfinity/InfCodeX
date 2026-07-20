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
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: 'sink failed',
    }));
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

  it('accept → todoStore.autoCompleteOnAccept fires', async () => {
    const recorder = makeRecorder();
    const observer = makeObserver();
    const todoStore = makeTodoStore();
    await applySidecarVerdictToRecorder({
      recorder,
      observer,
      todoStore,
      verdict: { verdict: 'accept', reason: '', trace: 'verifier_ok' },
    });
    expect(todoStore.autoCompleteOnAccept).toHaveBeenCalled();
    expect(todoStore.markInProgressFailed).not.toHaveBeenCalled();
  });

  it('emits a diagnostic when the accept fallback reconciles stale open todos', async () => {
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

    expect(diagnostics).toContainEqual({
      source: 'coding:sidecar-verifier',
      level: 'debug',
      message: 'Sidecar accept reconciled 3 open Todo item(s) after the Worker terminal turn.',
      detail: { todoReconciledCount: 3 },
    });
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
});
