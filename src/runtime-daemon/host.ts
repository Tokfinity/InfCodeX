import type { KodaXRuntime } from '../sdk-runtime.js';
import path from 'node:path';
import {
  emitKodaXDiagnostic,
  setKodaXDiagnosticSink,
  type KodaXDiagnostic,
} from '@kodax-ai/agent';
import {
  createRuntimeDaemonDispatcher,
  createRuntimeDaemonRunResultStore,
} from './server.js';
import {
  appendRuntimeDaemonLog,
  createRuntimeDaemonToken,
  ensureRuntimeDaemonDirectories,
  readRuntimeDaemonLog,
  readRuntimeDaemonLockOwner,
  releaseRuntimeDaemonOwnership,
  writeRuntimeDaemonToken,
  writeRuntimeDaemonState,
  type RuntimeDaemonLockHandle,
  type RuntimeDaemonPaths,
  type RuntimeDaemonState,
} from './state.js';
import {
  createRuntimeDaemonSocketServer,
  type RuntimeDaemonEndpoint,
  type RuntimeDaemonSocketServer,
} from './transport.js';
import { createRuntimeControlJournal } from './control-journal.js';

export interface RuntimeDaemonHostOptions {
  readonly runtime: KodaXRuntime;
  readonly paths: RuntimeDaemonPaths;
  readonly endpoint: RuntimeDaemonEndpoint;
  readonly lock: RuntimeDaemonLockHandle;
}

export interface RuntimeDaemonHost {
  readonly endpoint: RuntimeDaemonEndpoint;
  readonly state: RuntimeDaemonState;
  readonly closed: Promise<void>;
  unref(): void;
  close(): Promise<void>;
}

export async function startRuntimeDaemonHost(
  options: RuntimeDaemonHostOptions,
): Promise<RuntimeDaemonHost> {
  ensureRuntimeDaemonDirectories(options.paths);
  const token = createRuntimeDaemonToken();
  writeRuntimeDaemonToken(options.paths, token);
  const starting = createHostState(options, 'starting');
  writeRuntimeDaemonState(options.paths, starting);
  appendRuntimeDaemonLog(options.paths, 'info', 'Runtime daemon starting.', {
    runtimeId: options.runtime.identity.runtimeId,
    endpoint: options.endpoint.path,
  });
  const restoreDiagnostics = setKodaXDiagnosticSink((diagnostic) => {
    appendRuntimeDiagnostic(options.paths, diagnostic);
  });

  let server: RuntimeDaemonSocketServer | undefined;
  let requestStop: (() => void) | undefined;
  const runResults = createRuntimeDaemonRunResultStore();
  const controlJournal = createRuntimeControlJournal({
    rootDir: path.join(options.paths.rootDir, 'control'),
  });
  let ready: RuntimeDaemonState;
  try {
    server = await createRuntimeDaemonSocketServer({
      endpoint: options.endpoint,
      createDispatcher: (notify) => createRuntimeDaemonDispatcher({
        runtime: options.runtime,
        authToken: token,
        allowAgentRegistrationAdmin: true,
        notify,
        runResults,
        controlJournal,
        requireOperationEnvelope: true,
        logs: () => ({
          logFile: options.paths.logFile,
          entries: readRuntimeDaemonLog(options.paths),
        }),
        stop: () => {
          appendRuntimeDaemonLog(options.paths, 'info', 'Runtime daemon stop requested.');
          requestStop?.();
          return { ok: true };
        },
      }),
    });
    ready = createHostState(options, 'ready');
    writeRuntimeDaemonState(options.paths, ready);
    appendRuntimeDaemonLog(options.paths, 'info', 'Runtime daemon ready.', {
      runtimeId: ready.runtimeId,
      endpoint: ready.endpoint,
    });
  } catch (error: unknown) {
    appendRuntimeDaemonLog(options.paths, 'error', 'Runtime daemon failed to start.', {
      error: normalizeHostError(error).message,
    });
    let transportClosed = true;
    try {
      await server?.close();
    } catch (closeError: unknown) {
      transportClosed = false;
      appendRuntimeDaemonLog(options.paths, 'error', 'Runtime daemon transport cleanup failed.', {
        error: normalizeHostError(closeError).message,
      });
    }
    runResults.clear();
    restoreDiagnostics();
    if (transportClosed) {
      await releaseHostOwnership(options.paths, options.lock);
    } else {
      writeRuntimeDaemonState(options.paths, {
        ...starting,
        status: 'unhealthy',
        lastError: 'Runtime daemon transport cleanup failed.',
      });
    }
    throw error;
  }
  let closed = false;
  let signalClosed: (() => void) | undefined;
  const closedPromise = new Promise<void>((resolve) => { signalClosed = resolve; });
  const closeHost = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    const failures: string[] = [];
    let transportClosed = false;
    let runtimeClosed = false;
    try {
      try {
        writeRuntimeDaemonState(options.paths, createHostState(options, 'stopping'));
        appendRuntimeDaemonLog(options.paths, 'info', 'Runtime daemon stopping.');
      } catch (error: unknown) {
        failures.push(`state transition: ${normalizeHostError(error).message}`);
      }
      try {
        await server?.close();
        transportClosed = true;
      } catch (error: unknown) {
        failures.push(`transport close: ${normalizeHostError(error).message}`);
      }
      runResults.clear();
      try {
        await options.runtime.close();
        runtimeClosed = true;
      } catch (error: unknown) {
        failures.push(`Runtime close: ${normalizeHostError(error).message}`);
      }
      try {
        appendRuntimeDaemonLog(options.paths, 'info', 'Runtime daemon stopped.');
      } catch (error: unknown) {
        failures.push(`stop log: ${normalizeHostError(error).message}`);
      }
      restoreDiagnostics();
      if (transportClosed && runtimeClosed) {
        const released = await releaseHostOwnership(options.paths, options.lock);
        const current = readRuntimeDaemonLockOwner(options.lock.file);
        if (
          !released
          && current?.runtimeId === options.lock.owner.runtimeId
          && current.pid === options.lock.owner.pid
          && current.createdAt === options.lock.owner.createdAt
        ) {
          failures.push('owner release: the daemon still owns its profile lock');
        }
      } else {
        try {
          writeRuntimeDaemonState(options.paths, {
            ...createHostState(options, 'unhealthy'),
            lastError: failures.join('; '),
          });
        } catch (error: unknown) {
          failures.push(`unhealthy state: ${normalizeHostError(error).message}`);
        }
      }
      if (failures.length > 0) {
        try {
          appendRuntimeDaemonLog(options.paths, 'error', 'Runtime daemon stopped with cleanup failures.', {
            failures,
          });
        } catch (error: unknown) {
          failures.push(`failure log: ${normalizeHostError(error).message}`);
        }
        throw new Error(`Runtime daemon cleanup failed: ${failures.join('; ')}`);
      }
    } finally {
      restoreDiagnostics();
      signalClosed?.();
    }
  };
  requestStop = () => {
    const timer = setTimeout(() => {
      void closeHost().catch((error: unknown) => {
        emitKodaXDiagnostic({
          source: 'runtime.daemon.host',
          level: 'error',
          message: 'Runtime daemon shutdown failed.',
          detail: normalizeHostError(error),
        });
      });
    }, 0);
    timer.unref?.();
  };

  return {
    endpoint: options.endpoint,
    state: ready,
    closed: closedPromise,
    unref() {
      server?.unref();
    },
    close: closeHost,
  };
}

