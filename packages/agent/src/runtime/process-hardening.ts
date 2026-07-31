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

/** Electron bootstrap switch. It must never survive in long-running KodaX code. */
export const ELECTRON_RUN_AS_NODE_ENV = 'ELECTRON_RUN_AS_NODE';

/** Makes a Bun standalone executable behave as the Bun JavaScript runtime. */
export const BUN_BE_BUN_ENV = 'BUN_BE_BUN';

/**
 * Runs before the requested Node entrypoint and removes the Electron-only
 * bootstrap switch. The switch is still present when the OS creates the
 * process, which is the only point where Electron needs it.
 */
export const ELECTRON_NODE_ENV_SCRUB_IMPORT =
  'data:text/javascript,delete%20process.env.ELECTRON_RUN_AS_NODE';

export interface InternalNodeLaunch {
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
}

export interface JavaScriptChildLaunch extends InternalNodeLaunch {
  readonly command: string;
}

export interface PrepareInternalNodeLaunchOptions {
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly isElectron: boolean;
}

export interface PrepareJavaScriptChildLaunchOptions
  extends PrepareInternalNodeLaunchOptions {
  readonly executable?: string;
  readonly isBundled?: boolean;
}

function hardeningDisabled(): boolean {
  return process.env[HARDENING_OPT_OUT_ENV] === '1';
}

/**
 * Consume the Electron bootstrap switch and strip dynamic-linker preload vars
 * from the live `process.env`. Call once at process startup, before anything
 * spawns children or loads native addons. `KODAX_DISABLE_HARDENING=1` keeps the
 * linker vars but never keeps the one-shot Electron bootstrap switch.
 */
export function applyProcessHardening(): void {
  // This is a bootstrap invariant, not optional process hardening. Keeping it
  // would silently change any Electron application spawned by KodaX into Node.
  delete process.env[ELECTRON_RUN_AS_NODE_ENV];
  if (hardeningDisabled()) return;
  for (const name of HARDENED_ENV_VARS) {
    delete process.env[name];
  }
}

/**
 * Prepare a trusted JavaScript child launch when `process.execPath` may be a
 * packaged Electron executable. Electron receives Node mode at the exec
 * boundary; the target process removes it before loading application code.
 */
export function prepareInternalNodeLaunch(
  options: PrepareInternalNodeLaunchOptions,
): InternalNodeLaunch {
  const env: NodeJS.ProcessEnv = { ...options.env };
  delete env[ELECTRON_RUN_AS_NODE_ENV];
  if (!options.isElectron) return { args: [...options.args], env };
  return {
    args: ['--import', ELECTRON_NODE_ENV_SCRUB_IMPORT, ...options.args],
    env: { ...env, [ELECTRON_RUN_AS_NODE_ENV]: '1' },
  };
}

/**
 * Prepare a child that must interpret JavaScript rather than re-enter KodaX.
 *
 * Node and Electron use their normal executable contracts. A Bun-compiled
 * standalone has no separate interpreter binary, so `BUN_BE_BUN=1` switches
 * the executable to Bun mode for this child only.
 */
export function prepareJavaScriptChildLaunch(
  options: PrepareJavaScriptChildLaunchOptions,
): JavaScriptChildLaunch {
  const command = options.executable ?? process.execPath;
  if (options.isBundled ?? process.env.KODAX_BUNDLED === 'true') {
    const env: NodeJS.ProcessEnv = {
      ...options.env,
      [BUN_BE_BUN_ENV]: '1',
    };
    delete env[ELECTRON_RUN_AS_NODE_ENV];
    return { command, args: [...options.args], env };
  }

  const env: NodeJS.ProcessEnv = { ...options.env };
  delete env[BUN_BE_BUN_ENV];
  const launch = prepareInternalNodeLaunch({
    args: options.args,
    env,
    isElectron: options.isElectron,
  });
  return { command, ...launch };
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
