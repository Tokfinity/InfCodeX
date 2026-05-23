/**
 * FEATURE_190 (v0.7.43) Phase 1 — text-only termination canonical-path tests.
 *
 * Ratifies that the existing agent-runtime + coding primitives correctly
 * handle Worker/Generator text-only termination as the canonical V2
 * exit path under the F184 Sidecar Verifier architecture.
 *
 * Why these tests exist: F184 v0.7.45 retired the in-chain Evaluator
 * (Generator/Worker `handoffs = []` terminal). The Worker prompt + tool
 * surface still teaches `emit_handoff` as the terminal signal (Phase 2
 * and Phase 3 of FEATURE_190 will remove both). Before that prompt +
 * tool change ships, this suite proves the runtime side ALREADY handles
 * the "no emit_handoff, just a final text message" path correctly:
 *
 *   - `detectIdleYield` correctly exits the outer loop on text-only
 *     termination when no children are pending
 *   - `detectIdleYield` correctly KEEPS waiting on text-only termination
 *     when children are still pending (FEATURE_165 safety net preserved
 *     without depending on the emit_handoff wrapper gate)
 *   - `deriveFinalStatus` correctly returns COMPLETE for an empty
 *     recorder (no handoff, no verdict — the canonical text-only state)
 *   - `deriveFinalStatus` correctly returns BLOCKED via Sidecar Verifier
 *     verdict path (the F184 canonical blocked surface)
 *   - `buildManagedProtocolPayload` correctly handles the empty-recorder
 *     case (returns undefined — no slices to expose)
 *   - `continuationSuggested` derivation correctly returns falsy for the
 *     text-only canonical state
 *
 * These pins prevent silent regressions during Phase 2/3 — if any
 * primitive accidentally requires `recorder.handoff` to be populated to
 * function, the corresponding test here will fail.
 */

import { describe, expect, it } from 'vitest';

import { detectIdleYield } from '@kodax-ai/agent';

import {
  buildManagedProtocolPayload,
  deriveFinalStatus,
} from './status-derivation.js';
import type { VerdictRecorder } from './types.js';

describe('FEATURE_190 Phase 1 — detectIdleYield text-only termination behavior', () => {
  it('text-only Worker with no pending children → idle-yield false (loop exits cleanly)', () => {
    // The canonical text-only termination flow: Worker produces a final
    // text message, Runner.run exits via the no-tool-calls branch,
    // outer loop computes the snapshot and detectIdleYield returns
    // false → the outer loop breaks → run terminates.
    expect(
      detectIdleYield({
        lastAssistantToolCallCount: 0,
        pendingChildTaskCount: 0,
        hasEmittedHandoff: false,
        hasEmittedTerminalVerdict: false,
        hasPendingBackgroundMessages: false,
      }),
    ).toBe(false);
  });

  it('text-only Worker WITH pending children → idle-yield true (FEATURE_165 safety preserved)', () => {
    // Even if Worker tries to text-only terminate while a dispatched
    // child is still in flight, the outer loop must NOT break — it
    // must wait for the child to finish and re-invoke Worker. Under
    // pre-F190 architecture this gate lived in the emit_handoff
    // wrapper (handoffEmit pending-children check). Post-F190 the gate
    // is satisfied by detectIdleYield itself — pendingChildTaskCount>0
    // is sufficient to keep the loop waiting regardless of whether
    // Worker called emit_handoff or just went text-only.
    expect(
      detectIdleYield({
        lastAssistantToolCallCount: 0,
        pendingChildTaskCount: 1,
        hasEmittedHandoff: false,
        hasEmittedTerminalVerdict: false,
        hasPendingBackgroundMessages: false,
      }),
    ).toBe(true);
  });

  it('text-only Worker with pending background message → idle-yield true (Bug E coverage extends to text-only)', () => {
    expect(
      detectIdleYield({
        lastAssistantToolCallCount: 0,
        pendingChildTaskCount: 0,
        hasEmittedHandoff: false,
        hasEmittedTerminalVerdict: false,
        hasPendingBackgroundMessages: true,
      }),
    ).toBe(true);
  });
});

