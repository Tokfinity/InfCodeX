/**
 * FEATURE_184 (v0.7.45) — Sidecar Verifier provider resolution.
 *
 * Picks the (provider, model) pair the verifier calls. **Default
 * behaviour is inherit-from-main-agent** — the sidecar verifier runs
 * on the same provider/model as the Main Agent unless explicitly
 * overridden. The architectural value of FEATURE_184 is the *Stop-
 * hook shape* (out-of-chain verification fires after Worker text-only
 * termination, replacing the in-chain Evaluator role), NOT automatic
 * model-family decoupling.
 *
 * **Model decoupling is an opt-in escape hatch**: users who want to
 * route around a model quirk (e.g. zhipu/glm-5.1 intent-vs-action
 * floor, memory: project_feature_167) set the env vars below to send
 * the verifier to a different family. Without the override, sidecar
 * uses the same model — same model = same floor; the architecture
 * provides the override mechanism, the user decides whether to use it.
 *
 * Resolution order:
 *
 *   1. Explicit env override (both must be set):
 *        `KODAX_VERIFIER_PROVIDER` + `KODAX_VERIFIER_MODEL`
 *      Used verbatim — caller takes responsibility for the choice.
 *      If the provider name doesn't exist in the KodaX provider
 *      registry, the override is silently ignored and we fall through
 *      to step 2 (typos shouldn't silently break verification).
 *
 *   2. Inherit from Main Agent (default — always returns).
 *
 * The resolver **always returns a defined value** — the verifier hook
 * is always installed in production. This differs from a prior draft
 * where the resolver could return `undefined` to skip verification;
 * the corrected design (2026-05-21) makes verifier ubiquitous, with
 * model choice gated only by user override.
 *
 * DI-clean: `env` parameter is injectable so unit tests don't mutate
 * `process.env`.
 *
 * Design references:
 *   - ADR-030 (docs/ADR.md)
 *   - v0.7.45.md §FEATURE_184 Phase D
 *   - memory: project_feature_167_evaluator_verdict_fallback (the floor
 *     that motivated FEATURE_184 — but architecture provides the
 *     escape hatch, not automatic remediation)
 */

import {
  getProvider,
  isProviderName,
  type KodaXBaseProvider,
} from '@kodax-ai/llm';

/**
 * Outcome of verifier provider resolution. `source` lets callers log /
 * surface telemetry distinguishing user-configured vs main-inherited
 * verifier — useful for tracking "is the user opting into a cross-
 * family verifier or just inheriting main?" in eval data.
 */
export interface ResolvedVerifierProvider {
  readonly provider: KodaXBaseProvider;
  readonly model: string;
  readonly providerName: string;
  readonly source: 'explicit-env' | 'inherit-main';
}

export const VERIFIER_PROVIDER_ENV = 'KODAX_VERIFIER_PROVIDER';
export const VERIFIER_MODEL_ENV = 'KODAX_VERIFIER_MODEL';

function tryGetProvider(name: string): KodaXBaseProvider | undefined {
  if (!isProviderName(name)) return undefined;
  try {
    return getProvider(name);
  } catch {
    return undefined;
  }
}

export interface ResolveVerifierProviderOptions {
  /** Main Agent's effective provider instance — used as the inherit
   *  fallback when no env override is set. Always required. */
  readonly mainProvider: KodaXBaseProvider;
  /** Main Agent's effective provider name (string id in the KodaX
   *  provider registry) — used as the inherit fallback. */
  readonly mainProviderName: string;
  /** Main Agent's effective model id — used as the inherit fallback. */
  readonly mainModel: string;
  /** Injectable env reader; defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Resolve the verifier provider per the 2-step order documented in the
 * file JSDoc. Always returns a defined value — the verifier hook is
 * always installed in production.
 */
export function resolveVerifierProvider(
  options: ResolveVerifierProviderOptions,
): ResolvedVerifierProvider {
  const env = options.env ?? process.env;

  // 1. Explicit env override — both must be set to take effect.
  const explicitProvider = env[VERIFIER_PROVIDER_ENV];
  const explicitModel = env[VERIFIER_MODEL_ENV];
  if (explicitProvider && explicitModel) {
    const provider = tryGetProvider(explicitProvider);
    if (provider) {
      return {
        provider,
        model: explicitModel,
        providerName: explicitProvider,
        source: 'explicit-env',
      };
    }
    // Provider name unknown — silently fall through to inherit-main
    // (typos shouldn't break verification, and inherit-main is the
    // safe default).
  }

  // 2. Inherit from Main Agent.
  return {
    provider: options.mainProvider,
    model: options.mainModel,
    providerName: options.mainProviderName,
    source: 'inherit-main',
  };
}
