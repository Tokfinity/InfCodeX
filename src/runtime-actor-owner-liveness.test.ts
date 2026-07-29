import { spawn } from 'node:child_process';
import * as net from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import type { AgentActorOwner } from '@kodax-ai/agent';

import {
  createRuntimeActorOwnerLiveness,
  isRuntimeActorOwnerAlive,
  type RuntimeActorOwnerLiveness,
} from './runtime-actor-owner-liveness.js';

const handles: RuntimeActorOwnerLiveness[] = [];
const unexpectedErrors: Error[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()));
  expect(unexpectedErrors.splice(0)).toEqual([]);
});

function owner(overrides: Partial<AgentActorOwner> = {}): AgentActorOwner {
  return {
    ownerId: 'actor_owner',
    runtimeId: 'rt_owner',
    pid: process.pid,
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('Runtime Actor owner liveness', () => {
  it('proves that the exact Runtime endpoint is alive', async () => {
    const handle = await createRuntimeActorOwnerLiveness({
      onError: (error) => unexpectedErrors.push(error),
    });
    handles.push(handle);

    await expect(isRuntimeActorOwnerAlive(owner({
      livenessId: handle.id,
      livenessPort: handle.port,
    }))).resolves.toBe(true);
  });

  it('rejects a stale Runtime identity even when its PID still exists', async () => {
    const handle = await createRuntimeActorOwnerLiveness({
      onError: (error) => unexpectedErrors.push(error),
    });
    await handle.close();

    await expect(isRuntimeActorOwnerAlive(owner({
      livenessId: handle.id,
      livenessPort: handle.port,
    }))).resolves.toBe(false);
  });

  it('keeps legacy and malformed identities fail-closed while their PID exists', async () => {
    await expect(isRuntimeActorOwnerAlive(owner())).resolves.toBe(true);
    await expect(isRuntimeActorOwnerAlive(owner({
      livenessId: 'a'.repeat(32),
    }))).resolves.toBe(true);
    await expect(isRuntimeActorOwnerAlive(owner({
      livenessPort: 1,
    }))).resolves.toBe(true);
    await expect(isRuntimeActorOwnerAlive(owner({
      livenessId: 'invalid',
      livenessPort: 1,
    }))).resolves.toBe(true);
  });

  it('rejects an unrelated service that reuses the liveness port', async () => {
    const server = net.createServer((socket) => socket.end('different-runtime\n'));
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
      server.listen({ host: '127.0.0.1', port: 0, exclusive: true });
    });
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Expected a loopback TCP test endpoint.');
    }
    try {
      await expect(isRuntimeActorOwnerAlive(owner({
        livenessId: 'a'.repeat(32),
        livenessPort: address.port,
      }))).resolves.toBe(false);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });

  it('keeps a short-lived SDK process alive until its probe completes', async () => {
    const moduleUrl = new URL('./runtime-actor-owner-liveness.ts', import.meta.url).href;
    const script = `
      import {
        createRuntimeActorOwnerLiveness,
        isRuntimeActorOwnerAlive,
      } from ${JSON.stringify(moduleUrl)};
      const errors = [];
      const handle = await createRuntimeActorOwnerLiveness({
        onError: (error) => errors.push(error.message),
      });
      const alive = await isRuntimeActorOwnerAlive({
        ownerId: 'actor_child',
        runtimeId: 'rt_child',
        pid: process.pid,
        startedAt: new Date().toISOString(),
        livenessId: handle.id,
        livenessPort: handle.port,
      });
      process.stdout.write(JSON.stringify({ alive, errors }));
      await handle.close();
    `;
    const result = await runNodeModule(script);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({ alive: true, errors: [] });
  });
});

function runNodeModule(
  source: string,
): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      source,
    ], {
      cwd: process.cwd(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}
