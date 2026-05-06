/**
 * Capability-coupled + coding-AMA-specific invariants registered by
 * @kodax/coding.
 *
 * Pairs with `@kodax/agent`'s pure-new invariants (`finalOwner`,
 * `handoffLegality`, `evidenceTrail`). Together they form the FEATURE_101
 * admission v1 closed set + FEATURE_106 external.
 *
 * Why this split:
 *
 *   - Three pure invariants (finalOwner, handoffLegality, evidenceTrail)
 *     are pure functions of admission types and live in @kodax/agent.
 *   - Four coupled invariants (budgetCeiling, toolPermission,
 *     boundedRevise, independentReview) tie into @kodax/coding's budget
 *     controller / tool registry / revise tracker / role conventions and
 *     live here.
 *   - `harnessSelectionTiming` (FEATURE_106 external) reads coding's AMA
 *     `ctx.recorder.scout.payload.scout.confirmedHarness` and lives here
 *     too (v0.7.35.1 FEATURE_142 A-R2 moved it from @kodax/agent per
 *     ADR-021 — agent admission framework must not enumerate coding-AMA
 *     field names).
 *
 * `registerCodingInvariants()` is the canonical bootstrap entry point
 * — call it once at SDK startup (or in test setup paired with
 * `_resetInvariantRegistry()`). The function also calls
 * `registerCoreInvariants()` so a single call wires the full v1 set +
 * harnessSelectionTiming.
 */

import { registerCoreInvariants, registerInvariant } from '@kodax/agent';
import type { QualityInvariant } from '@kodax/agent';

import { boundedRevise } from './bounded-revise.js';
import { budgetCeiling } from './budget-ceiling.js';
import { harnessSelectionTiming } from './harness-selection-timing.js';
import { independentReview } from './independent-review.js';
import { resolveToolCapability, toolPermission } from './tool-permission.js';

export {
  boundedRevise,
  budgetCeiling,
  harnessSelectionTiming,
  independentReview,
  resolveToolCapability,
  toolPermission,
};

/**
 * Coding-package-supplied invariants in registration order.
 * v0.7.35.1 FEATURE_142 (A-R2): added `harnessSelectionTiming` (moved
 * from @kodax/agent's pure-invariant set).
 */
export const CODING_INVARIANTS: readonly QualityInvariant[] = [
  budgetCeiling,
  toolPermission,
  boundedRevise,
  independentReview,
  harnessSelectionTiming,
];

/**
 * Register the @kodax/coding capability-coupled + coding-AMA-specific
 * invariants AND the @kodax/agent pure-new invariants. Single bootstrap
 * call covers the FEATURE_101 admission v1 closed set + FEATURE_106's
 * external `harnessSelectionTiming`.
 *
 * Order matters: agent first (so the closed-set ids appear in
 * registration order before the coding additions), then coding.
 * Tests that need a specific subset should `_resetInvariantRegistry()`
 * and register only what they need.
 */
export function registerCodingInvariants(): void {
  registerCoreInvariants();
  for (const inv of CODING_INVARIANTS) {
    registerInvariant(inv);
  }
}
