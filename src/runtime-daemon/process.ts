import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

import {
  ELECTRON_RUN_AS_NODE_ENV,
  killChildProcessTree,
  prepareInternalNodeLaunch,
} from '@kodax-ai/agent';

import type { RuntimeDaemonClientTransport } from './client.js';
import {
  observeRuntimeDaemonHealth,
  runtimeDaemonEndpointFromState,
  type RuntimeDaemonHealthCheckOptions,
} from './lifecycle.js';
import {
  assertRuntimeDaemonOwnerAllowed,
  classifyRuntimeDaemonHealth,
  readRuntimeDaemonLockOwner,
  resolveRuntimeDaemonEndpointScope,
  resolveRuntimeDaemonPathsFromConfigHome,
  type RuntimeDaemonHealthObservation,
  type RuntimeDaemonPaths,
} from './state.js';
import {
  createRuntimeDaemonSocketClientTransport,
  defaultRuntimeDaemonEndpoint,
  type RuntimeDaemonEndpoint,
} from './transport.js';

export interface RuntimeDaemonProcessLeaseOptions {
  readonly homeDir?: string;
  readonly configHome?: string;
  readonly profile?: string;
  readonly endpoint?: RuntimeDaemonEndpoint;
  readonly defaultProvider?: string;
  readonly defaultModel?: string;
  readonly sessionsDir?: string;
  readonly permissionTimeoutMs?: number;
  readonly connectTimeoutMs?: number;
  readonly startupTimeoutMs?: number;
  readonly startupSignal?: AbortSignal;
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

export interface RuntimeDaemonStartupExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface RuntimeDaemonStartupProcess {
  readonly pid: number | undefined;
  readonly exit: Promise<RuntimeDaemonStartupExit>;
  unref(): void;
  terminate(): Promise<void>;
}

const CLEAN_EXIT_OWNER_PUBLICATION_GRACE_MS = 1_000;

export type RuntimeDaemonStartupFailureReason =
  | 'cancelled'
  | 'child_exit'
  | 'identity_mismatch'
  | 'timeout';

export class RuntimeDaemonStartupError extends Error {
  constructor(
    message: string,
    readonly reason: RuntimeDaemonStartupFailureReason,
  ) {
    super(message);
    this.name = 'RuntimeDaemonStartupError';
  }
}

type RuntimeDaemonHealthObserver = (
  paths: RuntimeDaemonPaths,
  options?: RuntimeDaemonHealthCheckOptions,
) => Promise<RuntimeDaemonHealthObservation>;

export async function acquireRuntimeDaemonProcessLease(
  options: RuntimeDaemonProcessLeaseOptions,
): Promise<RuntimeDaemonProcessLease> {
  const profile = options.profile ?? 'default';
  const homeDir = path.resolve(options.homeDir ?? os.homedir());
  const configHome = path.resolve(options.configHome ?? path.join(homeDir, '.kodax'));
  const paths = resolveRuntimeDaemonPathsFromConfigHome(configHome, profile);
  assertRuntimeDaemonOwnerAllowed(paths);
  const expectedEndpoint = defaultRuntimeDaemonEndpoint(
    paths.profile,
    resolveRuntimeDaemonEndpointScope(homeDir, configHome),
  );
  if (options.endpoint && options.endpoint.path !== expectedEndpoint.path) {
    throw new Error('SDK daemon auto-start only supports the profile default endpoint; use attach-only mode for custom endpoints.');
  }

  const initial = await observeRuntimeDaemonHealth(paths, options.healthCheck);
  const initialHealth = classifyRuntimeDaemonHealth(initial);
  if (initialHealth === 'healthy' && initial.state) {
    const observation = initial.state.status === 'ready'
      ? { ...initial, state: initial.state }
      : await waitForReadyRuntimeDaemonOwner(paths, options, initial);
    return connectProcessLease(
      paths,
      runtimeDaemonEndpointFromState(observation.state),
      false,
      options,
    );
  }
  if (initialHealth === 'unhealthy' || initialHealth === 'mismatch') {
    throw new Error(`Runtime daemon is ${initialHealth}; refusing to start a competing owner.`);
  }

  const child = await spawnRuntimeDaemonServeProcess({
    profile: paths.profile,
    homeDir,
    configHome,
    defaultProvider: options.defaultProvider,
    defaultModel: options.defaultModel,
    sessionsDir: options.sessionsDir,
    permissionTimeoutMs: options.permissionTimeoutMs,
  });
  const observation = await waitForHealthyDaemonStartup(paths, options, child);
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

export async function waitForHealthyDaemonStartup(
  paths: RuntimeDaemonPaths,
  options: RuntimeDaemonProcessLeaseOptions,
  child: RuntimeDaemonStartupProcess,
  observe: RuntimeDaemonHealthObserver = observeRuntimeDaemonHealth,
): Promise<RuntimeDaemonHealthObservation & { readonly state: NonNullable<RuntimeDaemonHealthObservation['state']> }> {
  const deadline = Date.now() + (options.startupTimeoutMs ?? 60_000);
  try {
    while (true) {
      const observation = await observeStartupHealth(paths, options, child, observe);
      const health = classifyRuntimeDaemonHealth(observation);
      if (
        health === 'healthy'
        && observation.state?.status === 'ready'
      ) {
        if (observation.state.pid === child.pid) child.unref();
        else await child.terminate();
        return { ...observation, state: observation.state };
      }
      if (health === 'mismatch') {
        throw new RuntimeDaemonStartupError(
          'Runtime daemon endpoint identity does not match its persisted owner state.',
          'identity_mismatch',
        );
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw runtimeDaemonStartupTimeout(paths);
      await waitForStartupPoll(
        Math.min(Math.max(1, options.pollIntervalMs ?? 100), remainingMs),
        paths,
        child,
        options.startupSignal,
      );
    }
  } catch (error: unknown) {
    try {
      await child.terminate();
    } catch (terminationError: unknown) {
      throw new AggregateError(
        [error, terminationError],
        'Runtime daemon startup failed and its child process could not be reclaimed.',
      );
    }
    throw error;
  }
}

export async function waitForReadyRuntimeDaemonOwner(
  paths: RuntimeDaemonPaths,
  options: RuntimeDaemonProcessLeaseOptions,
  initial: RuntimeDaemonHealthObservation,
  observe: RuntimeDaemonHealthObserver = observeRuntimeDaemonHealth,
): Promise<RuntimeDaemonHealthObservation & { readonly state: NonNullable<RuntimeDaemonHealthObservation['state']> }> {
  const deadline = Date.now() + (options.startupTimeoutMs ?? 60_000);
  const expectedOwner = initial.state;
  if (expectedOwner === undefined) {
    throw new RuntimeDaemonStartupError(
      'Runtime daemon owner state disappeared before it reached ready.',
      'identity_mismatch',
    );
  }
  let observation = initial;
  while (true) {
    const health = classifyRuntimeDaemonHealth(observation);
    if (
      observation.state !== undefined
      && (
        observation.state.runtimeId !== expectedOwner.runtimeId
        || observation.state.pid !== expectedOwner.pid
        || observation.state.profile !== expectedOwner.profile
        || observation.state.endpoint !== expectedOwner.endpoint
      )
    ) {
      throw new RuntimeDaemonStartupError(
        'Runtime daemon owner identity changed before it reached ready.',
        'identity_mismatch',
      );
    }
    if (health === 'healthy' && observation.state?.status === 'ready') {
      return { ...observation, state: observation.state };
    }
    if (health === 'mismatch') {
      throw new RuntimeDaemonStartupError(
        'Runtime daemon endpoint identity does not match its persisted owner state.',
        'identity_mismatch',
      );
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw runtimeDaemonStartupTimeout(paths);
    await raceRuntimeDaemonStartupStep(
      delay(Math.min(Math.max(1, options.pollIntervalMs ?? 100), remainingMs)),
      options.startupSignal,
    );
    observation = await raceRuntimeDaemonStartupStep(
      observe(paths, options.healthCheck),
      options.startupSignal,
    );
  }
}

async function observeStartupHealth(
  paths: RuntimeDaemonPaths,
  options: RuntimeDaemonProcessLeaseOptions,
  child: RuntimeDaemonStartupProcess,
  observe: RuntimeDaemonHealthObserver,
): Promise<RuntimeDaemonHealthObservation> {
  const outcome = await raceRuntimeDaemonStartupStep(Promise.race([
    observe(paths, options.healthCheck).then((observation) => ({
      kind: 'health' as const,
      observation,
    })),
    child.exit.then((exit) => ({ kind: 'exit' as const, exit })),
  ]), options.startupSignal);
  if (outcome.kind === 'exit') {
    if (hasCompetingStartupOwner(paths, child)) {
      return observe(paths, options.healthCheck);
    }
    if (outcome.exit.code === 0 && outcome.exit.signal === null) {
      const graceMs = Math.min(
        CLEAN_EXIT_OWNER_PUBLICATION_GRACE_MS,
        options.startupTimeoutMs ?? CLEAN_EXIT_OWNER_PUBLICATION_GRACE_MS,
      );
      const deadline = Date.now() + graceMs;
      while (Date.now() <= deadline) {
        const observation = await raceRuntimeDaemonStartupStep(
          observe(paths, options.healthCheck),
          options.startupSignal,
        );
        if (
          classifyRuntimeDaemonHealth(observation) !== 'missing' ||
          hasCompetingStartupOwner(paths, child)
        ) {
          return observation;
        }
        await raceRuntimeDaemonStartupStep(
          delay(
            Math.min(
              options.pollIntervalMs ?? 100,
              Math.max(1, deadline - Date.now()),
            ),
          ),
          options.startupSignal,
        );
      }
    }
    throw runtimeDaemonExitedEarly(outcome.exit);
  }
  return outcome.observation;
}

async function waitForStartupPoll(
  pollIntervalMs: number,
  paths: RuntimeDaemonPaths,
  child: RuntimeDaemonStartupProcess,
  signal?: AbortSignal,
): Promise<void> {
  const outcome = await raceRuntimeDaemonStartupStep(Promise.race([
    delay(pollIntervalMs).then(() => undefined),
    child.exit,
  ]), signal);
  if (outcome === undefined) return;
  if (hasCompetingStartupOwner(paths, child)) {
    await raceRuntimeDaemonStartupStep(delay(pollIntervalMs), signal);
    return;
  }
  throw runtimeDaemonExitedEarly(outcome);
}

function hasCompetingStartupOwner(
  paths: RuntimeDaemonPaths,
  child: RuntimeDaemonStartupProcess,
): boolean {
  const owner = readRuntimeDaemonLockOwner(paths.lockFile);
  return owner !== undefined && owner.pid !== child.pid;
}

function runtimeDaemonExitedEarly(exit: RuntimeDaemonStartupExit): RuntimeDaemonStartupError {
  const status = exit.signal !== null
    ? `signal ${exit.signal}`
    : `code ${exit.code ?? 'unknown'}`;
  return new RuntimeDaemonStartupError(
    `Runtime daemon child exited before becoming healthy (${status}).`,
    'child_exit',
  );
}

function runtimeDaemonStartupTimeout(paths: RuntimeDaemonPaths): RuntimeDaemonStartupError {
  const electronHint = process.versions.electron === undefined
    ? ''
    : ' Packaged Electron auto-start requires the RunAsNode fuse to remain enabled.';
  return new RuntimeDaemonStartupError(
    `Timed out waiting for runtime daemon profile "${paths.profile}" to become ready.${electronHint}`,
    'timeout',
  );
}

export async function spawnRuntimeDaemonServeProcess(input: {
  readonly profile: string;
  readonly homeDir: string;
  readonly configHome: string;
  readonly defaultProvider?: string;
  readonly defaultModel?: string;
  readonly sessionsDir?: string;
  readonly permissionTimeoutMs?: number;
}): Promise<RuntimeDaemonStartupProcess> {
  const entry = resolveDaemonCliEntry();
  assertRuntimeDaemonCliEntryAvailable(entry);
  const args = [
    ...(entry !== undefined ? daemonServeExecArgv(process.execArgv, entry.endsWith('.ts')) : []),
    ...(entry !== undefined ? [entry] : []),
    'daemon',
    'serve',
    '--profile',
    input.profile,
    '--home',
    input.homeDir,
    '--config-home',
    input.configHome,
  ];
  if (input.defaultProvider !== undefined) args.push('--provider', input.defaultProvider);
  if (input.defaultModel !== undefined) args.push('--model', input.defaultModel);
  if (input.sessionsDir !== undefined) args.push('--sessions-dir', input.sessionsDir);
  if (input.permissionTimeoutMs !== undefined) {
    args.push('--permission-timeout-ms', String(input.permissionTimeoutMs));
  }
  const launch = prepareInternalNodeLaunch({
    args,
    env: createRuntimeDaemonServeEnvironment({
      homeDir: input.homeDir,
      configHome: input.configHome,
      parentEnv: process.env,
    }),
    isElectron: process.versions.electron !== undefined,
  });
  const child = spawn(process.execPath, launch.args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: launch.env,
  });
  const exit = new Promise<RuntimeDaemonStartupExit>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  return createRuntimeDaemonStartupProcess(child, exit);
}

function createRuntimeDaemonStartupProcess(
  child: ChildProcess,
  exit: Promise<RuntimeDaemonStartupExit>,
): RuntimeDaemonStartupProcess {
  return {
    pid: child.pid,
    exit,
    unref() {
      child.unref();
    },
    async terminate() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      await killChildProcessTree(child);
      if (!await didExitWithin(exit, 1_000)) {
        throw new Error(`Runtime daemon child ${child.pid ?? 'unknown'} did not exit after termination.`);
      }
    },
  };
}

async function didExitWithin(
  exit: Promise<RuntimeDaemonStartupExit>,
  timeoutMs: number,
): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      exit.then(() => true),
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export function assertRuntimeDaemonCliEntryAvailable(entry: string | undefined): void {
  if (entry !== undefined && !existsSync(entry)) {
    throw new Error(
      `Runtime daemon CLI entry is unavailable at "${entry}". `
      + 'Keep the published KodaX dist files external to the embedder bundle.',
    );
  }
}

export function createRuntimeDaemonServeEnvironment(input: {
  readonly homeDir: string;
  readonly configHome?: string;
  readonly parentEnv: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...input.parentEnv,
    KODAX_DAEMON_SERVE: '1',
    KODAX_HOME: input.configHome ?? path.join(input.homeDir, '.kodax'),
  };
  delete env[ELECTRON_RUN_AS_NODE_ENV];
  return env;
}

function resolveDaemonCliEntry(): string | undefined {
  if (process.env.KODAX_BUNDLED === 'true') return undefined;
  const current = fileURLToPath(import.meta.url);
  if (current.endsWith('.ts')) return path.resolve(path.dirname(current), '..', 'kodax_cli.ts');
  const currentDir = path.dirname(current);
  const distDir = path.basename(currentDir) === 'chunks' ? path.dirname(currentDir) : currentDir;
  return path.join(distDir, 'kodax_cli.js');
}

export function daemonServeExecArgv(execArgv: readonly string[], needsTsx: boolean): string[] {
  const keep: string[] = [];
  for (let index = 0; index < execArgv.length; index += 1) {
    const arg = execArgv[index] ?? '';
    const normalized = arg.toLowerCase();
    if (normalized === '--require' || normalized === '-r') {
      const value = execArgv[index + 1];
      if (value !== undefined) {
        if (isKodaXProductionEnvPreload(value)) keep.push(arg, value);
        index += 1;
      }
    } else if (normalized.startsWith('--require=')) {
      const value = arg.slice('--require='.length);
      if (isKodaXProductionEnvPreload(value)) keep.push(arg);
    } else if (
      normalized.startsWith('--max-old-space-size')
      || normalized === '--enable-source-maps'
    ) {
      keep.push(arg);
    }
  }
  if (needsTsx) keep.push('--import', 'tsx');
  return keep;
}

function isKodaXProductionEnvPreload(value: string): boolean {
  return path.resolve(value) === path.resolve('scripts', 'production-env.cjs');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function raceRuntimeDaemonStartupStep<T>(
  step: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return step;
  if (signal.aborted) throw runtimeDaemonStartupCancelled();
  let cancel: (() => void) | undefined;
  try {
    return await Promise.race([
      step,
      new Promise<never>((_, reject) => {
        cancel = () => reject(runtimeDaemonStartupCancelled());
        signal.addEventListener('abort', cancel, { once: true });
      }),
    ]);
  } finally {
    if (cancel) signal.removeEventListener('abort', cancel);
  }
}

function runtimeDaemonStartupCancelled(): RuntimeDaemonStartupError {
  return new RuntimeDaemonStartupError('Runtime daemon startup cancelled.', 'cancelled');
}
