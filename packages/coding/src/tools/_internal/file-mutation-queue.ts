/**
 * file-mutation-queue — FEATURE_131 v0.7.36 Part A.
 *
 * Path-keyed serial mutation queue. Same path → mutations run in
 * arrival order; different paths → mutations still run concurrently.
 *
 * Why this exists: FEATURE_119 Pattern B lets the Worker fan out to
 * multiple async children that can each call `write` / `edit` /
 * `multi_edit` / `insert_after_anchor`. Without serialization at the
 * tool layer, two concurrent edits to the same file race the
 * read-modify-write cycle and silently lose one side's changes (last
 * writer wins).
 *
 * Implementation: a single process-global Map keyed by a normalized
 * path. Each `withFileMutation` call chains its work onto the tail of
 * that path's queue, sets the new tail, and clears the entry when its
 * own work is the current tail (so completed paths don't leak).
 *
 * Per-path ordering is process-local. A short cross-process category lease
 * additionally prevents privileged file sinks and model-started shell effects
 * from overlapping their path-validation/write windows while preserving
 * concurrency within either category.
 *
 * Path normalization rules (Windows/POSIX parity):
 *   - lowercase the drive letter on Windows-style paths so `C:\foo`
 *     and `c:/foo` queue together
 *   - normalize backslashes to forward slashes
 *   - collapse repeated separators
 * The intent is "would this path read and write the same file at the
 * OS level"; we keep the ruleset minimal — three fixups handle
 * 99%+ of the realistic collision space without the surface area of
 * full `path.resolve()` (which would couple us to cwd at queue time
 * and miss the symlink case anyway).
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  acquireKodaXFileLock,
  cleanupRegisteredManagedChildren,
  getAgentConfigHome,
  readProcessStartIdentity,
} from '@kodax-ai/agent';
import {
  canonicalizeAgentHomePolicyPath,
  isAgentHomeHardMutationTarget,
} from '../../permissions/agent-home-policy.js';

const fileMutationQueue = new Map<string, Promise<unknown>>();
// This lock protects only the small state-file transaction. Its wait budget
// must cover the lock implementation's 30-second stale-owner safety window so
// a rapid process handoff can recover instead of failing before recovery is
// permitted.
const FILE_SYSTEM_EFFECT_COORDINATOR_TIMEOUT_MS = 30_000;
// A real cross-category conflict remains a short fail-closed admission error.
const FILE_SYSTEM_EFFECT_CONFLICT_TIMEOUT_MS = 1_000;
// Exact-policy ACL setup/reset is serialized, not rejected. Real Windows
// account/ACL work can legitimately exceed the ordinary conflict budget.
const FILE_SYSTEM_EFFECT_POLICY_TRANSITION_TIMEOUT_MS = 30_000;
const FILE_SYSTEM_EFFECT_RELEASE_ATTEMPTS = 3;
const EFFECT_STATE_FILE = 'model-filesystem-effects.json';
const EFFECT_COORDINATOR_LOCK = 'model-filesystem-effects.lock';
let effectOwnerStartIdentity: string | undefined;
let effectOwnerStartIdentityRead = false;
function getEffectOwnerStartIdentity(): string | undefined {
  if (!effectOwnerStartIdentityRead) {
    effectOwnerStartIdentity = readProcessStartIdentity(process.pid);
    effectOwnerStartIdentityRead = true;
  }
  return effectOwnerStartIdentity;
}
const EFFECT_TEST_SCOPE = process.env.VITEST_WORKER_ID === undefined
  ? undefined
  : `${process.env.VITEST_WORKER_ID}-${process.pid}`.replace(/[^a-z0-9_-]/gi, '_');

interface EffectLeaseOwner {
  readonly effectFinished?: boolean;
  readonly effectPid?: number;
  readonly effectProcessStartIdentity?: string;
  readonly pid: number;
  readonly processStartIdentity?: string;
  readonly sandboxPolicyKey?: string;
  readonly posixProcessGroup?: boolean;
  readonly token: string;
  readonly windowsJobContained?: boolean;
}

interface EffectLeaseState {
  readonly direct: readonly EffectLeaseOwner[];
  readonly namespaces: readonly EffectLeaseOwner[];
  readonly shells: readonly EffectLeaseOwner[];
}

interface EffectLeaseStorage {
  readonly coordinatorPath: string;
  readonly statePath: string;
}

type EffectLeaseMode = 'direct' | 'namespace' | 'shell';

export interface FileSystemMutationLeaseRelease {
  (): Promise<void>;
  bindEffectProcess(pid: number, windowsJobContained: boolean): Promise<void>;
  finishEffectProcess(): Promise<void>;
}

function effectRuntimePath(agentHome: string, name: string): string {
  return path.join(
    agentHome,
    'runtime',
    ...(EFFECT_TEST_SCOPE === undefined ? [] : [`test-filesystem-effects-${EFFECT_TEST_SCOPE}`]),
    name,
  );
}

function captureEffectLeaseStorage(): EffectLeaseStorage {
  const agentHome = process.platform === 'win32'
    ? path.join(
        path.resolve(process.env.PROGRAMDATA ?? 'C:\\ProgramData'),
        'KodaX',
        'sandbox-runtime',
      )
    : getAgentConfigHome();
  return {
    coordinatorPath: effectRuntimePath(agentHome, EFFECT_COORDINATOR_LOCK),
    statePath: effectRuntimePath(agentHome, EFFECT_STATE_FILE),
  };
}

function isEffectLeaseOwner(value: unknown): value is EffectLeaseOwner {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return Number.isInteger(record.pid)
    && typeof record.token === 'string'
    && (record.effectPid === undefined || Number.isInteger(record.effectPid))
    && (record.effectProcessStartIdentity === undefined
      || typeof record.effectProcessStartIdentity === 'string')
    && (record.effectFinished === undefined || typeof record.effectFinished === 'boolean')
    && (record.processStartIdentity === undefined
      || typeof record.processStartIdentity === 'string')
    && (record.sandboxPolicyKey === undefined || typeof record.sandboxPolicyKey === 'string')
    && (record.posixProcessGroup === undefined || typeof record.posixProcessGroup === 'boolean')
    && (record.windowsJobContained === undefined
      || typeof record.windowsJobContained === 'boolean');
}

async function readEffectLeaseState(storage: EffectLeaseStorage): Promise<EffectLeaseState> {
  let raw: string;
  try {
    raw = await readFile(storage.statePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { direct: [], namespaces: [], shells: [] };
    }
    throw error;
  }
  const value: unknown = JSON.parse(raw);
  if (typeof value !== 'object' || value === null) {
    throw new Error('Invalid filesystem effect lease state.');
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.direct) || !record.direct.every(isEffectLeaseOwner)) {
    throw new Error('Invalid direct filesystem effect state.');
  }
  if (!Array.isArray(record.shells) || !record.shells.every(isEffectLeaseOwner)) {
    throw new Error('Invalid shell filesystem effect state.');
  }
  const namespaces = record.namespaces ?? [];
  if (!Array.isArray(namespaces) || !namespaces.every(isEffectLeaseOwner)) {
    throw new Error('Invalid namespace filesystem effect state.');
  }
  return { direct: record.direct, namespaces, shells: record.shells };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function isEffectLeaseOwnerAlive(owner: EffectLeaseOwner): boolean {
  if (!isProcessAlive(owner.pid)) return false;
  const currentIdentity = owner.pid === process.pid
    ? getEffectOwnerStartIdentity()
    : readProcessStartIdentity(owner.pid);
  return owner.processStartIdentity === undefined
    || currentIdentity === undefined
    || currentIdentity === owner.processStartIdentity;
}

function modelEffectTreeState(
  owner: EffectLeaseOwner,
  managedCleanupSkipped: boolean,
): 'absent' | 'alive' | 'unknown' {
  if (owner.effectFinished === true) return 'absent';
  if (owner.effectPid === undefined) return managedCleanupSkipped ? 'unknown' : 'absent';
  if (owner.posixProcessGroup === true) {
    try {
      process.kill(-owner.effectPid, 0);
      return 'alive';
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'absent' : 'unknown';
    }
  }
  const currentIdentity = readProcessStartIdentity(owner.effectPid);
  if (
    currentIdentity !== undefined
    && (
      owner.effectProcessStartIdentity === undefined
      || currentIdentity === owner.effectProcessStartIdentity
    )
  ) return 'alive';
  if (process.platform !== 'win32') return 'absent';
  if (owner.windowsJobContained === true || !managedCleanupSkipped) return 'absent';
  return 'unknown';
}

function removeStaleEffectLeases(
  state: EffectLeaseState,
  managedCleanupSkipped: boolean,
): EffectLeaseState {
  const parentAlive = new Map<EffectLeaseOwner, boolean>();
  for (const owner of [...state.direct, ...state.namespaces, ...state.shells]) {
    parentAlive.set(owner, isEffectLeaseOwnerAlive(owner));
  }
  const keepExternalEffect = (owner: EffectLeaseOwner): boolean => (
    parentAlive.get(owner) === true
    || modelEffectTreeState(owner, managedCleanupSkipped) !== 'absent'
  );
  return {
    direct: state.direct.filter((owner) => parentAlive.get(owner) === true),
    namespaces: state.namespaces.filter(keepExternalEffect),
    shells: state.shells.filter(keepExternalEffect),
  };
}

async function reconcileAbandonedManagedEffects(storage: EffectLeaseStorage): Promise<boolean> {
  const hasAbandonedExternalEffect = await withEffectLeaseCoordinator(storage, async () => {
    const state = await readEffectLeaseState(storage);
    return [...state.namespaces, ...state.shells]
      .some((owner) => !isEffectLeaseOwnerAlive(owner));
  });
  if (!hasAbandonedExternalEffect) return true;
  const cleanup = await cleanupRegisteredManagedChildren();
  return cleanup.skipped > 0;
}

async function writeEffectLeaseState(
  storage: EffectLeaseStorage,
  state: EffectLeaseState,
): Promise<void> {
  const { statePath } = storage;
  if (state.direct.length === 0 && state.namespaces.length === 0 && state.shells.length === 0) {
    await rm(statePath, { force: true });
    return;
  }
  await mkdir(path.dirname(statePath), { recursive: true });
  const temporaryPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(state)}\n`, 'utf8');
  try {
    await rename(temporaryPath, statePath);
  } catch (error) {
    try {
      await rm(temporaryPath, { force: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Filesystem effect state update and cleanup both failed.',
      );
    }
    throw error;
  }
}

async function withEffectLeaseCoordinator<T>(
  storage: EffectLeaseStorage,
  operation: () => Promise<T>,
): Promise<T> {
  const release = await acquireKodaXFileLock(
    storage.coordinatorPath,
    FILE_SYSTEM_EFFECT_COORDINATOR_TIMEOUT_MS,
  );
  try {
    return await operation();
  } finally {
    await release();
  }
}

function namespaceConflictsWithShell(
  namespace: EffectLeaseOwner,
  shellPolicyKey: string | undefined,
): boolean {
  if (namespace.sandboxPolicyKey === undefined) return true;
  // Only an exact, verified sandbox policy may share the ACL transition.
  // Ordinary permission execution still has to wait until path-based ACL
  // grants/revokes finish so it cannot retarget a junction mid-transition.
  if (shellPolicyKey === undefined) return true;
  return namespace.sandboxPolicyKey !== shellPolicyKey;
}

function shellConflictsWithNamespace(
  shell: EffectLeaseOwner,
  namespacePolicyKey: string | undefined,
): boolean {
  if (namespacePolicyKey === undefined) return true;
  if (shell.sandboxPolicyKey === undefined) return true;
  return shell.sandboxPolicyKey !== namespacePolicyKey;
}

async function acquireEffectLease(
  mode: EffectLeaseMode,
  sandboxPolicyKey?: string,
): Promise<FileSystemMutationLeaseRelease> {
  const storage = captureEffectLeaseStorage();
  const token = randomUUID();
  const ownerStartIdentity = getEffectOwnerStartIdentity();
  const owner: EffectLeaseOwner = {
    pid: process.pid,
    token,
    ...(ownerStartIdentity === undefined
      ? {}
      : { processStartIdentity: ownerStartIdentity }),
    ...(sandboxPolicyKey === undefined ? {} : { sandboxPolicyKey }),
  };
  const conflictDeadline = Date.now() + FILE_SYSTEM_EFFECT_CONFLICT_TIMEOUT_MS;
  const policyTransitionDeadline = Date.now()
    + FILE_SYSTEM_EFFECT_POLICY_TRANSITION_TIMEOUT_MS;
  const managedCleanupSkipped = await reconcileAbandonedManagedEffects(storage);
  while (true) {
    const acquired = await withEffectLeaseCoordinator(storage, async () => {
      const state = removeStaleEffectLeases(
        await readEffectLeaseState(storage),
        managedCleanupSkipped,
      );
      const conflicts = mode === 'shell'
        ? state.direct.length > 0
          || state.namespaces.some((lease) => (
            namespaceConflictsWithShell(lease, sandboxPolicyKey)
          ))
        : mode === 'direct'
          ? state.shells.length > 0 || state.namespaces.length > 0
          : state.direct.length > 0
            || state.namespaces.length > 0
            || state.shells.some((lease) => (
              shellConflictsWithNamespace(lease, sandboxPolicyKey)
            ));
      if (conflicts) {
        const incompatibleSandboxPolicy = sandboxPolicyKey !== undefined && (
          mode === 'namespace'
            ? state.namespaces.some((lease) => (
                lease.sandboxPolicyKey !== sandboxPolicyKey
              ))
              || state.shells.some((lease) => (
                shellConflictsWithNamespace(lease, sandboxPolicyKey)
              ))
            : mode === 'shell'
              && state.namespaces.some((lease) => (
                lease.sandboxPolicyKey !== undefined
                && lease.sandboxPolicyKey !== sandboxPolicyKey
              ))
        );
        if (incompatibleSandboxPolicy) return 'sandbox-policy-conflict' as const;
        const sandboxAclTransition = state.direct.length === 0 && (
          mode === 'namespace'
            ? sandboxPolicyKey !== undefined
              && state.shells.every((lease) => (
                !shellConflictsWithNamespace(lease, sandboxPolicyKey)
              ))
              && state.namespaces.length > 0
              && state.namespaces.every((lease) => (
                lease.sandboxPolicyKey === sandboxPolicyKey
              ))
            : mode === 'shell'
              && sandboxPolicyKey === undefined
              && state.namespaces.length > 0
              && state.namespaces.every((lease) => (
                lease.sandboxPolicyKey !== undefined
              ))
        );
        return sandboxAclTransition
          ? 'sandbox-acl-transition' as const
          : false;
      }
      await writeEffectLeaseState(storage, mode === 'shell'
        ? { direct: state.direct, namespaces: state.namespaces, shells: [...state.shells, owner] }
        : mode === 'direct'
          ? { direct: [...state.direct, owner], namespaces: state.namespaces, shells: state.shells }
          : { direct: state.direct, namespaces: [...state.namespaces, owner], shells: state.shells });
      return true;
    });
    if (acquired === true) break;
    if (acquired === 'sandbox-policy-conflict') {
      throw new Error('A different sandbox policy is already active.');
    }
    const deadline = acquired === 'sandbox-acl-transition'
      ? policyTransitionDeadline
      : conflictDeadline;
    if (Date.now() >= deadline) {
      throw new Error('A model filesystem effect is already active; retry after it finishes.');
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }

  let released = false;
  let releaseAttempt: Promise<void> | undefined;
  let backgroundReleaseScheduled = false;
  let stateUpdateAttempted = false;
  const releaseOnce = (): Promise<void> => withEffectLeaseCoordinator(storage, async () => {
    const state = await readEffectLeaseState(storage);
    const owned = (mode === 'shell'
      ? state.shells
      : mode === 'direct'
        ? state.direct
        : state.namespaces)
      .find((lease) => lease.token === token);
    if (owned === undefined) {
      if (stateUpdateAttempted) return;
      throw new Error('Filesystem effect lease ownership was lost.');
    }
    if (owned.effectPid !== undefined && owned.effectFinished !== true) {
      throw new Error('Filesystem effect process tree has not been proven drained.');
    }
    stateUpdateAttempted = true;
    await writeEffectLeaseState(storage, mode === 'shell'
      ? {
          direct: state.direct,
          namespaces: state.namespaces,
          shells: state.shells.filter((lease) => lease.token !== token),
        }
      : mode === 'direct'
        ? {
            direct: state.direct.filter((lease) => lease.token !== token),
            namespaces: state.namespaces,
            shells: state.shells,
          }
        : {
            direct: state.direct,
            namespaces: state.namespaces.filter((lease) => lease.token !== token),
            shells: state.shells,
          });
  });
  const scheduleBackgroundRelease = (): void => {
    if (released || backgroundReleaseScheduled) return;
    backgroundReleaseScheduled = true;
    const retry = (): void => {
      const timer = setTimeout(() => {
        void releaseOnce().then(() => {
          released = true;
          backgroundReleaseScheduled = false;
        }).catch(() => {
          retry();
        });
      }, 250);
      timer.unref?.();
    };
    retry();
  };
  const releaseReliably = async (): Promise<void> => {
    let lastError: unknown;
    for (let attempt = 1; attempt <= FILE_SYSTEM_EFFECT_RELEASE_ATTEMPTS; attempt += 1) {
      try {
        await releaseOnce();
        return;
      } catch (error) {
        lastError = error;
        if (attempt < FILE_SYSTEM_EFFECT_RELEASE_ATTEMPTS) {
          await new Promise<void>((resolve) => setTimeout(resolve, 20));
        }
      }
    }
    scheduleBackgroundRelease();
    throw lastError;
  };
  const release = async (): Promise<void> => {
    if (released) return;
    releaseAttempt ??= releaseReliably().then(() => {
      released = true;
    }).finally(() => {
      releaseAttempt = undefined;
    });
    await releaseAttempt;
  };
  const bindEffectProcess = async (
    effectPid: number,
    windowsJobContained: boolean,
  ): Promise<void> => {
    if (!Number.isInteger(effectPid) || effectPid <= 0) {
      throw new Error(`Invalid filesystem effect process id: ${effectPid}`);
    }
    await withEffectLeaseCoordinator(storage, async () => {
      const state = await readEffectLeaseState(storage);
      const owners = mode === 'shell'
        ? state.shells
        : mode === 'direct'
          ? state.direct
          : state.namespaces;
      if (!owners.some((lease) => lease.token === token)) {
        throw new Error('Filesystem effect lease ownership was lost before process binding.');
      }
      const effectProcessStartIdentity = readProcessStartIdentity(effectPid);
      const boundOwner: EffectLeaseOwner = {
        ...owner,
        effectPid,
        effectFinished: false,
        ...(effectProcessStartIdentity === undefined
          ? {}
          : { effectProcessStartIdentity }),
        posixProcessGroup: process.platform !== 'win32',
        windowsJobContained,
      };
      const replaceOwner = (lease: EffectLeaseOwner): EffectLeaseOwner => (
        lease.token === token ? boundOwner : lease
      );
      await writeEffectLeaseState(storage, {
        direct: mode === 'direct' ? state.direct.map(replaceOwner) : state.direct,
        namespaces: mode === 'namespace' ? state.namespaces.map(replaceOwner) : state.namespaces,
        shells: mode === 'shell' ? state.shells.map(replaceOwner) : state.shells,
      });
    });
    effectFinished = false;
  };
  let effectFinished = false;
  let finishAttempt: Promise<void> | undefined;
  let backgroundFinishScheduled = false;
  const finishEffectProcessOnce = (): Promise<void> => withEffectLeaseCoordinator(storage, async () => {
      const state = await readEffectLeaseState(storage);
      const replaceOwner = (lease: EffectLeaseOwner): EffectLeaseOwner => (
        lease.token === token ? { ...lease, effectFinished: true } : lease
      );
      const owners = mode === 'shell'
        ? state.shells
        : mode === 'direct'
          ? state.direct
          : state.namespaces;
      if (!owners.some((lease) => lease.token === token)) {
        throw new Error('Filesystem effect lease ownership was lost before tree completion.');
      }
      await writeEffectLeaseState(storage, {
        direct: mode === 'direct' ? state.direct.map(replaceOwner) : state.direct,
        namespaces: mode === 'namespace' ? state.namespaces.map(replaceOwner) : state.namespaces,
        shells: mode === 'shell' ? state.shells.map(replaceOwner) : state.shells,
      });
    });
  const scheduleBackgroundFinish = (): void => {
    if (effectFinished || backgroundFinishScheduled) return;
    backgroundFinishScheduled = true;
    const retry = (): void => {
      const timer = setTimeout(() => {
        void finishEffectProcessOnce().then(() => {
          effectFinished = true;
          backgroundFinishScheduled = false;
        }).catch(() => {
          retry();
        });
      }, 250);
      timer.unref?.();
    };
    retry();
  };
  const finishEffectProcess = async (): Promise<void> => {
    if (effectFinished) return;
    finishAttempt ??= (async () => {
      let lastError: unknown;
      for (let attempt = 1; attempt <= FILE_SYSTEM_EFFECT_RELEASE_ATTEMPTS; attempt += 1) {
        try {
          await finishEffectProcessOnce();
          effectFinished = true;
          return;
        } catch (error) {
          lastError = error;
          if (attempt < FILE_SYSTEM_EFFECT_RELEASE_ATTEMPTS) {
            await new Promise<void>((resolve) => setTimeout(resolve, 20));
          }
        }
      }
      scheduleBackgroundFinish();
      throw lastError;
    })().finally(() => {
      finishAttempt = undefined;
    });
    await finishAttempt;
  };
  return Object.assign(release, { bindEffectProcess, finishEffectProcess });
}

/**
 * Serializes host-privileged file sinks with model-started mutating shells.
 * This closes the symlink/junction retarget window between canonical policy
 * checks and the actual filesystem operation.
 */
