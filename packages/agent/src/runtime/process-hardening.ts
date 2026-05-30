/**
 * FEATURE_208 (v0.7.45) — process hardening (debug-preserving subset).
 *
 * KodaX is a single-user CLI; the trust boundary is user↔agent. The realistic
 * supply-chain risk is a poisoned npm package or MCP server injecting code via
 * the dynamic-linker preload env vars (`LD_PRELOAD` on Linux,
 * `DYLD_INSERT_LIBRARIES` / `DYLD_LIBRARY_PATH` on macOS). This module strips
 * those vars from the KodaX process and from every spawned MCP child.
 *
 * Debug preservation: we deliberately do NOT set `PR_SET_DUMPABLE 0` — it would
 * break `node --inspect` / gdb attach. (The original FEATURE_208 design also
 * called `process.setrlimit('core', …)` to disable core dumps, but Node has no
 * such API — `process.setrlimit` is `undefined` — so that line is omitted.)
 *
 * Opt-out: set `KODAX_DISABLE_HARDENING=1` (propagates to MCP children since it
 * lives on the inherited env). On Windows these vars do not exist, so every
 * operation here is a harmless no-op.
 */

/** Dynamic-linker preload vars stripped from the process + MCP children. */
export const HARDENED_ENV_VARS = [
  'LD_PRELOAD',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
] as const;

/** Env var that disables all hardening when set to `'1'`. */
export const HARDENING_OPT_OUT_ENV = 'KODAX_DISABLE_HARDENING';

function hardeningDisabled(): boolean {
  return process.env[HARDENING_OPT_OUT_ENV] === '1';
}

/**
 * Strip the dynamic-linker preload vars from the live `process.env`. Call once
 * at process startup, before anything spawns children or loads native addons.
 * No-op when `KODAX_DISABLE_HARDENING=1`.
 */
export function applyProcessHardening(): void {
  if (hardeningDisabled()) return;
  for (const name of HARDENED_ENV_VARS) {
    delete process.env[name];
  }
}

/**
 * Return a copy of `env` with the dynamic-linker preload vars removed. Used
 * when spawning MCP children so a server cannot reintroduce them via its own
 * `config.env`. Returns `env` unchanged when hardening is disabled.
 */
export function stripHardenedEnvVars(
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  if (hardeningDisabled()) return env;
  const next: NodeJS.ProcessEnv = { ...env };
  for (const name of HARDENED_ENV_VARS) {
    delete next[name];
  }
  return next;
}
