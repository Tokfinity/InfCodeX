/**
 * FEATURE_106 invariant: `harnessSelectionTiming`.
 *
 * External to the FEATURE_101 admission v1 closed set — it's registered
 * to the same runtime but enforces FEATURE_106's harness calibration
 * contract (multi-file mutations must be preceded by a Scout-emitted
 * harness verdict).
 *
 * Hook:
 *   - observe(mutation_recorded) when the event reports fileCount > 1
 *     and ctx.recorder.scout.payload.scout.confirmedHarness is missing —
 *     emit a `warn` severity result. The signal is informational: it
 *     captures the case where Scout under-classified a multi-file edit
 *     as H0 and we want a dispatch-eval metric without aborting the run.
 *
 * v0.7.31 behaviour is intentionally `warn`-only: rejecting mid-run on
 * a missing harness verdict would break runs that legitimately escalate
 * after the first mutation (e.g. Generator discovers more files mid-task).
 * Once Stage 1 benchmark proves the Scout calibration is reliable, we
 * can promote to `reject` in a future release — see FEATURE_106 §Roadmap.
 *
 * Pure function. State (whether confirmedHarness is set) lives on the
 * recorder context the Runner passes in; the invariant is a stateless
 * predicate.
 *
 * v0.7.35.1 FEATURE_142 (A-R2): moved from `@kodax/agent/src/admission/
 * invariants/` back to `@kodax/coding/src/agent-runtime/invariants/`.
 * The body reads `ctx.recorder.scout.payload.scout.confirmedHarness` —
 * a hardcoded reference to coding's AMA Scout role and confirmedHarness
 * field. Per ADR-021, the universal `@kodax/agent` admission framework
 * must not enumerate coding-AMA field names; coding registers this
 * invariant via `registerCodingInvariants()`.
 */

import type {
  InvariantResult,
  ObserveCtx,
  QualityInvariant,
  RunnerEvent,
} from '@kodax/agent';

function observe(event: RunnerEvent, ctx: ObserveCtx): InvariantResult {
  if (event.kind !== 'mutation_recorded') return { ok: true };
  if (event.fileCount <= 1) return { ok: true };

  const confirmed = ctx.recorder.scout?.payload?.scout?.confirmedHarness;
  if (typeof confirmed === 'string' && confirmed.length > 0) {
    return { ok: true };
  }
  return {
    ok: false,
    severity: 'warn',
    reason: `harnessSelectionTiming: multi-file mutation (file=${event.file}, fileCount=${event.fileCount}) recorded without a Scout-emitted confirmedHarness`,
  };
}

export const harnessSelectionTiming: QualityInvariant = {
  id: 'harnessSelectionTiming',
  description:
    'Multi-file mutations should be preceded by a Scout-emitted harness verdict; missing verdict is a warn-only signal in v0.7.31.',
  observe,
};
