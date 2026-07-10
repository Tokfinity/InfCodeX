import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import path from 'node:path';

export type RuntimeDaemonStatus =
  | 'starting'
  | 'ready'
  | 'draining'
  | 'stopping'
  | 'unhealthy'
  | 'crashed';

export interface RuntimeDaemonState {
  readonly runtimeId: string;
  readonly profile: string;
  readonly pid: number;
  readonly startedAt: string;
  readonly endpoint: string;
  readonly version: string;
  readonly status: RuntimeDaemonStatus;
  readonly lastError?: string;
}

export type RuntimeDaemonLogLevel = 'info' | 'warn' | 'error';

export interface RuntimeDaemonLogEntry {
  readonly time: string;
  readonly level: RuntimeDaemonLogLevel;
  readonly message: string;
  readonly data?: Record<string, unknown>;
}

export interface RuntimeDaemonPaths {
  readonly profile: string;
  readonly rootDir: string;
  readonly stateFile: string;
  readonly lockFile: string;
  readonly tokenFile: string;
  readonly logFile: string;
  readonly runsDir: string;
  readonly eventsDir: string;
}

export interface RuntimeDaemonLockOwner {
  readonly runtimeId: string;
  readonly pid: number;
  readonly createdAt: string;
}

export interface RuntimeDaemonLockHandle {
  readonly file: string;
  readonly owner: RuntimeDaemonLockOwner;
}

export type RuntimeDaemonHealth =
  | 'missing'
  | 'healthy'
  | 'stale'
  | 'unhealthy'
  | 'mismatch';

export interface RuntimeDaemonHealthObservation {
  readonly state?: RuntimeDaemonState;
  readonly pidAlive: boolean;
  readonly endpointReachable: boolean;
  readonly identityMatches: boolean;
  readonly lockOwnerPidAlive?: boolean;
}

export type RuntimeDaemonOwnershipDecision =
  | {
      readonly kind: 'attach';
      readonly state: RuntimeDaemonState;
      readonly health: 'healthy';
    }
  | {
      readonly kind: 'claim';
      readonly lock: RuntimeDaemonLockHandle;
      readonly health: 'missing' | 'stale';
    }
  | {
      readonly kind: 'wait';
      readonly lockOwner: RuntimeDaemonLockOwner;
      readonly state?: RuntimeDaemonState;
      readonly health: 'missing' | 'stale';
    }
  | {
      readonly kind: 'unhealthy';
      readonly health: 'unhealthy' | 'mismatch';
      readonly state?: RuntimeDaemonState;
      readonly lockOwner?: RuntimeDaemonLockOwner;
    };

export function resolveRuntimeDaemonPaths(
  homeDir: string,
  profile = 'default',
): RuntimeDaemonPaths {
  const normalizedProfile = normalizeRuntimeDaemonProfile(profile);
  const rootDir = path.join(homeDir, '.kodax', 'runtime', 'daemon', normalizedProfile);
  return {
    profile: normalizedProfile,
    rootDir,
    stateFile: path.join(rootDir, 'daemon.json'),
    lockFile: path.join(rootDir, 'daemon.lock'),
    tokenFile: path.join(rootDir, 'daemon.token'),
    logFile: path.join(rootDir, 'daemon.log'),
    runsDir: path.join(rootDir, 'runs'),
    eventsDir: path.join(rootDir, 'events'),
  };
}

export function normalizeRuntimeDaemonProfile(profile: string): string {
  const trimmed = profile.trim() || 'default';
  if (!/^[A-Za-z0-9_.-]+$/.test(trimmed)) {
    throw new Error(`Invalid runtime daemon profile: ${profile}`);
  }
  return trimmed;
}

export function ensureRuntimeDaemonDirectories(paths: RuntimeDaemonPaths): void {
  fs.mkdirSync(paths.rootDir, { recursive: true });
  fs.mkdirSync(paths.runsDir, { recursive: true });
  fs.mkdirSync(paths.eventsDir, { recursive: true });
}

export function createRuntimeDaemonToken(): string {
  return `dt_${randomUUID().replace(/-/g, '')}`;
}

