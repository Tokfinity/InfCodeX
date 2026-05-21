/**
 * FEATURE_184 (v0.7.45) — Sidecar Verifier provider resolution.
 *
 * Picks the (provider, model) pair the verifier calls — *deliberately*
 * decoupled from the Main Agent's provider. That decoupling is the
 * architectural fix for the zhipu/glm-5.1 intent-vs-action floor
 * (memory: project_feature_167): when the Main Agent fails because of a
 * model quirk, the verifier must not inherit the same quirk and rubber-
 * stamp the failure.
 *
 * Resolution order:
 *
 *   1. Explicit env override (both must be set):
 *        `KODAX_VERIFIER_PROVIDER` + `KODAX_VERIFIER_MODEL`
 *      Used verbatim — caller takes responsibility for the choice.
 *
 *   2. Preferred-fallback list (first whose API-key env var is set):
 *        `kimi-code  · kimi-for-coding`        (coding-plan, independent)
 *        `ark-coding · deepseek-v4-flash`      (coding-plan, independent)
 *      Both are independent model families w.r.t. the zhipu/glm-5.1 floor
 *      and route through coding-plan providers (cost-controlled, see
 *      `benchmark/EVAL_GUIDELINES.md` §"Canonical alias panel").
 *
 *   3. None available → returns `undefined`. Caller skips the verifier
 *      pass entirely (the StopHook factory simply isn't installed).
 *      This is the "claudecode parity but no sidecar" intermediate state
 *      — equivalent end behaviour to the F167 B2 synth-accept that
 *      Phase C.2 removes.
 *
 * **Intentional exclusions** from the preferred list:
 *   - `zhipu-coding · glm-5.1` — same model as the documented floor;
 *     same family as `ark-coding · glm-5.1`; using it would defeat the
 *     decoupling
 *   - `ark-coding · glm-5.1` — same underlying model as zhipu/glm-5.1
 *     even though routed through a different gateway; correlated failure
 *   - `anthropic · claude-*` — quality is fine but most users without
 *     ANTHROPIC_API_KEY shouldn't see verifier inactivity disguised as
 *     "needs anthropic"; users who specifically want sonnet can opt-in
 *     via the explicit env override
 *
 * DI-clean: `env` parameter is injectable so unit tests don't mutate
 * `process.env`.
 *
 * Design references:
 *   - ADR-030 (docs/ADR.md)
 *   - v0.7.45.md §FEATURE_184 Phase D
 *   - memory: project_feature_167_evaluator_verdict_fallback
 *   - memory: feedback_canonical_eval_alias_panel
 */

import {
  getProvider,
  isProviderName,
  type KodaXBaseProvider,
} from '@kodax-ai/llm';

/**
 * Outcome of a successful resolution. `source` lets callers log /
 * surface telemetry distinguishing user-configured vs default-picked
 * verifier — useful for tracking "how many users hit which path".
 */
export interface ResolvedVerifierProvider {
  readonly provider: KodaXBaseProvider;
  readonly model: string;
  readonly providerName: string;
  readonly source: 'explicit-env' | 'default-preferred';
}

interface PreferredCandidate {
  readonly providerName: string;
  readonly model: string;
  readonly apiKeyEnv: string;
}

/**
 * Verifier-default preferred candidates. Order matters: first whose API
 * key env var is populated wins. Both entries are intentional —
 * see file JSDoc for the family-decoupling rationale.
 */
export const PREFERRED_VERIFIER_CANDIDATES: readonly PreferredCandidate[] = Object.freeze([
  Object.freeze({ providerName: 'kimi-code',  model: 'kimi-for-coding',   apiKeyEnv: 'KIMI_API_KEY' }),
  Object.freeze({ providerName: 'ark-coding', model: 'deepseek-v4-flash', apiKeyEnv: 'ARK_API_KEY' }),
]);

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

function envHasValue(env: NodeJS.ProcessEnv, name: string): boolean {
  const v = env[name];
  return typeof v === 'string' && v.length > 0;
}

/**
 * Resolve the verifier provider per the 3-step order documented in the
 * file JSDoc. Returns `undefined` when no candidate is reachable —
 * callers MUST treat undefined as "skip the verifier pass" (no
 * exception, no warn-and-continue with main agent's provider).
 *
 * @param env  injectable env reader; defaults to `process.env`. Tests
 *             pass synthetic envs to drive each resolution branch.
 */
export function resolveVerifierProvider(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedVerifierProvider | undefined {
  // 1. Explicit env override — both must be set, otherwise fall through.
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
  }

  // 2. Preferred fallback list — first with API-key wins.
  for (const candidate of PREFERRED_VERIFIER_CANDIDATES) {
    if (!envHasValue(env, candidate.apiKeyEnv)) continue;
    const provider = tryGetProvider(candidate.providerName);
    if (provider) {
      return {
        provider,
        model: candidate.model,
        providerName: candidate.providerName,
        source: 'default-preferred',
      };
    }
  }

  // 3. Nothing reachable — caller skips verifier.
  return undefined;
}
