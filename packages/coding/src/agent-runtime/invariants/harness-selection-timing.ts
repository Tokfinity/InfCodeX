/**
 * FEATURE_106 invariant: `harnessSelectionTiming` — V2 no-op shell.
 *
 * FEATURE_193 (v0.7.43): V1 Scout role retired. The original predicate
 * gated multi-file mutations on a Scout-emitted `confirmedHarness` slot;
 * with Scout gone, `recorder.scout` is never populated on V2 and the
 * predicate would emit `warn` on every multi-file run. To avoid
 * background noise in telemetry without disturbing the agent-package
 * admission framework (the `'harnessSelectionTiming'` invariant id +
 * audit array are pre-1.0 SDK surface), this file keeps the export
 * shape but neutralizes the predicate to always admit.
 *
 * The V2 successor — `planBeforeMutate` — is registered alongside
 * `harnessSelectionTiming` in `CODING_INVARIANTS` and covers the
 * structural "plan-first" observation on the V2 Worker single loop.
 *
 * v0.7.35.1 FEATURE_142 (A-R2) provenance note: moved from
 * `@kodax-ai/agent/src/admission/invariants/` back to
 * `@kodax-ai/coding/src/agent-runtime/invariants/` per ADR-021 — the
 * universal `@kodax-ai/agent` admission framework must not enumerate
 * coding-AMA field names. With FEATURE_193 this file no longer reads
 * coding-AMA fields at all (no-op), but the ADR-021 boundary is
 * preserved by keeping the registration in the coding package.
 */

import type {
  InvariantResult,
  ObserveCtx,
  QualityInvariant,
  RunnerEvent,
} from '@kodax-ai/agent';

function observe(_event: RunnerEvent, _ctx: ObserveCtx): InvariantResult {
  // FEATURE_193 (v0.7.43): V2 no-op. The V1 predicate read
  // `ctx.recorder.scout?.payload?.scout?.confirmedHarness` to gate
  // multi-file mutations on a Scout harness verdict; Scout retirement
  // makes that read permanently undefined. Returning `{ ok: true }`
  // unconditionally keeps the invariant registered without emitting
  // warnings.
  return { ok: true };
}

export const harnessSelectionTiming: QualityInvariant = {
  id: 'harnessSelectionTiming',
  description:
    'FEATURE_193 V2 no-op shell — predicate always admits since V1 Scout retired. Kept registered for admission-framework / audit-array compat.',
  observe,
};
