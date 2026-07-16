/**
 * FEATURE_102 Phase 3 (v0.7.45) — cross-provider fallback for child dispatch.
 *
 * The LLM layer already retries the SAME provider on rate-limit / transient
 * errors (`withRateLimit`, 3 attempts + retry-after). This adds the next step:
 * when the primary provider is *exhausted or down* (rate-limit retries gave up,
 * a 5xx, or a network failure), re-run the child once on the next provider in
 * an operator-configured chain instead of failing the whole child.
 *
 * Scope is deliberately minimal (KodaX 极简): only hard transport/availability
 * errors trigger fallback. A child that *ran* and returned `success:false` is a
 * task outcome, not a provider outage, so it is NOT retried elsewhere. Aborts
 * (user cancel) are never faked over.
 *
 * Configured via `KODAX_FALLBACK_PROVIDERS` (comma-separated provider ids). The
 * REPL `/fallback` command + `~/.kodax/config.json` mirror into this env var;
 * an empty/unset list means fallback is OFF (no separate toggle).
 */
import { KodaXNetworkError, KodaXProviderError, KodaXRateLimitError } from '@kodax-ai/llm';

import type { KodaXOptions, KodaXResult } from './types.js';

type RunKodaXFn = (options: KodaXOptions, prompt: string) => Promise<KodaXResult>;

/** Parse the operator-configured fallback chain. Empty when unset → OFF. */
export function resolveFallbackChain(): string[] {
  const raw = process.env.KODAX_FALLBACK_PROVIDERS?.trim();
  if (!raw) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Only hard provider-availability errors are fallback-eligible. A returned
 * `success:false` (task outcome) is explicitly NOT eligible — switching
 * providers because the agent didn't finish the task would mask real failures.
 */
export function isFallbackEligibleError(error: unknown): boolean {
  return (
    error instanceof KodaXRateLimitError ||
    error instanceof KodaXNetworkError ||
    error instanceof KodaXProviderError
  );
}

function errorReason(error: unknown): string {
  if (error instanceof KodaXRateLimitError) return 'rate-limit exhausted';
  if (error instanceof KodaXNetworkError) return 'network error';
  if (error instanceof KodaXProviderError) return 'provider error';
  return error instanceof Error ? error.message : String(error);
}

export interface ChildFallbackHooks {
  /** Notified just before each fallback attempt (for progress/trace). */
  readonly onFallback?: (info: {
    readonly fromProvider: string;
    readonly toProvider: string;
    readonly reason: string;
  }) => void;
}

/**
 * Run a child via `run`, falling back across the configured provider chain on
 * hard availability errors. The fallback attempt clears `model` (the primary's
 * model id won't exist on another provider) so the fallback provider uses its
 * own default. Ineligible errors and aborts propagate unchanged.
 */
export async function invokeChildWithFallback(
  options: KodaXOptions,
  prompt: string,
  run: RunKodaXFn,
  hooks?: ChildFallbackHooks,
): Promise<KodaXResult> {
  const primary = options.provider ?? 'anthropic';
  try {
    return await run(options, prompt);
  } catch (error) {
    if (options.abortSignal?.aborted || !isFallbackEligibleError(error)) throw error;

    const chain = resolveFallbackChain().filter((candidate) => candidate !== primary);
    let lastError: unknown = error;
    for (const toProvider of chain) {
      hooks?.onFallback?.({ fromProvider: primary, toProvider, reason: errorReason(lastError) });
      try {
        return await run({ ...options, provider: toProvider, model: undefined }, prompt);
      } catch (next) {
        if (options.abortSignal?.aborted || !isFallbackEligibleError(next)) throw next;
        lastError = next;
      }
    }
    throw lastError;
  }
}