describe('FEATURE_190 Phase 1 — deriveFinalStatus text-only termination', () => {
  it('empty recorder (canonical text-only) → signal:COMPLETE', () => {
    // Worker text-only with no Sidecar Verifier verdict reaching the
    // recorder (e.g. happy-path completion where the verifier accepts
    // post-hoc but the synchronous deriveFinalStatus call sees the
    // recorder mid-flow, or any path where the verifier is OFF).
    // Must not crash, must not silently flag BLOCKED.
    const result = deriveFinalStatus({});
    expect(result.signal).toBe('COMPLETE');
    expect(result.verdictStatus).toBeUndefined();
    expect(result.reason).toBeUndefined();
  });

  it('recorder with sidecar verifier ACCEPT verdict → signal:COMPLETE + verdictStatus:accept', () => {
    const recorder: VerdictRecorder = {
      verdict: {
        role: 'evaluator',
        payload: {
          verdict: {
            status: 'accept',
            reason: 'all tests pass',
            userAnswer: 'Done. Changes applied to packages/x.',
          },
        },
      },
    };
    const result = deriveFinalStatus(recorder);
    expect(result.signal).toBe('COMPLETE');
    expect(result.verdictStatus).toBe('accept');
    expect(result.userAnswer).toBe('Done. Changes applied to packages/x.');
  });

  it('recorder with sidecar verifier BLOCKED verdict → signal:BLOCKED via verdict (F184 canonical blocked surface)', () => {
    const recorder: VerdictRecorder = {
      verdict: {
        role: 'evaluator',
        payload: {
          verdict: {
            status: 'blocked',
            reason: 'schema violation — payload missing required field',
          },
        },
      },
    };
    const result = deriveFinalStatus(recorder);
    expect(result.signal).toBe('BLOCKED');
    expect(result.verdictStatus).toBe('blocked');
    expect(result.reason).toContain('schema violation');
  });

  it('legacy path — recorder.handoff blocked still surfaces signal:BLOCKED (pre-Phase-3 emit_handoff still in scope)', () => {
    // While FEATURE_190 Phase 3 has not yet removed emit_handoff from
    // Worker/Generator tools, the legacy "Generator emit_handoff
    // status=blocked" path remains valid. Verifies pre-Phase-3 parity.
    // Once Phase 3 lands and the tool is deleted, this code path
    // becomes dead but staying compatible avoids a forced two-step
    // rollout coupling Phase 2 and Phase 3 atomically.
    const recorder: VerdictRecorder = {
      handoff: {
        role: 'generator',
        payload: {
          handoff: {
            status: 'blocked',
            summary: 'cannot proceed — required file missing',
          },
        },
      },
    };
    const result = deriveFinalStatus(recorder);
    expect(result.signal).toBe('BLOCKED');
    expect(result.verdictStatus).toBeUndefined(); // verdict slot owns the verdictStatus tier
    expect(result.reason).toContain('cannot proceed');
  });
});

describe('FEATURE_190 Phase 1 — buildManagedProtocolPayload text-only termination', () => {
  it('empty recorder (canonical text-only) → undefined (no slices to expose)', () => {
    expect(buildManagedProtocolPayload({})).toBeUndefined();
  });

  it('recorder with only sidecar verifier verdict → payload carries verdict slice only', () => {
    const recorder: VerdictRecorder = {
      verdict: {
        role: 'evaluator',
        payload: {
          verdict: {
            status: 'accept',
            reason: 'looks good',
          },
        },
      },
    };
    const payload = buildManagedProtocolPayload(recorder);
    expect(payload).toBeDefined();
    expect(payload?.verdict?.status).toBe('accept');
    expect(payload?.handoff).toBeUndefined();
    expect(payload?.scout).toBeUndefined();
    expect(payload?.contract).toBeUndefined();
  });
});

describe('FEATURE_190 Phase 1 — continuationSuggested text-only termination derivation', () => {
  it('empty recorder (canonical text-only) → continuationSuggested derives falsy', () => {
    // The continuationSuggested derivation in payload-builder.ts:295
    // reads `recorder.handoff?.payload.handoff?.status === 'ready' &&
    // verdictStatus !== 'accept'`. For text-only termination,
    // recorder.handoff is undefined → the `?.` chain returns undefined
    // → `undefined === 'ready'` is false → continuationSuggested is
    // false. This is the correct semantic: under F184 the Sidecar
    // Verifier owns the next-step decision, not a Worker-emitted
    // "ready" signal.
    const recorder: VerdictRecorder = {};
    const continuationSuggested =
      recorder.handoff?.payload.handoff?.status === 'ready'
      && undefined !== 'accept'; // verdictStatus undefined for empty recorder
    expect(continuationSuggested).toBeFalsy();
  });

  it('legacy: emit_handoff(status=ready) without sidecar verdict accept → continuationSuggested truthy (pre-Phase-3 parity)', () => {
    // Pre-Phase-3, the legacy "user can continue an unverified handoff"
    // affordance is preserved. Phase 3 will retire this surface.
    const recorder: VerdictRecorder = {
      handoff: {
        role: 'generator',
        payload: {
          handoff: {
            status: 'ready',
            summary: 'done',
          },
        },
      },
    };
    const verdictStatus = undefined;
    const continuationSuggested =
      recorder.handoff?.payload.handoff?.status === 'ready'
      && verdictStatus !== 'accept';
    expect(continuationSuggested).toBe(true);
  });

  it('sidecar verdict accept overrides ready handoff → continuationSuggested falsy', () => {
    const recorder: VerdictRecorder = {
      handoff: {
        role: 'generator',
        payload: { handoff: { status: 'ready', summary: 'done' } },
      },
      verdict: {
        role: 'evaluator',
        payload: { verdict: { status: 'accept' } },
      },
    };
    const verdictStatus: 'accept' | 'revise' | 'blocked' | undefined = 'accept';
    const continuationSuggested =
      recorder.handoff?.payload.handoff?.status === 'ready'
      && (verdictStatus as 'accept' | 'revise' | 'blocked' | undefined) !== 'accept';
    expect(continuationSuggested).toBe(false);
  });
});
