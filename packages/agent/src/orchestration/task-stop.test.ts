/**
 * Unit tests for `requestTaskStop` — the generic abort primitive
 * (FEATURE_120 v0.7.39 Phase 3a).
 *
 * Contract pinned by these tests:
 *   1. Known taskId → ok=true; controller.signal becomes aborted with
 *      the supplied reason wrapped in an Error.
 *   2. Unknown taskId → ok=false, reason='unknown-target'; queue +
 *      sibling controllers untouched.
 *   3. Already-aborted taskId → ok=false, reason='already-aborted';
 *      signal.reason is NOT overwritten (preserves first-abort cause).
 *   4. String `reason` becomes `new Error(reason)` on the signal.
 *   5. Error `reason` passes through unchanged.
 *   6. Missing `reason` → a default Error with the taskId in the
 *      message is used so the child receives a non-empty cause.
 *   7. Aborting taskId A leaves taskId B's controller untouched.
 */

import { describe, expect, it } from 'vitest';

import { requestTaskStop, type TaskAbortRegistry } from './task-stop.js';

describe('requestTaskStop — happy path', () => {
  it('aborts the registered controller and returns ok=true', () => {
    const ac = new AbortController();
    const registry: TaskAbortRegistry = new Map([['child-a', ac]]);

    const result = requestTaskStop({
      taskId: 'child-a',
      registry,
      reason: 'user cancelled task',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.taskId).toBe('child-a');
    }
    expect(ac.signal.aborted).toBe(true);
  });

  it('wraps a string reason in an Error on signal.reason', () => {
    const ac = new AbortController();
    const registry: TaskAbortRegistry = new Map([['child-a', ac]]);

    requestTaskStop({ taskId: 'child-a', registry, reason: 'budget exceeded' });

    expect(ac.signal.reason).toBeInstanceOf(Error);
    expect((ac.signal.reason as Error).message).toBe('budget exceeded');
  });

  it('passes through an Error reason verbatim', () => {
    const ac = new AbortController();
    const registry: TaskAbortRegistry = new Map([['child-a', ac]]);
    const err = new Error('domain-specific reason');

    requestTaskStop({ taskId: 'child-a', registry, reason: err });

    expect(ac.signal.reason).toBe(err);
  });

  it('uses a default Error mentioning the taskId when reason is missing', () => {
    const ac = new AbortController();
    const registry: TaskAbortRegistry = new Map([['child-a', ac]]);

    requestTaskStop({ taskId: 'child-a', registry });

    expect(ac.signal.reason).toBeInstanceOf(Error);
    expect((ac.signal.reason as Error).message).toMatch(/child-a/);
  });
});

describe('requestTaskStop — error paths', () => {
  it('returns unknown-target for an unregistered taskId', () => {
    const ac = new AbortController();
    const registry: TaskAbortRegistry = new Map([['child-a', ac]]);

    const result = requestTaskStop({
      taskId: 'child-NOPE',
      registry,
      reason: 'oops',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unknown-target');
      expect(result.taskId).toBe('child-NOPE');
    }
    expect(ac.signal.aborted).toBe(false);
  });

  it('returns already-aborted when the controller is already aborted, preserving the original signal.reason', () => {
    const ac = new AbortController();
    const originalReason = new Error('first-abort cause');
    ac.abort(originalReason);

    const registry: TaskAbortRegistry = new Map([['child-a', ac]]);

    const result = requestTaskStop({
      taskId: 'child-a',
      registry,
      reason: 'second-abort attempt',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('already-aborted');
    }
    // First-abort reason must NOT be overwritten — debugging chains
    // depend on the first cause sticking.
    expect(ac.signal.reason).toBe(originalReason);
  });
});

describe('requestTaskStop — isolation between siblings', () => {
  it('aborts only the targeted taskId, leaves siblings running', () => {
    const acA = new AbortController();
    const acB = new AbortController();
    const acC = new AbortController();
    const registry: TaskAbortRegistry = new Map([
      ['child-a', acA],
      ['child-b', acB],
      ['child-c', acC],
    ]);

    requestTaskStop({ taskId: 'child-b', registry, reason: 'off-scope' });

    expect(acA.signal.aborted).toBe(false);
    expect(acB.signal.aborted).toBe(true);
    expect(acC.signal.aborted).toBe(false);
  });
});
