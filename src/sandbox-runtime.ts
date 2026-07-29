import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants, readdirSync, statSync, writeSync } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  SandboxManager,
  getWindowsSandboxUserStatus,
  installWindowsSandbox,
  verifyWindowsWfpEgress,
  type SandboxAskCallback,
  type SandboxRuntimeConfig,
} from '@anthropic-ai/sandbox-runtime';
import {
  ELECTRON_NODE_ENV_SCRUB_IMPORT,
  ELECTRON_RUN_AS_NODE_ENV,
  emitKodaXDiagnostic,
  getAgentConfigHome,
  killChildProcessTree,
  prepareInternalNodeLaunch,
  type ISkillRegistry,
  type RunnerToolCall,
  type Skill,
} from '@kodax-ai/agent';
import type {
  KodaXShellSandbox,
  KodaXShellSandboxBackend,
  KodaXShellSandboxObservation,
  KodaXSkillScriptRunInput,
  KodaXSkillScriptRunner,
} from '@kodax-ai/coding';

export const KODAX_ASRT_VERSION = '0.0.65';

export interface SandboxRuntimeDoctorResult {
  readonly ready: boolean;
  readonly platform: NodeJS.Platform;
  readonly version: string;
  readonly diagnostics: readonly string[];
  readonly setupRequired: boolean;
}

export interface CreateSkillScriptRunnerInput {
  readonly registry: ISkillRegistry;
  readonly admissions: Readonly<Record<string, readonly string[]>>;
  readonly snapshotRoot: string;
  readonly workspaceAccess: 'none' | 'read' | 'write';
  readonly workspaceByteLimit?: number;
  readonly network:
    | { readonly mode: 'deny' }
    | { readonly mode: 'allowlist'; readonly origins: readonly string[] };
}

interface AdmittedScript {
  readonly skill: string;
  readonly relativePath: string;
  readonly snapshotPath: string;
}

interface SandboxEndpoint {
  readonly host: string;
  readonly port: number;
}

interface SandboxBrokerRequest {
  readonly config: SandboxRuntimeConfig;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly endpoints: readonly SandboxEndpoint[];
  readonly allowAllNetwork?: boolean;
  readonly bootstrapCommand?: string;
  readonly fallbackToNormalExecution?: boolean;
  readonly observationBackend?: KodaXShellSandboxBackend;
  readonly observationFile?: string;
  readonly targetStartedMarker?: string;
  readonly wrappedInvocation?: {
    readonly executable: string;
    readonly args: readonly string[];
    readonly env: NodeJS.ProcessEnv;
    readonly shell: boolean;
  };
}

export interface CreateAsrtShellSandboxInput {
  readonly workspaceRoot: string;
  readonly shouldSandbox: (call: RunnerToolCall) => boolean;
}

export type KodaXSandboxNetworkPolicy =
  | { readonly mode: 'allow' }
  | { readonly mode: 'deny' }
  | { readonly mode: 'allowlist'; readonly origins: readonly string[] };

export interface KodaXSandboxFilesystemPolicy {
  /**
   * Read roots required by the command. ASRT permits ordinary reads by
   * default; these roots also carve back access beneath a broader denyRead.
   */
  readonly allowRead: readonly string[];
  /** The only roots in which the command may create, modify, or remove data. */
  readonly allowWrite: readonly string[];
  /** Read-denied roots; a more specific allowRead entry takes precedence. */
  readonly denyRead?: readonly string[];
  /** Write-denied roots; denyWrite takes precedence over allowWrite. */
  readonly denyWrite?: readonly string[];
}

export interface KodaXSandboxRunInput {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd: string;
  readonly filesystem: KodaXSandboxFilesystemPolicy;
  readonly network?: KodaXSandboxNetworkPolicy;
  /** Defaults to a minimal process environment. */
  readonly inheritEnvironment?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly signal?: AbortSignal;
}

export type KodaXSandboxRunResult =
  | {
    readonly status: 'completed';
    readonly sandboxed: true;
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
  }
  | {
    readonly status: 'unavailable';
    readonly sandboxed: false;
    readonly doctor: SandboxRuntimeDoctorResult;
  };

export interface SandboxSetupOutcome {
  readonly status: 'ready' | 'cancelled' | 'unavailable';
  readonly attempted: boolean;
  readonly doctor: SandboxRuntimeDoctorResult;
  readonly guidance: readonly string[];
  readonly error?: string;
}

export interface KodaXSandboxCapability {
  readonly version: 1;
  readonly asrtVersion: string;
  readonly platform: NodeJS.Platform;
  readonly backend: 'windows-restricted-user' | 'macos-seatbelt' | 'linux-bubblewrap' | 'unsupported';
  readonly genericCommandExecution: true;
  readonly controls: readonly ['filesystem', 'network', 'environment', 'timeout', 'output'];
  readonly ordinaryCallsTriggerSetup: false;
  readonly setupMayElevate: boolean;
  readonly unavailableBehavior: 'structured-no-execution';
  readonly permissionFallback: 'normal-permission-policy';
}

export function sandboxRuntimeCapability(): KodaXSandboxCapability {
  const backend = process.platform === 'win32'
    ? 'windows-restricted-user'
    : process.platform === 'darwin'
      ? 'macos-seatbelt'
      : process.platform === 'linux'
        ? 'linux-bubblewrap'
        : 'unsupported';
  return {
    version: 1,
    asrtVersion: KODAX_ASRT_VERSION,
    platform: process.platform,
    backend,
    genericCommandExecution: true,
    controls: ['filesystem', 'network', 'environment', 'timeout', 'output'],
    ordinaryCallsTriggerSetup: false,
    setupMayElevate: process.platform === 'win32',
    unavailableBehavior: 'structured-no-execution',
    permissionFallback: 'normal-permission-policy',
  };
}

const MAX_OUTPUT_BYTES = 1_048_576;
const SCRIPT_TIMEOUT_MS = 120_000;
const moduleRequire = createRequire(import.meta.url);
const ASRT_MODULE_URL = process.env.KODAX_BUNDLED === 'true'
  ? undefined
  : pathToFileURL(moduleRequire.resolve('@anthropic-ai/sandbox-runtime')).href;
