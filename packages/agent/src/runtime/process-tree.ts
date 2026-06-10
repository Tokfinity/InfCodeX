import {
  spawn,
  spawnSync,
  type ChildProcess,
} from 'node:child_process';

const DEFAULT_GRACE_MS = 300;
const DEFAULT_FORCE_MS = 2_000;
const DEFAULT_TASKKILL_MS = 2_000;

export interface ProcessTreeKillOptions {
  readonly gracefulStdinEnd?: boolean;
  readonly gracefulMs?: number;
  readonly forceMs?: number;
  readonly taskkillMs?: number;
}

export function isChildProcessExited(child: Pick<ChildProcess, 'exitCode' | 'signalCode'>): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

export function waitForChildProcessExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  if (isChildProcessExited(child)) {
    return Promise.resolve(true);
  }

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (exited: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.off('exit', onExit);
      child.off('error', onExit);
      resolve(exited);
    };
    const onExit = (): void => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    child.once('exit', onExit);
    child.once('error', onExit);
  });
}

function runTaskkill(pid: number, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const killer = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      resolve();
    };
    timer = setTimeout(() => {
      try {
        killer.kill();
      } catch {
        // Best-effort cleanup fallback; caller may still try direct kill.
      }
      finish();
    }, timeoutMs);
    timer.unref?.();
    killer.once('exit', finish);
    killer.once('error', finish);
  });
}

export async function killPidTree(
  pid: number,
  options: ProcessTreeKillOptions = {},
): Promise<void> {
  if (process.platform === 'win32') {
    await runTaskkill(pid, options.taskkillMs ?? DEFAULT_TASKKILL_MS);
    return;
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return;
  }
}

export function killPidTreeSync(pid: number): void {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return;
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // Best-effort process-exit cleanup.
  }
}

export async function killChildProcessTree(
  child: ChildProcess,
  options: ProcessTreeKillOptions = {},
): Promise<void> {
  if (isChildProcessExited(child)) {
    return;
  }

  const gracefulMs = options.gracefulMs ?? DEFAULT_GRACE_MS;
  const forceMs = options.forceMs ?? DEFAULT_FORCE_MS;

  if (options.gracefulStdinEnd && child.stdin?.writable) {
    try {
      child.stdin.end();
    } catch {
      // Fall through to forceful termination below.
    }
    if (await waitForChildProcessExit(child, gracefulMs)) {
      return;
    }
  }

  if (process.platform === 'win32' && child.pid !== undefined) {
    await killPidTree(child.pid, options);
    if (await waitForChildProcessExit(child, forceMs)) {
      return;
    }
  }

  try {
    child.kill('SIGTERM');
  } catch {
    return;
  }
  if (await waitForChildProcessExit(child, forceMs)) {
    return;
  }

  try {
    child.kill('SIGKILL');
  } catch {
    // Nothing else to do once the OS refuses termination.
  }
  await waitForChildProcessExit(child, forceMs);
}

export function killChildProcessTreeSync(child: ChildProcess): void {
  if (isChildProcessExited(child) || child.pid === undefined) {
    return;
  }

  killPidTreeSync(child.pid);
}
