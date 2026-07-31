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
  [StructLayout(LayoutKind.Sequential)]
  private struct FileTime {
    public uint Low;
    public uint High;
  }
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern IntPtr OpenProcess(uint access, bool inheritHandle, uint processId);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GetProcessTimes(IntPtr process, out FileTime creation, out FileTime exit, out FileTime kernel, out FileTime user);
  [DllImport("kernel32.dll")]
  private static extern void GetSystemTimeAsFileTime(out FileTime systemTime);
  [DllImport("kernel32.dll")]
  private static extern bool CloseHandle(IntPtr handle);
  private static ulong ReadCreationTime(uint processId) {
    var process = OpenProcess(0x1000, false, processId);
    if (process == IntPtr.Zero) return 0;
    try {
      FileTime creation, exit, kernel, user;
      if (!GetProcessTimes(process, out creation, out exit, out kernel, out user)) return 0;
      return ((ulong)creation.High << 32) | creation.Low;
    } finally {
      CloseHandle(process);
    }
  }
  public static string ReadRows() {
    FileTime cutoffTime;
    GetSystemTimeAsFileTime(out cutoffTime);
    var cutoff = (((ulong)cutoffTime.High << 32) | cutoffTime.Low) / 10000;
    var snapshot = CreateToolhelp32Snapshot(2, 0);
    if (snapshot == new IntPtr(-1)) return string.Empty;
    var rows = new StringBuilder();
    var entry = new ProcessEntry32();
    entry.dwSize = (uint)Marshal.SizeOf(entry);
    try {
      if (!Process32First(snapshot, ref entry)) return string.Empty;
      do {
        var creationTime = ReadCreationTime(entry.th32ProcessID) / 10000;
        if (creationTime == 0 || creationTime <= cutoff) {
          rows.Append(entry.th32ProcessID).Append(',').Append(entry.th32ParentProcessID).Append(',').Append(creationTime).Append('\n');
        }
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

interface WindowsProcessIdentity {
  readonly pid: number;
  readonly parentPid: number;
  readonly creationTime: string;
}

function parseWindowsProcessSnapshotJson(stdout: string): WindowsProcessIdentity[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.flatMap((row) => {
      if (typeof row !== 'object' || row === null) return [];
      const record = row as Record<string, unknown>;
      const pid = Number(record.pid);
      const parentPid = Number(record.parentPid);
      const creationTime = typeof record.creationTime === 'string'
        ? record.creationTime
        : String(record.creationTime ?? '0');
      if (!Number.isFinite(pid) || pid <= 0 || !Number.isFinite(parentPid)) return [];
      return [{ pid, parentPid, creationTime }];
    });
  } catch {
    return [];
  }
}

function parseWmicCreationTime(
  value: string,
): { readonly identity: string; readonly unixMs: number } | undefined {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{6})([+-])(\d{3})$/.exec(value);
  if (!match) return undefined;
  const [, year, month, day, hour, minute, second, fraction, sign, offset] = match;
  const localMs = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    Number(fraction.slice(0, 3)),
  );
  const offsetMs = Number(offset) * 60_000 * (sign === '+' ? 1 : -1);
  const unixMs = localMs - offsetMs;
  if (!Number.isFinite(unixMs)) return undefined;
  return {
    identity: (BigInt(unixMs) + 11_644_473_600_000n).toString(),
    unixMs,
  };
}

