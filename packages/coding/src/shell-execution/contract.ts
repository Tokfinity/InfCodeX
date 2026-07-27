import { createHash } from 'node:crypto';
import path from 'node:path';

import type {
  KodaXShellExecutionContract,
  KodaXShellKind,
  KodaXShellProfileMode,
} from '../types.js';

const MAX_ARGS = 32;
const MAX_ARG_LENGTH = 4_096;
const MAX_ENV_ENTRIES = 128;
const MAX_ENV_VALUE_LENGTH = 65_536;
const MAX_ENV_TOTAL_LENGTH = 262_144;
const MAX_SETUP_LENGTH = 65_536;
const MAX_DENY_PATTERNS = 64;
const MAX_CACHE_TTL_MS = 600_000;
const MAX_PROBE_TIMEOUT_MS = 60_000;

const SHELL_KINDS = new Set<KodaXShellKind>([
  'pwsh',
  'powershell',
  'cmd',
  'bash',
  'zsh',
]);
const PROFILE_MODES = new Set<KodaXShellProfileMode>([
  'default',
  'none',
  'login',
  'interactive',
  'login-interactive',
]);

export const DEFAULT_SHELL_ENV_CACHE_TTL_MS = 30_000;
export const DEFAULT_SHELL_ENV_PROBE_TIMEOUT_MS = 10_000;

export function normalizeShellExecutionContract(
  value: unknown,
): KodaXShellExecutionContract {
  const root = requireRecord(value, 'shellExecution');
  assertOnlyKeys(
    root,
    ['version', 'shell', 'environment', 'cache', 'probeTimeoutMs'],
    'shellExecution',
  );
  if (root.version !== 1) {
    throw new Error('shellExecution.version must be 1');
  }
  const shell = requireRecord(root.shell, 'shellExecution.shell');
  assertOnlyKeys(
    shell,
    ['kind', 'executable', 'args', 'profile'],
    'shellExecution.shell',
  );
  if (!SHELL_KINDS.has(shell.kind as KodaXShellKind)) {
    throw new Error('shellExecution.shell.kind is not supported');
  }
  const kind = shell.kind as KodaXShellKind;
  const executable = optionalBoundedString(
    shell.executable,
    'shellExecution.shell.executable',
    4_096,
  );
  if (
    executable !== undefined
    && !path.isAbsolute(executable)
    && !path.win32.isAbsolute(executable)
    && /[\\/]/.test(executable)
  ) {
    throw new Error(
      'shellExecution.shell.executable must be absolute or a bare executable name',
    );
  }
  const args = normalizeShellArgs(shell.args, kind);
  const profile = normalizeProfileMode(shell.profile, kind);
  const environment = normalizeEnvironment(root.environment);
  const cache = normalizeCache(root.cache);
  const probeTimeoutMs = optionalInteger(
    root.probeTimeoutMs,
    'shellExecution.probeTimeoutMs',
    100,
    MAX_PROBE_TIMEOUT_MS,
  );

  return {
    version: 1,
    shell: {
      kind,
      ...(executable !== undefined ? { executable } : {}),
      ...(args !== undefined ? { args } : {}),
      ...(profile !== undefined ? { profile } : {}),
    },
    ...(environment !== undefined ? { environment } : {}),
    ...(cache !== undefined ? { cache } : {}),
    ...(probeTimeoutMs !== undefined ? { probeTimeoutMs } : {}),
  };
}

export function shellExecutionContractFingerprint(
  contract: KodaXShellExecutionContract,
): string {
  return createHash('sha256')
    .update(stableSerialize(normalizeShellExecutionContract(contract)))
    .digest('hex');
}

export function isSensitiveShellEnvironmentName(name: string): boolean {
  const normalized = name.toUpperCase();
  return normalized === 'KODAX_PROVIDER_CREDENTIAL'
    || normalized === 'KODAX_API_KEY'
    || /(?:^|_)(?:API_?KEY|KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?)$/.test(normalized)
    || /(?:^|_)(?:SECRET|CREDENTIAL)(?:_|$)/.test(normalized);
}

