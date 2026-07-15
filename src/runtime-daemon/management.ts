import type {
  KodaXRuntime,
  RuntimeDaemonManagementState,
  RuntimeDaemonPreflight,
  RuntimeDaemonRollbackInput,
  RuntimeDaemonRollbackResult,
  RuntimeSubscription,
} from '../sdk-runtime.js';
import {
  commitRuntimeDaemonRollbackPolicy,
  readRuntimeDaemonLockOwner,
  readRuntimeOwnerPolicy,
  type RuntimeDaemonPaths,
} from './state.js';

export interface RuntimeDaemonManagementController {
  attachClient(connectionId: string): void;
  detachClient(connectionId: string): void;
  runMutation<T>(effect: () => Promise<T>): Promise<T>;
  preflight(): Promise<RuntimeDaemonPreflight>;
  inspect(): Promise<RuntimeDaemonManagementState>;
  stop(): Promise<{ readonly ok: true }>;
  rollbackToInline(input: RuntimeDaemonRollbackInput): Promise<RuntimeDaemonRollbackResult>;
  close(): void;
}

export function createRuntimeDaemonManagementController(input: {
  readonly runtime: KodaXRuntime;
  readonly paths: RuntimeDaemonPaths;
  readonly requestStop: () => void;
}): RuntimeDaemonManagementController {
  return new DaemonManagementController(input);
}

class DaemonManagementController implements RuntimeDaemonManagementController {
  private readonly clients = new Set<string>();
  private readonly runtimeEvents: RuntimeSubscription;
  private revision = 0;
  private activeMutations = 0;
  private draining = false;
  private closed = false;
  private preflightFingerprint: string | undefined;

  constructor(private readonly input: {
    readonly runtime: KodaXRuntime;
    readonly paths: RuntimeDaemonPaths;
    readonly requestStop: () => void;
  }) {
    this.runtimeEvents = input.runtime.events.subscribe({}, () => {
      this.revision += 1;
    });
  }

  attachClient(connectionId: string): void {
    if (this.draining || this.closed) {
      throw managementError('conflict', 'Runtime daemon is draining and cannot attach another client.');
    }
    if (this.clients.has(connectionId)) return;
    this.clients.add(connectionId);
    this.revision += 1;
  }

  detachClient(connectionId: string): void {
    if (!this.clients.delete(connectionId)) return;
    this.revision += 1;
  }

  async runMutation<T>(effect: () => Promise<T>): Promise<T> {
    if (this.draining || this.closed) {
      throw managementError('conflict', 'Runtime daemon is draining and rejects new mutations.');
    }
    this.activeMutations += 1;
    this.revision += 1;
    try {
      return await effect();
    } finally {
      this.activeMutations -= 1;
    }
  }

  async preflight(): Promise<RuntimeDaemonPreflight> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const before = this.revision;
      const current = await this.input.runtime.status.preflight();
      this.observePreflight(current);
      if (before === this.revision && this.activeMutations === 0) {
        return withLogicalClients(current, this.clients.size);
      }
    }
    throw managementError('conflict', 'Runtime state changed while daemon preflight was being read.');
  }

  async inspect(): Promise<RuntimeDaemonManagementState> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const revision = this.revision;
      const current = await this.preflight();
      if (revision !== this.revision) continue;
      const owner = readRuntimeDaemonLockOwner(this.input.paths.lockFile);
      if (
        owner === undefined
        || owner.runtimeId !== this.input.runtime.identity.runtimeId
        || owner.kind !== 'daemon'
      ) {
        throw managementError('conflict', 'Runtime daemon owner fence changed during inspection.');
      }
      return {
        runtimeId: this.input.runtime.identity.runtimeId,
        revision,
        ownerPolicy: readRuntimeOwnerPolicy(this.input.paths),
        owner,
        preflight: current,
      };
    }
    throw managementError('conflict', 'Runtime state changed while daemon management was inspected.');
  }

  async stop(): Promise<{ readonly ok: true }> {
    this.beginDraining();
    try {
      await this.assertStoppable();
      this.input.requestStop();
      return { ok: true };
    } catch (error: unknown) {
      this.draining = false;
      throw error;
    }
  }

  async rollbackToInline(rollback: RuntimeDaemonRollbackInput): Promise<RuntimeDaemonRollbackResult> {
    if (rollback.expectedRuntimeId !== this.input.runtime.identity.runtimeId) {
      throw managementError('conflict', 'Runtime daemon instance changed before rollback commit.');
    }
    this.beginDraining(rollback.expectedRevision);
    try {
      await this.assertStoppable(rollback.expectedRevision);
      const ownerPolicy = commitRuntimeDaemonRollbackPolicy(
        this.input.paths,
        rollback.expectedRuntimeId,
        rollback.expectedOwnerPolicyRevision,
      );
      if (ownerPolicy.mode !== 'inline') {
        throw managementError('internal_error', 'Runtime owner rollback did not commit inline mode.');
      }
      this.revision += 1;
      this.input.requestStop();
      return {
        accepted: true,
        runtimeId: this.input.runtime.identity.runtimeId,
        revision: this.revision,
        ownerPolicy: { ...ownerPolicy, mode: 'inline' },
      };
    } catch (error: unknown) {
      this.draining = false;
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.runtimeEvents.close();
    this.clients.clear();
  }

  private beginDraining(expectedRevision?: number): void {
    if (this.closed) throw managementError('conflict', 'Runtime daemon management is closed.');
    if (this.draining) throw managementError('conflict', 'Runtime daemon is already draining.');
    if (expectedRevision !== undefined && this.revision !== expectedRevision) {
      throw managementError(
        'conflict',
        `Runtime daemon management revision changed: expected ${expectedRevision}, current ${this.revision}.`,
      );
    }
    if (this.activeMutations > 0) {
      throw managementError('conflict', 'Runtime daemon has an in-flight mutation.');
    }
    this.draining = true;
  }

  private async assertStoppable(expectedRevision?: number): Promise<void> {
    const current = await this.preflight();
    if (expectedRevision !== undefined && this.revision !== expectedRevision) {
      throw managementError(
        'conflict',
        `Runtime daemon state changed before stop commit: expected ${expectedRevision}, current ${this.revision}.`,
      );
    }
    if (!current.canStop) {
      throw managementError(
        'conflict',
        `Runtime daemon cannot stop safely: ${current.blockers.join(', ')}.`,
        { preflight: current },
      );
    }
  }

  private observePreflight(current: RuntimeDaemonPreflight): void {
    const fingerprint = JSON.stringify(current);
    if (this.preflightFingerprint === undefined) {
      this.preflightFingerprint = fingerprint;
      return;
    }
    if (fingerprint === this.preflightFingerprint) return;
    this.preflightFingerprint = fingerprint;
    this.revision += 1;
  }
}

function withLogicalClients(
  current: RuntimeDaemonPreflight,
  clientCount: number,
): RuntimeDaemonPreflight {
  const blockers: Array<RuntimeDaemonPreflight['blockers'][number]> = current.blockers
    .filter((blocker) => blocker !== 'connected_clients');
  if (clientCount > 1) blockers.push('connected_clients');
  return {
    ...current,
    clientCount,
    blockers,
    canStop: blockers.length === 0,
  };
}

function managementError(
  code: 'conflict' | 'internal_error',
  message: string,
  data?: unknown,
): Error & { readonly code: 'conflict' | 'internal_error'; readonly data?: unknown } {
  const error = new Error(message) as Error & {
    code: 'conflict' | 'internal_error';
    data?: unknown;
  };
  error.code = code;
  if (data !== undefined) error.data = data;
  return error;
}
