import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

import type { RuntimeDaemonClientTransport } from './client.js';
import {
  observeRuntimeDaemonHealth,
  runtimeDaemonEndpointFromState,
  type RuntimeDaemonHealthCheckOptions,
} from './lifecycle.js';
import {
  classifyRuntimeDaemonHealth,
  resolveRuntimeDaemonPaths,
  type RuntimeDaemonPaths,
} from './state.js';
import {
  createRuntimeDaemonSocketClientTransport,
  defaultRuntimeDaemonEndpoint,
  type RuntimeDaemonEndpoint,
} from './transport.js';

export interface RuntimeDaemonProcessLeaseOptions {
  readonly homeDir?: string;
  readonly profile?: string;
  readonly endpoint?: RuntimeDaemonEndpoint;
  readonly defaultProvider?: string;
  readonly defaultModel?: string;
  readonly sessionsDir?: string;
  readonly permissionTimeoutMs?: number;
  readonly connectTimeoutMs?: number;
  readonly startupTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly healthCheck?: RuntimeDaemonHealthCheckOptions;
}

export interface RuntimeDaemonProcessLease {
  readonly transport: RuntimeDaemonClientTransport;
  readonly endpoint: RuntimeDaemonEndpoint;
  readonly paths: RuntimeDaemonPaths;
  readonly ownsHost: boolean;
  close(): Promise<void>;
  shutdown(): Promise<void>;
}

export async function acquireRuntimeDaemonProcessLease(
  options: RuntimeDaemonProcessLeaseOptions,
): Promise<RuntimeDaemonProcessLease> {
  const profile = options.profile ?? 'default';
  const homeDir = path.resolve(options.homeDir ?? os.homedir());
  const paths = resolveRuntimeDaemonPaths(homeDir, profile);
  const expectedEndpoint = defaultRuntimeDaemonEndpoint(paths.profile, homeDir);
  if (options.endpoint && options.endpoint.path !== expectedEndpoint.path) {
    throw new Error('SDK daemon auto-start only supports the profile default endpoint; use attach-only mode for custom endpoints.');
  }

  const initial = await observeRuntimeDaemonHealth(paths, options.healthCheck);
  const initialHealth = classifyRuntimeDaemonHealth(initial);
  if (initialHealth === 'healthy' && initial.state) {
    return connectProcessLease(paths, runtimeDaemonEndpointFromState(initial.state), false, options);
  }
  if (initialHealth === 'unhealthy' || initialHealth === 'mismatch') {
    throw new Error(`Runtime daemon is ${initialHealth}; refusing to start a competing owner.`);
  }

  const child = await spawnRuntimeDaemonServeProcess({
    profile: paths.profile,
    homeDir,
    defaultProvider: options.defaultProvider,
    defaultModel: options.defaultModel,
    sessionsDir: options.sessionsDir,
    permissionTimeoutMs: options.permissionTimeoutMs,
  });
  const observation = await waitForHealthyDaemon(paths, options);
  const endpoint = runtimeDaemonEndpointFromState(observation.state);
  return connectProcessLease(paths, endpoint, observation.state.pid === child.pid, options);
}

async function connectProcessLease(
  paths: RuntimeDaemonPaths,
  endpoint: RuntimeDaemonEndpoint,
  ownsHost: boolean,
  options: RuntimeDaemonProcessLeaseOptions,
): Promise<RuntimeDaemonProcessLease> {
  const transport = await createRuntimeDaemonSocketClientTransport(endpoint, {
    connectTimeoutMs: options.connectTimeoutMs,
  });
  return {
    transport,
    endpoint,
    paths,
    ownsHost,
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

async function waitForHealthyDaemon(
  paths: RuntimeDaemonPaths,
  options: RuntimeDaemonProcessLeaseOptions,
) {
  const deadline = Date.now() + (options.startupTimeoutMs ?? 60_000);
  while (Date.now() <= deadline) {
    const observation = await observeRuntimeDaemonHealth(paths, options.healthCheck);
    const health = classifyRuntimeDaemonHealth(observation);
    if (health === 'healthy' && observation.state) return { ...observation, state: observation.state };
    if (health === 'mismatch') {
      throw new Error('Runtime daemon endpoint identity does not match its persisted owner state.');
    }
    await delay(options.pollIntervalMs ?? 100);
  }
  throw new Error(`Timed out waiting for runtime daemon profile "${paths.profile}" to become ready.`);
}

async function spawnRuntimeDaemonServeProcess(input: {
  readonly profile: string;
  readonly homeDir: string;
  readonly defaultProvider?: string;
  readonly defaultModel?: string;
  readonly sessionsDir?: string;
  readonly permissionTimeoutMs?: number;
}): Promise<{ readonly pid: number | undefined }> {
  const entry = resolveDaemonCliEntry();
  const args = [
    ...(entry !== undefined ? daemonServeExecArgv(process.execArgv, entry.endsWith('.ts')) : []),
    ...(entry !== undefined ? [entry] : []),
    'daemon',
    'serve',
    '--profile',
    input.profile,
    '--home',
    input.homeDir,
  ];
  if (input.defaultProvider !== undefined) args.push('--provider', input.defaultProvider);
  if (input.defaultModel !== undefined) args.push('--model', input.defaultModel);
  if (input.sessionsDir !== undefined) args.push('--sessions-dir', input.sessionsDir);
  if (input.permissionTimeoutMs !== undefined) {
    args.push('--permission-timeout-ms', String(input.permissionTimeoutMs));
  }
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      KODAX_DAEMON_SERVE: '1',
      KODAX_HOME: path.join(input.homeDir, '.kodax'),
    },
  });
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  child.unref();
  return { pid: child.pid };
}

function resolveDaemonCliEntry(): string | undefined {
  if (process.env.KODAX_BUNDLED === 'true') return undefined;
  const current = fileURLToPath(import.meta.url);
  if (current.endsWith('.ts')) return path.resolve(path.dirname(current), '..', 'kodax_cli.ts');
  const currentDir = path.dirname(current);
  const distDir = path.basename(currentDir) === 'chunks' ? path.dirname(currentDir) : currentDir;
  return path.join(distDir, 'kodax_cli.js');
}

function daemonServeExecArgv(execArgv: readonly string[], needsTsx: boolean): string[] {
  const keep: string[] = [];
  for (let index = 0; index < execArgv.length; index += 1) {
    const arg = execArgv[index] ?? '';
    const normalized = arg.toLowerCase();
    if (['--import', '--loader', '--experimental-loader', '--require', '-r'].includes(normalized)) {
      keep.push(arg);
      const value = execArgv[index + 1];
      if (value !== undefined) {
        keep.push(value);
        index += 1;
      }
    } else if (
      normalized.startsWith('--import=')
      || normalized.startsWith('--loader=')
      || normalized.startsWith('--experimental-loader=')
      || normalized.startsWith('--require=')
      || normalized.startsWith('--max-old-space-size')
      || normalized === '--enable-source-maps'
    ) {
      keep.push(arg);
    }
  }
  if (needsTsx && !keep.some((arg) => arg === 'tsx' || arg.endsWith('/tsx') || arg.endsWith('\\tsx'))) {
    keep.unshift('--import', 'tsx');
  }
  return keep;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
