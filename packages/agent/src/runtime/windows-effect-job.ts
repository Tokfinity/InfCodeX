import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const PAYLOAD_ENV = 'KODAX_EFFECT_JOB_PAYLOAD';
const STARTUP_TIMEOUT_MS = 15_000;
const SUPERVISOR_OUTPUT_LIMIT = 8_192;

const WINDOWS_EFFECT_JOB_SOURCE = String.raw`
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

public static class KodaXEffectJob {
  [StructLayout(LayoutKind.Sequential)]
  private struct IoCounters {
    public ulong ReadOperationCount;
    public ulong WriteOperationCount;
    public ulong OtherOperationCount;
    public ulong ReadTransferCount;
    public ulong WriteTransferCount;
    public ulong OtherTransferCount;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct BasicLimitInformation {
    public long PerProcessUserTimeLimit;
    public long PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize;
    public UIntPtr MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass;
    public uint SchedulingClass;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct ExtendedLimitInformation {
    public BasicLimitInformation BasicLimitInformation;
    public IoCounters IoInfo;
    public UIntPtr ProcessMemoryLimit;
    public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed;
    public UIntPtr PeakJobMemoryUsed;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct BasicAccountingInformation {
    public long TotalUserTime;
    public long TotalKernelTime;
    public long ThisPeriodTotalUserTime;
    public long ThisPeriodTotalKernelTime;
    public uint TotalPageFaultCount;
    public uint TotalProcesses;
    public uint ActiveProcesses;
    public uint TotalTerminatedProcesses;
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool SetInformationJobObject(
    IntPtr job,
    int infoClass,
    ref ExtendedLimitInformation info,
    uint length);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool QueryInformationJobObject(
    IntPtr job,
    int infoClass,
    out BasicAccountingInformation info,
    uint length,
    IntPtr returnLength);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern IntPtr OpenProcess(uint access, bool inheritHandle, uint processId);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool CloseHandle(IntPtr handle);

  private const uint Synchronize = 0x00100000;
  private const uint ProcessTerminate = 0x0001;
  private const uint ProcessSetQuota = 0x0100;
  private const uint ProcessQueryLimitedInformation = 0x1000;
  private const uint JobObjectLimitKillOnJobClose = 0x00002000;
  private const uint WaitObject0 = 0;

  private static void Require(bool result, string operation) {
    if (!result) throw new InvalidOperationException(
      operation + " failed with Win32 error " + Marshal.GetLastWin32Error());
  }

  private static void PublishReady() {
    Console.Out.WriteLine("READY");
    Console.Out.Flush();
  }

  public static void Run(uint targetPid, uint ownerPid, string jobName) {
    var job = CreateJobObjectW(IntPtr.Zero, jobName);
    if (job == IntPtr.Zero) throw new InvalidOperationException(
      "CreateJobObject failed with Win32 error " + Marshal.GetLastWin32Error());
    var processAccess = Synchronize | ProcessTerminate | ProcessSetQuota | ProcessQueryLimitedInformation;
    var target = OpenProcess(processAccess, false, targetPid);
    var owner = OpenProcess(Synchronize, false, ownerPid);
    if (target == IntPtr.Zero || owner == IntPtr.Zero) {
      if (target != IntPtr.Zero) CloseHandle(target);
      if (owner != IntPtr.Zero) CloseHandle(owner);
      CloseHandle(job);
      throw new InvalidOperationException(
        "OpenProcess failed with Win32 error " + Marshal.GetLastWin32Error());
    }
    try {
      var limits = new ExtendedLimitInformation();
      limits.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;
      Require(SetInformationJobObject(
        job,
        9,
        ref limits,
        (uint)Marshal.SizeOf(typeof(ExtendedLimitInformation))),
        "SetInformationJobObject");
      Require(AssignProcessToJobObject(job, target), "AssignProcessToJobObject");
      PublishReady();

      uint targetExitCode = 1;
      while (true) {
        if (WaitForSingleObject(owner, 0) == WaitObject0) break;
        if (WaitForSingleObject(target, 0) == WaitObject0) {
          GetExitCodeProcess(target, out targetExitCode);
          break;
        }
        Thread.Sleep(20);
      }

      Require(TerminateJobObject(job, targetExitCode), "TerminateJobObject");
      while (true) {
        BasicAccountingInformation accounting;
        Require(QueryInformationJobObject(
          job,
          1,
          out accounting,
          (uint)Marshal.SizeOf(typeof(BasicAccountingInformation)),
          IntPtr.Zero),
          "QueryInformationJobObject");
        if (accounting.ActiveProcesses == 0) return;
        Thread.Sleep(10);
      }
    } finally {
      CloseHandle(owner);
      CloseHandle(target);
      CloseHandle(job);
    }
  }
}`;

