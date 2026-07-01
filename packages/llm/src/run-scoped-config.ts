/**
 * Run-scoped configuration via AsyncLocalStorage — concurrency-safe per-run
 * overrides for settings the coding / llm layers otherwise read from the global
 * `process.env` (the config→env bridge). Multiple SDK sessions run concurrently;
 * a global env var would let one session's config clobber another's. Each
 * `runManagedTask` wraps its run in `runWithScopedConfig(...)`, and every reader
 * checks `getRunScopedConfig()` first, falling back to `process.env` for the
 * CLI / config.json path (single-session, env-bridged) and legacy callers.
 *
 * Lives in the base @kodax-ai/llm layer so both the llm providers (max-output
 * tokens, prompt-cache) and the coding layer (model-hint tiers, LSP) can read it.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface KodaXRunScopedConfig {
  readonly modelTiers?: {
    readonly fast?: { readonly provider?: string; readonly model?: string };
    readonly deep?: { readonly provider?: string; readonly model?: string };
  };
  readonly maxOutputTokens?: number;
  readonly disablePromptCache?: boolean;
  readonly lsp?: boolean;
}

const store = new AsyncLocalStorage<KodaXRunScopedConfig>();

/** Run `fn` with the given run-scoped config visible to `getRunScopedConfig()`
 *  for the entire (sync + async) call tree. Nesting replaces the inner scope. */
export function runWithScopedConfig<T>(config: KodaXRunScopedConfig, fn: () => T): T {
  return store.run(config, fn);
}

/** The current run's scoped config, or undefined outside any run (→ env fallback). */
export function getRunScopedConfig(): KodaXRunScopedConfig | undefined {
  return store.getStore();
}
