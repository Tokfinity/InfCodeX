import { spawn, type ChildProcess } from 'node:child_process';

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

export async function killChildProcessTree(child: ChildProcess): Promise<void> {
  if (isExited(child)) {
    return;
  }

  if (process.platform === 'win32' && child.pid !== undefined) {
    await runTaskkill(child.pid);
    await waitForExit(child, FORCE_WAIT_MS);
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
