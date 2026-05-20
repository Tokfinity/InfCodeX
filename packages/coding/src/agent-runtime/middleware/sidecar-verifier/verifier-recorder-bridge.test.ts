/**
 * FEATURE_184 (v0.7.45) Phase D.2 — Sidecar verifier → recorder bridge tests.
 *
 * Pins the parity contract between the sidecar verifier's verdict and
 * the legacy Evaluator emit_verdict shape: identical recorder.verdict
 * structure, identical TodoStore side effects, identical observer
 * onRoleEmit emission.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  applySidecarVerdictToRecorder,
  buildSidecarVerdictMetadata,
  buildSidecarVerdictPayload,
} from './verifier-recorder-bridge.js';
import type { SidecarVerifierVerdict } from './verifier.js';
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
    autoCompleteOnAccept: vi.fn(),
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
