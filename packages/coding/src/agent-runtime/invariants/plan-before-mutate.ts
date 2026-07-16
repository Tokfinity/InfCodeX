/**
 * FEATURE_114 v0.7.36 invariant: `planBeforeMutate`.
 *
 * V2 replacement for `harnessSelectionTiming` (which gated on the
 * legacy Scout-emitted `confirmedHarness` value — irrelevant once the
 * 4→2 role merge collapses Scout into Worker).
 *
 * Predicate: when a `mutation_recorded` event fires for the Worker,
 * the recorder MUST already have observed at least one
 * `todo_update` call (the plan commit). If not, the Worker walked
 * straight to a write/edit without committing a plan and without
 * declaring the task trivial — emit a `warn`-severity invariant
 * result so the deviation shows up in admission telemetry.
 *
 * Severity is `warn`, not `reject`: trivial single-line mutations
 * legitimately skip the plan ceremony, and we don't want to abort
 * the run. The plan-first nudge (`runner-nudges.ts`) and the Worker
 * system prompt enforce the soft contract; this invariant is the
 * observability check.
 *
 * Reads `recorder.todoUpdateCount` (added v0.7.36 to the recorder
 * context) — the Runner increments it on every `todo_update` call.
 * When the field is missing (e.g. test fixtures that don't wire the
 * recorder), the invariant is a no-op. FEATURE_193 (v0.7.43) retired
 * the V1 path that didn't write this field; on V2 the field is always
 * populated by the Worker.
 */

import type {
  InvariantResult,
  ObserveCtx,
  QualityInvariant,
  RunnerEvent,
} from '@kodax-ai/agent';

function observe(event: RunnerEvent, ctx: ObserveCtx): InvariantResult {
  if (event.kind !== 'mutation_recorded') return { ok: true };

  const recorder = ctx.recorder as {
    todoUpdateCount?: number;
    workerTrivialDeclaration?: boolean;
  };
  // Field absent → legacy V1 run; defer to harnessSelectionTiming
  // and stay silent here.
  if (typeof recorder.todoUpdateCount !== 'number') {
    return { ok: true };
  }
  if (recorder.todoUpdateCount > 0) return { ok: true };
  if (recorder.workerTrivialDeclaration === true) return { ok: true };

  return {
    ok: false,
    severity: 'warn',
    reason: `planBeforeMutate: Worker mutated ${event.file} without a prior todo_update plan commit and without a trivial declaration`,
  };
}

export const planBeforeMutate: QualityInvariant = {
  id: 'planBeforeMutate',
  description:
    'Worker mutations should be preceded by a todo_update plan commit (or an explicit trivial declaration). Missing plan is a warn-only signal in v0.7.36.',
  observe,
};
