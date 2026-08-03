import path from 'node:path';

import type { KodaXShellExecutionContract, KodaXShellKind } from '../types.js';
import { isSensitiveShellEnvironmentName } from './contract.js';

const WINDOWS_BOOTSTRAP_NAMES = new Set([
  'COMSPEC',
  'HOMEDRIVE',
  'HOMEPATH',
  'HOME',
  'LOCALAPPDATA',
  'OS',
  'PATH',
  'PATHEXT',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'WINDIR',
]);
const POSIX_BOOTSTRAP_NAMES = new Set([
  'HOME',
  'LANG',
  'LC_ALL',
  'LOGNAME',
  'PATH',
  'SHELL',
  'TERM',
  'TMPDIR',
  'USER',
]);
const EXECUTION_CONTROL_NAMES = new Set([
  'BASH_ENV',
  'NODE_OPTIONS',
  'RIPGREP_CONFIG_PATH',
]);
const MAX_RESOLVED_ENV_ENTRIES = 4_096;
const MAX_RESOLVED_ENV_BYTES = 2 * 1024 * 1024;

export function hardenShellCommandEnvironment(
  source: NodeJS.ProcessEnv,
  shellKind: KodaXShellKind,
  platform: NodeJS.Platform = process.platform,
  additionalDeniedNames: readonly string[] = [],
  executionCwd?: string,
  allowedSensitiveNames: readonly string[] = [],
): NodeJS.ProcessEnv {
  const result = { ...source };
  for (const name of Object.keys(result)) {
    const explicitlyAllowed = environmentNameIsListed(
      name,
      allowedSensitiveNames,
      platform,
    );
    if (isExecutionControlEnvironmentName(name)
      || (!explicitlyAllowed && (
        isSensitiveShellEnvironmentName(name)
        || additionalDeniedNames.some((candidate) => (
          candidate.toUpperCase() === name.toUpperCase()
        ))
      ))) {
      deleteEnvironmentValue(result, name, platform);
    }
  }
  sanitizeCommandPath(result, platform, executionCwd);
  if (platform !== 'win32' || shellKind !== 'cmd') return result;
  // cmd.exe otherwise searches the current working directory before PATH,
  // allowing a workspace-local executable to shadow a trusted bare command.
  setEnvironmentValue(result, 'NoDefaultCurrentDirectoryInExePath', '1', platform);
  return result;
}

export function parseSandboxEnvironmentPass(value: string | undefined): readonly string[] {
  if (!value) return [];
  return normalizeSandboxEnvironmentPass(value.split(','));
}

export function normalizeSandboxEnvironmentPass(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((name): name is string => typeof name === 'string')
    .map((name) => name.trim())
    .filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)))];
}

export function applyShellEnvironmentPass(
  source: NodeJS.ProcessEnv,
  target: NodeJS.ProcessEnv,
  names: readonly string[],
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const result = { ...target };
  for (const requestedName of names) {
    if (isExecutionControlEnvironmentName(requestedName)) continue;
    const sourceName = Object.keys(source).find((name) => (
      environmentNamesEqual(name, requestedName, platform)
    ));
    if (sourceName === undefined || source[sourceName] === undefined) continue;
    setEnvironmentValue(result, sourceName, source[sourceName]!, platform);
  }
  return result;
}

function environmentNameIsListed(
  name: string,
  candidates: readonly string[],
  platform: NodeJS.Platform,
): boolean {
  return candidates.some((candidate) => environmentNamesEqual(name, candidate, platform));
}

function environmentNamesEqual(
  left: string,
  right: string,
  platform: NodeJS.Platform,
): boolean {
  return platform === 'win32'
    ? left.toUpperCase() === right.toUpperCase()
    : left === right;
}

function sanitizeCommandPath(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  executionCwd: string | undefined,
): void {
  const pathName = Object.keys(environment).find((name) => name.toUpperCase() === 'PATH');
  if (!pathName || environment[pathName] === undefined) return;
  const flavor = platform === 'win32' ? path.win32 : path.posix;
  const delimiter = platform === 'win32' ? ';' : ':';
  const canonicalCwd = executionCwd === undefined ? undefined : flavor.resolve(executionCwd);
  const safeEntries = environment[pathName]!.split(delimiter).filter((rawEntry) => {
    const entry = rawEntry.replace(/^"|"$/g, '');
    if (!flavor.isAbsolute(entry)) return false;
    if (canonicalCwd === undefined) return true;
    const relative = flavor.relative(canonicalCwd, flavor.resolve(entry));
    return relative.startsWith('..') || flavor.isAbsolute(relative);
  });
  environment[pathName] = safeEntries.join(delimiter);
}

function deleteEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  name: string,
  platform: NodeJS.Platform,
): void {
  const matchingNames = platform === 'win32'
    ? Object.keys(environment).filter((candidate) => candidate.toUpperCase() === name.toUpperCase())
    : [name];
  for (const matchingName of matchingNames) delete environment[matchingName];
}

export function buildShellProbeEnvironment(
  source: NodeJS.ProcessEnv,
  contract: KodaXShellExecutionContract,
  sessionScratchDir?: string,
  platform: NodeJS.Platform = process.platform,
  additionalDeniedNames: readonly string[] = [],
  executionCwd?: string,
): NodeJS.ProcessEnv {
  const inherit = contract.environment?.inherit ?? 'filtered';
  const bootstrapNames = platform === 'win32'
    ? WINDOWS_BOOTSTRAP_NAMES
    : POSIX_BOOTSTRAP_NAMES;
  const result: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (
      value === undefined
      || isDeniedEnvironmentName(name, contract, additionalDeniedNames)
    ) continue;
    if (inherit === 'none' && !bootstrapNames.has(name.toUpperCase())) continue;
    setEnvironmentValue(result, name, value, platform);
  }
  for (const [name, value] of Object.entries(contract.environment?.set ?? {})) {
    if (additionalDeniedNames.some((candidate) => (
      candidate.toUpperCase() === name.toUpperCase()
    ))) {
      throw new Error(
        `shellExecution.environment.set cannot contain active Provider credential variable ${name}`,
      );
    }
    if (isDeniedEnvironmentName(name, contract, additionalDeniedNames)) {
      throw new Error(
        `shellExecution.environment.set cannot contain denied variable ${name}`,
      );
    }
    setEnvironmentValue(result, name, value, platform);
  }
  if (
    sessionScratchDir !== undefined
    && !isDeniedEnvironmentName(
      'KODAX_SESSION_TMP',
      contract,
      additionalDeniedNames,
    )
  ) {
    setEnvironmentValue(result, 'KODAX_SESSION_TMP', sessionScratchDir, platform);
  }
  sanitizeCommandPath(result, platform, executionCwd);
  validateEnvironmentSize(result);
  return result;
}

export function sanitizeResolvedShellEnvironment(
  source: Readonly<Record<string, string>>,
  contract: KodaXShellExecutionContract,
  platform: NodeJS.Platform = process.platform,
  additionalDeniedNames: readonly string[] = [],
  executionCwd?: string,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (
      isDeniedEnvironmentName(name, contract, additionalDeniedNames)
    ) continue;
    setEnvironmentValue(result, name, value, platform);
  }
  sanitizeCommandPath(result, platform, executionCwd);
  validateEnvironmentSize(result);
  return result;
}

export function isDeniedEnvironmentName(
  name: string,
  contract: KodaXShellExecutionContract,
  additionalDeniedNames: readonly string[] = [],
): boolean {
  if (isSensitiveShellEnvironmentName(name)) return true;
  if (isExecutionControlEnvironmentName(name)) return true;
  if (additionalDeniedNames.some((candidate) => (
    candidate.toUpperCase() === name.toUpperCase()
  ))) return true;
  return (contract.environment?.denyPatterns ?? []).some((pattern) => (
    environmentNameMatchesPattern(name, pattern)
  ));
}

function isExecutionControlEnvironmentName(name: string): boolean {
  return EXECUTION_CONTROL_NAMES.has(name.toUpperCase())
    || /^BASH_FUNC_.+(?:%%|\(\))$/i.test(name);
}

export function environmentNameMatchesPattern(
  name: string,
  pattern: string,
): boolean {
  let source = '^';
  for (const char of pattern.toUpperCase()) {
    if (char === '*') source += '.*';
    else if (char === '?') source += '.';
    else source += char.replace(/[\\^$.[\]{}()+|]/g, '\\$&');
  }
  return new RegExp(`${source}$`, 'i').test(name);
}

export function mergeWindowsRegistryPath(
  environment: NodeJS.ProcessEnv,
  machinePath: string | undefined,
  userPath: string | undefined,
): NodeJS.ProcessEnv {
  return mergeWindowsRegistryEnvironment(
    environment,
    machinePath === undefined ? {} : { Path: machinePath },
    userPath === undefined ? {} : { Path: userPath },
  );
}

export function parseWindowsRegistryPath(output: string): string | undefined {
  return recordEnvironmentValue(
    parseWindowsRegistryEnvironment(output),
    'PATH',
  );
}