function normalizeShellArgs(
  value: unknown,
  kind: KodaXShellKind,
): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_ARGS) {
    throw new Error(`shellExecution.shell.args must contain at most ${MAX_ARGS} strings`);
  }
  const args = value.map((entry, index) => (
    boundedString(entry, `shellExecution.shell.args[${index}]`, MAX_ARG_LENGTH)
  ));
  const denied = commandControlArgs(kind);
  if (args.some((arg) => isShellControlArgument(kind, arg, denied))) {
    throw new Error(
      'shellExecution.shell.args cannot override KodaX command or persistence flags',
    );
  }
  return args;
}

function isShellControlArgument(
  kind: KodaXShellKind,
  arg: string,
  denied: ReadonlySet<string>,
): boolean {
  const normalized = arg.trim().toLowerCase();
  if (kind === 'cmd') {
    return normalized === '/?'
      || normalized.startsWith('/c')
      || normalized.startsWith('/k');
  }
  if (kind === 'pwsh' || kind === 'powershell') {
    const switchValue = normalized.startsWith('/')
      ? `-${normalized.slice(1)}`
      : normalized;
    if (!switchValue.startsWith('-') || switchValue.length < 2) return false;
    const controlValue = switchValue.split(/[:=]/, 1)[0] ?? switchValue;
    return denied.has(controlValue)
      || [...denied].some((control) => control.startsWith(controlValue));
  }
  if (denied.has(normalized)) return true;
  if (kind === 'bash' || kind === 'zsh') {
    return /^-[^-]*[cilf]/.test(normalized);
  }
  return false;
}

function commandControlArgs(kind: KodaXShellKind): ReadonlySet<string> {
  if (kind === 'cmd') return new Set(['/c', '/k']);
  if (kind === 'pwsh' || kind === 'powershell') {
    return new Set([
      '-command',
      '-commandwithargs',
      '-encodedcommand',
      '-file',
      '-help',
      '-h',
      '-?',
      '-interactive',
      '-login',
      '-noexit',
      '-noninteractive',
      '-noprofile',
      '-sshservermode',
      '-version',
      '-wd',
      '-workingdirectory',
    ]);
  }
  return new Set([
    '-c',
    '--command',
    '-i',
    '--interactive',
    '-f',
    '-l',
    '-il',
    '-li',
    '--login',
    '--noprofile',
    '--norc',
  ]);
}

function normalizeProfileMode(
  value: unknown,
  kind: KodaXShellKind,
): KodaXShellProfileMode | undefined {
  if (value === undefined) return undefined;
  if (!PROFILE_MODES.has(value as KodaXShellProfileMode)) {
    throw new Error('shellExecution.shell.profile is not supported');
  }
  const profile = value as KodaXShellProfileMode;
  if (kind === 'cmd' && profile !== 'default' && profile !== 'none') {
    throw new Error('cmd supports only default or none profile mode');
  }
  if (kind === 'powershell' && profile !== 'default' && profile !== 'none') {
    throw new Error(
      'Windows PowerShell supports only default or none profile mode',
    );
  }
  return profile;
}

function normalizeEnvironment(
  value: unknown,
): KodaXShellExecutionContract['environment'] | undefined {
  if (value === undefined) return undefined;
  const environment = requireRecord(value, 'shellExecution.environment');
  assertOnlyKeys(
    environment,
    ['inherit', 'set', 'denyPatterns', 'setup', 'windowsPath'],
    'shellExecution.environment',
  );
  const inherit = environment.inherit;
  if (inherit !== undefined && inherit !== 'filtered' && inherit !== 'none') {
    throw new Error('shellExecution.environment.inherit must be filtered or none');
  }
  const set = normalizeEnvironmentSet(environment.set);
  const denyPatterns = normalizeDenyPatterns(environment.denyPatterns);
  const setup = optionalBoundedString(
    environment.setup,
    'shellExecution.environment.setup',
    MAX_SETUP_LENGTH,
  );
  const windowsPath = environment.windowsPath;
  if (
    windowsPath !== undefined
    && windowsPath !== 'process'
    && windowsPath !== 'registry'
  ) {
    throw new Error(
      'shellExecution.environment.windowsPath must be process or registry',
    );
  }
  return {
    ...(inherit !== undefined ? { inherit } : {}),
    ...(set !== undefined ? { set } : {}),
    ...(denyPatterns !== undefined ? { denyPatterns } : {}),
    ...(setup !== undefined ? { setup } : {}),
    ...(windowsPath !== undefined ? { windowsPath } : {}),
  };
}