export function acquireFileSystemMutationLease(
  sandboxPolicyKey?: string,
): Promise<FileSystemMutationLeaseRelease> {
  return acquireEffectLease('shell', sandboxPolicyKey);
}

/** Excludes every model-started shell while a temporary host namespace is visible. */
export function acquireExclusiveFileSystemEffectLease(
  sandboxPolicyKey?: string,
): Promise<FileSystemMutationLeaseRelease> {
  return acquireEffectLease('namespace', sandboxPolicyKey);
}

function acquireDirectFileMutationLease(): Promise<FileSystemMutationLeaseRelease> {
  return acquireEffectLease('direct');
}

/** Keep one host-side filesystem effect disjoint from model-started shells. */
export async function withHostFileSystemMutation<T>(operation: () => Promise<T>): Promise<T> {
  const releaseLease = await acquireDirectFileMutationLease();
  try {
    return await operation();
  } finally {
    await releaseLease();
  }
}

/** Serialize a host operation that can materialize or remove path aliases. */
export async function withHostFileSystemNamespaceMutation<T>(
  operation: (
    bindEffectProcess: FileSystemMutationLeaseRelease['bindEffectProcess'],
    finishEffectProcess: FileSystemMutationLeaseRelease['finishEffectProcess'],
  ) => Promise<T>,
): Promise<T> {
  const releaseLease = await acquireEffectLease('namespace');
  try {
    return await operation(
      releaseLease.bindEffectProcess,
      releaseLease.finishEffectProcess,
    );
  } finally {
    await releaseLease();
  }
}