const SENSITIVE_PATH_PARTS = new Set(['.ssh', '.aws', '.azure', '.gnupg', '.kodax', '.agents']);
const SENSITIVE_FILES = new Set(['.env', '.npmrc', '.pypirc', 'credentials', 'id_rsa', 'id_ed25519']);
const WORKSPACE_SHELL_SENSITIVE_HOME_PATHS = [
  '.ssh',
  '.aws',
  '.azure',
  '.gnupg',
  '.kube',
  '.docker',
  '.kodax',
  '.agents',
  path.join('.config', 'gcloud'),
  path.join('.config', 'gh'),
  '.env',
  '.env.local',
  '.env.development',
  '.env.production',
  '.env.test',
  '.env.staging',
  '.npmrc',
  '.pypirc',
  '.netrc',
  '.git-credentials',
  'credentials',
  'credentials.json',
  'application_default_credentials.json',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
] as const;
const ELECTRON_NODE_ENV_SCRUB_IMPORT_LITERAL = JSON.stringify(ELECTRON_NODE_ENV_SCRUB_IMPORT);
const ELECTRON_RUN_AS_NODE_ENV_LITERAL = JSON.stringify(ELECTRON_RUN_AS_NODE_ENV);
const TARGET_ARGV_BOOTSTRAP = String.raw`
const { spawn } = require('node:child_process');
const { writeSync } = require('node:fs');
const input = JSON.parse(Buffer.from(process.argv[2], 'base64').toString('utf8'));
const child = spawn(input.command, input.args, {
  cwd: input.cwd,
  env: process.env,
  shell: false,
  stdio: ['inherit', 'inherit', 'pipe'],
  windowsHide: true,
});
const stop = (signal) => child.kill(signal);
process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));
child.once('spawn', () => {
  writeSync(2, input.targetStartedMarker);
  child.stderr.pipe(process.stderr);
});
child.once('error', (error) => {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n');
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  process.exitCode = signal ? 1 : code ?? 1;
});
`;
const TARGET_ARGV_LOADER = "eval(Buffer.from(process.argv[1],'base64').toString('utf8'))";
const TARGET_ARGV_LOADER_LITERAL = JSON.stringify(TARGET_ARGV_LOADER);
const TARGET_ARGV_BOOTSTRAP_BASE64 = Buffer.from(
  TARGET_ARGV_BOOTSTRAP,
  'utf8',
).toString('base64');
const TARGET_ARGV_BOOTSTRAP_BASE64_LITERAL = JSON.stringify(TARGET_ARGV_BOOTSTRAP_BASE64);
const BROKER_SOURCE = String.raw`
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
let SandboxManager;
const request = JSON.parse(await readFile(process.argv[2], 'utf8'));
await rm(process.argv[2], { force: true });
const targetStartedMarker = request.targetStartedMarker
  ?? '\u0000KODAX_ASRT_TARGET_STARTED:' + randomUUID() + '\u0000\n';
const endpoints = new Set(request.endpoints.map((item) => item.host.toLowerCase() + ':' + item.port));
const callback = request.allowAllNetwork === true
  ? async () => true
  : request.endpoints.length === 0
    ? undefined
    : async ({ host, port }) => endpoints.has(host.toLowerCase() + ':' + port);
const withWindowsChildEnvironment = (argv, environment) => {
  const separator = argv.lastIndexOf('--');
  if (separator < 0) throw new Error('ASRT Windows wrapper omitted its child separator.');
  const controlled = new Set();
  for (let index = 0; index < separator - 1; index += 1) {
    if (argv[index] !== '--env') continue;
    const name = argv[index + 1].split('=', 1)[0];
    if (name) controlled.add(name.toLowerCase());
  }
  const injected = [];
  for (const [name, value] of Object.entries(environment ?? {})) {
    if (value === undefined) continue;
    if (!name || name.includes('=') || name.includes('\0') || value.includes('\0')) {
      throw new Error('Invalid environment entry for ASRT Windows child.');
    }
    const normalized = name.toLowerCase();
    if (controlled.has(normalized) && normalized !== 'path' && normalized !== 'pathext') continue;
    injected.push('--env', name + '=' + value);
  }
  const result = [...argv.slice(0, separator), ...injected, ...argv.slice(separator)];
  const estimate = result.reduce((size, value) => size + value.length + 3, 0);
  if (estimate > 30000) throw new Error('ASRT Windows child environment exceeds the CreateProcess command-line limit.');
  return result;
};
const writeObservation = async (observation) => {
  if (typeof request.observationFile !== 'string') return;
  await writeFile(request.observationFile, JSON.stringify(observation), { mode: 0o600 });
};
const waitForTarget = (target, observation) => {
  const marker = Buffer.from(targetStartedMarker, 'utf8');
  let pending = Buffer.alloc(0);
  let diagnostic = Buffer.alloc(0);
  let processError;
  let targetStarted = false;
  let observationWrite = Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      void observationWrite.then(() => resolve(result), reject);
    };
    target.stderr.on('data', (chunk) => {
      if (targetStarted) {
        process.stderr.write(chunk);
        return;
      }
      pending = Buffer.concat([pending, Buffer.from(chunk)]);
      const markerOffset = pending.indexOf(marker);
      if (markerOffset >= 0) {
        targetStarted = true;
        const suffix = pending.subarray(markerOffset + marker.length);
        pending = Buffer.alloc(0);
        diagnostic = Buffer.alloc(0);
        observationWrite = writeObservation(observation).catch(() => undefined);
        if (suffix.length > 0) process.stderr.write(suffix);
        return;
      }
      const retained = Math.max(0, marker.length - 1);
      if (pending.length > retained) {
        diagnostic = Buffer.concat([
          diagnostic,
          pending.subarray(0, pending.length - retained),
        ]).subarray(-65536);
        pending = pending.subarray(pending.length - retained);
      }
    });
    target.once('error', (error) => {
      processError = error instanceof Error ? error.message : String(error);
    });
    target.once('close', (exitCode, signal) => {
      const preTarget = Buffer.concat([diagnostic, pending]).toString('utf8').trim();
      finish({
        exitCode: signal ? 1 : exitCode ?? 1,
        targetStarted,
        diagnostic: preTarget || processError || undefined,
      });
    });
  });
};
let child;
let targetStarted = false;
let normalFallbackAttempted = false;
const runDirect = async () => {
  const internalElectronNode = request.command === process.execPath && process.versions.electron !== undefined;
  const directArgs = internalElectronNode
    ? ['--import', ${ELECTRON_NODE_ENV_SCRUB_IMPORT_LITERAL}, ...request.args]
    : request.args;
  const directEnv = internalElectronNode
    ? { ...request.env, [${ELECTRON_RUN_AS_NODE_ENV_LITERAL}]: '1' }
    : request.env;
  child = spawn(request.command, directArgs, {
    cwd: request.cwd,
    env: directEnv,
    shell: false,
    stdio: 'inherit',
    windowsHide: true,
  });
  return await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (exitCode, signal) => resolve(signal ? 1 : exitCode ?? 1));
  });
};
try {
  if (request.wrappedInvocation) {
    const wrapped = request.wrappedInvocation;
    child = spawn(wrapped.executable, wrapped.args, {
      cwd: request.cwd,
      env: wrapped.env,
      shell: wrapped.shell,
      stdio: ['inherit', 'inherit', 'pipe'],
      windowsHide: true,
    });
    const result = await waitForTarget(child, {
      version: 1,
      state: 'applied',
      backend: request.observationBackend ?? 'unsupported',
      policyId: 'kodax-workspace-shell-v1',
    });
    targetStarted = result.targetStarted;
    if (request.fallbackToNormalExecution === true && !targetStarted) {
      await writeObservation({
        version: 1,
        state: 'fallback',
        reason: 'backend_failed',
        execution: 'normal_permission_policy',
      }).catch(() => undefined);
      normalFallbackAttempted = true;
      process.exitCode = await runDirect();
    } else {
      if (!targetStarted && result.diagnostic) {
        process.stderr.write(result.diagnostic + '\n');
      }
      process.exitCode = result.exitCode;
    }
  } else {
  ({ SandboxManager } = await import(process.argv[1]));
  const bootstrap = request.bootstrapCommand ?? 'node';
  const bootstrapIsAbsolute = /^(?:[A-Za-z]:[\\/]|\\\\)/.test(bootstrap);
  const bootstrapIsElectronNode = bootstrap === process.execPath
    && process.versions.electron !== undefined;
  const config = process.platform === 'win32' && bootstrapIsAbsolute
    ? {
        ...request.config,
        filesystem: {
          ...request.config.filesystem,
          allowRead: [...new Set([...request.config.filesystem.allowRead, bootstrap])],
        },
      }
    : request.config;
  await SandboxManager.initialize(config, callback);
  const quote = (value) => process.platform === 'win32'
    ? '"' + value.replaceAll('"', '""') + '"'
    : "'" + value.replaceAll("'", "'\"'\"'") + "'";
  const internalElectronNode = request.command === process.execPath && process.versions.electron !== undefined;
  const childArgs = internalElectronNode
    ? ['--import', ${ELECTRON_NODE_ENV_SCRUB_IMPORT_LITERAL}, ...request.args]
    : request.args;
  const command = [
    quote(bootstrap),
    '-e',
    quote(${TARGET_ARGV_LOADER_LITERAL}),
    ${TARGET_ARGV_BOOTSTRAP_BASE64_LITERAL},
    Buffer.from(JSON.stringify({
      command: request.command,
      args: childArgs,
      cwd: request.cwd,
      targetStartedMarker,
    }), 'utf8').toString('base64'),
  ].join(' ');
  if (process.platform === 'win32') {
    const wrapped = await SandboxManager.wrapWithSandboxArgv(command, 'cmd', undefined, undefined, request.cwd);
    const requestedEnv = internalElectronNode || bootstrapIsElectronNode
      ? { ...request.env, [${ELECTRON_RUN_AS_NODE_ENV_LITERAL}]: '1' }
      : request.env;
    const childArgv = withWindowsChildEnvironment(wrapped.argv, requestedEnv);
    child = spawn(childArgv[0], childArgv.slice(1), {
      cwd: request.cwd,
      env: wrapped.env,
      shell: false,
      stdio: ['inherit', 'inherit', 'pipe'],
      windowsHide: true,
    });
  } else {
    const wrapped = await SandboxManager.wrapWithSandbox(command);
    const childEnv = internalElectronNode || bootstrapIsElectronNode
      ? { ...request.env, [${ELECTRON_RUN_AS_NODE_ENV_LITERAL}]: '1' }
      : request.env;
    child = spawn(wrapped, {
      cwd: request.cwd,
      env: childEnv,
      shell: true,
      stdio: ['inherit', 'inherit', 'pipe'],
    });
  }
  const stop = () => child?.kill('SIGTERM');
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const result = await waitForTarget(child, {
    version: 1,
    state: 'applied',
    backend: request.observationBackend ?? 'unsupported',
    policyId: 'kodax-workspace-shell-v1',
  });
  targetStarted = result.targetStarted;
  try { SandboxManager.cleanupAfterCommand(); } catch {}
  await SandboxManager.reset().catch(() => undefined);
  if (request.fallbackToNormalExecution === true && !targetStarted) {
    await writeObservation({
      version: 1,
      state: 'fallback',
      reason: 'backend_failed',
      execution: 'normal_permission_policy',
    }).catch(() => undefined);
    normalFallbackAttempted = true;
    process.exitCode = await runDirect();
  } else {
    if (!targetStarted && result.diagnostic) {
      process.stderr.write(result.diagnostic + '\n');
    }
    process.exitCode = result.exitCode;
  }
  }
} catch (error) {
  await SandboxManager?.reset().catch(() => undefined);
  if (
    request.fallbackToNormalExecution === true
    && !targetStarted
    && !normalFallbackAttempted
  ) {
    try {
      await writeObservation({
        version: 1,
        state: 'fallback',
        reason: 'backend_failed',
        execution: 'normal_permission_policy',
      }).catch(() => undefined);
      normalFallbackAttempted = true;
      process.exitCode = await runDirect();
    } catch (fallbackError) {
      process.stderr.write((fallbackError instanceof Error ? fallbackError.message : String(fallbackError)) + '\n');
      process.exitCode = 1;
    }
  } else {
    process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n');
    process.exitCode = 1;
  }
}
`;
let doctorPromise: Promise<SandboxRuntimeDoctorResult> | undefined;
let doctorExpiresAt = 0;
const SANDBOX_NOT_READY_RECHECK_MS = 30_000;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseBrokerObservation(
  text: string,
): KodaXShellSandboxObservation | undefined {
  const value = JSON.parse(text) as unknown;
  if (typeof value !== 'object' || value === null) return undefined;
  const observation = value as Readonly<Record<string, unknown>>;
  if (observation.version !== 1) return undefined;
  if (
    observation.state === 'applied'
    && observation.policyId === 'kodax-workspace-shell-v1'
    && (
      observation.backend === 'windows-restricted-user'
      || observation.backend === 'macos-seatbelt'
      || observation.backend === 'linux-bubblewrap'
      || observation.backend === 'unsupported'
    )
  ) {
    return observation as KodaXShellSandboxObservation;
  }
  if (
    observation.state === 'fallback'
    && observation.reason === 'backend_failed'
    && observation.execution === 'normal_permission_policy'
  ) {
    return observation as KodaXShellSandboxObservation;
  }
  return undefined;
}

function sandboxJavaScriptCommand(): string {
  return process.env.KODAX_A2A_NODE
    ?? (process.env.KODAX_BUNDLED === 'true' ? 'node' : process.execPath);
}