function normalizeEnvironmentSet(
  value: unknown,
): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  const entries = Object.entries(requireRecord(value, 'shellExecution.environment.set'));
  if (entries.length > MAX_ENV_ENTRIES) {
    throw new Error(
      `shellExecution.environment.set must contain at most ${MAX_ENV_ENTRIES} entries`,
    );
  }
  let totalLength = 0;
  const result: Record<string, string> = {};
  for (const [name, rawValue] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`invalid shell environment variable name: ${name}`);
    }
    if (isSensitiveShellEnvironmentName(name)) {
      throw new Error(`shellExecution.environment.set cannot contain sensitive variable ${name}`);
    }
    if (name.toUpperCase() === 'NODE_OPTIONS') {
      throw new Error(
        `shellExecution.environment.set cannot contain execution-control variable ${name}`,
      );
    }
    const stringValue = boundedStringAllowEmpty(
      rawValue,
      `shellExecution.environment.set.${name}`,
      MAX_ENV_VALUE_LENGTH,
    );
    totalLength += name.length + stringValue.length;
    if (totalLength > MAX_ENV_TOTAL_LENGTH) {
      throw new Error('shellExecution.environment.set exceeds the size limit');
    }
    result[name] = stringValue;
  }
  return result;
}

function normalizeDenyPatterns(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_DENY_PATTERNS) {
    throw new Error(
      `shellExecution.environment.denyPatterns must contain at most ${MAX_DENY_PATTERNS} strings`,
    );
  }
  return value.map((entry, index) => {
    const pattern = boundedString(
      entry,
      `shellExecution.environment.denyPatterns[${index}]`,
      256,
    );
    if (!/^[A-Za-z0-9_*?-]+$/.test(pattern)) {
      throw new Error(`invalid shell environment deny pattern: ${pattern}`);
    }
    return pattern;
  });
}

function normalizeCache(
  value: unknown,
): KodaXShellExecutionContract['cache'] | undefined {
  if (value === undefined) return undefined;
  const cache = requireRecord(value, 'shellExecution.cache');
  assertOnlyKeys(
    cache,
    ['ttlMs', 'refreshToken'],
    'shellExecution.cache',
  );
  const ttlMs = optionalInteger(
    cache.ttlMs,
    'shellExecution.cache.ttlMs',
    0,
    MAX_CACHE_TTL_MS,
  );
  const refreshToken = cache.refreshToken;
  if (
    refreshToken !== undefined
    && typeof refreshToken !== 'string'
    && typeof refreshToken !== 'number'
  ) {
    throw new Error('shellExecution.cache.refreshToken must be a string or number');
  }
  if (
    typeof refreshToken === 'number'
    && (!Number.isSafeInteger(refreshToken) || !Number.isFinite(refreshToken))
  ) {
    throw new Error('shellExecution.cache.refreshToken number must be a safe integer');
  }
  if (typeof refreshToken === 'string' && refreshToken.length > 256) {
    throw new Error('shellExecution.cache.refreshToken exceeds the size limit');
  }
  return {
    ...(ttlMs !== undefined ? { ttlMs } : {}),
    ...(refreshToken !== undefined ? { refreshToken } : {}),
  };
}

function optionalInteger(
  value: unknown,
  label: string,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) {
    throw new Error(`${label} must be a safe integer between ${min} and ${max}`);
  }
  return Number(value);
}

function optionalBoundedString(
  value: unknown,
  label: string,
  maxLength: number,
): string | undefined {
  return value === undefined ? undefined : boundedString(value, label, maxLength);
}

function boundedString(value: unknown, label: string, maxLength: number): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > maxLength
    || value.includes('\0')
  ) {
    throw new Error(`${label} must be a non-empty string of at most ${maxLength} characters`);
  }
  return value;
}

function boundedStringAllowEmpty(
  value: unknown,
  label: string,
  maxLength: number,
): string {
  if (
    typeof value !== 'string'
    || value.length > maxLength
    || value.includes('\0')
  ) {
    throw new Error(`${label} must be a string of at most ${maxLength} characters`);
  }
  return value;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unknown !== undefined) {
    throw new Error(`${label} contains unknown field ${unknown}`);
  }
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'undefined';
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${stableSerialize(record[key])}`
  )).join(',')}}`;
}
