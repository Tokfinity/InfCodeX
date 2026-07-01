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

import type {
  KodaXAgentMode,
  KodaXEffectiveTaskConfig,
  KodaXOptions,
  KodaXTaskVerificationContract,
} from '../types.js';

/**
 * Merge the profile-default verification standard with per-task
 * `context.taskVerification` (per-task fields win). Returns undefined when
 * neither is present. Shared with R3's sidecar wiring so the reported and the
 * enforced standard cannot drift.
 */
export function resolveEffectiveVerification(
  options: KodaXOptions,
): KodaXTaskVerificationContract | undefined {
  const profileDefault = options.context?.agentProfile?.verification;
  const perTask = options.context?.taskVerification;
  if (!profileDefault && !perTask) return undefined;
  return { ...profileDefault, ...perTask };
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
  const config: KodaXEffectiveTaskConfig = {
    agentMode: args.agentMode,
    agentProfile: options.context?.agentProfile,
    toolScope: args.toolScope,
    verification: resolveEffectiveVerification(options),
    ...(args.verifier ? { verifier: args.verifier } : {}),
  };
  try {
    cb(config);
  } catch {
    // Observer must not break the run.
  }
}
