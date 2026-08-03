import { spawn } from 'node:child_process';
import * as net from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import type { AgentActorOwner } from '@kodax-ai/agent';

import {
  createRuntimeActorOwnerLiveness,
  inspectRuntimeActorOwners,
  isRuntimeActorOwnerAlive,
  type RuntimeActorOwnerLiveness,
} from './runtime-actor-owner-liveness.js';

const handles: RuntimeActorOwnerLiveness[] = [];
const unexpectedErrors: Error[] = [];
const CHILD_PROXY_ENV_KEYS = [
  'NODE_USE_ENV_PROXY',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
] as const;

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

  it('bounds recovery latency across several unresponsive owner endpoints', async () => {
    const servers = await Promise.all(Array.from({ length: 3 }, async () => {
      const server = net.createServer(() => undefined);
      await new Promise<void>((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
        server.listen({ host: '127.0.0.1', port: 0, exclusive: true });
      });
      return server;
    }));
    try {
      const owners = servers.map((server, index) => {
        const address = server.address();
        if (address === null || typeof address === 'string') {
          throw new Error('Expected a loopback TCP test endpoint.');
        }
        return owner({
          ownerId: `slow-owner-${index}`,
          runtimeId: `slow-runtime-${index}`,
          livenessId: String(index + 1).repeat(32),
          livenessPort: address.port,
        });
      });
      const startedAt = performance.now();
      await expect(inspectRuntimeActorOwners(owners)).resolves.toEqual([
        'unknown',
        'unknown',
        'unknown',
      ]);
      expect(performance.now() - startedAt).toBeLessThan(1_100);
    } finally {
      await Promise.all(servers.map((server) => new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      })));
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
      process.stdout.write(JSON.stringify({
        alive,
        errors,
        proxyEnvironment: {
          nodeUseEnvProxy: process.env.NODE_USE_ENV_PROXY ?? null,
          httpProxy: process.env.HTTP_PROXY ?? null,
          httpsProxy: process.env.HTTPS_PROXY ?? null,
        },
      }));
      await handle.close();
    `;
    const result = await runNodeModuleFromProxyConfiguredParent(script);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
      alive: true,
      errors: [],
      proxyEnvironment: {
        nodeUseEnvProxy: null,
        httpProxy: null,
        httpsProxy: null,
      },
    });
  });
});

function restoreEnvironmentValue(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

async function runNodeModuleFromProxyConfiguredParent(
  source: string,
): Promise<Awaited<ReturnType<typeof runNodeModule>>> {
  const inherited = new Map<string, string | undefined>([
    ['NODE_USE_ENV_PROXY', process.env.NODE_USE_ENV_PROXY],
    ['HTTP_PROXY', process.env.HTTP_PROXY],
    ['HTTPS_PROXY', process.env.HTTPS_PROXY],
  ]);
  try {
    process.env.NODE_USE_ENV_PROXY = '1';
    process.env.HTTP_PROXY = 'http://127.0.0.1:9';
    process.env.HTTPS_PROXY = 'http://127.0.0.1:9';
    return await runNodeModule(source);
  } finally {
    for (const [name, value] of inherited) restoreEnvironmentValue(name, value);
  }
}

function runNodeModule(
  source: string,
): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    for (const key of CHILD_PROXY_ENV_KEYS) delete env[key];
    const child = spawn(process.execPath, [
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      source,
    ], {
      cwd: process.cwd(),
      env,
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