export async function doctorSandboxRuntime(options: { readonly refresh?: boolean } = {}): Promise<SandboxRuntimeDoctorResult> {
  if (
    options.refresh
    || doctorPromise === undefined
    || Date.now() >= doctorExpiresAt
  ) {
    const probe = inspectSandboxRuntime();
    doctorPromise = probe;
    doctorExpiresAt = Number.POSITIVE_INFINITY;
    void probe.then(
      (result) => {
        if (doctorPromise !== probe) return;
        doctorExpiresAt = result.ready
          ? Number.POSITIVE_INFINITY
          : Date.now() + SANDBOX_NOT_READY_RECHECK_MS;
      },
      () => {
        if (doctorPromise !== probe) return;
        doctorPromise = undefined;
        doctorExpiresAt = 0;
      },
    );
  }
  return doctorPromise;
}

async function inspectSandboxRuntime(): Promise<SandboxRuntimeDoctorResult> {
  const diagnostics: string[] = [];
  if (!SandboxManager.isSupportedPlatform()) diagnostics.push(`Unsupported platform: ${process.platform}.`);
  const dependencies = SandboxManager.checkDependencies();
  diagnostics.push(...dependencies.warnings, ...dependencies.errors);
  let setupRequired = dependencies.errors.length > 0;
  if (process.env.KODAX_BUNDLED !== 'true') {
    try {
      const manifest = JSON.parse(
        await readFile(moduleRequire.resolve('@anthropic-ai/sandbox-runtime/package.json'), 'utf8'),
      ) as { readonly version?: unknown };
      if (manifest.version !== KODAX_ASRT_VERSION) {
        setupRequired = true;
        diagnostics.push(`ASRT package version mismatch: expected ${KODAX_ASRT_VERSION}, found ${String(manifest.version)}.`);
      }
    } catch (error: unknown) {
      setupRequired = true;
      diagnostics.push(`ASRT package provenance check failed: ${errorText(error)}`);
    }
  }
  const nodeCommand = sandboxJavaScriptCommand();
  const nodeProbeLaunch = prepareInternalNodeLaunch({
    args: ['--version'],
    env: sanitizedEnvironment(),
    isElectron: nodeCommand === process.execPath && process.versions.electron !== undefined,
  });
  const nodeProbe = spawnSync(nodeCommand, nodeProbeLaunch.args, {
    env: nodeProbeLaunch.env, shell: false, encoding: 'utf8', windowsHide: true, timeout: 5_000,
  });
  if (nodeProbe.status !== 0) {
    setupRequired = true;
    const reason = nodeProbe.error?.message ?? (nodeProbe.stderr.trim() || nodeCommand);
    diagnostics.push(`JavaScript Skill interpreter is unavailable: ${reason}.`);
  }
  if (process.platform === 'win32') {
    try {
      const user = getWindowsSandboxUserStatus();
      if (!user.provisioned || !user.credPresent || !user.inSandboxGroup) {
        setupRequired = true;
        diagnostics.push('Windows sandbox account is not fully provisioned.');
      } else {
        await verifyWindowsWfpEgress();
      }
    } catch (error: unknown) {
      setupRequired = true;
      diagnostics.push(errorText(error));
    }
  }
  return {
    ready: SandboxManager.isSupportedPlatform() && !setupRequired,
    platform: process.platform,
    version: KODAX_ASRT_VERSION,
    diagnostics,
    setupRequired,
  };
}

export async function setupSandboxRuntime(): Promise<SandboxRuntimeDoctorResult> {
  if (process.platform !== 'win32') return doctorSandboxRuntime({ refresh: true });
  const result = installWindowsSandbox();
  if (result.cancelled) throw new Error('Sandbox setup was cancelled.');
  return doctorSandboxRuntime({ refresh: true });
}

export function sandboxSetupGuidance(
  doctor: SandboxRuntimeDoctorResult,
): readonly string[] {
  if (doctor.ready) {
    return [
      `KodaX sandbox is active (${doctor.platform}, ASRT ${doctor.version}).`,
    ];
  }
  if (doctor.platform === 'win32') {
    return [
      'Run "kodax sandbox setup". Windows will show a UAC prompt for the one-time sandbox account and network policy setup.',
      'The terminal itself does not need to be started as Administrator; approve the UAC prompt when it appears.',
    ];
  }
  if (doctor.platform === 'darwin') {
    return [
      'KodaX uses macOS Seatbelt through sandbox-exec. Install the missing dependency, then rerun "kodax sandbox doctor".',
      'Homebrew: brew install ripgrep',
    ];
  }
  if (doctor.platform === 'linux') {
    return [
      'KodaX uses bubblewrap on Linux. Install bubblewrap, socat, and ripgrep, then rerun "kodax sandbox doctor".',
      'Debian/Ubuntu: sudo apt install bubblewrap socat ripgrep',
      'Fedora/RHEL: sudo dnf install bubblewrap socat ripgrep',
      'Arch Linux: sudo pacman -S bubblewrap socat ripgrep',
    ];
  }
  return [
    `KodaX sandbox is not supported on ${doctor.platform}.`,
  ];
}

/**
 * Setup/onboarding helper. It may trigger the Windows UAC installer, but never
 * invokes a macOS/Linux package manager or silently widens execution.
 */
export async function prepareSandboxRuntimeForSetup(
  options: { readonly allowElevation?: boolean } = {},
): Promise<SandboxSetupOutcome> {
  const initial = await doctorSandboxRuntime({ refresh: true });
  if (initial.ready) {
    return {
      status: 'ready',
      attempted: false,
      doctor: initial,
      guidance: sandboxSetupGuidance(initial),
    };
  }
  if (initial.platform !== 'win32' || options.allowElevation === false) {
    return {
      status: 'unavailable',
      attempted: false,
      doctor: initial,
      guidance: sandboxSetupGuidance(initial),
    };
  }
  try {
    const doctor = await setupSandboxRuntime();
    return {
      status: doctor.ready ? 'ready' : 'unavailable',
      attempted: true,
      doctor,
      guidance: sandboxSetupGuidance(doctor),
    };
  } catch (error: unknown) {
    const doctor = await doctorSandboxRuntime({ refresh: true });
    const message = errorText(error);
    return {
      status: /cancelled/i.test(message) ? 'cancelled' : 'unavailable',
      attempted: true,
      doctor,
      guidance: sandboxSetupGuidance(doctor),
      error: message,
    };
  }
}

function canonicalRelative(value: string, label: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '');
  if (!normalized || path.posix.isAbsolute(normalized) || normalized.split('/').includes('..')) {
    throw new Error(`${label} must be a safe relative path.`);
  }
  return normalized;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isSensitiveRelative(relative: string): boolean {
  const parts = relative.split(path.sep).map((part) => part.toLowerCase());
  return parts.some((part) => SENSITIVE_PATH_PARTS.has(part))
    || parts.some((part) => SENSITIVE_FILES.has(part) || part.startsWith('.env.'));
}

async function copySkillSnapshot(skill: Skill, root: string): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const files = [
    ...(skill.scripts ?? []).map((file) => ({ folder: 'scripts', file })),
    ...(skill.references ?? []).map((file) => ({ folder: 'references', file })),
    ...(skill.assets ?? []).map((file) => ({ folder: 'assets', file })),
    ...(skill.templates ?? []).map((file) => ({ folder: 'templates', file })),
    ...(skill.resources ?? []).map((file) => ({ folder: 'resources', file })),
  ];
  await writeFile(path.join(root, 'SKILL.md'), await readFile(skill.skillFilePath), { mode: 0o600 });
  for (const { folder, file } of files) {
    const relative = canonicalRelative(file.relativePath, `Skill ${skill.name} support file`);
    const target = path.join(root, folder, ...relative.split('/'));
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, await readFile(file.path), { mode: 0o600 });
  }
}

async function snapshotAdmissions(input: CreateSkillScriptRunnerInput, root: string): Promise<Map<string, AdmittedScript>> {
  const scripts = new Map<string, AdmittedScript>();
  for (const [skillName, rawPaths] of Object.entries(input.admissions)) {
    const skill = await input.registry.loadFull(skillName);
    const available = new Map((skill.scripts ?? []).map((file) => [
      `scripts/${canonicalRelative(file.relativePath, `Skill ${skillName} script`)}`, file,
    ]));
    const skillRoot = path.join(root, skillName.replace(/[^A-Za-z0-9._-]/g, '_'));
    await copySkillSnapshot(skill, skillRoot);
    for (const rawPath of rawPaths) {
      const relativePath = canonicalRelative(rawPath, `toolPolicy.skillScripts.${skillName}`);
      if (!available.has(relativePath)) throw new Error(`Skill "${skillName}" has no script "${relativePath}".`);
      scripts.set(`${skillName}\0${relativePath}`, {
        skill: skillName,
        relativePath,
        snapshotPath: path.join(skillRoot, ...relativePath.split('/')),
      });
    }
  }
  return scripts;
}

function networkEndpoints(network: CreateSkillScriptRunnerInput['network']): SandboxEndpoint[] {
  if (network.mode === 'deny') return [];
  return network.origins.map((origin) => {
    const url = new URL(origin);
    return { host: url.hostname.toLowerCase(), port: url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80 };
  });
}

function sanitizedEnvironment(): NodeJS.ProcessEnv {
  const names = [
    'PATH',
    'Path',
    'PATHEXT',
    'SystemRoot',
    'COMSPEC',
    'TEMP',
    'TMP',
    'HOME',
    'USERPROFILE',
    'LOCALAPPDATA',
    'LANG',
  ];
  const env: NodeJS.ProcessEnv = { NO_COLOR: '1' };
  for (const name of names) if (process.env[name] !== undefined) env[name] = process.env[name];
  for (const [name, value] of Object.entries(process.env)) {
    if (name.startsWith('LC_') && value !== undefined) env[name] = value;
  }
  return env;
}

