/**
 * FEATURE_132 — pluggable server acquisition (cascade step ②).
 *
 * Discovery (step ①, `discovery.ts`) finds servers already on the machine.
 * When none is found and auto-download is enabled, the service asks a
 * `ServerAcquirer` to install one. Phase A ships only the no-op acquirer:
 * nothing is downloaded, so an un-found server falls straight through to
 * step ③ (actionable install guidance). Phase B/C add real acquirers
 * (npm `go install`, GitHub-release downloads) behind this same interface.
 *
 * `KODAX_LSP_NO_DOWNLOAD=1` globally forces the no-op path regardless of
 * which acquirer is installed.
 */

import type { LaunchCommand } from './discovery.js';

export interface AcquireContext {
  readonly serverId: string;
  readonly root: string;
}

export interface ServerAcquirer {
  /**
   * Try to install/locate a server, returning a launch command on success
   * or `undefined` to fall through to install guidance. Implementations
   * MUST be best-effort and never throw on a missing toolchain.
   */
  acquire(ctx: AcquireContext): Promise<LaunchCommand | undefined>;
}

/** The default acquirer: never downloads anything. */
export const NOOP_ACQUIRER: ServerAcquirer = {
  async acquire() {
    return undefined;
  },
};

/** True when auto-download is globally disabled. */
export function isDownloadDisabled(): boolean {
  return process.env.KODAX_LSP_NO_DOWNLOAD === '1';
}
