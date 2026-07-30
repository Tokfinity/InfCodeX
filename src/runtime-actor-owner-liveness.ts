import { randomUUID } from 'node:crypto';
import * as net from 'node:net';

import type { AgentActorOwner } from '@kodax-ai/agent';

const LOOPBACK_HOST = '127.0.0.1';
const LIVENESS_ID_PATTERN = /^[a-f0-9]{32}$/;
const LIVENESS_PROBE_TIMEOUT_MS = 500;
const MAX_LIVENESS_RESPONSE_BYTES = 128;

export interface RuntimeActorOwnerLiveness {
  readonly id: string;
  readonly port: number;
  close(): Promise<void>;
}

export interface RuntimeActorOwnerLivenessOptions {
  readonly onError: (error: Error) => void;
}

export type RuntimeActorOwnerState = 'alive' | 'dead' | 'unknown';

export async function createRuntimeActorOwnerLiveness(
  options: RuntimeActorOwnerLivenessOptions,
): Promise<RuntimeActorOwnerLiveness> {
  const id = randomUUID().replace(/-/g, '');
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    socket.end(`${id}\n`);
  });
  server.on('error', options.onError);
  await listen(server);
  const address = server.address();
  if (address === null || typeof address === 'string') {
    await closeServer(server);
    throw new Error('Runtime Actor owner liveness did not bind a TCP endpoint.');
  }
  server.unref();

  let closeAttempt: Promise<void> | undefined;
  return {
    id,
    port: address.port,
    close() {
      if (closeAttempt) return closeAttempt;
      const attempt = (async () => {
        for (const socket of sockets) socket.destroy();
        sockets.clear();
        await closeServer(server);
      })();
      closeAttempt = attempt;
      void attempt.catch(() => {
        if (closeAttempt === attempt) closeAttempt = undefined;
      });
      return attempt;
    },
  };
}

export async function isRuntimeActorOwnerAlive(
  owner: AgentActorOwner,
): Promise<boolean> {
  return (await inspectRuntimeActorOwner(owner)) !== 'dead';
}

export async function inspectRuntimeActorOwner(
  owner: AgentActorOwner,
): Promise<RuntimeActorOwnerState> {
  if (isPidDefinitelyDead(owner.pid)) return 'dead';
  if (owner.livenessId === undefined || owner.livenessPort === undefined) {
    return 'unknown';
  }
  if (
    !LIVENESS_ID_PATTERN.test(owner.livenessId)
    || !Number.isSafeInteger(owner.livenessPort)
    || owner.livenessPort <= 0
    || owner.livenessPort > 65_535
  ) {
    return 'unknown';
  }
  try {
    return await probe(owner.livenessPort, owner.livenessId)
      ? 'alive'
      : 'dead';
  } catch (error: unknown) {
    return errorCode(error) === 'ECONNREFUSED' ? 'dead' : 'unknown';
  }
}

function isPidDefinitelyDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error: unknown) {
    return errorCode(error) === 'ESRCH';
  }
}

function probe(port: number, expectedId: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: LOOPBACK_HOST, port });
    let response = '';
    let settled = false;
    const timer = setTimeout(() => settle(undefined), LIVENESS_PROBE_TIMEOUT_MS);
    timer.unref?.();
    // The pending Promise alone does not keep a short-lived SDK process alive.
    // Keep this client referenced until cleanup destroys it.

    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('end', onEnd);
      socket.off('error', onError);
      socket.destroy();
    };
    const settle = (result: boolean | undefined, error?: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else if (result === undefined) reject(new Error('Timed out probing Runtime Actor owner liveness.'));
      else resolve(result);
    };
    const onData = (chunk: Buffer): void => {
      response += chunk.toString('utf8');
      if (Buffer.byteLength(response) > MAX_LIVENESS_RESPONSE_BYTES) settle(false);
    };
    const onEnd = (): void => settle(response.trim() === expectedId);
    const onError = (error: Error): void => settle(undefined, error);
    socket.on('data', onData);
    socket.once('end', onEnd);
    socket.once('error', onError);
  });
}

function listen(server: net.Server): Promise<void> {
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
    server.listen({ host: LOOPBACK_HOST, port: 0, exclusive: true });
  });
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      server.close((error) => {
        if (error && errorCode(error) !== 'ERR_SERVER_NOT_RUNNING') {
          reject(error);
          return;
        }
        resolve();
      });
    } catch (error: unknown) {
      if (errorCode(error) === 'ERR_SERVER_NOT_RUNNING') {
        resolve();
        return;
      }
      reject(error);
    }
  });
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && typeof error.code === 'string'
    ? error.code
    : undefined;
}