/** Record the latest restorable mutation, including repeat edits to one path. */
export function recordFileBackup(
  backups: Map<string, string>,
  filePath: string,
  content: string,
): void {
  const backupPath = canonicalizeAgentHomePolicyPath(filePath);
  if (backupPath === undefined) throw new Error(`Cannot identify backup path: ${filePath}`);
  backups.delete(backupPath);
  backups.set(backupPath, content);
}

/**
 * Normalize a path so equivalent variants collide on the same queue
 * key. Cross-platform parity per design §FEATURE_131 acceptance #9.
 *
 * On Windows the filesystem is case-insensitive across the entire
 * path, so we lowercase everything once we know we're on win32.
 * POSIX paths are case-sensitive and stay as-is. Detection is via
 * `process.platform`, with `KODAX_PATH_KEY_PLATFORM` as a test-only
 * override so unit tests can exercise both branches regardless of
 * the host OS.
 */
function isWindowsPathPlatform(): boolean {
  const override = process.env.KODAX_PATH_KEY_PLATFORM;
  if (override === 'win32') return true;
  if (override === 'posix') return false;
  return process.platform === 'win32';
}

export function normalizePathForKey(absolutePath: string): string {
  if (typeof absolutePath !== 'string' || absolutePath.length === 0) {
    return '';
  }
  let normalized = absolutePath.replace(/\\/g, '/');
  // Collapse repeated separators ("a//b" → "a/b") but not the leading
  // double-slash on UNC paths.
  if (normalized.startsWith('//')) {
    normalized = '//' + normalized.slice(2).replace(/\/+/g, '/');
  } else {
    normalized = normalized.replace(/\/+/g, '/');
  }
  if (isWindowsPathPlatform()) {
    // Windows filesystem is case-insensitive end-to-end — lowercase
    // the entire path so any spelling collides on the same key.
    normalized = normalized.toLowerCase();
  } else if (normalized.length >= 2 && /^[A-Za-z]:/.test(normalized)) {
    // POSIX host but a Windows-style path snuck in (cross-platform
    // tests, mock data) — at minimum align the drive letter so the
    // common case of `C:` vs `c:` doesn't split the queue.
    normalized = normalized[0]!.toLowerCase() + normalized.slice(1);
  }
  // Trim trailing slash unless it's the root marker.
  if (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.replace(/\/+$/g, '');
  }
  return normalized;
}