function interpreterFor(script: string): { readonly command: string; readonly args: readonly string[] } {
  const extension = path.extname(script).toLowerCase();
  if (['.js', '.mjs', '.cjs'].includes(extension)) {
    return {
      command: process.env.KODAX_A2A_NODE ?? (process.env.KODAX_BUNDLED === 'true' ? 'node' : process.execPath),
      args: [script],
    };
  }
  if (extension === '.py') return { command: process.env.KODAX_A2A_PYTHON ?? (process.platform === 'win32' ? 'python.exe' : 'python3'), args: [script] };
  if (extension === '.ps1') {
    const command = process.env.KODAX_A2A_POWERSHELL
      ?? (process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'pwsh');
    return { command, args: ['-NoProfile', '-NonInteractive', '-File', script] };
  }
  if (extension === '.sh' && process.platform !== 'win32') return { command: '/bin/sh', args: [script] };
  if (['.cmd', '.bat'].includes(extension) && process.platform === 'win32') {
    return { command: process.env.COMSPEC ?? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'), args: ['/d', '/s', '/c', script] };
  }
  throw new Error(`Unsupported admitted Skill script type: ${extension || '<none>'}.`);
}

interface SandboxProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const SANDBOX_TERMINATION_FORCE_MS = 250;
const SANDBOX_TERMINATION_HARD_MS = 1_500;

async function collectProcess(
  child: ReturnType<typeof spawn>,
  signal?: AbortSignal,
  timeoutMs = SCRIPT_TIMEOUT_MS,
  maxOutputBytes = MAX_OUTPUT_BYTES,
): Promise<SandboxProcessResult> {
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let bytes = 0;
  let stopError: Error | undefined;
  let rejectStopped: (error: Error) => void = () => undefined;
  let hardStopTimer: ReturnType<typeof setTimeout> | undefined;
  const stopped = new Promise<never>((_resolve, reject) => {
    rejectStopped = reject;
  });
  const requestStop = (error: Error): void => {
    if (stopError !== undefined) return;
    stopError = error;
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (hardStopTimer !== undefined) clearTimeout(hardStopTimer);
      rejectStopped(error);
    };
    hardStopTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } finally {
        finish();
      }
    }, SANDBOX_TERMINATION_HARD_MS);
    void killChildProcessTree(child, {
      forceMs: SANDBOX_TERMINATION_FORCE_MS,
      taskkillMs: SANDBOX_TERMINATION_FORCE_MS,
    }).then(finish, finish);
  };
  const append = (chunks: Buffer[], chunk: Buffer): void => {
    bytes += chunk.byteLength;
    if (bytes > maxOutputBytes) {
      requestStop(new Error(`Sandboxed command output exceeded ${maxOutputBytes} bytes.`));
    }
    else chunks.push(chunk);
  };
  child.stdout?.on('data', (chunk: Buffer) => { append(stdoutChunks, chunk); });
  child.stderr?.on('data', (chunk: Buffer) => { append(stderrChunks, chunk); });
  const timer = setTimeout(() => {
    requestStop(new Error(`Sandboxed command exceeded its ${timeoutMs} ms timeout.`));
  }, timeoutMs);
  const abort = (): void => {
    const reason = signal?.reason;
    requestStop(reason instanceof Error ? reason : new Error('Sandboxed command was cancelled.'));
  };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  try {
    const completed = new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => resolve(code ?? 1));
    });
    const exitCode = await Promise.race([completed, stopped]);
    if (stopError !== undefined) throw stopError;
    return {
      exitCode,
      stdout: Buffer.concat(stdoutChunks).toString('utf8'),
      stderr: Buffer.concat(stderrChunks).toString('utf8'),
    };
  } finally {
    clearTimeout(timer);
    if (hardStopTimer !== undefined) clearTimeout(hardStopTimer);
    signal?.removeEventListener('abort', abort);
  }
}

async function runBrokerResult(
  request: SandboxBrokerRequest,
  signal?: AbortSignal,
  timeoutMs = SCRIPT_TIMEOUT_MS,
  maxOutputBytes = MAX_OUTPUT_BYTES,
): Promise<SandboxProcessResult> {
  const requestFile = path.join(os.tmpdir(), `kodax-asrt-${process.pid}-${randomUUID()}.json`);
  const protectedRequest: SandboxBrokerRequest = {
    ...request,
    bootstrapCommand: request.bootstrapCommand ?? sandboxJavaScriptCommand(),
    config: {
      ...request.config,
      filesystem: {
        ...request.config.filesystem,
        denyRead: [...request.config.filesystem.denyRead, requestFile],
      },
    },
  };
  await writeFile(requestFile, JSON.stringify(protectedRequest), { mode: 0o600 });
  try {
    const args = process.env.KODAX_BUNDLED === 'true'
      ? ['__asrt-broker', requestFile]
      : ['--input-type=module', '-e', BROKER_SOURCE, ASRT_MODULE_URL!, requestFile];
    const launch = prepareInternalNodeLaunch({
      args,
      env: sanitizedEnvironment(),
      isElectron: process.versions.electron !== undefined,
    });
    const child = spawn(process.execPath, launch.args, {
      env: launch.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    return await collectProcess(child, signal, timeoutMs, maxOutputBytes);
  } finally {
    await rm(requestFile, { force: true });
  }
}

async function runBroker(request: SandboxBrokerRequest, signal?: AbortSignal): Promise<string> {
  const result = await runBrokerResult(request, signal);
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(`Sandboxed Skill script failed (${result.exitCode}): ${detail}`);
  }
  return result.stdout;
}

async function workspaceSource(root: string, relative: string): Promise<string> {
  const realRoot = await realpath(root);
  const candidate = path.resolve(root, canonicalRelative(relative, 'Skill script input'));
  const resolved = await realpath(candidate);
  if (!isInside(realRoot, resolved) || isSensitiveRelative(path.relative(realRoot, resolved))) {
    throw new Error('Skill script input is outside the permitted workspace surface.');
  }
  if (!(await stat(resolved)).isFile()) throw new Error('Skill script inputs must be files.');
  return resolved;
}

async function workspaceTarget(root: string, relative: string): Promise<string> {
  const realRoot = await realpath(root);
  const candidate = path.resolve(root, canonicalRelative(relative, 'Skill script output target'));
  if (!isInside(path.resolve(root), candidate) || isSensitiveRelative(path.relative(path.resolve(root), candidate))) {
    throw new Error('Skill script output target is outside the permitted workspace surface.');
  }
  await mkdir(path.dirname(candidate), { recursive: true });
  if (!isInside(realRoot, await realpath(path.dirname(candidate)))) throw new Error('Skill script output target escapes through a symlink.');
  try { await stat(candidate); throw new Error('Skill script output target already exists.'); }
  catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return candidate;
}

async function stageInputFiles(root: string, stage: string, input: KodaXSkillScriptRunInput, access: CreateSkillScriptRunnerInput['workspaceAccess']): Promise<void> {
  if (input.inputs.length > 0 && access === 'none') throw new Error('Skill script inputs require workspace read access.');
  for (const item of input.inputs) {
    const source = await workspaceSource(root, item.path);
    const relative = canonicalRelative(item.as ?? path.basename(source), 'Skill script staged input');
    const target = path.resolve(stage, 'inputs', ...relative.split('/'));
    if (!isInside(path.join(stage, 'inputs'), target)) throw new Error('Skill script staged input escapes staging.');
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await copyFile(source, target);
  }
}

async function promoteOutputs(
  root: string,
  stage: string,
  input: KodaXSkillScriptRunInput,
  access: CreateSkillScriptRunnerInput['workspaceAccess'],
  workspaceByteLimit?: number,
): Promise<string[]> {
  if (input.outputs.length > 0 && access !== 'write') throw new Error('Skill script outputs require workspace write access.');
  const promoted: string[] = [];
  for (const item of input.outputs) {
    const relative = canonicalRelative(item.path, 'Skill script staged output');
    const source = path.resolve(stage, 'outputs', ...relative.split('/'));
    const realSource = await realpath(source);
    if (!isInside(path.join(stage, 'outputs'), realSource)
      || (await lstat(source)).isSymbolicLink()
      || !(await stat(source)).isFile()) {
      throw new Error(`Skill script did not produce output "${relative}".`);
    }
    const target = await workspaceTarget(root, item.target);
    if (workspaceByteLimit !== undefined
      && directorySize(root, true) + (await stat(source)).size > workspaceByteLimit) {
      throw new Error('Skill script outputs would exceed the remote workspace byte quota.');
    }
    await copyFile(source, target, constants.COPYFILE_EXCL);
    promoted.push(path.relative(root, target));
  }
  return promoted;
}

function directorySize(root: string, skipScriptStaging = false): number {
  let total = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (skipScriptStaging && entry.name === '.kodax-a2a-script') continue;
    if (entry.isSymbolicLink()) continue;
    const item = path.join(root, entry.name);
    if (entry.isDirectory()) total += directorySize(item);
    else if (entry.isFile()) total += statSync(item).size;
  }
  return total;
}

function sandboxConfig(
  stage: string,
  snapshotRoot: string,
  endpoints: readonly SandboxEndpoint[],
  interpreter: string,
): SandboxRuntimeConfig {
  const home = os.homedir();
  const interpreterRead = path.isAbsolute(interpreter) ? [interpreter] : [];
  return {
    network: {
      allowedDomains: [], deniedDomains: [], strictAllowlist: endpoints.length === 0,
      allowUnixSockets: [], allowAllUnixSockets: false, allowLocalBinding: false,
    },
    filesystem: {
      denyRead: [home],
      allowRead: [stage, snapshotRoot, process.execPath, ...interpreterRead],
      allowWrite: [stage],
      denyWrite: [home],
    },
  };
}

function canonicalTempDirectories(): string[] {
  const candidates = [
    os.tmpdir(),
    process.env.TEMP,
    process.env.TMP,
    process.env.TMPDIR,
    ...(process.platform === 'win32' ? [] : ['/tmp', '/var/tmp']),
  ];
  return [...new Set(candidates
    .filter((candidate): candidate is string => (
      typeof candidate === 'string' && path.isAbsolute(candidate)
    ))
    .map((candidate) => path.resolve(candidate)))];
}

function existingWorkspaceDenyWrites(workspaceRoot: string): string[] {
  const candidates = [
    path.join(workspaceRoot, '.git', 'config'),
    path.join(workspaceRoot, '.git', 'hooks'),
  ];
  return candidates.filter((candidate) => {
    try {
      statSync(candidate);
      return true;
    } catch {
      return false;
    }
  });
}

