/**
 * FEATURE_125 (v0.7.41) — Team Mode bootstrap helper.
 *
 * One-call entry point invoked from the REPL bootstrap (`kodax_cli.ts`
 * / `repl.ts`) once per process. Wires the four moving parts:
 *
 *   1. Reaps stale instance directories left by crashed peers
 *      (acceptance criterion 7 in v0.7.41.md).
 *   2. Constructs the `StateWriter` (S1) using sensible defaults.
 *   3. Registers the writer in the process-level singleton (S3
 *      consumers + tool-result paths use `getActiveTeamModeWriter`).
 *   4. Returns a small handle exposing the writer, a sibling-snapshot
 *      function (used by the runner-driven adapter once per LLM
 *      round), and an idempotent `shutdown()`.
 *
 * Disabled via `KODAX_DISABLE_MULTI_INSTANCE=1` — the helper returns
 * `null` and the singleton stays empty so every caller silently falls
 * back to solo-mode behavior. The env var is the project-spec escape
 * hatch for failure diagnosis; do NOT use it as a daily-driver opt-out.
 *
 * DI-clean: optional `fs`, `clock`, `instancesRoot` overrides so tests
 * can exercise the full lifecycle without touching `~/.kodax`.
 */

import { setActiveTeamModeWriter } from './active-team-mode.js';
import {
  discoverInstances,
  type DiscoveredInstance,
  type InstanceDiscoveryFs,
} from './instance-discovery.js';
import {
  createStateWriter,
  type SessionMeta,
  type SessionStateSnapshot,
  type StateWriter,
  type StateWriterFs,
} from './state-writer.js';

export interface TeamModeBootstrapOptions {
  /** Static session meta. Required because cwd / startedAt are essential. */
  readonly meta: SessionMeta;
  /**
   * Initial published state. Defaults to `{ agentPhase: 'idle' }` —
   * callers typically update this immediately when work begins.
   */
  readonly initialState?: SessionStateSnapshot;
  /**
   * pid override; defaults to `process.pid`. Tests inject a stable
   * pid; production never passes this.
   */
  readonly pid?: number;
  /**
   * Override the instances root directory. Defaults to
   * `getAgentConfigPath('instances')` via the underlying
   * `createStateWriter` / `discoverInstances`. Tests pass a temp dir.
   */
  readonly instancesRoot?: string;
  /** Inject an in-memory fs for both the writer and the discovery scan. Tests only. */
  readonly fs?: StateWriterFs & InstanceDiscoveryFs;
  readonly clock?: () => number;
  readonly heartbeatIntervalMs?: number;
  /**
   * Pass `false` to skip the initial reap of stale peer directories.
   * Defaults to `true` — every session that bootstraps Team Mode is
   * also a candidate cleaner for crashed peers.
   */
  readonly reapStaleOnStart?: boolean;
  /** Forwarded to discoverInstances for per-instance failure logs. */
  readonly logger?: (message: string) => void;
}

export interface TeamModeHandle {
  readonly writer: StateWriter;
  /**
   * Get the current sibling snapshot. Cheap (a single readdir + N
   * stat). Caller wires this into the runner-driven LLM-call prefix
   * so each round sees a fresh sibling list — Team Mode block is
   * intentionally NOT cached in the stable system-prompt prefix.
   */
  discoverSiblings(): DiscoveredInstance[];
  /**
   * Tear down the writer + clear the singleton. Idempotent. Safe to
   * call from a process-exit handler, an Ink unmount, or an explicit
   * `/exit` slash command.
   */
  shutdown(): Promise<void>;
}

const DEFAULT_INITIAL_STATE: SessionStateSnapshot = { agentPhase: 'idle' };

export function bootstrapTeamMode(
  options: TeamModeBootstrapOptions,
): TeamModeHandle | null {
  if (process.env.KODAX_DISABLE_MULTI_INSTANCE === '1') return null;

  const fs = options.fs;
  const reapOnStart = options.reapStaleOnStart ?? true;
  const logger = options.logger;
  if (reapOnStart) {
    try {
      discoverInstances({
        reapStale: true,
        ...(options.instancesRoot !== undefined ? { instancesRoot: options.instancesRoot } : {}),
        ...(fs !== undefined ? { fs } : {}),
        ...(options.clock !== undefined ? { clock: options.clock } : {}),
        ...(options.pid !== undefined ? { excludePid: options.pid } : {}),
        ...(logger !== undefined ? { logger } : {}),
      });
    } catch {
      /* swallow — discovery failure must not block startup */
    }
  }

  const writer = createStateWriter({
    meta: options.meta,
    initialState: options.initialState ?? DEFAULT_INITIAL_STATE,
    ...(options.pid !== undefined ? { pid: options.pid } : {}),
    ...(options.instancesRoot !== undefined ? { instancesRoot: options.instancesRoot } : {}),
    ...(fs !== undefined ? { fs } : {}),
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
    ...(options.heartbeatIntervalMs !== undefined
      ? { heartbeatIntervalMs: options.heartbeatIntervalMs }
      : {}),
  });

  setActiveTeamModeWriter(writer);

  let shuttingDown = false;
  return {
    writer,
    discoverSiblings() {
      return discoverInstances({
        excludePid: writer.pid,
        ...(options.instancesRoot !== undefined ? { instancesRoot: options.instancesRoot } : {}),
        ...(fs !== undefined ? { fs } : {}),
        ...(options.clock !== undefined ? { clock: options.clock } : {}),
        ...(logger !== undefined ? { logger } : {}),
      });
    },
    async shutdown() {
      if (shuttingDown) return;
      shuttingDown = true;
      // Drop the singleton first so any in-flight tool call after
      // this point sees `null` and skips the team-mode update path.
      setActiveTeamModeWriter(null);
      await writer.shutdown();
    },
  };
}
