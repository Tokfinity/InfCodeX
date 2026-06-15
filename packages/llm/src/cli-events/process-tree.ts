import { spawn, spawnSync, type ChildProcess } from 'node:child_process';

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

function readWindowsPidListJson(stdout: string): number[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const values = Array.isArray(parsed) ? parsed : [parsed];
    return values
      .map((value) => Number(value))
      .filter((pid) => Number.isFinite(pid) && pid > 0);
  } catch {
    return [];
  }
}

function getWindowsChildPidsViaWmic(parentPid: number): number[] {
  const result = spawnSync('wmic', [
    'process',
    'where',
    `ParentProcessId=${parentPid}`,
    'get',
    'ProcessId',
    '/format:list',
  ], {
    encoding: 'utf8',
    timeout: TASKKILL_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    return [];
  }

  const pids: number[] = [];
  const pattern = /ProcessId=(\d+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(result.stdout)) !== null) {
    const pid = Number(match[1]);
    if (Number.isFinite(pid) && pid > 0 && pid !== parentPid) {
      pids.push(pid);
    }
  }
  return pids;
}

function getWindowsChildPids(parentPid: number): number[] {
  const script = [
    `$children = Get-CimInstance Win32_Process -Filter "ParentProcessId = ${parentPid}"`,
    'if ($null -eq $children) { exit 0 }',
    '$children | Select-Object -ExpandProperty ProcessId | ConvertTo-Json -Compress',
  ].join('; ');
  const result = spawnSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    script,
  ], {
    encoding: 'utf8',
    timeout: TASKKILL_TIMEOUT_MS,
    windowsHide: true,
  });
  if (!result.error && result.status === 0) {
    const pids = readWindowsPidListJson(result.stdout);
    if (pids.length > 0) return pids;
  }
  return getWindowsChildPidsViaWmic(parentPid);
}

function collectWindowsDescendantPids(pid: number, seen = new Set<number>()): number[] {
  const descendants: number[] = [];
  for (const childPid of getWindowsChildPids(pid)) {
    if (seen.has(childPid)) {
      continue;
    }
    seen.add(childPid);
    descendants.push(childPid);
    descendants.push(...collectWindowsDescendantPids(childPid, seen));
  }
  return descendants;
}

export async function killChildProcessTree(child: ChildProcess): Promise<void> {
  if (process.platform === 'win32' && child.pid !== undefined) {
    const descendantPids = collectWindowsDescendantPids(child.pid);
    if (!isExited(child)) {
      await runTaskkill(child.pid);
    }
    for (const childPid of descendantPids.reverse()) {
      if (signalTargetExists(childPid)) {
        await runTaskkill(childPid);
      }
    }
    await waitForExit(child, FORCE_WAIT_MS);
    return;
  }

  if (child.pid !== undefined && process.platform !== 'win32') {
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

  if (isExited(child)) {
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
