/**
 * FEATURE_102 Phase 1 (P1-auto, v0.7.45) — translate the dormant `model_hint`
 * field into a real per-child provider/model choice.
 *
 * Minimalist scope (KodaX 极简): rather than a speculative 5-name capability
 * alias layer, a hint maps to an operator-configured *tier* read from env. A
 * tier left unconfigured resolves to `undefined`, so the child falls back to
 * the parent provider/model — i.e. routing is OFF by default and turns on only
 * when the operator points a tier at a concrete model. No separate toggle.
 *
 *   model_hint 'fast'     → cheap tier  (KODAX_FAST_PROVIDER / KODAX_FAST_MODEL)
 *   model_hint 'deep'     → strong tier (KODAX_DEEP_PROVIDER / KODAX_DEEP_MODEL)
 *   model_hint 'balanced' / unset       → parent (no routing)
 *
 * `fast`→cheap only applies to read-only children: the F102 gating eval
 * (`tests/feature-102-model-tier-quality.eval.ts`) validated that a cheap floor
 * model preserves quality on read-only investigation, but did NOT cover
 * write/codegen children — those stay on the parent tier until separately
 * cleared. `deep`→strong is unrestricted (a stronger model never lowers
 * quality).
 *
 * Priority in `child-executor` is: explicit bundle.provider/model (FEATURE_102
 * P2) > specialist's declared model (FEATURE_191) > this hint tier > parent.
 */
import type { KodaXChildModelHint } from './types.js';

export interface ResolvedHintTier {
  readonly provider?: string;
  readonly model?: string;
}

function readTier(providerEnv: string, modelEnv: string): ResolvedHintTier | undefined {
  const provider = process.env[providerEnv]?.trim() || undefined;
  const model = process.env[modelEnv]?.trim() || undefined;
  if (!provider && !model) return undefined;
  return { provider, model };
}

/**
 * Resolve the operator-configured tier for a child's `model_hint`. Returns
 * `undefined` when no routing applies (parent inherited) — the caller treats
 * that as a no-op via its `??` fallback chain.
 */
export function resolveModelHintTier(
  hint: KodaXChildModelHint | undefined,
  readOnly: boolean,
): ResolvedHintTier | undefined {
  if (hint === 'fast') {
    // Cheap tier is read-only-gated per the F102 gating eval caveat.
    return readOnly ? readTier('KODAX_FAST_PROVIDER', 'KODAX_FAST_MODEL') : undefined;
  }
  if (hint === 'deep') {
    return readTier('KODAX_DEEP_PROVIDER', 'KODAX_DEEP_MODEL');
  }
  return undefined;
}
