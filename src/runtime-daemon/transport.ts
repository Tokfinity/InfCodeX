import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import type { RuntimeSubscription } from '../sdk-runtime.js';
import type { RuntimeDaemonClientTransport } from './client.js';
import {
  createRuntimeDaemonErrorResponse,
  createRuntimeDaemonRequest,
  isRuntimeDaemonErrorResponse,
  isRuntimeDaemonRequest,
  isRuntimeDaemonNotification,
  isRuntimeDaemonSuccessResponse,
  parseRuntimeDaemonFrame,
  type RuntimeDaemonFrame,
  type RuntimeDaemonNotification,
  type RuntimeDaemonErrorCode,
} from './protocol.js';
import type { RuntimeDaemonDispatcher } from './server.js';
import { normalizeRuntimeDaemonProfile } from './state.js';

export interface RuntimeDaemonEndpoint {
  readonly kind: 'pipe' | 'unix';
  readonly path: string;
}

export interface RuntimeDaemonFrameParser {
  push(chunk: Buffer | string): void;
  flush(): void;
}

export interface RuntimeDaemonSocketServerOptions {
  readonly endpoint: RuntimeDaemonEndpoint;
  readonly createDispatcher: (
    notify: (notification: RuntimeDaemonNotification) => void,
  ) => RuntimeDaemonDispatcher;
}

export interface RuntimeDaemonSocketServer {
  readonly endpoint: RuntimeDaemonEndpoint;
  close(): Promise<void>;
}

export interface RuntimeDaemonSocketClientTransportOptions {
  readonly connectTimeoutMs?: number;
}

export class RuntimeDaemonTransportError extends Error {
  constructor(
    message: string,
    readonly code: RuntimeDaemonErrorCode,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'RuntimeDaemonTransportError';
  }
}

export function isRuntimeDaemonTransportError(
  error: unknown,
): error is RuntimeDaemonTransportError {
  return error instanceof RuntimeDaemonTransportError;
}

export function defaultRuntimeDaemonEndpoint(
  profile = 'default',
  homeDir?: string,
): RuntimeDaemonEndpoint {
  const normalized = normalizeRuntimeDaemonProfile(profile);
  const scopedProfile = homeDir === undefined
    ? normalized
    : `${normalized}-${shortPathHash(path.resolve(homeDir))}`;
  if (process.platform === 'win32') {
    return {
      kind: 'pipe',
      path: `\\\\.\\pipe\\kodax-runtime-${scopedProfile}`,
    };
  }
  return {
    kind: 'unix',
    path: path.join(
      os.tmpdir(),
      `kodax-runtime-${process.getuid?.() ?? 'user'}-${scopedProfile}.sock`,
    ),
  };
}

function shortPathHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

export function createRuntimeDaemonFrameParser(
  onFrame: (frame: RuntimeDaemonFrame) => void,
): RuntimeDaemonFrameParser {
  let buffer = '';
  const consumeLine = (line: string): void => {
    if (!line.trim()) return;
    onFrame(parseRuntimeDaemonFrame(line));
  };
  return {
    push(chunk) {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      while (true) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) break;
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        consumeLine(line);
      }
    },
    flush() {
      const tail = buffer.trim();
      buffer = '';
      if (tail.length > 0) consumeLine(tail);
    },
  };
}

