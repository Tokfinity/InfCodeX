/**
 * Pure-new invariant implementations bundled with @kodax-ai/agent.
 *
 * The admission contract types live in `../admission.ts`; the registry
 * runtime in `../admission-runtime.ts`. This module exports the three
 * invariant declarations plus a `registerCoreInvariants()` helper that
 * registers them in one call.
 *
 * Why this split:
 *   - These three (finalOwner, handoffLegality, evidenceTrail) are pure
 *     functions of the admission types — they have NO @kodax-ai/coding
 *     dependencies. Living in @kodax-ai/agent keeps the dependency direction
 *     clean and lets `Runner.admit` unit-test against real invariants
 *     without pulling the coding runtime into the test harness.
 *   - The four coupled invariants (budgetCeiling, toolPermission,
 *     boundedRevise, independentReview) wrap @kodax-ai/coding capabilities
 *     (mutation tracker, budget controller, ToolGuardrail tier resolver)
 *     and live in `@kodax-ai/coding/src/agent-runtime/invariants/`.
 *   - `harnessSelectionTiming` (FEATURE_106 external) was here in
 *     v0.7.31; v0.7.35.1 FEATURE_142 (A-R2) moved it back to
 *     `@kodax-ai/coding/src/agent-runtime/invariants/` because its body
 *     hardcoded `ctx.recorder.scout.payload.scout.confirmedHarness` —
 *     a coding-AMA Scout-role field reference (ADR-021).
 *
 * Registration is NOT side-effecting on import — consumers call
 * `registerCoreInvariants()` explicitly so test isolation
 * (`_resetInvariantRegistry()` followed by registering only the subset
 * a test needs) stays predictable.
 */

import { registerInvariant } from '../admission-runtime.js';
import type { QualityInvariant } from '../admission.js';
import { evidenceTrail } from './evidence-trail.js';
import { finalOwner } from './final-owner.js';
import { handoffLegality } from './handoff-legality.js';

export { evidenceTrail, finalOwner, handoffLegality };

/**
 * The three pure invariants @kodax-ai/agent ships, in registration order.
 * Exposed as a constant so consumers can introspect the set without
 * registering (e.g. dispatch-eval metric setup that wants id labels).
 */
export const CORE_INVARIANTS: readonly QualityInvariant[] = [
  finalOwner,
  handoffLegality,
  evidenceTrail,
];

/**
 * Register the three pure-new invariants on the shared runtime registry.
 * Idempotent only when paired with `_resetInvariantRegistry()` first —
 * `registerInvariant` itself throws on duplicate registration, which is
 * the desired contract (silent overwrite would mask refactors).
 */
export function registerCoreInvariants(): void {
  for (const inv of CORE_INVARIANTS) {
    registerInvariant(inv);
  }
}