export function parseWindowsRegistryEnvironment(
  output: string,
): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(.+?)\s+REG_(?:EXPAND_)?SZ(?:\s+(.*?))?\s*$/i.exec(line);
    const name = match?.[1]?.trim();
    if (
      name === undefined
      || name.length === 0
      || name === '(Default)'
      || name.includes('=')
      || name.includes('\0')
    ) continue;
    result[name] = match?.[2] ?? '';
  }
  return result;
}

export function mergeWindowsRegistryEnvironment(
  environment: NodeJS.ProcessEnv,
  machine: Readonly<Record<string, string>>,
  user: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  const machinePath = recordEnvironmentValue(machine, 'PATH');
  const userPath = recordEnvironmentValue(user, 'PATH');
  if (machinePath === undefined && userPath === undefined) {
    return { ...environment };
  }

  const result = { ...environment };
  overlayWindowsRegistryValues(result, machine);
  overlayWindowsRegistryValues(result, user);

  const machineScope = { ...environment };
  overlayWindowsRegistryValues(machineScope, machine);
  setEnvironmentValue(machineScope, 'PATH', '', 'win32');
  const expandedMachinePath = machinePath === undefined
    ? ''
    : expandWindowsEnvironmentReferences(machinePath, machineScope);

  const expansionScope = { ...result };
  setEnvironmentValue(expansionScope, 'PATH', expandedMachinePath, 'win32');
  for (const [name, value] of [
    ...Object.entries(machine),
    ...Object.entries(user),
  ]) {
    if (name.toUpperCase() === 'PATH') continue;
    setEnvironmentValue(
      result,
      name,
      expandWindowsEnvironmentReferences(value, expansionScope),
      'win32',
    );
  }

  const finalScope = { ...result };
  setEnvironmentValue(finalScope, 'PATH', expandedMachinePath, 'win32');
  const expandedUserPath = userPath === undefined
    ? ''
    : expandWindowsEnvironmentReferences(userPath, finalScope);
  const userOwnsMachinePath = /%PATH%/i.test(userPath ?? '');
  const pathValue = userOwnsMachinePath
    ? expandedUserPath
    : [expandedMachinePath, expandedUserPath]
        .filter((value) => value.length > 0)
        .join(';');
  setEnvironmentValue(result, 'PATH', pathValue, 'win32');
  return result;
}

function expandWindowsEnvironmentReferences(
  value: string,
  environment: NodeJS.ProcessEnv,
): string {
  const lookup = new Map(
    Object.entries(environment)
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .map(([name, entryValue]) => [name.toUpperCase(), entryValue]),
  );
  let expanded = value;
  for (let depth = 0; depth < 16; depth += 1) {
    const next = expanded.replace(/%([^%]+)%/g, (match, name: string) => (
      lookup.get(name.toUpperCase()) ?? match
    ));
    if (next === expanded) return expanded;
    expanded = next;
  }
  return expanded;
}

function overlayWindowsRegistryValues(
  target: NodeJS.ProcessEnv,
  values: Readonly<Record<string, string>>,
): void {
  for (const [name, value] of Object.entries(values)) {
    if (name.toUpperCase() === 'PATH') continue;
    setEnvironmentValue(target, name, value, 'win32');
  }
}

function recordEnvironmentValue(
  values: Readonly<Record<string, string>>,
  name: string,
): string | undefined {
  return Object.entries(values).find(
    ([candidate]) => candidate.toUpperCase() === name.toUpperCase(),
  )?.[1];
}

function setEnvironmentValue(
  target: NodeJS.ProcessEnv,
  name: string,
  value: string,
  platform: NodeJS.Platform,
): void {
  if (platform === 'win32') {
    const existing = Object.keys(target).find(
      (candidate) => candidate.toUpperCase() === name.toUpperCase(),
    );
    if (existing !== undefined && existing !== name) delete target[existing];
  }
  target[name] = value;
}

function validateEnvironmentSize(environment: NodeJS.ProcessEnv): void {
  const entries = Object.entries(environment);
  if (entries.length > MAX_RESOLVED_ENV_ENTRIES) {
    throw new Error('resolved shell environment contains too many variables');
  }
  const byteLength = entries.reduce((total, [name, value]) => (
    total + Buffer.byteLength(name) + Buffer.byteLength(value ?? '')
  ), 0);
  if (byteLength > MAX_RESOLVED_ENV_BYTES) {
    throw new Error('resolved shell environment exceeds the size limit');
  }
}
