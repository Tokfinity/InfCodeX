import { Worker, type ResourceLimits } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { RuntimeSubscription } from '../sdk-runtime.js';
import type { RuntimeDaemonClientTransport } from '../runtime-daemon/client.js';
import {
  createRuntimeDaemonRequest,
  isRuntimeDaemonErrorResponse,
  isRuntimeDaemonNotification,
  isRuntimeDaemonSuccessResponse,
  type RuntimeDaemonNotification,
} from '../runtime-daemon/protocol.js';
import type {
  RuntimeWorkerBootstrapOptions,
  RuntimeWorkerOptions,
} from './protocol.js';

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

export interface RuntimeWorkerTransportHandle {
  readonly transport: RuntimeDaemonClientTransport;
  readonly threadId: number;
  terminate(): Promise<void>;
}

export function createRuntimeWorkerTransport(
  bootstrap: RuntimeWorkerBootstrapOptions,
  options: RuntimeWorkerOptions = {},
): RuntimeWorkerTransportHandle {
  const workerUrl = resolveRuntimeWorkerUrl();
  const worker = new Worker(workerUrl, {
    workerData: bootstrap,
    execArgv: workerUrl.href.endsWith('.ts') ? ['--import', 'tsx'] : [],
    ...(options.resourceLimits !== undefined
      ? { resourceLimits: options.resourceLimits as ResourceLimits }
      : {}),
  });
  const pending = new Map<string, PendingRequest>();
  const listeners = new Set<(notification: RuntimeDaemonNotification) => void>();
  let requestSequence = 0;
  let closed = false;

  const rejectPending = (error: Error): void => {
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  };
  const markClosed = (error: Error): void => {
    if (closed) return;
    closed = true;
    rejectPending(error);
    listeners.clear();
  };

  worker.on('message', (message: unknown) => {
    if (isRuntimeDaemonNotification(message)) {
      for (const listener of listeners) listener(message);
      return;
    }
    if (!isRuntimeDaemonSuccessResponse(message) && !isRuntimeDaemonErrorResponse(message)) return;
    if (!message.id) return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (isRuntimeDaemonSuccessResponse(message)) {
      entry.resolve(message.result);
      return;
    }
    const error = new Error(message.error.message) as Error & { code?: string; data?: unknown };
    error.code = message.error.code;
    if (message.error.data !== undefined) error.data = message.error.data;
    entry.reject(error);
  });
  worker.on('error', (error) => markClosed(error));
  worker.on('exit', (code) => markClosed(new Error(`Runtime Worker exited with code ${code}.`)));

  const transport: RuntimeDaemonClientTransport = {
    request(method, params) {
      if (closed) return Promise.reject(new Error('Runtime Worker transport is closed.'));
      const id = `worker_${++requestSequence}`;
      return new Promise<unknown>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        try {
          worker.postMessage(createRuntimeDaemonRequest(id, method, params));
        } catch (error: unknown) {
          pending.delete(id);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
    subscribe(listener): RuntimeSubscription {
      if (closed) return { close() {} };
      listeners.add(listener);
      return { close: () => listeners.delete(listener) };
    },
    async close() {
      if (closed) return;
      markClosed(new Error('Runtime Worker transport closed.'));
      await worker.terminate();
    },
  };

  return {
    transport,
    threadId: worker.threadId,
    async terminate() {
      if (!closed) markClosed(new Error('Runtime Worker terminated.'));
      await worker.terminate();
    },
  };
}

function resolveRuntimeWorkerUrl(): URL {
  if (import.meta.url.endsWith('.ts')) {
    const compiled = new URL('../../dist/runtime-worker.js', import.meta.url);
    if (existsSync(fileURLToPath(compiled))) return compiled;
    return new URL('./entry.ts', import.meta.url);
  }
  if (process.env.KODAX_BUNDLED === 'true') {
    return pathToFileURL(join(dirname(process.execPath), 'runtime-worker.js'));
  }
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const sidecarDir = basename(currentDir) === 'chunks' ? dirname(currentDir) : currentDir;
  return pathToFileURL(join(sidecarDir, 'runtime-worker.js'));
}
