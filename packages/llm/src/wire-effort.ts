/**
 * FEATURE_222 (R6) — canonical host-facing reasoning-effort resolver.
 *
 * Mapping a user's desired reasoning strength to the actual wire `effort` value
 * for a provider/model means composing several pieces that already exist but
 * were only wired together privately inside the REPL: the model's reasoning
 * profile (`resolveModelCapabilities`), the learned hard-rejection cache
 * (`narrowReasoningProfile`), and the alias/disabled/ceiling/default resolution
 * (`resolveReasoningEffort`). A host that re-assembles these by hand drifts.
 *
 * `resolveWireEffort` is the single entry point: give it a provider/model + the
 * desired effort (+ any learned rejected efforts) and it returns the legal wire
 * effort — or `undefined`, which is a deliberate "omit reasoning_effort" signal
 * (e.g. anthropic-adaptive, or a provider with no reasoning). It reuses the
 * existing pure functions verbatim; no new resolution logic.
 */

import { resolveModelCapabilities, resolveProviderModelDescriptors } from './providers/index.js';
import { resolveReasoningEffort } from './reasoning.js';
import { narrowReasoningProfile } from './capability-learning.js';

export interface ResolveWireEffortInput {
  /** Provider id (built-in alias or registered custom provider name). */
  readonly provider: string;
  /** Model id. Omit to use the provider's default model. */
  readonly model?: string;
  /** The desired reasoning strength (a wire effort or tier the user requested).
   *  Treated as a non-explicit session preference: an unsupported value falls
   *  back to a legal one rather than throwing. */
  readonly desiredEffort?: string;
  /** Learned hard-rejected efforts for this provider/model (e.g. from the agent
   *  layer's `getCachedRejectedEfforts`). Removed from the ladder before
   *  resolving, so a rejected rung is never re-selected. */
  readonly rejectedEfforts?: readonly string[];
}

export interface ResolvedWireEffort {
  /** The legal wire effort to send, or `undefined` to omit reasoning_effort
   *  entirely (adaptive/none — NOT a fallback to `configuredEffort`). */
  readonly effort: string | undefined;
  /** What the input resolved to before profile-driven adjustment (alias/
   *  ceiling/disable). Useful for a "requested X → sending Y" status label. */
  readonly configuredEffort: string | undefined;
  /** True when the wire effort differs from the configured one (aliased,
   *  ceiled, disabled-folded, auto-resolved, or narrowed by a rejection). */
  readonly adjusted: boolean;
}

/**
 * Resolve the wire-level reasoning effort for a provider/model + desired
 * strength, honoring alias/disabled/ceiling/default rules and learned
 * rejections. Pure — no I/O, no throw.
 */
export function resolveWireEffort(input: ResolveWireEffortInput): ResolvedWireEffort {
  const modelId = input.model ?? resolveProviderModelDescriptors(input.provider)[0]?.id;
  const profile = modelId
    ? resolveModelCapabilities(input.provider, modelId)?.reasoningProfile
    : undefined;
  if (!profile) {
    // No reasoning profile → nothing to send on the wire.
    return { effort: undefined, configuredEffort: undefined, adjusted: false };
  }

  const narrowed =
    input.rejectedEfforts && input.rejectedEfforts.length > 0
      ? narrowReasoningProfile(profile, input.rejectedEfforts)
      : profile;

  const resolved = resolveReasoningEffort({
    capability: narrowed,
    // Non-explicit: an unsupported/rejected desired effort falls back instead of throwing.
    sessionEffort: input.desiredEffort,
  });

  // CRITICAL: preserve effectiveEffort === undefined (a deliberate "no wire
  // effort" signal, e.g. anthropic-adaptive). Never substitute configuredEffort.
  return {
    effort: resolved.effectiveEffort,
    configuredEffort: resolved.configuredEffort,
    adjusted: resolved.effectiveEffort !== resolved.configuredEffort,
  };
}
