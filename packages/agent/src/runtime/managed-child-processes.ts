import { spawnSync, type ChildProcess } from 'node:child_process';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { getAgentConfigPath } from './agent-home.js';
import { killPidTree } from './process-tree.js';

const REGISTRY_VERSION = 1;
const WINDOWS_CREATION_SKEW_MS = 60_000;
const PROCESS_QUERY_TIMEOUT_MS = 5_000;
const PID_EXIT_WAIT_MS = 2_000;

export interface ManagedChildProcessMetadata {
  readonly kind: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
}

interface ManagedChildProcessRecord extends ManagedChildProcessMetadata {
  readonly version: typeof REGISTRY_VERSION;
  readonly pid: number;
  readonly ownerPid: number;
  readonly registeredAtMs: number;
}

interface ActiveManagedChildProcess {
  readonly record: ManagedChildProcessRecord;
  readonly child: Pick<ChildProcess, 'exitCode' | 'signalCode'>;
}

const activeChildren = new Map<number, ActiveManagedChildProcess>();

export interface ManagedChildCleanupSummary {
  readonly killed: number;
  readonly pruned: number;
  readonly skipped: number;
}

interface CleanupOptions {
  readonly includeCurrentOwner?: boolean;
}

interface WindowsProcessInfo {
  readonly ProcessId?: number;
  readonly CreationDate?: string;
  readonly CommandLine?: string;
}

type WindowsProcessLookup =
  | { readonly status: 'found'; readonly info: WindowsProcessInfo }
  | { readonly status: 'missing' }
  | { readonly status: 'unknown' };

type PosixCommandLineLookup =
  | { readonly status: 'found'; readonly commandLine: string }
  | { readonly status: 'missing' }
  | { readonly status: 'unknown' };

function registryDir(): string {
  return getAgentConfigPath('processes', 'children');
}

function registryPath(pid: number): string {
  return path.join(registryDir(), `${pid}.json`);
}

function writeRecord(record: ManagedChildProcessRecord): void {
  mkdirSync(registryDir(), { recursive: true });
  writeFileSync(registryPath(record.pid), JSON.stringify(record), 'utf8');
}

function removeRecord(pid: number): void {
  activeChildren.delete(pid);
  rmSync(registryPath(pid), { force: true });
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function commandNeedle(command: string): string {
  return path.basename(command).toLowerCase();
}

function tokenMatches(token: string, commandLine: string): boolean {
  const haystack = commandLine.toLowerCase();
  const raw = token.toLowerCase();
  if (haystack.includes(raw)) {
    return true;
  }
  const basename = path.basename(raw);
  return basename.length > 3 && haystack.includes(basename);
}

function significantArg(arg: string): boolean {
  return arg.length > 3 && !arg.startsWith('-');
}

function commandMatches(record: ManagedChildProcessRecord, commandLine: string): boolean {
  const haystack = commandLine.toLowerCase();
  if (!tokenMatches(record.command, haystack) && !haystack.includes(commandNeedle(record.command))) {
    return false;
  }
  const args = record.args?.filter(significantArg) ?? [];
  return args.length === 0 || args.some((arg) => tokenMatches(arg, haystack));
}

function argsMatch(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  const a = left ?? [];
  const b = right ?? [];
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function activeChildMatchesRecord(record: ManagedChildProcessRecord): boolean {
  if (record.ownerPid !== process.pid) {
    return false;
  }
  const active = activeChildren.get(record.pid);
  if (!active || active.child.exitCode !== null || active.child.signalCode !== null) {
    return false;
  }
  return active.record.registeredAtMs === record.registeredAtMs
    && active.record.kind === record.kind
    && active.record.command === record.command
    && argsMatch(active.record.args, record.args)
    && active.record.cwd === record.cwd;
}

function parseWindowsDate(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const dmtf = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{1,6})([+-]\d{3})/.exec(value);
  if (dmtf) {
    const [, year, month, day, hour, minute, second, micros, offset] = dmtf;
    const utcMs = Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
      Number(micros.slice(0, 3).padEnd(3, '0')),
    );
    return utcMs - Number(offset) * 60_000;
  }
  const match = /\/Date\((\d+)\)\//.exec(value);
  if (match?.[1]) {
    return Number(match[1]);
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function decodeWmicValue(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function parseWmicListOutput(stdout: string): WindowsProcessInfo | undefined {
  const info: {
    ProcessId?: number;
    CreationDate?: string;
    CommandLine?: string;
  } = {};
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    const separator = line.indexOf('=');
    if (separator <= 0) {
      continue;
    }
    const key = line.slice(0, separator);
    const value = decodeWmicValue(line.slice(separator + 1).trim());
    if (key === 'ProcessId') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        info.ProcessId = parsed;
      }
    } else if (key === 'CreationDate') {
      info.CreationDate = value;
    } else if (key === 'CommandLine') {
      info.CommandLine = value;
    }
  }
  return info.ProcessId === undefined ? undefined : info;
}