function readWindowsProcessSnapshotFallback(): WindowsProcessIdentity[] | undefined {
  const script = [
    '$cutoff = [DateTime]::UtcNow',
    '$items = try { @(Get-CimInstance Win32_Process -ErrorAction Stop) } catch { @(Get-WmiObject Win32_Process -ErrorAction Stop) }',
    '$rows = @($items | ForEach-Object {',
    "  $creationTime = '0'",
    '  try {',
    '    $created = $_.CreationDate',
    '    if ($created -isnot [DateTime]) { $created = [System.Management.ManagementDateTimeConverter]::ToDateTime([string]$created) }',
    '    $created = $created.ToUniversalTime()',
    '    if ($created -le $cutoff) { $creationTime = ([long][Math]::Floor($created.ToFileTimeUtc() / 10000)).ToString() }',
    '  } catch {}',
    '  [PSCustomObject]@{ pid = [int]$_.ProcessId; parentPid = [int]$_.ParentProcessId; creationTime = $creationTime }',
    '})',
    '$rows | ConvertTo-Json -Compress',
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
  if (!result.error && result.status === 0) {
    const snapshot = parseWindowsProcessSnapshotJson(result.stdout);
    if (snapshot.length > 0) return snapshot;
  }

  const cutoffUnixMs = Date.now();
  const wmic = spawnSync('wmic', [
    'process',
    'get',
    'CreationDate,ParentProcessId,ProcessId',
    '/format:list',
  ], {
    encoding: 'utf8',
    timeout: NATIVE_SNAPSHOT_TIMEOUT_MS,
    windowsHide: true,
  });
  if (wmic.error || wmic.status !== 0) return undefined;
  const snapshot = wmic.stdout.split(/\r?\n\s*\r?\n/).flatMap((block) => {
    const values = new Map(
      block.split(/\r?\n/).flatMap((line): Array<[string, string]> => {
        const separator = line.indexOf('=');
        return separator < 0 ? [] : [[line.slice(0, separator), line.slice(separator + 1)]];
      }),
    );
    const pid = Number(values.get('ProcessId'));
    const parentPid = Number(values.get('ParentProcessId'));
    const creationTime = values.get('CreationDate');
    const parsedCreationTime = creationTime === undefined
      ? undefined
      : parseWmicCreationTime(creationTime);
    if (
      !Number.isFinite(pid)
      || pid <= 0
      || !Number.isFinite(parentPid)
      || parsedCreationTime === undefined
      || parsedCreationTime.unixMs > cutoffUnixMs
    ) return [];
    return [{ pid, parentPid, creationTime: parsedCreationTime.identity }];
  });
  return snapshot.length > 0 ? snapshot : undefined;
}

function readWindowsProcessSnapshotNative(): WindowsProcessIdentity[] | undefined {
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
  if (result.error || result.status !== 0) return undefined;
  const snapshot = result.stdout.split(/\r?\n/).flatMap((line) => {
    const [pidText, parentText, creationTime = '0'] = line.split(',', 3);
    const pid = Number(pidText);
    const parentPid = Number(parentText);
    if (!Number.isFinite(pid) || pid <= 0 || !Number.isFinite(parentPid)) return [];
    return [{ pid, parentPid, creationTime }];
  });
  return snapshot.length > 0 ? snapshot : undefined;
}

function readWindowsProcessSnapshot(): WindowsProcessIdentity[] | undefined {
  const nativeSnapshot = readWindowsProcessSnapshotNative();
  return nativeSnapshot ?? readWindowsProcessSnapshotFallback();
}

function collectDescendantIdentities(
  snapshot: readonly WindowsProcessIdentity[],
  parentPid: number,
): WindowsProcessIdentity[] {
  const children = new Map<number, WindowsProcessIdentity[]>();
  for (const identity of snapshot) {
    children.set(identity.parentPid, [
      ...(children.get(identity.parentPid) ?? []),
      identity,
    ]);
  }

  const descendants: WindowsProcessIdentity[] = [];
  const pending = [parentPid];
  const seen = new Set<number>([parentPid]);
  while (pending.length > 0) {
    const parent = pending.shift();
    if (parent === undefined) break;
    for (const child of children.get(parent) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      descendants.push(child);
      pending.push(child.pid);
    }
  }
  return descendants;
}

function currentCapturedWindowsPids(
  captured: readonly WindowsProcessIdentity[],
): Set<number> | undefined {
  const snapshot = readWindowsProcessSnapshot();
  if (snapshot === undefined) return undefined;
  const uncertainPids = new Set(
    snapshot
      .filter((identity) => identity.creationTime === '0')
      .map((identity) => identity.pid),
  );
  if (captured.some((identity) => uncertainPids.has(identity.pid))) return undefined;
  const currentKeys = new Set(
    snapshot
      .filter((identity) => identity.creationTime !== '0')
      .map((identity) => `${identity.pid}:${identity.creationTime}`),
  );
  return new Set(
    captured
      .filter((identity) => identity.creationTime !== '0')
      .filter((identity) => currentKeys.has(`${identity.pid}:${identity.creationTime}`))
      .map((identity) => identity.pid),
  );
}

async function waitForCapturedWindowsProcessesExit(
  captured: readonly WindowsProcessIdentity[],
  timeoutMs: number,
): Promise<boolean> {
  if (captured.length === 0) return false;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const currentPids = currentCapturedWindowsPids(captured);
    if (currentPids !== undefined && currentPids.size === 0) return true;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return currentCapturedWindowsPids(captured)?.size === 0;
}

async function killWindowsPid(pid: number, signal: NodeJS.Signals): Promise<boolean> {
  try {
    process.kill(pid, signal);
  } catch {
    return !signalTargetExists(pid);
  }
  return waitForWindowsPidExit(pid, FORCE_WAIT_MS);
}

async function killCapturedWindowsProcess(
  identity: WindowsProcessIdentity,
  signal: NodeJS.Signals,
): Promise<boolean> {
  if (currentCapturedWindowsPids([identity])?.has(identity.pid) !== true) return true;
  return killWindowsPid(identity.pid, signal);
}

export async function killChildProcessTree(child: ChildProcess): Promise<void> {
  if (process.platform === 'win32' && child.pid !== undefined && !isExited(child)) {
    const snapshot = readWindowsProcessSnapshot();
    const rootIdentity = snapshot?.find(
      (identity) => identity.pid === child.pid && identity.creationTime !== '0',
    );
    const descendantIdentities = collectDescendantIdentities(snapshot ?? [], child.pid)
      .filter((identity) => identity.creationTime !== '0');
    const killOrder = [...descendantIdentities].reverse();
    const captured = rootIdentity === undefined
      ? descendantIdentities
      : [rootIdentity, ...descendantIdentities];
    const taskkillSucceeded = rootIdentity !== undefined
      && currentCapturedWindowsPids([rootIdentity])?.has(child.pid) === true
      && await runTaskkill(child.pid);
    if (taskkillSucceeded && await waitForCapturedWindowsProcessesExit(captured, FORCE_WAIT_MS)) {
      if (await waitForExit(child, FORCE_WAIT_MS)) return;
    }

    for (const identity of killOrder) {
      await killCapturedWindowsProcess(identity, 'SIGTERM');
    }
    if (rootIdentity !== undefined) {
      await killCapturedWindowsProcess(rootIdentity, 'SIGTERM');
    }
    if (await waitForCapturedWindowsProcessesExit(captured, FORCE_WAIT_MS)) {
      if (await waitForExit(child, FORCE_WAIT_MS)) return;
    }

    for (const identity of killOrder) {
      await killCapturedWindowsProcess(identity, 'SIGKILL');
    }
    if (rootIdentity !== undefined) {
      await killCapturedWindowsProcess(rootIdentity, 'SIGKILL');
    }
    await waitForCapturedWindowsProcessesExit(captured, FORCE_WAIT_MS);
    if (await waitForExit(child, FORCE_WAIT_MS)) return;
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