function workspaceShellSensitiveReadDenies(
  home: string,
  agentHome: string,
  controlDirectory: string,
): string[] {
  return [...new Set([
    path.resolve(controlDirectory),
    path.resolve(agentHome),
    ...WORKSPACE_SHELL_SENSITIVE_HOME_PATHS.map((relative) => path.resolve(home, relative)),
  ])];
}

function workspaceShellSandboxConfig(
  workspaceRoot: string,
): SandboxRuntimeConfig {
  const agentHome = path.resolve(getAgentConfigHome());
  const controlDirectory = path.join(agentHome, 'sandbox-runtime');
  const home = path.resolve(os.homedir());
  const denyRead = workspaceShellSensitiveReadDenies(home, agentHome, controlDirectory);
  const userReadGrants = (process.env.PATH ?? process.env.Path ?? '')
    .split(path.delimiter)
    .map((entry) => entry.replace(/^"|"$/g, ''))
    .filter((entry) => path.isAbsolute(entry))
    .map((entry) => path.resolve(entry))
    .filter((entry) => {
      const relative = path.relative(home, entry);
      return relative !== ''
        && !relative.startsWith('..')
        && !path.isAbsolute(relative)
        && !denyRead.some((denied) => isInside(denied, entry));
    });
  const bootstrap = sandboxJavaScriptCommand();
  return {
    network: {
      allowedDomains: [],
      deniedDomains: [],
      strictAllowlist: false,
      allowUnixSockets: [],
      allowAllUnixSockets: false,
      allowLocalBinding: false,
    },
    filesystem: {
      denyRead,
      allowRead: [
        ...new Set([
          ...userReadGrants,
          ...(path.isAbsolute(bootstrap) ? [bootstrap] : []),
        ]),
      ],
      allowWrite: [workspaceRoot, ...canonicalTempDirectories()],
      denyWrite: [
        controlDirectory,
        ...existingWorkspaceDenyWrites(workspaceRoot),
      ],
    },
  };
}

function workspaceShellSessionSandboxConfig(
  workspaceRoot: string,
): SandboxRuntimeConfig {
  const config = workspaceShellSandboxConfig(workspaceRoot);
  if (process.platform !== 'win32') return config;
  // Keep the long-lived ACL stamp bounded; the complete read-deny set is
  // applied by srt-win exec to each exact command in wrapSandboxTarget().
  return {
    ...config,
    filesystem: {
      ...config.filesystem,
      denyRead: [path.resolve(getAgentConfigHome(), 'sandbox-runtime')],
    },
  };
}

function normalizedSandboxPaths(
  values: readonly string[] | undefined,
  cwd: string,
): string[] {
  return [...new Set((values ?? []).map((value) => (
    path.resolve(cwd, value)
  )))];
}

function sdkSandboxEndpoints(network: KodaXSandboxNetworkPolicy): SandboxEndpoint[] {
  if (network.mode !== 'allowlist') return [];
  return network.origins.map((origin) => {
    const url = new URL(origin);
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:')
      || url.username
      || url.password
      || url.pathname !== '/'
      || url.search
      || url.hash
    ) {
      throw new Error(`Sandbox network origin must be an HTTP(S) origin: ${origin}`);
    }
    return {
      host: url.hostname.toLowerCase(),
      port: url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80,
    };
  });
}

/**
 * Public SDK executor. An unavailable sandbox is returned as structured state;
 * this function never runs the command without containment.
 */