export async function createRuntimeDaemonSocketClientTransport(
  endpoint: RuntimeDaemonEndpoint,
  options: RuntimeDaemonSocketClientTransportOptions = {},
): Promise<RuntimeDaemonClientTransport> {
  const socket = net.createConnection(endpoint.path);
  socket.setEncoding('utf8');

  await waitForConnect(socket, options.connectTimeoutMs);

  let closed = false;
  const listeners = new Set<(notification: RuntimeDaemonNotification) => void>();
  const pending = new Map<string, {
    readonly resolve: (value: unknown) => void;
    readonly reject: (error: Error) => void;
  }>();
  const parser = createRuntimeDaemonFrameParser((frame) => {
    if (isRuntimeDaemonSuccessResponse(frame)) {
      const item = pending.get(frame.id);
      if (!item) return;
      pending.delete(frame.id);
      item.resolve(frame.result);
      return;
    }
    if (isRuntimeDaemonErrorResponse(frame)) {
      if (!frame.id) return;
      const item = pending.get(frame.id);
      if (!item) return;
      pending.delete(frame.id);
      item.reject(new RuntimeDaemonTransportError(
        frame.error.message,
        frame.error.code,
        frame.error.data,
      ));
      return;
    }
    if (isRuntimeDaemonNotification(frame)) {
      for (const listener of listeners) {
        listener(frame);
      }
    }
  });

  socket.on('data', (chunk) => parser.push(chunk));
  socket.on('close', () => {
    closed = true;
    rejectPending(pending, new Error('Runtime daemon transport closed.'));
  });
  socket.on('error', (error) => {
    closed = true;
    rejectPending(pending, error);
  });

  return {
    request(method, params) {
      if (closed) {
        return Promise.reject(new Error('Runtime daemon transport is closed.'));
      }
      const id = `req_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
      const frame = createRuntimeDaemonRequest(id, method, params);
      const result = new Promise<unknown>((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
      socket.write(`${JSON.stringify(frame)}\n`);
      return result;
    },
    subscribe(listener) {
      listeners.add(listener);
      const subscription: RuntimeSubscription = {
        close() {
          listeners.delete(listener);
        },
      };
      return subscription;
    },
    async close() {
      if (closed) return;
      closed = true;
      parser.flush();
      socket.end();
      socket.destroy();
      rejectPending(pending, new Error('Runtime daemon transport closed.'));
    },
  };
}

export async function createRuntimeDaemonSocketServer(
  options: RuntimeDaemonSocketServerOptions,
): Promise<RuntimeDaemonSocketServer> {
  await prepareUnixSocketEndpoint(options.endpoint);

  const server = net.createServer();
  const sockets = new Set<net.Socket>();
  const dispatchers = new Set<RuntimeDaemonDispatcher>();
  let closed = false;

  server.on('connection', (socket) => {
    if (closed) {
      socket.destroy();
      return;
    }
    sockets.add(socket);

    const send = (frame: RuntimeDaemonFrame): void => {
      if (socket.destroyed) return;
      socket.write(`${JSON.stringify(frame)}\n`);
    };
    const dispatcher = options.createDispatcher((notification) => send(notification));
    dispatchers.add(dispatcher);
    const parser = createRuntimeDaemonFrameParser((frame) => {
      if (isRuntimeDaemonRequest(frame)) {
        void dispatcher.handle(frame).then(send, (error: unknown) => {
          send(createRuntimeDaemonErrorResponse({
            code: 'internal_error',
            message: normalizeTransportError(error).message,
          }));
        });
        return;
      }
      if (isRuntimeDaemonErrorResponse(frame)) {
        send(frame);
        return;
      }
      send(createRuntimeDaemonErrorResponse({
        code: 'invalid_request',
        message: 'Runtime daemon server expects request frames from clients.',
      }));
    });

    socket.on('data', (chunk) => parser.push(chunk));
    socket.on('end', () => parser.flush());
    socket.on('close', () => {
      sockets.delete(socket);
      dispatchers.delete(dispatcher);
      dispatcher.close();
    });
  });

  await waitForListen(server, options.endpoint.path);

  return {
    endpoint: options.endpoint,
    async close() {
      if (closed) return;
      closed = true;
      for (const dispatcher of dispatchers) {
        dispatcher.close();
      }
      dispatchers.clear();
      for (const socket of sockets) {
        socket.destroy();
      }
      sockets.clear();
      await closeNetServer(server);
    },
  };
}

function waitForConnect(socket: net.Socket, timeoutMs = 2_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(new Error('Timed out connecting to runtime daemon.'));
    }, timeoutMs);
    timer.unref?.();
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off('connect', onConnect);
      socket.off('error', onError);
    };
    const onConnect = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    socket.once('connect', onConnect);
    socket.once('error', onError);
  });
}

function waitForListen(server: net.Server, endpointPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      server.off('listening', onListening);
      server.off('error', onError);
    };
    const onListening = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    server.once('listening', onListening);
    server.once('error', onError);
    server.listen(endpointPath);
  });
}

async function prepareUnixSocketEndpoint(endpoint: RuntimeDaemonEndpoint): Promise<void> {
  if (endpoint.kind !== 'unix') return;
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(endpoint.path);
  } catch (error: unknown) {
    if (isNodeFileError(error) && error.code === 'ENOENT') return;
    throw error;
  }
  if (!stat.isSocket()) {
    throw new Error(`Runtime daemon Unix endpoint exists and is not a socket: ${endpoint.path}`);
  }
  if (await unixSocketAcceptsConnections(endpoint.path)) {
    throw new Error(`Runtime daemon Unix endpoint is already accepting connections: ${endpoint.path}`);
  }
  try {
    await fs.unlink(endpoint.path);
  } catch (error: unknown) {
    if (!isNodeFileError(error) || error.code !== 'ENOENT') throw error;
  }
}

function unixSocketAcceptsConnections(socketPath: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const timer = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(new Error(`Timed out probing runtime daemon Unix endpoint: ${socketPath}`));
    }, 250);
    timer.unref?.();
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off('connect', onConnect);
      socket.off('error', onError);
    };
    const onConnect = (): void => {
      cleanup();
      socket.end();
      socket.destroy();
      resolve(true);
    };
    const onError = (error: Error): void => {
      cleanup();
      socket.destroy();
      if (isNodeFileError(error) && (error.code === 'ECONNREFUSED' || error.code === 'ENOENT')) {
        resolve(false);
        return;
      }
      reject(error);
    };
    socket.once('connect', onConnect);
    socket.once('error', onError);
  });
}

function closeNetServer(server: net.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function rejectPending(
  pending: Map<string, { readonly reject: (error: Error) => void }>,
  error: Error,
): void {
  for (const item of pending.values()) {
    item.reject(error);
  }
  pending.clear();
}

function normalizeTransportError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isNodeFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