export function writeRuntimeDaemonToken(paths: RuntimeDaemonPaths, token: string): void {
  ensureRuntimeDaemonDirectories(paths);
  fs.writeFileSync(paths.tokenFile, `${token}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  if (process.platform !== 'win32') {
    fs.chmodSync(paths.tokenFile, 0o600);
  }
}

export function readRuntimeDaemonToken(paths: RuntimeDaemonPaths): string | undefined {
  if (!fs.existsSync(paths.tokenFile)) return undefined;
  const token = fs.readFileSync(paths.tokenFile, 'utf8').trim();
  return token.length > 0 ? token : undefined;
}

export function writeRuntimeDaemonState(
  paths: RuntimeDaemonPaths,
  state: RuntimeDaemonState,
): void {
  ensureRuntimeDaemonDirectories(paths);
  fs.writeFileSync(paths.stateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

export function appendRuntimeDaemonLog(
  paths: RuntimeDaemonPaths,
  level: RuntimeDaemonLogLevel,
  message: string,
  data?: Record<string, unknown>,
): void {
  ensureRuntimeDaemonDirectories(paths);
  const entry: RuntimeDaemonLogEntry = {
    time: new Date().toISOString(),
    level,
    message,
    ...(data !== undefined ? { data } : {}),
  };
  fs.appendFileSync(paths.logFile, `${JSON.stringify(entry)}\n`, 'utf8');
}

export function readRuntimeDaemonLog(
  paths: RuntimeDaemonPaths,
  limit = 200,
): readonly RuntimeDaemonLogEntry[] {
  if (!fs.existsSync(paths.logFile)) return [];
  const entries: RuntimeDaemonLogEntry[] = [];
  const lines = fs.readFileSync(paths.logFile, 'utf8').split(/\r?\n/).filter((line) => line.trim().length > 0);
  for (const line of lines.slice(-limit)) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRuntimeDaemonLogEntry(parsed)) entries.push(parsed);
    } catch (error: unknown) {
      entries.push({
        time: new Date().toISOString(),
        level: 'warn',
        message: `Skipped malformed daemon log line: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  return entries;
}

export function readRuntimeDaemonState(paths: RuntimeDaemonPaths): RuntimeDaemonState | undefined {
  if (!fs.existsSync(paths.stateFile)) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(paths.stateFile, 'utf8')) as unknown;
    return isRuntimeDaemonState(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function tryAcquireRuntimeDaemonLock(
  paths: RuntimeDaemonPaths,
  owner: RuntimeDaemonLockOwner,
): RuntimeDaemonLockHandle | undefined {
  ensureRuntimeDaemonDirectories(paths);
  let fd: number | undefined;
  try {
    fd = fs.openSync(paths.lockFile, 'wx');
    fs.writeFileSync(fd, `${JSON.stringify(owner, null, 2)}\n`, 'utf8');
    return { file: paths.lockFile, owner };
  } catch (error) {
    if (isNodeFileError(error) && error.code === 'EEXIST') {
      return undefined;
    }
    throw error;
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
}

export function releaseRuntimeDaemonLock(handle: RuntimeDaemonLockHandle): boolean {
  const current = readRuntimeDaemonLockOwner(handle.file);
  if (
    !current
    || current.runtimeId !== handle.owner.runtimeId
    || current.pid !== handle.owner.pid
  ) {
    return false;
  }
  fs.unlinkSync(handle.file);
  return true;
}

export function readRuntimeDaemonLockOwner(file: string): RuntimeDaemonLockOwner | undefined {
  if (!fs.existsSync(file)) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    return isRuntimeDaemonLockOwner(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function claimRuntimeDaemonOwnership(
  paths: RuntimeDaemonPaths,
  owner: RuntimeDaemonLockOwner,
  observation: RuntimeDaemonHealthObservation,
): RuntimeDaemonOwnershipDecision {
  const health = classifyRuntimeDaemonHealth(observation);
  const lockOwner = readRuntimeDaemonLockOwner(paths.lockFile);

  if (health === 'healthy') {
    if (observation.state) {
      return {
        kind: 'attach',
        state: observation.state,
        health,
      };
    }
    return {
      kind: 'unhealthy',
      health: 'unhealthy',
    };
  }

  if (
    health === 'unhealthy'
    && observation.state !== undefined
    && isRuntimeDaemonTransitionStatus(observation.state.status)
    && observation.pidAlive
    && lockOwner !== undefined
  ) {
    return {
      kind: 'wait',
      lockOwner,
      state: observation.state,
      health: 'missing',
    };
  }

  if (health === 'unhealthy' || health === 'mismatch') {
    return {
      kind: 'unhealthy',
      health,
      ...(observation.state !== undefined ? { state: observation.state } : {}),
      ...(lockOwner !== undefined ? { lockOwner } : {}),
    };
  }

  const claimHealth: 'missing' | 'stale' = health === 'stale' ? 'stale' : 'missing';

  if (claimHealth === 'stale') {
    removeRuntimeDaemonOwnershipFiles(paths);
  } else if (lockOwner !== undefined) {
    if (observation.lockOwnerPidAlive === false) {
      removeRuntimeDaemonOwnershipFiles(paths);
    } else {
      return {
        kind: 'wait',
        lockOwner,
        ...(observation.state !== undefined ? { state: observation.state } : {}),
        health: claimHealth,
      };
    }
  }

  if (claimHealth === 'missing') {
    const nextLockOwner = readRuntimeDaemonLockOwner(paths.lockFile);
    if (nextLockOwner !== undefined) {
      return {
        kind: 'wait',
        lockOwner: nextLockOwner,
        ...(observation.state !== undefined ? { state: observation.state } : {}),
        health: claimHealth,
      };
    }
  }

  const lock = tryAcquireRuntimeDaemonLock(paths, owner);
  if (lock) {
    return {
      kind: 'claim',
      lock,
      health: claimHealth,
    };
  }

  const nextLockOwner = readRuntimeDaemonLockOwner(paths.lockFile);
  if (nextLockOwner) {
    return {
      kind: 'wait',
      lockOwner: nextLockOwner,
      ...(observation.state !== undefined ? { state: observation.state } : {}),
      health: claimHealth,
    };
  }

  return {
    kind: 'unhealthy',
    health: 'unhealthy',
    ...(observation.state !== undefined ? { state: observation.state } : {}),
  };
}

export function removeRuntimeDaemonOwnershipFiles(paths: RuntimeDaemonPaths): void {
  fs.rmSync(paths.lockFile, { force: true });
  fs.rmSync(paths.stateFile, { force: true });
  fs.rmSync(paths.tokenFile, { force: true });
}

export function removeRuntimeDaemonStateFiles(paths: RuntimeDaemonPaths): void {
  fs.rmSync(paths.stateFile, { force: true });
  fs.rmSync(paths.tokenFile, { force: true });
}

export function classifyRuntimeDaemonHealth(
  observation: RuntimeDaemonHealthObservation,
): RuntimeDaemonHealth {
  if (!observation.state) {
    return 'missing';
  }
  if (observation.endpointReachable && !observation.identityMatches) {
    return 'mismatch';
  }
  if (
    observation.pidAlive
    && observation.endpointReachable
    && observation.identityMatches
  ) {
    return 'healthy';
  }
  if (!observation.pidAlive && !observation.endpointReachable) {
    return 'stale';
  }
  return 'unhealthy';
}

function isRuntimeDaemonState(value: unknown): value is RuntimeDaemonState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const state = value as Record<string, unknown>;
  return typeof state.runtimeId === 'string'
    && typeof state.profile === 'string'
    && typeof state.pid === 'number'
    && typeof state.startedAt === 'string'
    && typeof state.endpoint === 'string'
    && typeof state.version === 'string'
    && isRuntimeDaemonStatus(state.status)
    && (state.lastError === undefined || typeof state.lastError === 'string');
}

function isRuntimeDaemonLogEntry(value: unknown): value is RuntimeDaemonLogEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return typeof entry.time === 'string'
    && isRuntimeDaemonLogLevel(entry.level)
    && typeof entry.message === 'string'
    && (entry.data === undefined || isPlainRecord(entry.data));
}

function isRuntimeDaemonLogLevel(value: unknown): value is RuntimeDaemonLogLevel {
  return value === 'info' || value === 'warn' || value === 'error';
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isRuntimeDaemonLockOwner(value: unknown): value is RuntimeDaemonLockOwner {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const owner = value as Record<string, unknown>;
  return typeof owner.runtimeId === 'string'
    && typeof owner.pid === 'number'
    && typeof owner.createdAt === 'string';
}

function isRuntimeDaemonStatus(value: unknown): value is RuntimeDaemonStatus {
  return value === 'starting'
    || value === 'ready'
    || value === 'draining'
    || value === 'stopping'
    || value === 'unhealthy'
    || value === 'crashed';
}

function isRuntimeDaemonTransitionStatus(status: RuntimeDaemonStatus): boolean {
  return status === 'starting' || status === 'draining' || status === 'stopping';
}

function isNodeFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