export async function runKodaXSandboxed(
  input: KodaXSandboxRunInput,
): Promise<KodaXSandboxRunResult> {
  if (!input.command.trim()) throw new Error('Sandbox command must not be empty.');
  if (input.timeoutMs !== undefined && (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0)) {
    throw new Error('Sandbox timeoutMs must be a positive finite number.');
  }
  if (
    input.maxOutputBytes !== undefined
    && (!Number.isSafeInteger(input.maxOutputBytes) || input.maxOutputBytes <= 0)
  ) {
    throw new Error('Sandbox maxOutputBytes must be a positive safe integer.');
  }
  const cwd = path.resolve(input.cwd);
  const network = input.network ?? { mode: 'deny' };
  const endpoints = sdkSandboxEndpoints(network);
  const doctor = await doctorSandboxRuntime();
  if (!doctor.ready) return { status: 'unavailable', sandboxed: false, doctor };
  const env = {
    ...(input.inheritEnvironment === true ? process.env : sanitizedEnvironment()),
    ...input.env,
  };
  const request: SandboxBrokerRequest = {
    config: {
      network: {
        allowedDomains: [],
        deniedDomains: [],
        strictAllowlist: network.mode === 'deny',
        allowUnixSockets: [],
        allowAllUnixSockets: false,
        allowLocalBinding: false,
      },
      filesystem: {
        allowRead: normalizedSandboxPaths(input.filesystem.allowRead, cwd),
        allowWrite: normalizedSandboxPaths(input.filesystem.allowWrite, cwd),
        denyRead: normalizedSandboxPaths(input.filesystem.denyRead, cwd),
        denyWrite: normalizedSandboxPaths(input.filesystem.denyWrite, cwd),
      },
    },
    command: input.command,
    args: input.args ?? [],
    cwd,
    env,
    endpoints,
    allowAllNetwork: network.mode === 'allow',
  };
  const result = await runBrokerResult(
    request,
    input.signal,
    input.timeoutMs ?? SCRIPT_TIMEOUT_MS,
    input.maxOutputBytes ?? MAX_OUTPUT_BYTES,
  );
  return {
    status: 'completed',
    sandboxed: true,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

interface WorkspaceSessionResponse {
  readonly id?: string;
  readonly type: 'ready' | 'result';
  readonly ok: boolean;
  readonly invocation?: NonNullable<SandboxBrokerRequest['wrappedInvocation']>;
  readonly error?: string;
}

interface WorkspaceSessionLease {
  readonly invocation: NonNullable<SandboxBrokerRequest['wrappedInvocation']>;
  release(): Promise<void>;
}

interface WorkspaceSessionClient {
  acquire(
    request: SandboxBrokerRequest,
    signal?: AbortSignal,
    deadlineAt?: number,
  ): Promise<WorkspaceSessionLease>;
  close(): Promise<void>;
}

const WORKSPACE_SESSION_IDLE_MS = 5 * 60_000;
const WORKSPACE_SESSION_START_TIMEOUT_MS = 180_000;
const WORKSPACE_SESSION_RPC_TIMEOUT_MS = 30_000;
const WORKSPACE_SESSION_TERMINATE_GRACE_MS = 1_500;
// ASRT 0.0.65 may run two serial 60s ACL helpers while resetting Windows.
const WORKSPACE_SESSION_WINDOWS_RESET_GRACE_MS = 130_000;
const workspaceSessions = new Map<string, Promise<WorkspaceSessionClient>>();

function workspacePreparationTimeoutError(): Error {
  const error = new Error('ASRT workspace session preparation timed out.');
  error.name = 'TimeoutError';
  return error;
}

function throwIfWorkspacePreparationStopped(
  signal?: AbortSignal,
  deadlineAt?: number,
): void {
  if (signal?.aborted) throw new DOMException('Operation aborted', 'AbortError');
  if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
    throw workspacePreparationTimeoutError();
  }
}

function waitForWorkspacePreparation<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
  deadlineAt?: number,
): Promise<T> {
  throwIfWorkspacePreparationStopped(signal, deadlineAt);
  if (signal === undefined && deadlineAt === undefined) return promise;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      action();
    };
    const onAbort = (): void => {
      finish(() => reject(new DOMException('Operation aborted', 'AbortError')));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (deadlineAt !== undefined) {
      timer = setTimeout(() => {
        finish(() => reject(workspacePreparationTimeoutError()));
      }, Math.max(0, deadlineAt - Date.now()));
      timer.unref();
    }
    promise.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

async function sandboxControlDirectory(): Promise<string> {
  const directory = path.join(getAgentConfigHome(), 'sandbox-runtime');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return directory;
}

function workspaceSessionEntryArgs(initFile: string): string[] {
  if (process.env.KODAX_BUNDLED === 'true') {
    return ['__asrt-workspace-session', initFile];
  }
  if (import.meta.url.endsWith('.ts')) {
    return [
      '--import',
      'tsx',
      fileURLToPath(new URL('./sandbox-workspace-session-entry.ts', import.meta.url)),
      initFile,
    ];
  }
  const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
  const distributionDirectory = path.basename(currentDirectory) === 'chunks'
    ? path.dirname(currentDirectory)
    : currentDirectory;
  const entry = path.join(distributionDirectory, 'sandbox-workspace-session.js');
  return [entry, initFile];
}

function setWorkspaceSessionReferenced(
  child: ReturnType<typeof spawn>,
  referenced: boolean,
): void {
  const method = referenced ? 'ref' : 'unref';
  child[method]();
  for (const stream of child.stdio) {
    if (!stream) continue;
    const controllable = stream as typeof stream & {
      ref?: () => void;
      unref?: () => void;
    };
    controllable[method]?.();
  }
}

async function startWorkspaceSessionClient(
  workspaceRoot: string,
  onExit: () => void,
): Promise<WorkspaceSessionClient> {
  const controlDirectory = await sandboxControlDirectory();
  const initFile = path.join(
    controlDirectory,
    `workspace-${process.pid}-${randomUUID()}.json`,
  );
  await writeFile(initFile, JSON.stringify({
    config: workspaceShellSessionSandboxConfig(workspaceRoot),
  }), { mode: 0o600 });
  const launch = prepareInternalNodeLaunch({
    args: workspaceSessionEntryArgs(initFile),
    env: sanitizedEnvironment(),
    isElectron: process.versions.electron !== undefined,
  });
  const child = spawn(process.execPath, launch.args, {
    env: launch.env,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const control = child.stdio[3];
  if (!control) throw new Error('ASRT workspace session control pipe was not created.');
  const responses = readline.createInterface({
    input: control as NodeJS.ReadableStream,
  });
  const pending = new Map<string, {
    resolve: (response: WorkspaceSessionResponse) => void;
    reject: (error: Error) => void;
  }>();
  let stderrTail = '';
  let exited = false;
  let closing = false;
  let evicted = false;
  let requestSequence = 0;
  let activeLeases = 0;
  let resolveDrained: (() => void) | undefined;
  let idleTimer: NodeJS.Timeout | undefined;
  let closePromise: Promise<void> | undefined;
  const childExit = new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
  });
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const evict = (): void => {
    if (evicted) return;
    evicted = true;
    onExit();
  };
  let terminatePromise: Promise<void> | undefined;
  const terminate = (): Promise<void> => {
    if (terminatePromise) return terminatePromise;
    terminatePromise = (async () => {
      try {
        await killChildProcessTree(child, {
          gracefulStdinEnd: true,
          gracefulMs: process.platform === 'win32'
            ? WORKSPACE_SESSION_WINDOWS_RESET_GRACE_MS
            : WORKSPACE_SESSION_TERMINATE_GRACE_MS,
          forceMs: WORKSPACE_SESSION_TERMINATE_GRACE_MS,
          taskkillMs: WORKSPACE_SESSION_TERMINATE_GRACE_MS,
        });
      } finally {
        responses.close();
        control.destroy();
        child.stdin.destroy();
      }
    })().finally(evict);
    return terminatePromise;
  };
  const fail = (error: Error): void => {
    if (exited) return;
    exited = true;
    rejectReady(error);
    for (const item of pending.values()) item.reject(error);
    pending.clear();
  };
  child.stderr.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-16_384);
  });
  child.stdout.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-16_384);
  });
  responses.on('line', (line) => {
    let response: WorkspaceSessionResponse;
    try {
      response = JSON.parse(line) as WorkspaceSessionResponse;
    } catch {
      fail(new Error('ASRT workspace session returned malformed control data.'));
      void terminate();
      return;
    }
    if (response.type === 'ready') {
      if (response.ok) resolveReady();
      else rejectReady(new Error(response.error ?? 'ASRT workspace session failed.'));
      return;
    }
    if (response.type !== 'result' || !response.id) {
      fail(new Error('ASRT workspace session returned an invalid control response.'));
      void terminate();
      return;
    }
    const item = pending.get(response.id);
    if (!item) return;
    pending.delete(response.id);
    item.resolve(response);
  });
  child.once('error', (error) => {
    fail(error);
    void terminate();
  });
  responses.once('close', () => {
    if (closing || exited) return;
    fail(new Error('ASRT workspace session control pipe closed unexpectedly.'));
    void terminate();
  });
  child.once('exit', (code) => {
    if (idleTimer) clearTimeout(idleTimer);
    fail(new Error(
      `ASRT workspace session exited ${code ?? 1}: ${stderrTail.trim() || 'no diagnostics'}`,
    ));
    evict();
  });
  const startupTimer = setTimeout(() => {
    fail(new Error('ASRT workspace session initialization timed out.'));
    void terminate();
  }, WORKSPACE_SESSION_START_TIMEOUT_MS);
  try {
    await ready.finally(() => clearTimeout(startupTimer));
  } catch (error) {
    await terminate();
    await rm(initFile, { force: true });
    throw error;
  }

  const request = async (
    type: 'wrap' | 'cleanup',
    value?: SandboxBrokerRequest,
  ): Promise<WorkspaceSessionResponse> => {
    if (exited || (closing && type === 'wrap')) {
      throw new Error('ASRT workspace session is unavailable.');
    }
    const id = `workspace_${++requestSequence}`;
    const response = new Promise<WorkspaceSessionResponse>((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
    const timeout = setTimeout(() => {
      fail(new Error(`ASRT workspace session ${type} request timed out.`));
      void terminate();
    }, WORKSPACE_SESSION_RPC_TIMEOUT_MS);
    timeout.unref();
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdin.write(
          `${JSON.stringify({ id, type, request: value })}\n`,
          (error) => error ? reject(error) : resolve(),
        );
      });
    } catch (error: unknown) {
      pending.delete(id);
      clearTimeout(timeout);
      fail(error instanceof Error ? error : new Error(String(error)));
      void terminate();
      throw error;
    }
    return response.finally(() => clearTimeout(timeout));
  };
  const scheduleIdleClose = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    if (activeLeases > 0 || closing || exited) return;
    idleTimer = setTimeout(() => {
      void client.close();
    }, WORKSPACE_SESSION_IDLE_MS);
    idleTimer.unref();
    setWorkspaceSessionReferenced(child, false);
  };
  const client: WorkspaceSessionClient = {
    async acquire(value, signal, deadlineAt) {
      throwIfWorkspacePreparationStopped(signal, deadlineAt);
      if (exited || closing) {
        throw new Error('ASRT workspace session is unavailable.');
      }
      if (idleTimer) clearTimeout(idleTimer);
      setWorkspaceSessionReferenced(child, true);
      activeLeases += 1;
      let finalized = false;
      const finalize = (): void => {
        if (finalized) return;
        finalized = true;
        activeLeases -= 1;
        if (activeLeases === 0) {
          resolveDrained?.();
          resolveDrained = undefined;
        }
        scheduleIdleClose();
      };
      const wrapPromise = request('wrap', value);
      let response: WorkspaceSessionResponse;
      try {
        response = await waitForWorkspacePreparation(
          wrapPromise,
          signal,
          deadlineAt,
        );
      } catch (error: unknown) {
        void wrapPromise.then(async (lateResponse) => {
          if (!lateResponse.ok || !lateResponse.invocation) return;
          const cleanup = await request('cleanup');
          if (!cleanup.ok) {
            throw new Error(cleanup.error ?? 'ASRT command cleanup failed.');
          }
        }).catch((cleanupError: unknown) => {
          emitKodaXDiagnostic({
            source: 'sandbox:workspace-session',
            level: 'warn',
            message: 'Late workspace sandbox preparation cleanup failed.',
            detail: cleanupError,
          });
        }).finally(finalize);
        throw error;
      }
      try {
        if (!response.ok || !response.invocation) {
          finalize();
          throw new Error(response.error ?? 'ASRT workspace wrapping failed.');
        }
        try {
          throwIfWorkspacePreparationStopped(signal, deadlineAt);
        } catch (error: unknown) {
          try {
            await request('cleanup');
          } catch (cleanupError: unknown) {
            emitKodaXDiagnostic({
              source: 'sandbox:workspace-session',
              level: 'warn',
              message: 'Cancelled workspace sandbox preparation cleanup failed.',
              detail: cleanupError,
            });
          }
          finalize();
          throw error;
        }
        let released = false;
        return {
          invocation: response.invocation,
          async release() {
            if (released) return;
            released = true;
            try {
              const cleanup = await request('cleanup');
              if (!cleanup.ok) {
                throw new Error(cleanup.error ?? 'ASRT command cleanup failed.');
              }
            } finally {
              finalize();
            }
          },
        };
      } catch (error) {
        finalize();
        throw error;
      }
    },
    async close() {
      if (closePromise) return closePromise;
      closing = true;
      closePromise = (async () => {
        if (idleTimer) clearTimeout(idleTimer);
        if (exited) return;
        setWorkspaceSessionReferenced(child, true);
        if (activeLeases > 0) {
          await new Promise<void>((resolve) => { resolveDrained = resolve; });
        }
        if (exited) return;
        child.stdin.end();
        await childExit;
      })();
      return closePromise;
    },
  };
  scheduleIdleClose();
  return client;
}

async function getWorkspaceSession(
  workspaceRoot: string,
): Promise<WorkspaceSessionClient | undefined> {
  const doctor = await doctorSandboxRuntime();
  if (!doctor.ready) return undefined;
  const key = process.platform === 'win32'
    ? workspaceRoot.toLowerCase()
    : workspaceRoot;
  let session = workspaceSessions.get(key);
  if (!session) {
    session = startWorkspaceSessionClient(workspaceRoot, () => {
      if (workspaceSessions.get(key) === session) workspaceSessions.delete(key);
    });
    workspaceSessions.set(key, session);
    void session.catch(() => {
      if (workspaceSessions.get(key) === session) workspaceSessions.delete(key);
    });
  }
  return session;
}

/** Test-only cleanup for mocked or disposable workspace sessions. */
export async function resetAsrtWorkspaceSessionsForTest(): Promise<void> {
  const sessions = [...workspaceSessions.values()];
  workspaceSessions.clear();
  await Promise.allSettled(sessions.map(async (session) => (await session).close()));
}

/**
 * Runtime-owned broker for exact workspace shell calls admitted by Auto[LLM].
 * Non-admitted commands return undefined and preserve the existing execution
 * path, including user-approved operations that intentionally need more scope.
 */
