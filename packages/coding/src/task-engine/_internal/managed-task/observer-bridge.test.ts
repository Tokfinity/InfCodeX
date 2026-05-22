import { describe, expect, it, vi } from 'vitest';

import type { KodaXEvents, KodaXManagedTaskStatus, KodaXTaskRole } from '../../../types.js';
import type { ManagedTaskBudgetController } from './budget.js';
import { buildObserverBridge, NULL_OBSERVER } from './observer-bridge.js';

/**
 * Scaffolding to invoke `buildObserverBridge` for the surface-contract
 * assertions below. The full event-shape coverage lives in
 * `runner-driven.test.ts`; this file pins the FEATURE_184 Phase D.3
 * `sidecarStarted` contract end-to-end (10/10 buildObserverBridge
 * parameters wired, including the optional `checkpointWriter`).
 */
function makeBridgeHarness() {
  const statuses: KodaXManagedTaskStatus[] = [];
  const events: KodaXEvents = {
    onManagedTaskStatus: (s) => {
      statuses.push(s);
    },
  };
  const budget: ManagedTaskBudgetController = {
    totalBudget: 100,
    spentBudget: 0,
    currentHarness: 'H2_PLAN_EXECUTE_EVAL',
  };
  const checkpointWriter = vi.fn<(role: KodaXTaskRole) => void>();
  const bridge = buildObserverBridge(
    events,
    { current: 'H2_PLAN_EXECUTE_EVAL' },
    { emitted: [] },
    budget,
    { current: 3 },
    { current: 6 },
    { current: false },
    { items: [] },
    { current: 'session-abc' },
    checkpointWriter,
  );
  return { bridge, statuses, checkpointWriter };
}

describe('observer-bridge — FEATURE_184 Phase D.3 sidecarStarted', () => {
  it('emits a `phase: "verifying"` status when the sidecar verifier kicks off', () => {
    const { bridge, statuses, checkpointWriter } = makeBridgeHarness();

    bridge.sidecarStarted();

    expect(statuses).toHaveLength(1);
    const ev = statuses[0]!;
    expect(ev.phase).toBe('verifying');
    expect(ev.note).toBe('Verifying agent output');
    expect(ev.persistToHistory).toBe(false);
    // Inherits the per-emit envelope so the REPL can still render
    // round/budget/harness context next to the spinner.
    expect(ev.agentMode).toBe('ama');
    expect(ev.harnessProfile).toBe('H2_PLAN_EXECUTE_EVAL');
    expect(ev.upgradeCeiling).toBe('H2_PLAN_EXECUTE_EVAL');
    expect(ev.currentRound).toBe(3);
    expect(ev.maxRounds).toBe(6);
    // sidecarStarted is a pure UI label flip (same shape as
    // agentSwitched / idleWaiting). It must NOT write checkpoints —
    // those are slot-emit anchored, not transient REPL state.
    expect(checkpointWriter).not.toHaveBeenCalled();
  });

  it('does not throw when the consumer did not register onManagedTaskStatus', () => {
    const bridge = buildObserverBridge(
      undefined,
      { current: 'H2_PLAN_EXECUTE_EVAL' },
      { emitted: [] },
      { totalBudget: 100, spentBudget: 0, currentHarness: 'H2_PLAN_EXECUTE_EVAL' },
      { current: 1 },
      { current: 6 },
      { current: false },
      { items: [] },
      { current: undefined },
    );

    expect(() => bridge.sidecarStarted()).not.toThrow();
  });

  it('NULL_OBSERVER provides a no-op sidecarStarted so chain-only paths do not throw', () => {
    // Mirrors the FEATURE_166 `agentSwitched` pin: any structural change
    // to ObserverBridge must keep NULL_OBSERVER total — without the
    // no-op, `runner-driven.ts` paths that fall through to NULL_OBSERVER
    // (test fixtures + chain-only topology tests) would crash with
    // `undefined is not a function`.
    expect(typeof NULL_OBSERVER.sidecarStarted).toBe('function');
    expect(() => NULL_OBSERVER.sidecarStarted()).not.toThrow();
  });
});

