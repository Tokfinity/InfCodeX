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
import { getRunScopedConfig } from '@kodax-ai/llm';

import type { KodaXChildModelHint } from './types.js';

export interface ResolvedHintTier {
  readonly provider?: string;
  readonly model?: string;
}

/**
 * Resolve one tier: run-scoped config (concurrency-safe, from KodaXOptions.
 * modelTiers) first, then the global env fallback (CLI / config.json bridge).
 */
function resolveTier(
  scoped: { readonly provider?: string; readonly model?: string } | undefined,
  providerEnv: string,
  modelEnv: string,
): ResolvedHintTier | undefined {
  const provider = scoped?.provider?.trim() || process.env[providerEnv]?.trim() || undefined;
  const model = scoped?.model?.trim() || process.env[modelEnv]?.trim() || undefined;
  if (!provider && !model) return undefined;
  return { provider, model };
}

/**
 * Resolve the operator-configured tier for a child's `model_hint`. Returns
 * `undefined` when no concrete tier is configured; the caller records that
 * outcome and safely inherits the parent provider/model.
 */
export function resolveModelHintTier(
  hint: KodaXChildModelHint | undefined,
  readOnly: boolean,
): ResolvedHintTier | undefined {
  const tiers = getRunScopedConfig()?.modelTiers;
  if (hint === 'fast') {
    // Cheap tier is read-only-gated per the F102 gating eval caveat.
    return readOnly ? resolveTier(tiers?.fast, 'KODAX_FAST_PROVIDER', 'KODAX_FAST_MODEL') : undefined;
  }
  if (hint === 'deep') {
    return resolveTier(tiers?.deep, 'KODAX_DEEP_PROVIDER', 'KODAX_DEEP_MODEL');
  }
  return undefined;
}
