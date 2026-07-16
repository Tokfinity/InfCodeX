/**
 * FEATURE_247 (R4) — effective managed-task configuration snapshot.
 *
 * Both managed-task entry paths (SA via `dispatchManagedTask`, AMA via
 * `runManagedTaskViaRunner`) call `emitEffectiveTaskConfig` once at run start so
 * an SDK embedder subscribed to `KodaXEvents.onEffectiveConfig` can confirm the
 * intended profile entered the pipeline and inspect its tool scope + verifier
 * standard. Children (raw `runKodaX`) never reach these entry points, so the
 * event fires once per top-level managed task.
 */

import { getProvider, isProviderName } from '@kodax-ai/llm';

import type {
  KodaXAgentMode,
  KodaXEffectiveTaskConfig,
  KodaXOptions,
  KodaXTaskVerificationContract,
} from '../types.js';
import { resolveVerifierProvider } from './middleware/sidecar-verifier/verifier-provider-resolver.js';

/**
 * Resolve the verification standard that reaches the Sidecar Verifier.
 *
 * ONLY a profile (Partner) run contributes a verifier standard: the profile
 * default (`agentProfile.verification`) merged with per-task
 * `context.taskVerification` (per-task fields win — a shallow merge, so an
 * array field like `criteria` on the per-task contract REPLACES the profile's
 * rather than element-merging). Returns undefined when neither is present.
 *
 * A plain (non-profile) run that sets `context.taskVerification` returns
 * `undefined` here: pre-FEATURE_247, `taskVerification` shaped only the Worker
 * role prompt, never the sidecar verifier. Keeping that path unchanged
 * preserves the default Coding Agent's verifier behavior (regression fix from
 * the FEATURE_247 self-review). Shared with R3's sidecar wiring so the reported
 * (R4) and enforced (R3) standard cannot drift.
 */
export function resolveEffectiveVerification(
  options: KodaXOptions,
): KodaXTaskVerificationContract | undefined {
  const profile = options.context?.agentProfile;
  if (!profile) return undefined;
  const profileDefault = profile.verification;
  const perTask = options.context?.taskVerification;
  if (!profileDefault && !perTask) return undefined;
  const merged = { ...profileDefault, ...perTask };
  // Guard the documented shallow-merge footgun: an explicitly-empty per-task
  // `criteria: []` would REPLACE (not element-merge) the profile's criteria,
  // silently disabling every profile-level verification criterion. Treat an
  // empty per-task array as "unset" so the profile default survives.
  if (
    Array.isArray(perTask?.criteria) &&
    perTask.criteria.length === 0 &&
    Array.isArray(profileDefault?.criteria) &&
    profileDefault.criteria.length > 0
  ) {
    return { ...merged, criteria: profileDefault.criteria };
  }
  return merged;
}

/**
 * Resolve the (provider, model) the Sidecar Verifier will actually run on, for
 * the R4 effective-config snapshot. Reuses the SAME `resolveVerifierProvider`
 * the runner uses (deterministic: env override or inherit-main) so the reported
 * verifier cannot drift from the enforced one. Defensive — any resolution
 * failure (unknown provider name, registry miss) returns undefined rather than
 * breaking the snapshot.
 */
function resolveVerifierAttribution(
  options: KodaXOptions,
): { readonly provider: string; readonly model?: string } | undefined {
  const mainProviderName = options.provider ?? 'anthropic';
  if (!isProviderName(mainProviderName)) return undefined;
  try {
    const resolved = resolveVerifierProvider({
      mainProvider: getProvider(mainProviderName),
      mainProviderName,
      mainModel: options.modelOverride ?? options.model,
    });
    return {
      provider: resolved.providerName,
      ...(resolved.model !== undefined ? { model: resolved.model } : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * Emit the effective-config snapshot if the caller subscribed. The observer
 * callback is defensively wrapped — a throwing subscriber must never abort the
 * managed-task run.
 */
export function emitEffectiveTaskConfig(
  options: KodaXOptions,
  args: {
    readonly agentMode: KodaXAgentMode;
    readonly toolScope: readonly string[];
    readonly verifier?: { readonly provider?: string; readonly model?: string };
  },
): void {
  const cb = options.events?.onEffectiveConfig;
  if (!cb) return;
  // Report the verifier the run will use: an explicit caller-supplied value
  // wins; otherwise resolve it the same way the runner does so the R4 snapshot
  // is truthful instead of always `undefined`.
  const verifier = args.verifier ?? resolveVerifierAttribution(options);
  const config: KodaXEffectiveTaskConfig = {
    agentMode: args.agentMode,
    agentProfile: options.context?.agentProfile,
    toolScope: args.toolScope,
    verification: resolveEffectiveVerification(options),
    ...(verifier ? { verifier } : {}),
  };
  try {
    cb(config);
  } catch {
    // Observer must not break the run.
  }
}
