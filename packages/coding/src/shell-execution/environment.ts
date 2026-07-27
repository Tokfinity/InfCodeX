import type { KodaXShellExecutionContract } from '../types.js';
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
const EXECUTION_CONTROL_NAMES = new Set(['BASH_ENV', 'NODE_OPTIONS']);
const PROBE_CONTROL_NAMES = new Set(['NODE_OPTIONS']);
const MAX_RESOLVED_ENV_ENTRIES = 4_096;
const MAX_RESOLVED_ENV_BYTES = 2 * 1024 * 1024;

export function buildShellProbeEnvironment(
  source: NodeJS.ProcessEnv,
  contract: KodaXShellExecutionContract,
  sessionScratchDir?: string,
  platform: NodeJS.Platform = process.platform,
  additionalDeniedNames: readonly string[] = [],
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
      || PROBE_CONTROL_NAMES.has(name.toUpperCase())
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
  validateEnvironmentSize(result);
  return result;
}

export function sanitizeResolvedShellEnvironment(
  source: Readonly<Record<string, string>>,
  contract: KodaXShellExecutionContract,
  platform: NodeJS.Platform = process.platform,
  additionalDeniedNames: readonly string[] = [],
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (
      isDeniedEnvironmentName(name, contract, additionalDeniedNames)
      || EXECUTION_CONTROL_NAMES.has(name.toUpperCase())
    ) continue;
    setEnvironmentValue(result, name, value, platform);
  }
  validateEnvironmentSize(result);
  return result;
}

export function isDeniedEnvironmentName(
  name: string,
  contract: KodaXShellExecutionContract,
  additionalDeniedNames: readonly string[] = [],
): boolean {
  if (isSensitiveShellEnvironmentName(name)) return true;
  if (additionalDeniedNames.some((candidate) => (
    candidate.toUpperCase() === name.toUpperCase()
  ))) return true;
  return (contract.environment?.denyPatterns ?? []).some((pattern) => (
    environmentNameMatchesPattern(name, pattern)
  ));
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