async function releaseHostOwnership(
  paths: RuntimeDaemonPaths,
  lock: RuntimeDaemonLockHandle,
): Promise<boolean> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      if (releaseRuntimeDaemonOwnership(paths, lock)) return true;
    } catch (error: unknown) {
      emitKodaXDiagnostic({
        source: 'runtime.daemon.host',
        level: 'warn',
        message: 'Runtime daemon ownership release attempt failed.',
        detail: normalizeHostError(error),
      });
    }
    const current = readRuntimeDaemonLockOwner(lock.file);
    if (
      current === undefined
      || current.runtimeId !== lock.owner.runtimeId
      || current.pid !== lock.owner.pid
      || current.createdAt !== lock.owner.createdAt
      || current.kind !== lock.owner.kind
    ) return false;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  try {
    appendRuntimeDaemonLog(paths, 'error', 'Runtime daemon ownership release timed out.');
  } catch (error: unknown) {
    emitKodaXDiagnostic({
      source: 'runtime.daemon.host',
      level: 'error',
      message: 'Runtime daemon ownership release timed out and could not be logged.',
      detail: normalizeHostError(error),
    });
  }
  return false;
}

function appendRuntimeDiagnostic(paths: RuntimeDaemonPaths, diagnostic: KodaXDiagnostic): void {
  try {
    appendRuntimeDaemonLog(
      paths,
      diagnostic.level === 'error' ? 'error' : diagnostic.level === 'warn' ? 'warn' : 'info',
      `[${diagnostic.source}] ${diagnostic.message}`,
      {
        level: diagnostic.level,
        source: diagnostic.source,
        ...(diagnostic.detail !== undefined ? { detail: diagnostic.detail } : {}),
      },
    );
  } catch {
    // Diagnostic sinks must never affect the daemon runtime path.
  }
}

function createHostState(
  options: RuntimeDaemonHostOptions,
  status: RuntimeDaemonState['status'],
): RuntimeDaemonState {
  return {
    runtimeId: options.runtime.identity.runtimeId,
    profile: options.paths.profile,
    pid: process.pid,
    startedAt: options.runtime.identity.startedAt,
    endpoint: options.endpoint.path,
    version: options.runtime.identity.version,
    status,
  };
}

function normalizeHostError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