export function createAsrtShellSandbox(
  input: CreateAsrtShellSandboxInput,
): KodaXShellSandbox {
  const workspaceRoot = path.resolve(input.workspaceRoot);
  void getWorkspaceSession(workspaceRoot).catch((error: unknown) => {
    emitKodaXDiagnostic({
      source: 'sandbox:workspace-session',
      level: 'warn',
      message: 'Workspace sandbox warm-up failed; commands will use normal permission fallback.',
      detail: error,
    });
  });
  return {
    async prepare(shellInput) {
      if (!shellInput.toolCallId) {
        shellInput.reportObservation?.({
          version: 1,
          state: 'not_selected',
        });
        return undefined;
      }
      const call: RunnerToolCall = {
        id: shellInput.toolCallId,
        name: 'bash',
        input: { ...shellInput.toolInput },
      };
      if (!input.shouldSandbox(call)) {
        shellInput.reportObservation?.({
          version: 1,
          state: 'not_selected',
        });
        return undefined;
      }
      let lease: WorkspaceSessionLease | undefined;
      try {
        const session = await waitForWorkspacePreparation(
          getWorkspaceSession(workspaceRoot),
          shellInput.signal,
          shellInput.deadlineAt,
        );
        if (!session) {
          shellInput.reportObservation?.({
            version: 1,
            state: 'fallback',
            reason: 'not_ready',
            execution: 'normal_permission_policy',
          });
          return undefined;
        }
        const executable = shellInput.executable
          ?? (process.platform === 'win32'
            ? process.env.COMSPEC ?? path.join(
              process.env.SystemRoot ?? 'C:\\Windows',
              'System32',
              'cmd.exe',
            )
            : '/bin/sh');
        const args = shellInput.args
          ?? (process.platform === 'win32'
            ? ['/d', '/s', '/c', shellInput.command]
            : ['-c', shellInput.command]);
        const controlDirectory = await sandboxControlDirectory();
        const requestFile = path.join(
          controlDirectory,
          `kodax-asrt-shell-${process.pid}-${randomUUID()}.json`,
        );
        const observationFile = path.join(
          controlDirectory,
          `kodax-asrt-observation-${process.pid}-${randomUUID()}.json`,
        );
        const env = { ...shellInput.env };
        const request: SandboxBrokerRequest = {
          config: workspaceShellSandboxConfig(workspaceRoot),
          command: executable,
          args,
          cwd: shellInput.cwd,
          env,
          endpoints: [],
          allowAllNetwork: true,
          bootstrapCommand: sandboxJavaScriptCommand(),
          fallbackToNormalExecution: true,
          observationBackend: sandboxRuntimeCapability().backend,
          observationFile,
          targetStartedMarker:
            `\0KODAX_ASRT_TARGET_STARTED:${randomUUID()}\0\n`,
        };
        const activeLease = await session.acquire(
          request,
          shellInput.signal,
          shellInput.deadlineAt,
        );
        lease = activeLease;
        const brokerRequest: SandboxBrokerRequest = {
          ...request,
          wrappedInvocation: activeLease.invocation,
        };
        const brokerArgs = process.env.KODAX_BUNDLED === 'true'
          ? ['__asrt-broker', requestFile]
          : ['--input-type=module', '-e', BROKER_SOURCE, ASRT_MODULE_URL!, requestFile];
        const launch = prepareInternalNodeLaunch({
          args: brokerArgs,
          env: sanitizedEnvironment(),
          isElectron: process.versions.electron !== undefined,
        });
        await writeFile(requestFile, JSON.stringify(brokerRequest), { mode: 0o600 });
        return {
          executable: process.execPath,
          args: launch.args,
          env: launch.env,
          async cleanup() {
            let observation: KodaXShellSandboxObservation | undefined;
            try {
              observation = await readFile(observationFile, 'utf8')
                .then(parseBrokerObservation)
                .catch((error: NodeJS.ErrnoException) => {
                  if (error.code === 'ENOENT') return undefined;
                  throw error;
                });
            } finally {
              await Promise.all([
                rm(requestFile, { force: true }),
                rm(observationFile, { force: true }),
              ]);
              try {
                await activeLease.release();
              } catch (error: unknown) {
                emitKodaXDiagnostic({
                  source: 'sandbox:workspace-session',
                  level: 'warn',
                  message: 'Workspace sandbox command cleanup failed.',
                  detail: error,
                });
              }
            }
            return observation;
          },
        };
      } catch (error: unknown) {
        if (lease) await lease.release().catch((releaseError: unknown) => {
          emitKodaXDiagnostic({
            source: 'sandbox:workspace-session',
            level: 'warn',
            message: 'Workspace sandbox lease release failed.',
            detail: releaseError,
          });
        });
        if (
          shellInput.signal?.aborted
          || (
            shellInput.deadlineAt !== undefined
            && Date.now() >= shellInput.deadlineAt
          )
        ) {
          throw error;
        }
        emitKodaXDiagnostic({
          source: 'sandbox:workspace-session',
          level: 'warn',
          message: 'Workspace sandbox preparation failed; using normal permission fallback.',
          detail: error,
        });
        shellInput.reportObservation?.({
          version: 1,
          state: 'fallback',
          reason: 'prepare_failed',
          execution: 'normal_permission_policy',
        });
        return undefined;
      }
    },
  };
}

export async function createAsrtSkillScriptRunner(input: CreateSkillScriptRunnerInput): Promise<KodaXSkillScriptRunner> {
  const doctor = await doctorSandboxRuntime();
  if (!doctor.ready) throw new Error(`ASRT ${KODAX_ASRT_VERSION} is not ready: ${doctor.diagnostics.join(' ') || 'run kodax sandbox setup'}`);
  const runnerRoot = path.join(input.snapshotRoot, randomUUID());
  const snapshotRoot = path.join(runnerRoot, 'skills');
  await mkdir(snapshotRoot, { recursive: true, mode: 0o700 });
  try {
    const scripts = await snapshotAdmissions(input, snapshotRoot);
    const endpoints = networkEndpoints(input.network);
    let previousRun = Promise.resolve();
    return {
      async run(runInput, context) {
        const waitForPrevious = previousRun;
        let releaseRun: (() => void) | undefined;
        previousRun = new Promise<void>((resolve) => { releaseRun = resolve; });
        await waitForPrevious;
        if (context.signal?.aborted) {
          releaseRun?.();
          throw context.signal.reason ?? new Error('Sandboxed Skill script was cancelled.');
        }
        try {
          if (runInput.args.length > 64 || runInput.args.some((arg) => arg.length > 8_192)) {
            throw new Error('Skill script arguments exceed the bounded remote contract.');
          }
          if (runInput.inputs.length > 32 || runInput.outputs.length > 32) {
            throw new Error('Skill script file mappings exceed the bounded remote contract.');
          }
          const relative = canonicalRelative(runInput.script, 'Skill script');
          const admitted = scripts.get(`${runInput.skill}\0${relative}`);
          if (!admitted) throw new Error('Skill script is not admitted by this Runtime binding.');
          if (['.cmd', '.bat'].includes(path.extname(admitted.snapshotPath).toLowerCase())
            && runInput.args.some((arg) => /[&|<>^]/.test(arg))) {
            throw new Error('Batch Skill script arguments cannot contain command operators.');
          }
          const stage = path.join(context.workspaceRoot, '.kodax-a2a-script', randomUUID());
          try {
            await mkdir(path.join(stage, 'inputs'), { recursive: true, mode: 0o700 });
            await mkdir(path.join(stage, 'outputs'), { recursive: true, mode: 0o700 });
            await stageInputFiles(context.workspaceRoot, stage, runInput, input.workspaceAccess);
            const interpreter = interpreterFor(admitted.snapshotPath);
            const stdout = await runBroker({
              config: sandboxConfig(stage, runnerRoot, endpoints, interpreter.command),
              command: interpreter.command,
              args: [...interpreter.args, ...runInput.args],
              cwd: stage,
              env: sanitizedEnvironment(),
              endpoints,
            }, context.signal);
            const outputs = await promoteOutputs(
              context.workspaceRoot,
              stage,
              runInput,
              input.workspaceAccess,
              input.workspaceByteLimit,
            );
            return JSON.stringify({ stdout: stdout.trim(), outputs });
          } finally {
            await rm(stage, { recursive: true, force: true });
          }
        } finally {
          releaseRun?.();
        }
      },
      async dispose() {
        await previousRun;
        await rm(runnerRoot, { recursive: true, force: true });
      },
    };
  } catch (error: unknown) {
    await rm(runnerRoot, { recursive: true, force: true });
    throw error;
  }
}

function withWindowsSandboxChildEnvironment(
  argv: readonly string[],
  environment: Readonly<NodeJS.ProcessEnv>,
): string[] {
  const separator = argv.lastIndexOf('--');
  if (separator < 0) throw new Error('ASRT Windows wrapper omitted its child separator.');
  const controlled = new Set<string>();
  for (let index = 0; index < separator - 1; index += 1) {
    if (argv[index] !== '--env') continue;
    const name = argv[index + 1]?.split('=', 1)[0];
    if (name) controlled.add(name.toLowerCase());
  }
  const injected: string[] = [];
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined) continue;
    if (!name || name.includes('=') || name.includes('\0') || value.includes('\0')) {
      throw new Error('Invalid environment entry for ASRT Windows child.');
    }
    const normalized = name.toLowerCase();
    if (
      controlled.has(normalized)
      && normalized !== 'path'
      && normalized !== 'pathext'
    ) continue;
    injected.push('--env', `${name}=${value}`);
  }
  const result = [...argv.slice(0, separator), ...injected, ...argv.slice(separator)];
  const estimate = result.reduce((size, value) => size + value.length + 3, 0);
  if (estimate > 30_000) {
    throw new Error(
      'ASRT Windows child environment exceeds the CreateProcess command-line limit.',
    );
  }
  return result;
}

async function wrapSandboxTarget(
  request: SandboxBrokerRequest,
  targetStartedMarker: string,
): Promise<NonNullable<SandboxBrokerRequest['wrappedInvocation']>> {
  const bootstrapCommand = request.bootstrapCommand ?? sandboxJavaScriptCommand();
  const bootstrapIsElectronNode = (
    bootstrapCommand === process.execPath
    && process.versions.electron !== undefined
  );
  const internalElectronNode = (
    request.command === process.execPath
    && process.versions.electron !== undefined
  );
  const childArgs = internalElectronNode
    ? ['--import', ELECTRON_NODE_ENV_SCRUB_IMPORT, ...request.args]
    : request.args;
  const requestedEnv = internalElectronNode || bootstrapIsElectronNode
    ? { ...request.env, [ELECTRON_RUN_AS_NODE_ENV]: '1' }
    : request.env;
  const quote = (value: string): string => process.platform === 'win32'
    ? `"${value.replaceAll('"', '""')}"`
    : `'${value.replaceAll("'", `'"'"'`)}'`;
  const command = [
    quote(bootstrapCommand),
    '-e',
    quote(TARGET_ARGV_LOADER),
    TARGET_ARGV_BOOTSTRAP_BASE64,
    Buffer.from(JSON.stringify({
      command: request.command,
      args: childArgs,
      cwd: request.cwd,
      targetStartedMarker,
    }), 'utf8').toString('base64'),
  ].join(' ');
  if (process.platform === 'win32') {
    // Windows supports per-exec denies but not grants. Empty grant arrays keep
    // the session's workspace/PATH grants while the command receives all denies.
    const perExecConfig = {
      filesystem: {
        denyRead: request.config.filesystem.denyRead,
        allowRead: [],
        allowWrite: [],
        denyWrite: request.config.filesystem.denyWrite,
      },
    } satisfies Partial<SandboxRuntimeConfig>;
    const wrapped = await SandboxManager.wrapWithSandboxArgv(
      command,
      'cmd',
      perExecConfig,
      undefined,
      request.cwd,
    );
    const argv = withWindowsSandboxChildEnvironment(wrapped.argv, requestedEnv);
    return {
      executable: argv[0]!,
      args: argv.slice(1),
      env: wrapped.env,
      shell: false,
    };
  }
  return {
    executable: await SandboxManager.wrapWithSandbox(command),
    args: [],
    env: requestedEnv,
    shell: true,
  };
}