function getWindowsProcessInfoViaWmic(pid: number): WindowsProcessLookup {
  const result = spawnSync('wmic', [
    'process',
    'where',
    `ProcessId=${pid}`,
    'get',
    'ProcessId,CreationDate,CommandLine',
    '/format:list',
  ], {
    encoding: 'utf8',
    timeout: PROCESS_QUERY_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.error) {
    return { status: 'unknown' };
  }
  if (result.status !== 0) {
    return { status: 'unknown' };
  }
  const info = parseWmicListOutput(result.stdout);
  return info ? { status: 'found', info } : { status: 'missing' };
}

function getWindowsProcessInfo(pid: number): WindowsProcessLookup {
  const script = [
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"`,
    'if ($null -eq $p) { exit 0 }',
    '$p | Select-Object ProcessId,CreationDate,CommandLine | ConvertTo-Json -Compress',
  ].join('; ');
  const result = spawnSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    script,
  ], {
    encoding: 'utf8',
    timeout: PROCESS_QUERY_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.error) {
    return getWindowsProcessInfoViaWmic(pid);
  }
  if (result.status !== 0) {
    return getWindowsProcessInfoViaWmic(pid);
  }
  if (!result.stdout.trim()) {
    return { status: 'missing' };
  }
  try {
    return { status: 'found', info: JSON.parse(result.stdout) as WindowsProcessInfo };
  } catch {
    return getWindowsProcessInfoViaWmic(pid);
  }
}

function getPosixCommandLine(pid: number): PosixCommandLineLookup {
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'command='], {
    encoding: 'utf8',
    timeout: PROCESS_QUERY_TIMEOUT_MS,
  });
  if (result.error) {
    return { status: 'unknown' };
  }
  if (result.status !== 0) {
    return { status: 'missing' };
  }
  const commandLine = result.stdout.trim();
  if (!commandLine) {
    return { status: 'missing' };
  }
  return { status: 'found', commandLine };
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isPidAlive(pid);
}

function isConfirmedRecord(record: ManagedChildProcessRecord): boolean | undefined {
  if (process.platform === 'win32') {
    const lookup = getWindowsProcessInfo(record.pid);
    if (lookup.status === 'unknown') {
      return undefined;
    }
    if (lookup.status === 'missing') {
      return false;
    }
    const info = lookup.info;
    if (!info?.CommandLine || !commandMatches(record, info.CommandLine)) {
      return false;
    }
    const creationMs = parseWindowsDate(info.CreationDate);
    if (creationMs === undefined) {
      return undefined;
    }
    return creationMs <= record.registeredAtMs + 5_000
      && creationMs >= record.registeredAtMs - WINDOWS_CREATION_SKEW_MS;
  }

  const lookup = getPosixCommandLine(record.pid);
  if (lookup.status === 'unknown') {
    return undefined;
  }
  if (lookup.status === 'missing') {
    return false;
  }
  return commandMatches(record, lookup.commandLine);
}

function readRecord(filePath: string): ManagedChildProcessRecord | undefined {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<ManagedChildProcessRecord>;
    if (
      parsed.version !== REGISTRY_VERSION
      || typeof parsed.pid !== 'number'
      || typeof parsed.ownerPid !== 'number'
      || typeof parsed.registeredAtMs !== 'number'
      || typeof parsed.kind !== 'string'
      || typeof parsed.command !== 'string'
    ) {
      return undefined;
    }
    return parsed as ManagedChildProcessRecord;
  } catch {
    return undefined;
  }
}

export function registerManagedChildProcess(
  child: ChildProcess,
  metadata: ManagedChildProcessMetadata,
): () => void {
  const pid = child.pid;
  if (pid === undefined) {
    return () => {};
  }

  let registered = false;
  const unregister = (): void => {
    if (!registered) {
      return;
    }
    registered = false;
    removeRecord(pid);
  };

  try {
    const record: ManagedChildProcessRecord = {
      version: REGISTRY_VERSION,
      pid,
      ownerPid: process.pid,
      registeredAtMs: Date.now(),
      kind: metadata.kind,
      command: metadata.command,
      args: metadata.args ? [...metadata.args] : undefined,
      cwd: metadata.cwd,
    };
    writeRecord(record);
    activeChildren.set(pid, { record, child });
    registered = true;
  } catch {
    return () => {};
  }

  child.once('exit', unregister);
  child.once('error', unregister);
  return () => {
    child.off('exit', unregister);
    child.off('error', unregister);
    unregister();
  };
}

export async function cleanupRegisteredManagedChildren(
  options: CleanupOptions = {},
): Promise<ManagedChildCleanupSummary> {
  let killed = 0;
  let pruned = 0;
  let skipped = 0;
  let files: string[] = [];

  try {
    files = readdirSync(registryDir()).filter((file) => file.endsWith('.json'));
  } catch {
    return { killed, pruned, skipped };
  }

  for (const file of files) {
    const filePath = path.join(registryDir(), file);
    const record = readRecord(filePath);
    if (!record) {
      rmSync(filePath, { force: true });
      pruned += 1;
      continue;
    }

    if (!options.includeCurrentOwner && record.ownerPid === process.pid) {
      skipped += 1;
      continue;
    }

    if (!options.includeCurrentOwner && isPidAlive(record.ownerPid)) {
      skipped += 1;
      continue;
    }

    if (!isPidAlive(record.pid)) {
      removeRecord(record.pid);
      pruned += 1;
      continue;
    }

    const confirmed = activeChildMatchesRecord(record) ? true : isConfirmedRecord(record);
    if (confirmed === undefined) {
      skipped += 1;
      continue;
    }

    if (!confirmed) {
      removeRecord(record.pid);
      pruned += 1;
      continue;
    }

    await killPidTree(record.pid);
    if (await waitForPidExit(record.pid, PID_EXIT_WAIT_MS)) {
      removeRecord(record.pid);
      killed += 1;
    } else {
      skipped += 1;
    }
  }

  return { killed, pruned, skipped };
}
