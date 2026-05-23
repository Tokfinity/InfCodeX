/**
 * FEATURE_190 (v0.7.43) Phase 1 — text-only termination canonical-path tests.
 *
 * Ratifies that the existing agent-runtime + coding primitives correctly
 * handle Worker/Generator text-only termination as the canonical V2
 * exit path under the F184 Sidecar Verifier architecture.
 *
 * Why these tests exist: F184 v0.7.45 retired the in-chain Evaluator
 * (Generator/Worker `handoffs = []` terminal). FEATURE_190 Phase 2a
 * rewrote the Worker prompt for text-only termination and Phase 3
 * deleted the `emit_handoff` tool surface. This suite ratifies that
 * the runtime side correctly handles the "no emit_handoff, just a final
 * text message" canonical path:
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
 *
 * These pins prevent silent regressions during Phase 2/3 — if any
 * primitive accidentally requires `recorder.handoff` to be populated to
 * function, the corresponding test here will fail.
 *
 * FEATURE_190 follow-up (post-F193): the `continuationSuggested`
 * derivation describe block was deleted — the field has been removed
 * from `KodaXOrchestrationVerdict` / `KodaXManagedTaskVerdict` public
 * types. Sidecar Verifier owns the continuation decision via
 * `disposition` + `signal` (see `artifacts.ts:writeManagedTaskArtifacts`).
 *
 * FEATURE_193 (v0.7.43): the legacy "recorder.handoff blocked surfaces
 * BLOCKED" pin was retired — `recorder.handoff` slot deleted alongside
 * the `emit_handoff` tool. The pin's replacement asserts the new V2
 * contract: text-only termination with no verdict slot resolves to
 * COMPLETE; BLOCKED only via Sidecar Verifier verdict.
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

  it('FEATURE_193 (v0.7.43): recorder.handoff blocked fallback retired — empty recorder always returns signal:COMPLETE', () => {
    // FEATURE_193 removed `emit_handoff` and the `recorder.handoff` slot
    // (Generator role retired). The legacy Phase-3-deferred fallback —
    // "Generator-level blocker → signal:BLOCKED via recorder.handoff" —
    // is now dead. On V2 only `recorder.verdict` (Sidecar Verifier
    // bridge) can surface BLOCKED; a Worker text-only termination with
    // no verdict slot resolves to COMPLETE.
    const result = deriveFinalStatus({});
    expect(result.signal).toBe('COMPLETE');
    expect(result.verdictStatus).toBeUndefined();
    expect(result.reason).toBeUndefined();
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

// FEATURE_190 follow-up (post-F193): `continuationSuggested` derivation
// describe block removed — the field was deleted from
// `KodaXOrchestrationVerdict` / `KodaXManagedTaskVerdict` public types.
// Sidecar Verifier owns the continuation decision; see
// `artifacts.ts:writeManagedTaskArtifacts` for the disposition-based
// derivation that replaced it.
