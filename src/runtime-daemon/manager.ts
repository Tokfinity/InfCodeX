import os from 'node:os';
import path from 'node:path';

import type { KodaXRuntime } from '../sdk-runtime.js';
import type { RuntimeDaemonClientTransport } from './client.js';
import {
  resolveRuntimeDaemonOwnership,
  runtimeDaemonEndpointFromState,
  type RuntimeDaemonHealthCheckOptions,
} from './lifecycle.js';
import { startRuntimeDaemonHost, type RuntimeDaemonHost } from './host.js';
import {
  resolveRuntimeDaemonPaths,
  type RuntimeDaemonPaths,
} from './state.js';
import {
  createRuntimeDaemonSocketClientTransport,
  defaultRuntimeDaemonEndpoint,
  type RuntimeDaemonEndpoint,
} from './transport.js';

export interface RuntimeDaemonLeaseOptions {
  readonly homeDir?: string;
  readonly profile?: string;
  readonly endpoint?: RuntimeDaemonEndpoint;
  readonly connectTimeoutMs?: number;
  readonly startupTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly healthCheck?: RuntimeDaemonHealthCheckOptions;
  createRuntime(): Promise<KodaXRuntime>;
}

export interface RuntimeDaemonLease {
  readonly transport: RuntimeDaemonClientTransport;
  readonly endpoint: RuntimeDaemonEndpoint;
  readonly paths: RuntimeDaemonPaths;
  readonly ownsHost: boolean;
  close(): Promise<void>;
  shutdown(): Promise<void>;
}

export async function acquireRuntimeDaemonLease(
  options: RuntimeDaemonLeaseOptions,
): Promise<RuntimeDaemonLease> {
  const profile = options.profile ?? 'default';
  const homeDir = resolveRuntimeDaemonHomeDir(options.homeDir);
  const paths = resolveRuntimeDaemonPaths(homeDir, profile);
  const endpoint = options.endpoint ?? defaultRuntimeDaemonEndpoint(profile, homeDir);
  const candidateRuntime = await options.createRuntime();
  const owner = {
    runtimeId: candidateRuntime.identity.runtimeId,
    pid: process.pid,
    createdAt: new Date().toISOString(),
  };

  const decision = await resolveRuntimeDaemonOwnership(paths, owner, options.healthCheck);
  if (decision.kind === 'attach') {
    await candidateRuntime.close();
    const attachedEndpoint = runtimeDaemonEndpointFromState(decision.state);
    return createAttachedLease(paths, attachedEndpoint, options.connectTimeoutMs);
  }

  if (decision.kind === 'wait') {
    return waitForDaemonLease(paths, endpoint, candidateRuntime, owner, {
      ...options,
      profile,
    });
  }

  if (decision.kind === 'unhealthy') {
    await candidateRuntime.close();
    throw new Error(`Runtime daemon is ${decision.health}; refusing to take ownership.`);
  }

  const host = await startRuntimeDaemonHost({
    runtime: candidateRuntime,
    paths,
    endpoint,
    lock: decision.lock,
  });
  const transport = await createRuntimeDaemonSocketClientTransport(endpoint, {
    connectTimeoutMs: options.connectTimeoutMs,
  });
  return createOwnedLease(paths, endpoint, transport, host);
}

function resolveRuntimeDaemonHomeDir(homeDir: string | undefined): string {
  return path.resolve(homeDir ?? os.homedir());
}

async function waitForDaemonLease(
  paths: RuntimeDaemonPaths,
  endpoint: RuntimeDaemonEndpoint,
  candidateRuntime: KodaXRuntime,
  owner: { readonly runtimeId: string; readonly pid: number; readonly createdAt: string },
  options: RuntimeDaemonLeaseOptions & { readonly profile: string },
): Promise<RuntimeDaemonLease> {
  const deadline = Date.now() + (options.startupTimeoutMs ?? 5_000);
  while (Date.now() <= deadline) {
    const decision = await resolveRuntimeDaemonOwnership(paths, owner, options.healthCheck);
    if (decision.kind === 'attach') {
      await candidateRuntime.close();
      return createAttachedLease(
        paths,
        runtimeDaemonEndpointFromState(decision.state),
        options.connectTimeoutMs,
      );
    }
    if (decision.kind === 'claim') {
      const host = await startRuntimeDaemonHost({
        runtime: candidateRuntime,
        paths,
        endpoint,
        lock: decision.lock,
      });
      const transport = await createRuntimeDaemonSocketClientTransport(endpoint, {
        connectTimeoutMs: options.connectTimeoutMs,
      });
      return createOwnedLease(paths, endpoint, transport, host);
    }
    if (decision.kind === 'unhealthy') {
      await candidateRuntime.close();
      throw new Error(`Runtime daemon is ${decision.health}; refusing to take ownership.`);
    }
    await delay(options.pollIntervalMs ?? 100);
  }
  await candidateRuntime.close();
  throw new Error(`Timed out waiting for runtime daemon profile "${options.profile}" to become ready.`);
}

async function createAttachedLease(
  paths: RuntimeDaemonPaths,
  endpoint: RuntimeDaemonEndpoint,
  connectTimeoutMs: number | undefined,
): Promise<RuntimeDaemonLease> {
  const transport = await createRuntimeDaemonSocketClientTransport(endpoint, {
    connectTimeoutMs,
  });
  return {
    transport,
    endpoint,
    paths,
    ownsHost: false,
    async close() {
      await transport.close?.();
    },
    async shutdown() {
      try {
        await transport.request('runtime.shutdown');
      } finally {
        await transport.close?.();
      }
    },
  };
}

function createOwnedLease(
  paths: RuntimeDaemonPaths,
  endpoint: RuntimeDaemonEndpoint,
  transport: RuntimeDaemonClientTransport,
  host: RuntimeDaemonHost,
): RuntimeDaemonLease {
  host.unref();
  let transportClosed = false;
  let hostClosed = false;
  return {
    transport,
    endpoint,
    paths,
    ownsHost: true,
    async close() {
      if (transportClosed) return;
      transportClosed = true;
      await transport.close?.();
    },
    async shutdown() {
      if (hostClosed) return;
      hostClosed = true;
      await host.close();
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