describe('observer-bridge — sidecarFinished (Phase D.3 follow-up, opt-in log)', () => {
  it('emits a persisted `phase: "worker"` summary note with verdict + model + elapsed + trace', () => {
    const { bridge, statuses, checkpointWriter } = makeBridgeHarness();

    bridge.sidecarFinished({
      verdict: 'accept',
      providerName: 'anthropic',
      model: 'claude-sonnet-4-6',
      source: 'inherit-main',
      elapsedMs: 3214,
      trace: 'verifier_ok',
    });

    expect(statuses).toHaveLength(1);
    const ev = statuses[0]!;
    // 'worker' (not a new union value) — log line is observability only.
    expect(ev.phase).toBe('worker');
    // persistToHistory MUST be true — log line is durable evidence.
    expect(ev.persistToHistory).toBe(true);
    // Note carries the four user-visible facts (verdict + provider/model +
    // elapsedMs + trace) so users can confirm sidecar fired post-hoc.
    expect(ev.note).toContain('[Sidecar Verifier]');
    expect(ev.note).toContain('accept');
    expect(ev.note).toContain('anthropic/claude-sonnet-4-6');
    expect(ev.note).toContain('(inherit)');
    expect(ev.note).toContain('3214ms');
    expect(ev.note).toContain('verifier_ok');
    // sidecarFinished is observer-layer only — no recorder mutation,
    // no checkpoint side-effect (those are slot-emit anchored).
    expect(checkpointWriter).not.toHaveBeenCalled();
  });

  it('labels env-override verifier as `(env)` so users can tell apart inherit vs cross-family', () => {
    const { bridge, statuses } = makeBridgeHarness();

    bridge.sidecarFinished({
      verdict: 'revise',
      providerName: 'anthropic',
      model: 'claude-opus-4-7',
      source: 'explicit-env',
      elapsedMs: 5400,
      trace: 'verifier_ok',
    });

    expect(statuses[0]!.note).toContain('(env)');
  });

  it('renders undefined model as `(default)` so user sees the provider default explicitly', () => {
    // Regression pin for FEATURE_187 Phase B follow-up: when no specific
    // model is configured (caller passes undefined per the verifier /
    // stall resolver `model: string | undefined` contract), the log line
    // shows `(default)` rather than the literal string "undefined". This
    // is the common case for users who set provider but not model.
    const { bridge, statuses } = makeBridgeHarness();

    bridge.sidecarFinished({
      verdict: 'accept',
      providerName: 'anthropic',
      model: undefined,
      source: 'inherit-main',
      elapsedMs: 1200,
      trace: 'verifier_ok',
    });

    const note = statuses[0]!.note ?? '';
    expect(note).toContain('anthropic/(default)');
    expect(note).not.toContain('undefined');
  });

  it('does not throw when the consumer did not register onManagedTaskStatus', () => {
    const bridge = buildObserverBridge(
      undefined,
      { current: 'H2_PLAN_EXECUTE_EVAL' },
      { emitted: [] },
      { totalBudget: 100, spentBudget: 0, currentHarness: 'H2_PLAN_EXECUTE_EVAL' },
      { current: 1 },
      { current: 6 },
      { current: false },
      { items: [] },
      { current: undefined },
    );

    expect(() =>
      bridge.sidecarFinished({
        verdict: 'accept',
        providerName: 'anthropic',
        model: 'claude-sonnet-4-6',
        source: 'inherit-main',
        elapsedMs: 100,
        trace: 'verifier_ok',
      }),
    ).not.toThrow();
  });

  it('NULL_OBSERVER provides a no-op sidecarFinished so chain-only paths do not throw', () => {
    expect(typeof NULL_OBSERVER.sidecarFinished).toBe('function');
    expect(() =>
      NULL_OBSERVER.sidecarFinished({
        verdict: 'accept',
        providerName: 'anthropic',
        model: 'claude-sonnet-4-6',
        source: 'inherit-main',
        elapsedMs: 100,
        trace: 'verifier_ok',
      }),
    ).not.toThrow();
  });
});
