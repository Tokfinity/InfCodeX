/**
 * FEATURE_132 — server acquisition (cascade step ②), opt-in by design.
 *
 * Discovery (step ①, `discovery.ts`) finds servers already on the machine.
 * When none is found, a server MAY auto-install itself via its `acquire()`
 * method (e.g. gopls `go install`, Phase C GitHub-release downloads). Because
 * auto-installing toolchains mutates the user's environment, KodaX makes this
 * **opt-in**: nothing is installed unless `KODAX_LSP_DOWNLOAD=1` is set (and
 * `KODAX_LSP_NO_DOWNLOAD=1` always wins as a hard off). Otherwise an un-found
 * server falls straight through to step ③ (actionable install guidance).
 */

import { spawnLspProcess } from './spawn.js';

/** True only when the user has explicitly opted into server auto-install. */
export function isAutoInstallEnabled(): boolean {
  return process.env.KODAX_LSP_DOWNLOAD === '1' && process.env.KODAX_LSP_NO_DOWNLOAD !== '1';
}

export interface InstallCommand {
  readonly command: string;
  readonly args: readonly string[];
}

export interface RunInstallOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly debug?: (message: string) => void;
}

const DEFAULT_INSTALL_TIMEOUT_MS = 5 * 60_000;

/**
 * Run an install command (e.g. `go install …`) and resolve `true` on a clean
 * exit. Best-effort and never throws — a non-zero exit, missing toolchain, or
 * timeout resolves `false` so the caller falls back to install guidance.
 */
export function runInstallCommand(command: InstallCommand, options: RunInstallOptions = {}): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const child = spawnLspProcess(command.command, command.args, {
      stdio: 'ignore',
      env: process.env,
      signal: options.signal,
    });
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // ignore
      }
      options.debug?.(`install timed out: ${command.command} ${command.args.join(' ')}`);
      done(false);
    }, options.timeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS);
    child.on('error', (error) => {
      options.debug?.(`install failed to start: ${error.message}`);
      done(false);
    });
    child.on('exit', (code) => done(code === 0));
  });
}
