import type { KodaXRuntime } from '../sdk-runtime.js';
import {
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
  releaseRuntimeDaemonLock,
  removeRuntimeDaemonStateFiles,
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
  try {
    server = await createRuntimeDaemonSocketServer({
      endpoint: options.endpoint,
      createDispatcher: (notify) => createRuntimeDaemonDispatcher({
        runtime: options.runtime,
        authToken: token,
        allowAgentRegistrationAdmin: true,
        notify,
        runResults,
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
  } catch (error: unknown) {
    appendRuntimeDaemonLog(options.paths, 'error', 'Runtime daemon failed to start.', {
      error: normalizeHostError(error).message,
    });
    restoreDiagnostics();
    releaseRuntimeDaemonLock(options.lock);
    writeRuntimeDaemonState(options.paths, {
      ...starting,
      status: 'unhealthy',
      lastError: normalizeHostError(error).message,
    });
    throw error;
  }

  const ready = createHostState(options, 'ready');
  writeRuntimeDaemonState(options.paths, ready);
  appendRuntimeDaemonLog(options.paths, 'info', 'Runtime daemon ready.', {
    runtimeId: ready.runtimeId,
    endpoint: ready.endpoint,
  });
  let closed = false;
  let signalClosed: (() => void) | undefined;
  const closedPromise = new Promise<void>((resolve) => { signalClosed = resolve; });
  const closeHost = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    try {
      writeRuntimeDaemonState(options.paths, createHostState(options, 'stopping'));
      appendRuntimeDaemonLog(options.paths, 'info', 'Runtime daemon stopping.');
      await server?.close();
      runResults.clear();
      await options.runtime.close();
      appendRuntimeDaemonLog(options.paths, 'info', 'Runtime daemon stopped.');
      restoreDiagnostics();
      if (releaseRuntimeDaemonLock(options.lock)) {
        removeRuntimeDaemonStateFiles(options.paths);
      }
    } finally {
      signalClosed?.();
    }
  };
  requestStop = () => {
    const timer = setTimeout(() => {
      void closeHost();
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
