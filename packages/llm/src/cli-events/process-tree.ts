import { spawn, spawnSync, type ChildProcess } from 'node:child_process';

// Keep this file in sync with packages/agent/src/runtime/process-tree.ts.
// @kodax-ai/llm intentionally does not depend on @kodax-ai/agent.

const TASKKILL_TIMEOUT_MS = 2_000;
const FORCE_WAIT_MS = 2_000;
const NATIVE_SNAPSHOT_TIMEOUT_MS = 5_000;
const NATIVE_PARENT_PROCESS_SOURCE = String.raw`
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class KodaXNativeProcessSnapshot {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
  private struct ProcessEntry32 {
    public uint dwSize;
    public uint cntUsage;
    public uint th32ProcessID;
    public IntPtr th32DefaultHeapID;
    public uint th32ModuleID;
    public uint cntThreads;
    public uint th32ParentProcessID;
    public int pcPriClassBase;
    public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
    public string szExeFile;
  }
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);
  [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
  private static extern bool Process32First(IntPtr snapshot, ref ProcessEntry32 entry);
  [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
  private static extern bool Process32Next(IntPtr snapshot, ref ProcessEntry32 entry);
  [DllImport("kernel32.dll")]
  private static extern bool CloseHandle(IntPtr handle);
  public static string ReadRows() {
    var snapshot = CreateToolhelp32Snapshot(2, 0);
    if (snapshot == new IntPtr(-1)) return string.Empty;
    var rows = new StringBuilder();
    var entry = new ProcessEntry32();
    entry.dwSize = (uint)Marshal.SizeOf(entry);
    try {
      if (!Process32First(snapshot, ref entry)) return string.Empty;
      do {
        rows.Append(entry.th32ProcessID).Append(',').Append(entry.th32ParentProcessID).Append('\n');
        entry.dwSize = (uint)Marshal.SizeOf(entry);
      } while (Process32Next(snapshot, ref entry));
      return rows.ToString();
    } finally {
      CloseHandle(snapshot);
    }
  }
}`;

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

function runTaskkill(pid: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const killer = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    let settled = false;
    const finish = (succeeded: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(succeeded);
    };
    const timer = setTimeout(() => {
      try {
        killer.kill();
      } catch {
        // Best-effort fallback.
      }
      finish(false);
    }, TASKKILL_TIMEOUT_MS);
    timer.unref?.();
    killer.once('exit', (code) => finish(code === 0));
    killer.once('error', () => finish(false));
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

async function waitForWindowsPidExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!signalTargetExists(pid)) {
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return !signalTargetExists(pid);
}

async function waitForWindowsPidsExit(pids: readonly number[], timeoutMs: number): Promise<boolean> {
  const uniquePids = [...new Set(pids.filter((pid) => Number.isFinite(pid) && pid > 0))];
  if (uniquePids.length === 0) {
    return true;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (uniquePids.every((pid) => !signalTargetExists(pid))) {
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return uniquePids.every((pid) => !signalTargetExists(pid));
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
  // Mirror the agent copy: CIM first, partial stdout accepted, WMIC fallback.
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
  const partialPids = readWindowsPidListJson(result.stdout);
  if (partialPids.length > 0) return partialPids;
  return getWindowsChildPidsViaWmic(parentPid);
}

function collectWindowsDescendantPidsNative(parentPid: number): number[] {
  const script = [
    "$source = @'",
    NATIVE_PARENT_PROCESS_SOURCE,
    "'@",
    'Add-Type -TypeDefinition $source',
    '[KodaXNativeProcessSnapshot]::ReadRows()',
  ].join('\n');
  const result = spawnSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    script,
  ], {
    encoding: 'utf8',
    timeout: NATIVE_SNAPSHOT_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) return [];
  return collectDescendantsFromProcessRows(result.stdout, parentPid);
}

function collectDescendantsFromProcessRows(stdout: string, parentPid: number): number[] {
  const children = new Map<number, number[]>();
  for (const line of stdout.split(/\r?\n/)) {
    const [pidText, parentText] = line.split(',', 2);
    const pid = Number(pidText);
    const parent = Number(parentText);
    if (!Number.isFinite(pid) || pid <= 0 || !Number.isFinite(parent)) continue;
    children.set(parent, [...(children.get(parent) ?? []), pid]);
  }

  const descendants: number[] = [];
  const pending = [parentPid];
  const seen = new Set<number>([parentPid]);
  while (pending.length > 0) {
    const parent = pending.shift();
    if (parent === undefined) break;
    for (const child of children.get(parent) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      descendants.push(child);
      pending.push(child);
    }
  }
  return descendants;
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

async function killWindowsPid(pid: number, signal: NodeJS.Signals): Promise<boolean> {
  try {
    process.kill(pid, signal);
  } catch {
    return !signalTargetExists(pid);
  }
  return waitForWindowsPidExit(pid, FORCE_WAIT_MS);
}

export async function killChildProcessTree(child: ChildProcess): Promise<void> {
  if (process.platform === 'win32' && child.pid !== undefined) {
    const taskkillSucceeded = !isExited(child) && await runTaskkill(child.pid);
    if (taskkillSucceeded && await waitForWindowsPidsExit([child.pid], FORCE_WAIT_MS)) {
      await waitForExit(child, FORCE_WAIT_MS);
      return;
    }

    let descendantPids = collectWindowsDescendantPidsNative(child.pid);
    if (descendantPids.length === 0) {
      descendantPids = collectWindowsDescendantPids(child.pid);
    }
    const killOrder = [...descendantPids].reverse();
    const targets = [child.pid, ...descendantPids];

    for (const childPid of killOrder) {
      if (signalTargetExists(childPid)) {
        await killWindowsPid(childPid, 'SIGTERM');
      }
    }
    await killWindowsPid(child.pid, 'SIGTERM');
    if (await waitForWindowsPidsExit(targets, FORCE_WAIT_MS)) {
      await waitForExit(child, FORCE_WAIT_MS);
      return;
    }

    for (const childPid of killOrder) {
      if (signalTargetExists(childPid)) {
        await killWindowsPid(childPid, 'SIGKILL');
      }
    }
    await killWindowsPid(child.pid, 'SIGKILL');
    await waitForWindowsPidsExit(targets, FORCE_WAIT_MS);
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
