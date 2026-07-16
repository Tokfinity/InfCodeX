/**
 * FEATURE_101 × FEATURE_106 joint integration test (v0.7.31 Phase 2.1+2.2).
 *
 * FEATURE_193 (v0.7.43): the FEATURE_106 invariant
 * (`harnessSelectionTiming`) is now a permanent no-op shell on V2 —
 * V1 Scout retirement made its `recorder.scout.payload.scout
 * .confirmedHarness` precondition permanently undefined. The integration
 * surface still composes (registration + binding) so these tests
 * survive as the no-op contract pin.
 *
 * Verifies that the admission contract runtime (FEATURE_101) and the
 * neutralized AMA harness calibration (FEATURE_106) compose
 * end-to-end:
 *
 *   1. `registerCodingInvariants()` bootstraps the full v1 closed set
 *      (4 core pure + 3 coding capability-coupled = 7 invariant ids
 *      + FEATURE_106 external harnessSelectionTiming = 8 total;
 *      FEATURE_184 Phase C.1 v0.7.45 removed independentReview —
 *      superseded by Sidecar Verifier StopHook).
 *
 *   2. `Runner.admit()` accepts a Scout-shaped manifest under default
 *      caps and produces an `AdmittedHandle` whose `invariantBindings`
 *      include the harness-timing invariant when declared.
 *
 *   3. `harnessSelectionTiming.observe` always admits on V2 — the
 *      multi-file `mutation_recorded` "warn" path was retired with
 *      Scout (FEATURE_193). Tests pin the no-op contract.
 *
 *   4. The scope-aware-harness Guardrail (FEATURE_106 Slice 1) and
 *      this invariant (Slice 3) are independent — the Guardrail acts
 *      on tool results, the invariant observes runner events. Both
 *      remain wired after a single bootstrap call.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  Runner,
  _resetInvariantRegistry,
  createAgent,
  getInvariant,
  listRegisteredInvariants,
} from '@kodax-ai/agent';
import type {
  AgentManifest,
  ObserveCtx,
  RunnerEvent,
  SystemCap,
} from '@kodax-ai/agent';

import { registerCodingInvariants } from './index.js';

const SYS_CAP: SystemCap = {
  maxBudget: 200,
  maxIterations: 200,
  allowedToolCapabilities: ['read', 'edit', 'bash:test'],
};

// Matches @kodax-ai/core/admission.ts §ReadonlyMutationTracker.
function emptyTracker(): ObserveCtx['mutationTracker'] {
  return { files: new Set<string>(), totalOps: 0 };
}

function obsCtx(
  manifest: AgentManifest,
  recorder: ObserveCtx['recorder'] = {},
): ObserveCtx {
  return {
    manifest,
    mutationTracker: emptyTracker(),
    recorder,
  };
}

describe('FEATURE_101 × FEATURE_106 — joint registration + observe wiring', () => {
  beforeEach(() => {
    _resetInvariantRegistry();
    registerCodingInvariants();
  });
  afterEach(() => _resetInvariantRegistry());

  it('registerCodingInvariants brings up the full v1+v2 set including harnessSelectionTiming and planBeforeMutate', () => {
    const ids = listRegisteredInvariants();
    expect(ids).toContain('harnessSelectionTiming');
    expect(ids).toContain('planBeforeMutate');
    // 8 ids = 6 admission v1 closed set (FEATURE_184 Phase C.1 v0.7.45:
    // independentReview removed — superseded by Sidecar Verifier StopHook)
    // + FEATURE_106 external (harnessSelectionTiming) + FEATURE_114 V2
    // external (planBeforeMutate). The two externals coexist during the
    // V1↔V2 migration window.
    expect(ids).toHaveLength(8);
  });

  it('Runner.admit binds harnessSelectionTiming when manifest declares it', async () => {
    const manifest: AgentManifest = {
      ...createAgent({ name: 'scout-like', instructions: 'classify' }),
      declaredInvariants: ['harnessSelectionTiming'],
    };
    const verdict = await Runner.admit(manifest, { systemCap: SYS_CAP });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.handle.invariantBindings).toContain('harnessSelectionTiming');
    }
  });

  it('harnessSelectionTiming.observe admits multi-file mutations on V2 (FEATURE_193 — V1 warn path neutralized)', () => {
    // FEATURE_193 (v0.7.43): V1 predicate read `recorder.scout.payload.scout
    // .confirmedHarness` to gate multi-file mutations; Scout retirement
    // makes the slot permanently undefined, so the body was rewritten to
    // a no-op. This test pins the V2 admit contract — V1 expected `warn`
    // here, V2 expects unconditional admit.
    const inv = getInvariant('harnessSelectionTiming');
    expect(inv).toBeDefined();
    expect(inv?.observe).toBeDefined();

    const manifest = createAgent({ name: 'scout-like', instructions: 'classify' });
    const event: RunnerEvent = {
      kind: 'mutation_recorded',
      file: 'packages/api/src/handlers/auth.ts',
      fileCount: 4,
    };
    const result = inv!.observe!(event, obsCtx(manifest));
    expect(result.ok).toBe(true);
  });

  it('harnessSelectionTiming.observe stays silent when Scout has committed to H1 (calibration successful)', () => {
    const inv = getInvariant('harnessSelectionTiming');
    expect(inv).toBeDefined();
    const manifest = createAgent({ name: 'scout-like', instructions: 'classify' });
    const recorder: ObserveCtx['recorder'] = {
      scout: { payload: { scout: { confirmedHarness: 'H1_EXECUTE_EVAL' } } },
    };
    const event: RunnerEvent = {
      kind: 'mutation_recorded',
      file: 'packages/api/src/handlers/auth.ts',
      fileCount: 4,
    };
    const result = inv!.observe!(event, obsCtx(manifest, recorder));
    expect(result.ok).toBe(true);
  });

  it('harnessSelectionTiming.observe ignores single-file mutations regardless of harness commitment', () => {
    const inv = getInvariant('harnessSelectionTiming');
    expect(inv).toBeDefined();
    const manifest = createAgent({ name: 'scout-like', instructions: 'classify' });
    const event: RunnerEvent = {
      kind: 'mutation_recorded',
      file: 'a.ts',
      fileCount: 1,
    };
    expect(inv!.observe!(event, obsCtx(manifest)).ok).toBe(true);
  });

  it('Guardrail Slice 1 + invariant Slice 3 share registration but are independent contracts', () => {
    // Slice 3 (this invariant) is registered.
    expect(getInvariant('harnessSelectionTiming')).toBeDefined();
    // Slice 1 (the guardrail) is not in the invariant registry — it
    // lives at the Guardrail layer (run-scoped). The two are wired
    // through different runtimes; both are exercised in
    // `scope-aware-harness-guardrail.integration.test.ts`. This test
    // confirms they don't accidentally collide on the same id.
    expect(listRegisteredInvariants()).not.toContain('scope-aware-harness');
  });
});
