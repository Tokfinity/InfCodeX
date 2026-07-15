import {
  spawn,
  spawnSync,
  type ChildProcess,
} from 'node:child_process';

// Keep this file in sync with packages/llm/src/cli-events/process-tree.ts.
// @kodax-ai/llm stays dependency-light, so it carries a small local copy.

const DEFAULT_GRACE_MS = 300;
const DEFAULT_FORCE_MS = 2_000;
const DEFAULT_TASKKILL_MS = 5_000;
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

function runTaskkill(pid: number, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const killer = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (succeeded: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      resolve(succeeded);
    };
    timer = setTimeout(() => {
      try {
        killer.kill();
      } catch {
        // Best-effort cleanup fallback; caller may still try direct kill.
      }
      finish(false);
    }, timeoutMs);
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
    // The child may not be a process-group leader (older registrations or
    // callers that did not use detached:true). Fall back to direct PID below.
  }

  try {
    process.kill(pid, signal);
    signaled = true;
  } catch {
    // If the group signal succeeded, the direct PID may already be gone.
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
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isPosixPidTreeAlive(pid);
}

async function waitForWindowsPidExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!signalTargetExists(pid)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
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
    await new Promise((resolve) => setTimeout(resolve, 50));
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
    timeout: DEFAULT_TASKKILL_MS,
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
    timeout: DEFAULT_TASKKILL_MS,
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

function getWindowsChildPids(parentPid: number): number[] {
  // Mirror the llm copy: CIM first, partial stdout accepted, WMIC fallback.
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
    timeout: DEFAULT_TASKKILL_MS,
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

async function killWindowsPid(pid: number, signal: NodeJS.Signals, timeoutMs: number): Promise<boolean> {
  try {
    process.kill(pid, signal);
  } catch {
    return !signalTargetExists(pid);
  }
  return waitForWindowsPidExit(pid, timeoutMs);
}

export async function killPidTree(
  pid: number,
  options: ProcessTreeKillOptions = {},
): Promise<void> {
  if (process.platform === 'win32') {
    const taskkillMs = options.taskkillMs ?? DEFAULT_TASKKILL_MS;
    const forceMs = options.forceMs ?? DEFAULT_FORCE_MS;

    const taskkillSucceeded = await runTaskkill(pid, taskkillMs);
    if (taskkillSucceeded && await waitForWindowsPidsExit([pid], forceMs)) {
      return;
    }

    // `taskkill /t` depends on Windows management services and can fail under
    // load. Snapshot parent links before direct-killing the root so orphaned
    // descendants remain addressable without WMI.
    let descendantPids = collectWindowsDescendantPidsNative(pid);
    if (descendantPids.length === 0) {
      descendantPids = collectWindowsDescendantPids(pid);
    }
    const killOrder = [...descendantPids].reverse();
    const targets = [pid, ...descendantPids];

    for (const childPid of killOrder) {
      if (signalTargetExists(childPid)) {
        await killWindowsPid(childPid, 'SIGTERM', forceMs);
      }
    }
    await killWindowsPid(pid, 'SIGTERM', forceMs);
    if (await waitForWindowsPidsExit(targets, forceMs)) {
      return;
    }

    for (const childPid of killOrder) {
      if (signalTargetExists(childPid)) {
        await killWindowsPid(childPid, 'SIGKILL', forceMs);
      }
    }
    await killWindowsPid(pid, 'SIGKILL', forceMs);
    await waitForWindowsPidsExit(targets, forceMs);
    return;
  }

  const forceMs = options.forceMs ?? DEFAULT_FORCE_MS;
  if (!signalPosixPidTree(pid, 'SIGTERM')) {
    return;
  }
  if (await waitForPosixPidTreeExit(pid, forceMs)) {
    return;
  }
  signalPosixPidTree(pid, 'SIGKILL');
  await waitForPosixPidTreeExit(pid, forceMs);
}

export function killPidTreeSync(pid: number): void {
  if (process.platform === 'win32') {
    const descendantPids = collectWindowsDescendantPids(pid);
    spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    for (const childPid of descendantPids.reverse()) {
      spawnSync('taskkill', ['/pid', String(childPid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    }
    return;
  }

  signalPosixPidTree(pid, 'SIGTERM');
  signalPosixPidTree(pid, 'SIGKILL');
}

export async function killChildProcessTree(
  child: ChildProcess,
  options: ProcessTreeKillOptions = {},
): Promise<void> {
  const gracefulMs = options.gracefulMs ?? DEFAULT_GRACE_MS;
  const forceMs = options.forceMs ?? DEFAULT_FORCE_MS;

  if (options.gracefulStdinEnd && !isChildProcessExited(child) && child.stdin?.writable) {
    try {
      child.stdin.end();
    } catch {
      // Fall through to forceful termination below.
    }
    if (await waitForChildProcessExit(child, gracefulMs) && process.platform === 'win32') {
      return;
    }
  }

  if (child.pid !== undefined && process.platform !== 'win32') {
    if (!signalPosixPidTree(child.pid, 'SIGTERM')) {
      return;
    }
    if (await waitForPosixPidTreeExit(child.pid, forceMs)) {
      return;
    }
    signalPosixPidTree(child.pid, 'SIGKILL');
    await waitForPosixPidTreeExit(child.pid, forceMs);
    return;
  }

  if (isChildProcessExited(child)) {
    return;
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
  if (child.pid === undefined) {
    return;
  }

  if (process.platform === 'win32' && isChildProcessExited(child)) {
    return;
  }

  killPidTreeSync(child.pid);
}