/**
 * Run `fn` serialized against any other in-flight mutations targeting
 * the same `absolutePath`. Returns whatever `fn` returns. The queue
 * tail entry is cleared when this call's work is the current tail —
 * so steady-state behavior is "queue size === count of paths with
 * mutations actively in flight", never growing unboundedly.
 *
 * Errors propagate: if `fn` throws/rejects, the queue still moves on
 * to the next caller (it chains off `previous` not off the failure),
 * but the rejected promise is what `withFileMutation` returns to the
 * caller. Subsequent enqueues see a settled prior tail and proceed.
 */
export async function withFileMutation<T>(
  absolutePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = normalizePathForKey(absolutePath);
  const previous = fileMutationQueue.get(key) ?? Promise.resolve();
  // Wrap `fn` so a failure on the prior tail does not poison this
  // call's chain. We always advance the queue regardless of whether
  // the prior caller succeeded.
  const next: Promise<T> = previous
    .catch(() => undefined)
    .then(async () => {
      return withHostFileSystemMutation(async () => {
        if (isAgentHomeHardMutationTarget(absolutePath)) {
          throw new Error(`Mutation targets protected KodaX state: ${absolutePath}`);
        }
        return await fn();
      });
    });
  // Track a sibling promise for tail-eviction so `next`'s consumer
  // sees its real result (success or rejection) without our cleanup
  // accidentally swallowing it.
  const trackable: Promise<unknown> = next.catch(() => undefined).finally(() => {
    if (fileMutationQueue.get(key) === trackable) {
      fileMutationQueue.delete(key);
    }
  });
  fileMutationQueue.set(key, trackable);
  return next;
}

/**
 * Test-only helper: snapshot the live queue size. Used by the unit
 * tests to assert "no leak after settle". Production code should not
 * read this — it only exists for verification.
 */
export function _peekFileMutationQueueSizeForTests(): number {
  return fileMutationQueue.size;
}

/**
 * Test-only helper: clear the queue between tests. Production code
 * should never call this — it would orphan in-flight mutations.
 */
export function _resetFileMutationQueueForTests(): void {
  fileMutationQueue.clear();
}

export async function _resetFileSystemEffectLeasesForTests(): Promise<void> {
  if (process.env.VITEST_WORKER_ID === undefined) {
    throw new Error('Filesystem-effect lease reset is only available under Vitest.');
  }
  const storage = captureEffectLeaseStorage();
  await rm(storage.statePath, { force: true });
}
