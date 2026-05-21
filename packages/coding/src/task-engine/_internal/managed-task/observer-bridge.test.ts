import { describe, expect, it } from 'vitest';

import type { KodaXEvents, KodaXManagedTaskStatus } from '../../../types.js';
import type { ManagedTaskBudgetController } from './budget.js';
import { buildObserverBridge, NULL_OBSERVER } from './observer-bridge.js';

/**
 * Minimum scaffolding to invoke `buildObserverBridge` for the
 * surface-contract assertions below. We do not test the full event
 * shape here (that is covered by the integration tests in
 * `runner-driven.test.ts`); we only pin the FEATURE_184 Phase D.3
 * `sidecarStarted` contract.
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
  );
  return { bridge, statuses };
}

describe('observer-bridge — FEATURE_184 Phase D.3 sidecarStarted', () => {
  it('emits a `phase: "verifying"` status when the sidecar verifier kicks off', () => {
    const { bridge, statuses } = makeBridgeHarness();

    bridge.sidecarStarted();

    expect(statuses).toHaveLength(1);
    const ev = statuses[0]!;
    expect(ev.phase).toBe('verifying');
    expect(ev.note).toBe('Verifying agent output');
    expect(ev.persistToHistory).toBe(false);
    // Inherits the per-emit envelope so the REPL can still render
    // round/budget context next to the spinner.
    expect(ev.agentMode).toBe('ama');
    expect(ev.harnessProfile).toBe('H2_PLAN_EXECUTE_EVAL');
    expect(ev.currentRound).toBe(3);
    expect(ev.maxRounds).toBe(6);
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
