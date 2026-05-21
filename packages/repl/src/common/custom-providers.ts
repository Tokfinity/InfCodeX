/**
 * Custom provider CRUD — v0.7.42 (closes gap 7 reported by KodaX Space).
 *
 * Before v0.7.42 the only way for an SDK embedder to add / remove a
 * custom provider was to:
 *   1. Read `~/.kodax/config.json` directly.
 *   2. Hand-validate the entry against `KodaXCustomProviderConfig`
 *      (Space wrote a parallel zod schema to do this).
 *   3. Write the file back, hoping the format stayed in sync with
 *      whatever shape the KodaX SDK currently expected.
 *   4. Call `registerConfiguredCustomProviders` separately to
 *      re-hydrate the in-memory registry.
 *
 * Space reported: "你们改格式我们就坏" (if you change the format we
 * break). The 4-step ritual was fragile, the validation was duplicated,
 * and the read / write / re-register split made it easy for an embedder
 * to forget the last step and end up with a stale in-memory registry.
 *
 * This module exposes a tight CRUD surface — list / get / upsert /
 * remove — that owns the file-format end-to-end. The schema is enforced
 * via `validateCustomProviderConfig` from `@kodax-ai/llm` (the canonical
 * validator the SDK itself uses), so embedders cannot drift away from
 * the SDK's expected shape. Each mutation persists to `config.json` and
 * eagerly re-registers ALL custom providers in memory so subsequent
 * `resolveProvider(name)` calls see the new state without a process
 * restart.
 *
 * Path resolution: this module resolves the config file path on EVERY
 * call via `getAgentConfigPath('config.json')` so that programmatic
 * `setAgentConfigHome()` overrides (e.g. for tests, substrate
 * consumers, multi-tenant shared machines) take effect immediately —
 * unlike the load-time-frozen `KODAX_CONFIG_FILE` constant in
 * `common/utils.ts` that captures the path once at import time.
 *
 * Concurrency / multi-process: this is a single-machine, last-write-
 * wins implementation. If two SDK consumers (KodaX CLI + KodaX Space)
 * both mutate the same config simultaneously, the later writer's view
 * survives. KodaX is a single-user CLI; the multi-writer surface is
 * not a real production concern for v0.7.42. A future FEATURE could
 * layer file locking on top of this surface without changing the
 * caller-facing API.
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  getAgentConfigPath,
  registerCustomProviders,
  validateCustomProviderConfig,
  type KodaXCustomProviderConfig,
} from '@kodax-ai/coding';

/**
 * Return a snapshot of every custom provider currently persisted in
 * `~/.kodax/config.json`. The returned array is a defensive deep copy —
 * mutating it does NOT change the on-disk config (use
 * {@link upsertCustomProvider} / {@link removeCustomProvider} for
 * mutation). Order matches the file order (which is the insertion order
 * preserved by JSON parse).
 */
export function listCustomProviders(): KodaXCustomProviderConfig[] {
  const config = readWholeConfig();
  const providers = extractCustomProviders(config);
  return providers.map((entry) => cloneCustomProvider(entry));
}

/**
 * Look up a single custom provider by `name`. Returns `undefined` if no
 * such provider is configured. Returned value is a defensive deep copy.
 */
export function getCustomProviderConfig(
  name: string,
): KodaXCustomProviderConfig | undefined {
  if (typeof name !== 'string' || name.length === 0) {
    return undefined;
  }
  const entry = extractCustomProviders(readWholeConfig()).find(
    (provider) => provider.name === name,
  );
  return entry ? cloneCustomProvider(entry) : undefined;
}

/**
 * Add a new custom provider OR replace an existing one with the same
 * name. The input is validated via `validateCustomProviderConfig`; on
 * validation failure the call throws and the config is NOT touched.
 *
 * After a successful write, the in-memory custom-provider registry is
 * fully re-registered (with the new entry in place) so subsequent
 * `resolveProvider(name)` calls see the change without a restart.
 *
 * Returns the deep-cloned stored shape (so callers can observe any
 * normalization the validator performed without re-reading the file).
 */
export function upsertCustomProvider(
  config: KodaXCustomProviderConfig,
): KodaXCustomProviderConfig {
  // Validate first — fail before touching disk so a malformed input
  // cannot corrupt `config.json` partway through.
  validateCustomProviderConfig(config);

  const cloned = cloneCustomProvider(config);
  const whole = readWholeConfig();
  const existing = extractCustomProviders(whole);

  const idx = existing.findIndex((provider) => provider.name === cloned.name);
  const next =
    idx >= 0
      ? existing.map((provider, i) => (i === idx ? cloned : provider))
      : [...existing, cloned];

  writeWholeConfig({ ...whole, customProviders: next });
  registerCustomProviders(next);
  return cloneCustomProvider(cloned);
}

/**
 * Remove the custom provider identified by `name`. Returns `true` when
 * an entry was removed, `false` when no provider with that name existed
 * (the file is then NOT rewritten — no-op for unknown names so caller
 * code can be idempotent).
 *
 * The in-memory registry is re-registered after a successful removal so
 * `resolveProvider(name)` immediately throws for the removed provider.
 */
export function removeCustomProvider(name: string): boolean {
  if (typeof name !== 'string' || name.length === 0) {
    return false;
  }
  const whole = readWholeConfig();
  const existing = extractCustomProviders(whole);
  const next = existing.filter((provider) => provider.name !== name);
  if (next.length === existing.length) {
    return false;
  }
  writeWholeConfig({ ...whole, customProviders: next });
  registerCustomProviders(next);
  return true;
}

// ============== Internals ==============

/**
 * Resolve the config file path dynamically on every call. Routes through
 * `getAgentConfigPath()` so `setAgentConfigHome()` overrides apply
 * immediately — unlike `common/utils.ts`'s `KODAX_CONFIG_FILE` constant
 * which is captured at module-load time.
 */
function configFilePath(): string {
  return getAgentConfigPath('config.json');
}

/**
 * Read the entire `config.json` as a plain object. Treats a missing or
 * malformed file as an empty config, mirroring `loadConfig`'s behavior
 * in `common/utils.ts` (read failures must not break startup).
 */
function readWholeConfig(): Record<string, unknown> {
  const file = configFilePath();
  if (!fs.existsSync(file)) {
    return {};
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * Persist the entire config object back to disk, preserving all
 * top-level fields the caller has not touched. mkdirSync handles the
 * fresh-install case (no `~/.kodax/` yet).
 */
function writeWholeConfig(config: Record<string, unknown>): void {
  const file = configFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config, null, 2), 'utf-8');
}

/**
 * Pull the `customProviders` array out of an arbitrary config object.
 * Tolerant of missing field / wrong type — returns empty array.
 */
function extractCustomProviders(
  config: Record<string, unknown>,
): KodaXCustomProviderConfig[] {
  const value = config.customProviders;
  if (!Array.isArray(value)) {
    return [];
  }
  // The on-disk shape is trusted as-is here; the writer side runs
  // `validateCustomProviderConfig` before persistence, so a well-formed
  // file is the contract. Embedders that hand-edit `config.json` with
  // bad entries will surface the error on next `resolveProvider` call.
  return value as KodaXCustomProviderConfig[];
}

/**
 * Deep-clone helper — keeps the public API copy-on-read so callers
 * cannot mutate the on-disk state by holding a reference. `structuredClone`
 * is Node 18+ which matches the package's engines.node requirement.
 */
function cloneCustomProvider(
  config: KodaXCustomProviderConfig,
): KodaXCustomProviderConfig {
  return structuredClone(config);
}
