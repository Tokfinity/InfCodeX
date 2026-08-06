import { isRuntimeDaemonPidAlive } from './lifecycle.js';
import {
  readRuntimeDaemonLockOwner,
  readRuntimeDaemonShutdownOutcome,
  resolveRuntimeDaemonPathsFromConfigHome,
  type RuntimeDaemonShutdownOutcome,
} from './state.js';

export interface RuntimeDaemonShutdownVerificationOwner {
  readonly runtimeId: string;
  readonly pid: number;
  readonly kind?: 'daemon' | 'inline';
  readonly processContainment?: 'windows-job';
  readonly supervisorPid?: number;
}

export interface RuntimeDaemonShutdownVerificationInput {
  readonly configHome: string;
  readonly profile?: string;
  readonly owner: RuntimeDaemonShutdownVerificationOwner;
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
}

export type RuntimeDaemonShutdownVerification =
  | {
      readonly status: 'succeeded' | 'failed';
      readonly outcome: RuntimeDaemonShutdownOutcome;
    }
  | {
      readonly status: 'replacement_running';
      readonly runtimeId: string;
      readonly pid: number;
    }
  | {
      readonly status: 'unverified';
      readonly reason:
        | 'daemon_active'
        | 'containment_active'
        | 'containment_unavailable'
        | 'outcome_missing';
    };

const DEFAULT_SHUTDOWN_VERIFICATION_TIMEOUT_MS = 15_000;
const DEFAULT_SHUTDOWN_VERIFICATION_POLL_MS = 25;

/**
 * Verify one exact daemon shutdown from its durable outcome and process fence.
 * This is deliberately a quit-path API: it performs no steady-state polling.
 */
export async function waitForRuntimeDaemonShutdown(
  input: RuntimeDaemonShutdownVerificationInput,
): Promise<RuntimeDaemonShutdownVerification> {
  if (!Number.isSafeInteger(input.owner.pid) || input.owner.pid <= 0) {
    throw new Error('Runtime daemon shutdown verification requires a positive owner PID.');
  }
  const timeoutMs = input.timeoutMs ?? DEFAULT_SHUTDOWN_VERIFICATION_TIMEOUT_MS;
  const pollIntervalMs = input.pollIntervalMs ?? DEFAULT_SHUTDOWN_VERIFICATION_POLL_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Runtime daemon shutdown verification timeout must be positive.');
  }
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new Error('Runtime daemon shutdown verification poll interval must be positive.');
  }
  if (
    input.owner.processContainment === 'windows-job'
    && (!Number.isSafeInteger(input.owner.supervisorPid) || input.owner.supervisorPid! <= 0)
  ) {
    throw new Error('Windows Job containment requires a positive supervisor PID.');
  }

  const paths = resolveRuntimeDaemonPathsFromConfigHome(
    input.configHome,
    input.profile ?? 'default',
  );
  const deadline = Date.now() + timeoutMs;
  let reason: Extract<RuntimeDaemonShutdownVerification, { status: 'unverified' }>['reason'] =
    'outcome_missing';
  while (true) {
    const currentOwner = readRuntimeDaemonLockOwner(paths.lockFile);
    const replacement = (
      currentOwner?.kind === 'daemon'
      && isRuntimeDaemonPidAlive(currentOwner.pid)
      && (currentOwner.runtimeId !== input.owner.runtimeId
        || currentOwner.pid !== input.owner.pid)
    ) ? currentOwner : undefined;

    const outcome = readRuntimeDaemonShutdownOutcome(paths, input.owner);
    const daemonActive = isRuntimeDaemonPidAlive(input.owner.pid);
    const containmentActive = input.owner.processContainment === 'windows-job'
      && isRuntimeDaemonPidAlive(input.owner.supervisorPid!);
    if (outcome?.status === 'failed') return { status: 'failed', outcome };
    if (process.platform === 'win32' && input.owner.processContainment !== 'windows-job') {
      return { status: 'unverified', reason: 'containment_unavailable' };
    }
    if (outcome?.status === 'succeeded' && !daemonActive && !containmentActive) {
      if (replacement !== undefined) {
        return {
          status: 'replacement_running',
          runtimeId: replacement.runtimeId,
          pid: replacement.pid,
        };
      }
      return { status: 'succeeded', outcome };
    }
    reason = daemonActive
      ? 'daemon_active'
      : containmentActive
        ? 'containment_active'
        : 'outcome_missing';
    if (Date.now() >= deadline) return { status: 'unverified', reason };
    await delay(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
  }
}

function delay(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, timeoutMs));
}
