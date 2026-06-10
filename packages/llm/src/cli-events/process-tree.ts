import { spawn, type ChildProcess } from 'node:child_process';

// Keep this file in sync with packages/agent/src/runtime/process-tree.ts.
// @kodax-ai/llm intentionally does not depend on @kodax-ai/agent.

const TASKKILL_TIMEOUT_MS = 2_000;
const FORCE_WAIT_MS = 2_000;

function isExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (isExited(child)) {
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

function runTaskkill(pid: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const killer = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    let settled = false;
    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      try {
        killer.kill();
      } catch {
        // Best-effort fallback.
      }
      finish();
    }, TASKKILL_TIMEOUT_MS);
    timer.unref?.();
    killer.once('exit', finish);
    killer.once('error', finish);
  });
}

function signalPosixPidTree(pid: number, signal: NodeJS.Signals): boolean {
  let signaled = false;
  try {
    process.kill(-pid, signal);
    signaled = true;
  } catch {
    // Child may not be a process-group leader; fall back to direct PID.
  }

  try {
    process.kill(pid, signal);
    signaled = true;
  } catch {
    // It may already be gone after the process-group signal.
  }
  return signaled;
}

function signalTargetExists(target: number): boolean {
  try {
    process.kill(target, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function isPosixPidTreeAlive(pid: number): boolean {
  return signalTargetExists(-pid) || signalTargetExists(pid);
}

async function waitForPosixPidTreeExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPosixPidTreeAlive(pid)) {
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return !isPosixPidTreeAlive(pid);
}

export async function killChildProcessTree(child: ChildProcess): Promise<void> {
  if (isExited(child)) {
    return;
  }

  if (process.platform === 'win32' && child.pid !== undefined) {
    await runTaskkill(child.pid);
    await waitForExit(child, FORCE_WAIT_MS);
    return;
  }

  if (child.pid !== undefined) {
    if (!signalPosixPidTree(child.pid, 'SIGTERM')) {
      return;
    }
    if (await waitForPosixPidTreeExit(child.pid, FORCE_WAIT_MS)) {
      return;
    }
    signalPosixPidTree(child.pid, 'SIGKILL');
    await waitForPosixPidTreeExit(child.pid, FORCE_WAIT_MS);
    return;
  }

  try {
    child.kill('SIGTERM');
  } catch {
    return;
  }
  if (await waitForExit(child, FORCE_WAIT_MS)) {
    return;
  }

  try {
    child.kill('SIGKILL');
  } catch {
    // Best-effort cleanup.
  }
  await waitForExit(child, FORCE_WAIT_MS);
}