const WINDOWS_EFFECT_JOB_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
try {
  $payload = [Text.Encoding]::UTF8.GetString(
    [Convert]::FromBase64String($env:${PAYLOAD_ENV})) | ConvertFrom-Json
  Remove-Item Env:${PAYLOAD_ENV} -ErrorAction SilentlyContinue
  $source = @'
${WINDOWS_EFFECT_JOB_SOURCE}
'@
  Add-Type -TypeDefinition $source
  [KodaXEffectJob]::Run(
    [uint32]$payload.targetPid,
    [uint32]$payload.ownerPid,
    [string]$payload.jobName)
  exit 0
} catch {
  [Console]::Out.WriteLine('ERROR:' + $_.Exception.Message)
  [Console]::Out.Flush()
  exit 1
}`;

const WINDOWS_EFFECT_JOB_ENCODED_COMMAND = Buffer.from(
  WINDOWS_EFFECT_JOB_SCRIPT,
  'utf16le',
).toString('base64');

export interface WindowsEffectJob {
  /** Resolves only after the Job reports zero active processes. */
  readonly drained: Promise<void>;
  /** The process that owns the Job handle and proves the effect is still fenced. */
  readonly supervisorPid: number;
  /** Stops the supervisor and its pipes from keeping the Node.js event loop alive. */
  unref?(): void;
}

function unrefIfSupported(resource: object | null): void {
  if (resource === null) return;
  const unref = Reflect.get(resource, 'unref');
  if (typeof unref === 'function') unref.call(resource);
}

export async function containWindowsEffectProcess(
  processPid: number,
  ownerPid = process.pid,
): Promise<WindowsEffectJob> {
  if (process.platform !== 'win32') {
    throw new Error('Windows effect Job containment is available only on Windows.');
  }
  const powershell = path.join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  const payload = Buffer.from(JSON.stringify({
    targetPid: processPid,
    ownerPid,
    jobName: `KodaXEffect-${randomUUID()}`,
  }), 'utf8').toString('base64');
  let supervisor: ChildProcess;
  try {
    supervisor = spawn(powershell, [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      WINDOWS_EFFECT_JOB_ENCODED_COMMAND,
    ], {
      env: { ...process.env, [PAYLOAD_ENV]: payload },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (error) {
    throw error;
  }
  const drained = new Promise<void>((resolve, reject) => {
    supervisor.once('error', reject);
    supervisor.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Windows effect Job supervisor exited with code ${String(code)}.`));
    });
  });
  // The supervisor can fail after READY but before its owner reaches the
  // eventual drain await. Observe that rejection immediately while preserving
  // the original promise for the caller's authoritative result.
  void drained.catch(() => undefined);
  if (supervisor.pid === undefined) {
    try {
      await drained;
    } catch (error: unknown) {
      throw new Error('Windows effect Job supervisor failed to start.', { cause: error });
    }
    throw new Error('Windows effect Job supervisor did not expose a process ID.');
  }
  try {
    await waitForEffectJobReady(supervisor);
  } catch (error) {
    supervisor.kill();
    await drained.catch(() => undefined);
    throw error;
  }
  supervisor.stdout?.resume();
  supervisor.stderr?.resume();
  let unreferenced = false;
  return {
    drained,
    supervisorPid: supervisor.pid,
    unref: () => {
      if (unreferenced) return;
      unreferenced = true;
      supervisor.unref();
      unrefIfSupported(supervisor.stdout);
      unrefIfSupported(supervisor.stderr);
    },
  };
}

function waitForEffectJobReady(supervisor: ChildProcess): Promise<void> {
  const stdout = supervisor.stdout;
  const stderr = supervisor.stderr;
  if (stdout === null) {
    return Promise.reject(new Error('Windows effect Job supervisor stdout is unavailable.'));
  }
  return new Promise<void>((resolve, reject) => {
    let stdoutBuffer = '';
    let stderrBuffer = '';
    const timer = setTimeout(() => {
      settle(new Error('Windows effect Job supervisor did not become ready in time.'));
    }, STARTUP_TIMEOUT_MS);
    const cleanup = (): void => {
      clearTimeout(timer);
      stdout.off('data', onStdout);
      stderr?.off('data', onStderr);
      supervisor.off('error', onError);
      supervisor.off('exit', onExit);
    };
    const settle = (error?: Error): void => {
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onStdout = (chunk: Buffer | string): void => {
      stdoutBuffer = `${stdoutBuffer}${chunk.toString()}`.slice(-SUPERVISOR_OUTPUT_LIMIT);
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line === 'READY') {
          settle();
          return;
        }
        if (line.startsWith('ERROR:')) {
          settle(new Error(line.slice('ERROR:'.length)));
          return;
        }
      }
    };
    const onStderr = (chunk: Buffer | string): void => {
      stderrBuffer = `${stderrBuffer}${chunk.toString()}`.slice(-SUPERVISOR_OUTPUT_LIMIT);
    };
    const onError = (error: Error): void => settle(error);
    const onExit = (): void => settle(new Error(
      `Windows effect Job supervisor exited before readiness${
        stderrBuffer ? `: ${stderrBuffer.trim()}` : '.'
      }`,
    ));
    stdout.on('data', onStdout);
    stderr?.on('data', onStderr);
    supervisor.once('error', onError);
    supervisor.once('exit', onExit);
  });
}