async function writeBrokerObservation(
  request: SandboxBrokerRequest,
  observation: KodaXShellSandboxObservation,
): Promise<void> {
  if (request.observationFile === undefined) return;
  await writeFile(
    request.observationFile,
    JSON.stringify(observation),
    { mode: 0o600 },
  );
}

interface SandboxedBrokerChildResult {
  readonly exitCode: number;
  readonly targetStarted: boolean;
  readonly diagnostic?: string;
}

function waitForSandboxedBrokerTarget(
  child: ReturnType<typeof spawn>,
  request: SandboxBrokerRequest,
  targetStartedMarker: string,
): Promise<SandboxedBrokerChildResult> {
  const marker = Buffer.from(targetStartedMarker, 'utf8');
  const stderr = child.stderr;
  if (stderr === null) {
    throw new Error('ASRT wrapper stderr attestation pipe was not created.');
  }
  let pending = Buffer.alloc(0);
  let diagnostic = Buffer.alloc(0);
  let processError: string | undefined;
  let targetStarted = false;
  let observationWrite = Promise.resolve();
  return new Promise<SandboxedBrokerChildResult>((resolve) => {
    let settled = false;
    const finish = (result: SandboxedBrokerChildResult): void => {
      if (settled) return;
      settled = true;
      void observationWrite.then(() => resolve(result));
    };
    stderr.on('data', (chunk: Buffer) => {
      if (targetStarted) {
        process.stderr.write(chunk);
        return;
      }
      pending = Buffer.concat([pending, chunk]);
      const markerOffset = pending.indexOf(marker);
      if (markerOffset >= 0) {
        targetStarted = true;
        const suffix = pending.subarray(markerOffset + marker.length);
        pending = Buffer.alloc(0);
        diagnostic = Buffer.alloc(0);
        observationWrite = writeBrokerObservation(request, {
          version: 1,
          state: 'applied',
          backend: request.observationBackend ?? 'unsupported',
          policyId: 'kodax-workspace-shell-v1',
        }).catch(() => undefined);
        if (suffix.length > 0) process.stderr.write(suffix);
        return;
      }
      const retained = Math.max(0, marker.length - 1);
      if (pending.length > retained) {
        diagnostic = Buffer.concat([
          diagnostic,
          pending.subarray(0, pending.length - retained),
        ]).subarray(-65_536);
        pending = pending.subarray(pending.length - retained);
      }
    });
    child.once('error', (error: Error) => {
      processError = error.message;
    });
    child.once('close', (code, signal) => {
      const preTarget = Buffer.concat([diagnostic, pending]).toString('utf8').trim();
      finish({
        exitCode: signal ? 1 : code ?? 1,
        targetStarted,
        ...(preTarget || processError
          ? { diagnostic: preTarget || processError }
          : {}),
      });
    });
  });
}

async function resetSandboxManagerBestEffort(): Promise<void> {
  try {
    SandboxManager.cleanupAfterCommand();
  } catch {
    // Cleanup diagnostics must not alter an already completed user command.
  }
  await SandboxManager.reset().catch(() => undefined);
}

async function runNormalBrokerProcess(
  request: SandboxBrokerRequest,
): Promise<number> {
  const internalElectronNode = (
    request.command === process.execPath
    && process.versions.electron !== undefined
  );
  const args = internalElectronNode
    ? ['--import', ELECTRON_NODE_ENV_SCRUB_IMPORT, ...request.args]
    : request.args;
  const env = internalElectronNode
    ? { ...request.env, [ELECTRON_RUN_AS_NODE_ENV]: '1' }
    : request.env;
  const child = spawn(request.command, args, {
    cwd: request.cwd,
    env,
    shell: false,
    stdio: 'inherit',
    windowsHide: true,
  });
  return new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(signal ? 1 : code ?? 1));
  });
}

/** Internal entry used only by the standalone binary's isolated broker process. */
export async function runAsrtBrokerProcess(requestFile: string): Promise<number> {
  let request: SandboxBrokerRequest | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  let targetStarted = false;
  let normalFallbackAttempted = false;
  try {
    request = JSON.parse(await readFile(requestFile, 'utf8')) as SandboxBrokerRequest;
    await rm(requestFile, { force: true });
    const targetStartedMarker = request.targetStartedMarker
      ?? `\0KODAX_ASRT_TARGET_STARTED:${randomUUID()}\0\n`;
    if (request.wrappedInvocation === undefined) {
      const endpoints = new Set(
        request.endpoints.map((item) => `${item.host.toLowerCase()}:${item.port}`),
      );
      const callback: SandboxAskCallback | undefined = request.allowAllNetwork === true
        ? async () => true
        : request.endpoints.length === 0
          ? undefined
          : async ({ host, port }) => (
              port !== undefined && endpoints.has(`${host.toLowerCase()}:${port}`)
            );
      await SandboxManager.initialize(request.config, callback);
    }
    const wrapped = request.wrappedInvocation
      ?? await wrapSandboxTarget(request, targetStartedMarker);
    child = spawn(wrapped.executable, [...wrapped.args], {
      cwd: request.cwd,
      env: wrapped.env,
      shell: wrapped.shell,
      stdio: ['inherit', 'inherit', 'pipe'],
      windowsHide: true,
    });
    const stop = (): void => { child?.kill('SIGTERM'); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    const result = await waitForSandboxedBrokerTarget(
      child,
      request,
      targetStartedMarker,
    );
    targetStarted = result.targetStarted;
    if (request.fallbackToNormalExecution === true && !targetStarted) {
      if (request.wrappedInvocation === undefined) {
        await resetSandboxManagerBestEffort();
      }
      await writeBrokerObservation(request, {
        version: 1,
        state: 'fallback',
        reason: 'backend_failed',
        execution: 'normal_permission_policy',
      }).catch(() => undefined);
      normalFallbackAttempted = true;
      return await runNormalBrokerProcess(request);
    }
    if (!targetStarted && result.diagnostic !== undefined) {
      process.stderr.write(`${result.diagnostic}\n`);
    }
    return result.exitCode;
  } catch (error: unknown) {
    if (
      request?.fallbackToNormalExecution === true
      && !targetStarted
      && !normalFallbackAttempted
    ) {
      if (request.wrappedInvocation === undefined) {
        await resetSandboxManagerBestEffort();
      }
      try {
        await writeBrokerObservation(request, {
          version: 1,
          state: 'fallback',
          reason: 'backend_failed',
          execution: 'normal_permission_policy',
        }).catch(() => undefined);
        normalFallbackAttempted = true;
        return await runNormalBrokerProcess(request);
      } catch (fallbackError: unknown) {
        process.stderr.write(`${errorText(fallbackError)}\n`);
        return 1;
      }
    }
    process.stderr.write(`${errorText(error)}\n`);
    return 1;
  } finally {
    if (request?.wrappedInvocation === undefined) {
      await resetSandboxManagerBestEffort();
    }
  }
}

interface WorkspaceSessionCommand {
  readonly id: string;
  readonly type: 'wrap' | 'cleanup';
  readonly request?: SandboxBrokerRequest;
}

function writeWorkspaceSessionResponse(response: WorkspaceSessionResponse): void {
  writeSync(3, `${JSON.stringify(response)}\n`);
}

/** Internal long-lived owner for one workspace's ASRT ACL/WFP session. */
export async function runAsrtWorkspaceSessionProcess(
  initFile: string,
): Promise<number> {
  try {
    const init = JSON.parse(await readFile(initFile, 'utf8')) as {
      readonly config: SandboxRuntimeConfig;
    };
    await rm(initFile, { force: true });
    await SandboxManager.initialize(init.config, async () => true);
    writeWorkspaceSessionResponse({ type: 'ready', ok: true });
    const lines = readline.createInterface({ input: process.stdin });
    let previous = Promise.resolve();
    for await (const line of lines) {
      const command = JSON.parse(line) as WorkspaceSessionCommand;
      previous = previous.then(async () => {
        try {
          if (command.type === 'cleanup') {
            SandboxManager.cleanupAfterCommand();
            writeWorkspaceSessionResponse({
              id: command.id,
              type: 'result',
              ok: true,
            });
            return;
          }
          if (!command.request) throw new Error('Missing workspace wrap request.');
          const marker = command.request.targetStartedMarker
            ?? `\0KODAX_ASRT_TARGET_STARTED:${randomUUID()}\0\n`;
          const invocation = await wrapSandboxTarget(command.request, marker);
          writeWorkspaceSessionResponse({
            id: command.id,
            type: 'result',
            ok: true,
            invocation,
          });
        } catch (error: unknown) {
          writeWorkspaceSessionResponse({
            id: command.id,
            type: 'result',
            ok: false,
            error: errorText(error),
          });
        }
      });
    }
    await previous;
    await resetSandboxManagerBestEffort();
    return 0;
  } catch (error: unknown) {
    try {
      writeWorkspaceSessionResponse({
        type: 'ready',
        ok: false,
        error: errorText(error),
      });
    } catch (responseError: unknown) {
      process.stderr.write(
        `ASRT workspace session could not report startup failure: ${errorText(responseError)}\n`,
      );
    }
    await resetSandboxManagerBestEffort();
    return 1;
  }
}
