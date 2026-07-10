#!/usr/bin/env node

// ── Runtime environment defaults ──
// NODE_ENV must be set BEFORE any ESM static import is evaluated, otherwise
// React loads its development reconciler (~100 MB/turn profiling leak).
// This is handled by the CJS shim/preload upstream of this file:
//   - bin entry:        scripts/kodax-bin.cjs requires production-env.cjs
//                       then dynamic-imports this module (ESM)
//   - npm run dev/start: --require ./scripts/production-env.cjs flag
// The inline fallback below only covers `node dist/kodax_cli.js` invoked
// directly; in that path we cannot guarantee React is still in production
// mode, but setting NODE_ENV here keeps downstream NODE_ENV checks sane.
const nodeEnvKey = ['NODE', 'ENV'].join('_') as 'NODE_ENV';
if (!process.env[nodeEnvKey]) {
  process.env[nodeEnvKey] = process.env.KODAX_DEV === '1' ? 'development' : 'production';
}

// Propagate a sensible V8 heap limit to child processes (sub-agents, forks).
// The main process heap limit is set via --max-old-space-size in the
// package.json scripts or shell wrapper. NODE_OPTIONS set here at runtime
// only affects children. Default 4 GB; override via KODAX_HEAP_LIMIT.
if (
  !process.execArgv.some(a => a.includes('max-old-space-size'))
  && !process.env.NODE_OPTIONS?.includes('max-old-space-size')
) {
  const limit = process.env.KODAX_HEAP_LIMIT ?? '4096';
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --max-old-space-size=${limit}`.trim();
}

/**
 * KodaX CLI — Command-line entry point.
 * UI module: Ink-based interactive REPL with managed task lifecycle.
 */
import { Command } from 'commander';
import chalk from 'chalk';
import { spawn } from 'node:child_process';
import fs from 'fs/promises';
import fsSync from 'fs';
import os from 'node:os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { runAcpServer } from './acp_server.js';
import { createKodaXRuntime, type KodaXRuntime } from './sdk-runtime.js';
import {
  isRuntimeDaemonPidAlive,
  observeRuntimeDaemonHealth,
  runtimeDaemonEndpointFromState,
} from './runtime-daemon/lifecycle.js';
import {
  classifyRuntimeDaemonHealth,
  readRuntimeDaemonLockOwner,
  readRuntimeDaemonToken,
  removeRuntimeDaemonOwnershipFiles,
  resolveRuntimeDaemonPaths,
  type RuntimeDaemonHealth,
  type RuntimeDaemonState,
} from './runtime-daemon/state.js';
import { createRuntimeDaemonSocketClientTransport } from './runtime-daemon/transport.js';
import { runDoctor } from './kodax_doctor.js';
import {
  getDefaultCommandDir,
  KODAX_COMMANDS_DIR,
  loadCommands,
  parseCommandCall,
  processCommandCall,
  type KodaXCommand,
  type KodaXCommandContext,
} from './cli_commands.js';
import {
  ACP_PERMISSION_MODES,
  createKodaXOptions,
  parseAgentModeOption,
  parseEffortOption,
  parseOptionalNonNegativeInt,
  parseOutputModeOption,
  parsePermissionModeOption,
  parseReasoningModeOption,
  parseRepoIntelligenceModeOption,
  parseRuntimeModeOption,
  normalizeCliSessionFlags,
  resolveCliAgentMode,
  resolveCliEffort,
  resolveCliModelSelection,
  resolveCliReasoningMode,
  type CliOutputMode,
  type CliOptions,
  type CliRuntimeMode,
  validateCliModeSelection,
} from './cli_option_helpers.js';
import { runSkillCreatorTool } from './skill_cli.js';

// Read the CLI version from the binary build define first, then package.json.
const packageJsonPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../package.json');
const version = process.env.KODAX_VERSION ?? (fsSync.existsSync(packageJsonPath)
  ? JSON.parse(fsSync.readFileSync(packageJsonPath, 'utf-8')).version
  : '0.0.0');

import {
  runKodaX,
  runManagedTask,
  KodaXClient,
  KodaXEvents,
  type KodaXOptions,
  KodaXReasoningMode,
  createExtensionRuntime,
  dedupeExtensionPathsByEntrypoint,
  discoverDefaultExtensions,
  excludeExtensionPathsByEntrypoint,
  registerConfiguredMcpCapabilityProvider,
  buildMcpReverseCapabilities,
  KODAX_DEFAULT_PROVIDER,
  checkPromiseSignal,
  getProvider,
  getAvailableProviderNames,
  KODAX_TOOLS,
  KodaXTerminalError,
  bootstrapTracing,
  shutdownDefaultLspService,
} from '@kodax-ai/coding';
import {
  cleanupRegisteredManagedChildren,
  shutdownTracing,
  applyProcessHardening,
} from '@kodax-ai/agent';
import {
  getGitRoot,
  loadConfig,
  prepareRuntimeConfig,
  FileSessionStorage,
  dedupeSessions,
  KODAX_CONFIG_FILE,
  ensureExampleConfigFile,
  resolveInteractiveSurfacePreference,
  runInteractiveMode,
  runInkInteractiveMode,
  type SessionDedupeReport,
} from '@kodax-ai/repl';
import type { AcpPermissionMode } from './acp_server.js';
export {
  ACP_PERMISSION_MODES,
  getDefaultCommandDir,
  KODAX_COMMANDS_DIR,
  loadCommands,
  parseCommandCall,
  parseAgentModeOption,
  parsePermissionModeOption,
  parseReasoningModeOption,
  parseRepoIntelligenceModeOption,
  parseRuntimeModeOption,
  processCommandCall,
  resolveCliAgentMode,
};
export type { KodaXCommand, KodaXCommandContext };

function hasConfiguredMcpServers(config: { mcpServers?: Record<string, { connect?: string }> }): boolean {
  return Object.values(config.mcpServers ?? {}).some(
    (server) => (server.connect ?? 'lazy') !== 'disabled',
  );
}

function resolveCliRuntimeMode(value: CliRuntimeMode | undefined): CliRuntimeMode {
  if (value !== undefined) return value;
  const fromEnv = process.env.KODAX_RUNTIME_MODE?.trim();
  if (!fromEnv) return 'embedded';
  return parseRuntimeModeOption(fromEnv);
}

function resolveDefaultRuntimeDaemonHomeDir(): string {
  return os.homedir();
}

async function discoverCliDefaultExtensions(): Promise<string[]> {
  try {
    return await discoverDefaultExtensions();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(chalk.yellow('[extensions] Failed to discover default extensions: ' + message));
    return [];
  }
}

function printSessionDedupeReport(report: SessionDedupeReport, applied: boolean): void {
  const action = applied ? 'Applied' : 'Dry run';
  console.log(chalk.cyan(`\nSession dedupe ${action}\n`));
  console.log(`Scanned: ${report.scanned}`);
  console.log(`Runner candidates: ${report.runnerCandidates}`);
  console.log(`Matched: ${report.matches.length}`);
  console.log(`Moved: ${report.moved.length}`);
  if (report.archiveDir) {
    console.log(`Archive: ${report.archiveDir}`);
  }

  if (report.matches.length > 0) {
    console.log(chalk.bold('\nMatches:'));
    for (const match of report.matches) {
      const marker = report.moved.some((move) => move.runnerId === match.runnerId)
        ? 'moved'
        : 'candidate';
      console.log(`  ${match.runnerId} -> ${match.canonicalId} (${marker}, score=${match.score})`);
    }
  }

  if (report.skipped.length > 0) {
    const reasonCounts = new Map<string, number>();
    for (const skipped of report.skipped) {
      reasonCounts.set(skipped.reason, (reasonCounts.get(skipped.reason) ?? 0) + 1);
    }
    console.log(chalk.bold('\nSkipped:'));
    for (const [reason, count] of reasonCounts.entries()) {
      console.log(`  ${reason}: ${count}`);
    }
  }

  if (!applied) {
    console.log(chalk.dim('\nRun `kodax sessions dedupe --apply` to move uniquely matched runner ghosts.'));
  }
}

interface DaemonStartResult {
  readonly started: boolean;
  readonly reason?: 'already_running';
  readonly pid?: number | null;
  readonly health?: RuntimeDaemonHealth;
  readonly state: RuntimeDaemonState | null;
}

interface DaemonStopResult {
  readonly stopped: boolean;
  readonly reason?: RuntimeDaemonHealth | 'unverified_owner';
  readonly forced?: boolean;
  readonly health?: RuntimeDaemonHealth;
  readonly state: RuntimeDaemonState | null;
}

interface DaemonRestartResult {
  readonly restarted: boolean;
  readonly stop: DaemonStopResult;
  readonly start: DaemonStartResult;
}

interface DaemonLogsResult {
  readonly profile: string;
  readonly logFile: string;
  readonly exists: boolean;
  readonly lines: readonly string[];
}

interface DaemonRuntimeStatusSummary {
  readonly sessions: number;
  readonly runs: number;
  readonly activeRuns: number;
  readonly queuedRuns: number;
  readonly pendingPermissions: number;
  readonly workflows: number;
}

type DaemonRuntimeStatusProbe =
  | { readonly ok: true; readonly summary: DaemonRuntimeStatusSummary }
  | { readonly ok: false; readonly error: string };

interface CliRuntimeSurfaceStatus {
  readonly mode: 'embedded' | 'daemon';
  readonly runtimeId: string;
  readonly profile: string;
  readonly startedAt?: string;
  readonly endpoint?: string;
  readonly health?: string;
  readonly sessions?: number;
  readonly runs?: number;
  readonly activeRuns?: number;
  readonly queuedRuns?: number;
  readonly pendingPermissions?: number;
  readonly workflows?: number;
}

async function printDaemonStatus(input: {
  readonly profile: string;
  readonly homeDir: string;
  readonly json: boolean;
}): Promise<void> {
  const paths = resolveRuntimeDaemonPaths(input.homeDir, input.profile);
  const observation = await observeRuntimeDaemonHealth(paths);
  const health = classifyRuntimeDaemonHealth(observation);
  const runtimeStatus = await readDaemonRuntimeStatusSummary(paths, observation.state, health);
  const snapshot = {
    profile: paths.profile,
    health,
    state: observation.state ?? null,
    pidAlive: observation.pidAlive,
    endpointReachable: observation.endpointReachable,
    identityMatches: observation.identityMatches,
    stateFile: paths.stateFile,
    lockFile: paths.lockFile,
    ...(runtimeStatus !== null ? { runtime: runtimeStatus } : {}),
  };
  if (input.json) {
    console.log(JSON.stringify(snapshot, null, 2));
    return;
  }
  console.log(chalk.cyan('\nKodaX Runtime Daemon\n'));
  console.log(`Profile: ${snapshot.profile}`);
  console.log(`Health: ${formatDaemonHealth(health)}`);
  console.log(`State: ${snapshot.state ? snapshot.state.status : 'missing'}`);
  if (snapshot.state) {
    console.log(`Runtime: ${snapshot.state.runtimeId}`);
    console.log(`PID: ${snapshot.state.pid} (${snapshot.pidAlive ? 'alive' : 'not alive'})`);
    console.log(`Endpoint: ${snapshot.state.endpoint} (${snapshot.endpointReachable ? 'reachable' : 'unreachable'})`);
  }
  if (runtimeStatus?.ok === true) {
    console.log(`Sessions: ${runtimeStatus.summary.sessions}`);
    console.log(`Runs: ${runtimeStatus.summary.runs} (${runtimeStatus.summary.activeRuns} active, ${runtimeStatus.summary.queuedRuns} queued)`);
    console.log(`Pending permissions: ${runtimeStatus.summary.pendingPermissions}`);
    console.log(`Workflows: ${runtimeStatus.summary.workflows}`);
  } else if (runtimeStatus?.ok === false) {
    console.log(chalk.yellow(`Runtime status: unavailable (${runtimeStatus.error})`));
  }
  console.log(chalk.dim(`State file: ${snapshot.stateFile}`));
}

async function readDaemonRuntimeStatusSummary(
  paths: ReturnType<typeof resolveRuntimeDaemonPaths>,
  state: RuntimeDaemonState | undefined,
  health: RuntimeDaemonHealth,
): Promise<DaemonRuntimeStatusProbe | null> {
  if (health !== 'healthy' || state === undefined) return null;
  const transport = await createRuntimeDaemonSocketClientTransport(
    runtimeDaemonEndpointFromState(state),
    { connectTimeoutMs: 1_000 },
  );
  try {
    const token = readRuntimeDaemonToken(paths);
    await transport.request('initialize', {
      profile: paths.profile,
      ...(token !== undefined ? { token } : {}),
      clientInfo: { name: 'kodax-cli', title: 'KodaX CLI' },
      capabilities: { configAdmin: true },
    });
    return {
      ok: true,
      summary: summarizeDaemonRuntimeStatus(await transport.request('daemon.status')),
    };
  } catch (error: unknown) {
    return {
      ok: false,
      error: normalizeCliError(error).message,
    };
  } finally {
    await transport.close?.();
  }
}

function summarizeDaemonRuntimeStatus(value: unknown): DaemonRuntimeStatusSummary {
  const record = isRecord(value) ? value : {};
  const runs = Array.isArray(record.runs) ? record.runs : [];
  return {
    sessions: arrayLength(record.sessions),
    runs: runs.length,
    activeRuns: runs.filter(isActiveDaemonRunStatus).length,
    queuedRuns: runs.filter(isQueuedDaemonRunStatus).length,
    pendingPermissions: arrayLength(record.pendingPermissions),
    workflows: arrayLength(record.workflows),
  };
}

async function getInteractiveRuntimeStatus(input: {
  readonly runtime: KodaXRuntime;
  readonly homeDir: string;
  readonly profile: string;
}): Promise<CliRuntimeSurfaceStatus> {
  const snapshot = await input.runtime.status.snapshot();
  let endpoint: string | undefined;
  let health: string | undefined;
  if (input.runtime.identity.mode === 'daemon') {
    const paths = resolveRuntimeDaemonPaths(input.homeDir, input.profile);
    const observation = await observeRuntimeDaemonHealth(paths);
    health = classifyRuntimeDaemonHealth(observation);
    endpoint = observation.state?.endpoint;
  }
  const runs = snapshot.runs as readonly unknown[];
  return {
    mode: input.runtime.identity.mode,
    runtimeId: input.runtime.identity.runtimeId,
    profile: input.runtime.identity.profile,
    startedAt: input.runtime.identity.startedAt,
    ...(endpoint !== undefined ? { endpoint } : {}),
    ...(health !== undefined ? { health } : {}),
    sessions: snapshot.sessions.length,
    runs: snapshot.runs.length,
    activeRuns: runs.filter(isActiveDaemonRunStatus).length,
    queuedRuns: runs.filter(isQueuedDaemonRunStatus).length,
    pendingPermissions: snapshot.pendingPermissions.length,
    workflows: snapshot.workflows.length,
  };
}

function isActiveDaemonRunStatus(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return value.phase === 'running'
    || value.phase === 'waiting_permission'
    || value.phase === 'waiting_user_input';
}

function isQueuedDaemonRunStatus(value: unknown): boolean {
  return isRecord(value) && value.phase === 'queued';
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

async function startDaemonCommand(input: {
  readonly profile: string;
  readonly homeDir: string;
  readonly provider?: string;
  readonly model?: string;
  readonly timeoutMs: number;
  readonly json: boolean;
}): Promise<void> {
  const paths = resolveRuntimeDaemonPaths(input.homeDir, input.profile);
  const result = await getDaemonStartResult(input);
  if (input.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (result.reason === 'already_running') {
    console.log(chalk.green(`KodaX runtime daemon already running for profile "${paths.profile}".`));
    return;
  }
  if (result.health !== 'healthy') {
    throw new Error(`KodaX runtime daemon did not become healthy within ${input.timeoutMs}ms.`);
  }
  console.log(chalk.green(`KodaX runtime daemon started for profile "${paths.profile}".`));
  if (result.state) {
    console.log(chalk.dim(`PID: ${result.state.pid}`));
    console.log(chalk.dim(`Endpoint: ${result.state.endpoint}`));
  }
}

async function getDaemonStartResult(input: {
  readonly profile: string;
  readonly homeDir: string;
  readonly provider?: string;
  readonly model?: string;
  readonly timeoutMs: number;
}): Promise<DaemonStartResult> {
  const paths = resolveRuntimeDaemonPaths(input.homeDir, input.profile);
  const before = await observeRuntimeDaemonHealth(paths);
  const beforeHealth = classifyRuntimeDaemonHealth(before);
  if (beforeHealth === 'healthy') {
    return {
      started: false,
      reason: 'already_running',
      state: before.state ?? null,
    };
  }

  const child = spawnDaemonServeProcess({
    profile: paths.profile,
    homeDir: input.homeDir,
    provider: input.provider,
    model: input.model,
  });
  const observation = await waitForDaemonHealth(paths, input.timeoutMs);
  const health = classifyRuntimeDaemonHealth(observation);
  return {
    started: health === 'healthy',
    pid: child.pid ?? null,
    health,
    state: observation.state ?? null,
  };
}

async function serveDaemonCommand(input: {
  readonly profile: string;
  readonly homeDir: string;
  readonly provider?: string;
  readonly model?: string;
}): Promise<void> {
  const runtime = await createKodaXRuntime({
    mode: 'daemon',
    profile: input.profile,
    homeDir: input.homeDir,
    sessionsDir: path.join(input.homeDir, '.kodax', 'sessions'),
    autoStartDaemon: true,
    defaultProvider: input.provider,
    defaultModel: input.model,
  });
  const paths = resolveRuntimeDaemonPaths(input.homeDir, input.profile);
  const observation = await observeRuntimeDaemonHealth(paths);
  if (observation.state && observation.state.pid !== process.pid) {
    await runtime.close();
    console.log(chalk.yellow(`KodaX runtime daemon already owned by PID ${observation.state.pid}.`));
    return;
  }

  await waitForShutdownSignal(async () => {
    await runtime.close();
  });
}

async function stopDaemonCommand(input: {
  readonly profile: string;
  readonly homeDir: string;
  readonly timeoutMs: number;
  readonly force: boolean;
  readonly json: boolean;
}): Promise<void> {
  const paths = resolveRuntimeDaemonPaths(input.homeDir, input.profile);
  const result = await getDaemonStopResult(input);
  if (input.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (result.reason === 'unverified_owner') {
    throw new Error(
      `Refusing to force stop daemon profile "${paths.profile}" because ownership could not be verified.`,
    );
  }
  if (result.reason !== undefined) {
    console.log(chalk.yellow(`No healthy KodaX runtime daemon for profile "${paths.profile}" (${result.reason}).`));
    return;
  }
  if (!result.stopped) {
    throw new Error(`KodaX runtime daemon did not stop within ${input.timeoutMs}ms.`);
  }
  console.log(chalk.green(`KodaX runtime daemon stopped for profile "${paths.profile}".`));
}

async function getDaemonStopResult(input: {
  readonly profile: string;
  readonly homeDir: string;
  readonly timeoutMs: number;
  readonly force?: boolean;
}): Promise<DaemonStopResult> {
  const deadline = Date.now() + input.timeoutMs;
  const paths = resolveRuntimeDaemonPaths(input.homeDir, input.profile);
  const observation = await observeRuntimeDaemonHealth(paths);
  const health = classifyRuntimeDaemonHealth(observation);
  if (health !== 'healthy' || !observation.state) {
    if (input.force === true) {
      return forceStopDaemonOwnership(paths, health, observation.state ?? null);
    }
    return {
      stopped: false,
      reason: health,
      state: observation.state ?? null,
    };
  }

  const endpoint = runtimeDaemonEndpointFromState(observation.state);
  const transport = await createRuntimeDaemonSocketClientTransport(endpoint, {
    connectTimeoutMs: input.timeoutMs,
  });
  try {
    const token = readRuntimeDaemonToken(paths);
    await transport.request('initialize', {
      profile: paths.profile,
      ...(token !== undefined ? { token } : {}),
      clientInfo: { name: 'kodax-cli', title: 'KodaX CLI' },
      capabilities: { configAdmin: true },
    });
    await transport.request('daemon.stop');
  } finally {
    await transport.close?.();
  }
  const after = await waitForDaemonStopped(paths, input.timeoutMs);
  const afterHealth = classifyRuntimeDaemonHealth(after);
  const processExited = afterHealth !== 'healthy'
    && await waitForDaemonProcessExit(
      observation.state.pid,
      Math.max(0, deadline - Date.now()),
    );
  return {
    stopped: processExited,
    health: afterHealth,
    state: processExited ? (after.state ?? null) : observation.state,
  };
}

function forceStopDaemonOwnership(
  paths: ReturnType<typeof resolveRuntimeDaemonPaths>,
  health: RuntimeDaemonHealth,
  state: RuntimeDaemonState | null,
): DaemonStopResult {
  if (health === 'missing') {
    const lockOwner = readRuntimeDaemonLockOwner(paths.lockFile);
    if (lockOwner && isRuntimeDaemonPidAlive(lockOwner.pid)) {
      return {
        stopped: false,
        forced: true,
        reason: 'unverified_owner',
        health,
        state,
      };
    }
    removeRuntimeDaemonOwnershipFiles(paths);
    return {
      stopped: true,
      forced: true,
      health: 'missing',
      state: null,
    };
  }
  if (health === 'stale') {
    removeRuntimeDaemonOwnershipFiles(paths);
    return {
      stopped: true,
      forced: true,
      health: 'missing',
      state: null,
    };
  }
  return {
    stopped: false,
    forced: true,
    reason: 'unverified_owner',
    health,
    state,
  };
}

async function restartDaemonCommand(input: {
  readonly profile: string;
  readonly homeDir: string;
  readonly provider?: string;
  readonly model?: string;
  readonly timeoutMs: number;
  readonly json: boolean;
}): Promise<void> {
  const result = await getDaemonRestartResult(input);
  if (input.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const paths = resolveRuntimeDaemonPaths(input.homeDir, input.profile);
  if (!result.restarted) {
    throw new Error(`KodaX runtime daemon restart failed for profile "${paths.profile}".`);
  }
  console.log(chalk.green(`KodaX runtime daemon restarted for profile "${paths.profile}".`));
  if (result.start.state) {
    console.log(chalk.dim(`PID: ${result.start.state.pid}`));
    console.log(chalk.dim(`Endpoint: ${result.start.state.endpoint}`));
  }
}

async function getDaemonRestartResult(input: {
  readonly profile: string;
  readonly homeDir: string;
  readonly provider?: string;
  readonly model?: string;
  readonly timeoutMs: number;
}): Promise<DaemonRestartResult> {
  const stop = await getDaemonStopResult(input);
  if (stop.health === 'healthy') {
    return {
      restarted: false,
      stop,
      start: {
        started: false,
        reason: 'already_running',
        state: stop.state,
      },
    };
  }
  if (!stop.stopped) {
    return {
      restarted: false,
      stop,
      start: {
        started: false,
        health: stop.health,
        state: stop.state,
      },
    };
  }
  if (stop.reason === 'unhealthy' || stop.reason === 'mismatch') {
    return {
      restarted: false,
      stop,
      start: {
        started: false,
        health: stop.reason,
        state: stop.state,
      },
    };
  }
  const start = await getDaemonStartResult(input);
  return {
    restarted: start.started === true || start.reason === 'already_running',
    stop,
    start,
  };
}

async function printDaemonLogs(input: {
  readonly profile: string;
  readonly homeDir: string;
  readonly lines: number;
  readonly json: boolean;
}): Promise<void> {
  const result = readDaemonLogs(input);
  if (input.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(chalk.cyan(`KodaX runtime daemon log (${result.profile})`));
  console.log(chalk.dim(result.logFile));
  if (!result.exists) {
    console.log(chalk.yellow('No daemon log file exists yet.'));
    return;
  }
  for (const line of result.lines) {
    console.log(line);
  }
}

function readDaemonLogs(input: {
  readonly profile: string;
  readonly homeDir: string;
  readonly lines: number;
}): DaemonLogsResult {
  const paths = resolveRuntimeDaemonPaths(input.homeDir, input.profile);
  if (!fsSync.existsSync(paths.logFile)) {
    return {
      profile: paths.profile,
      logFile: paths.logFile,
      exists: false,
      lines: [],
    };
  }
  return {
    profile: paths.profile,
    logFile: paths.logFile,
    exists: true,
    lines: tailTextFile(paths.logFile, input.lines),
  };
}

function tailTextFile(file: string, lineCount: number): readonly string[] {
  if (lineCount <= 0) return [];
  const content = fsSync.readFileSync(file, 'utf8');
  const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.slice(-lineCount);
}

function spawnDaemonServeProcess(input: {
  readonly profile: string;
  readonly homeDir: string;
  readonly provider?: string;
  readonly model?: string;
}): ReturnType<typeof spawn> {
  const entry = fileURLToPath(import.meta.url);
  if (!entry) {
    throw new Error('Cannot resolve current KodaX CLI entrypoint for daemon start.');
  }
  const args = [
    ...daemonServeExecArgv(process.execArgv),
    entry,
    'daemon',
    'serve',
    '--profile',
    input.profile,
    '--home',
    input.homeDir,
  ];
  if (input.provider !== undefined) {
    args.push('--provider', input.provider);
  }
  if (input.model !== undefined) {
    args.push('--model', input.model);
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
  child.unref();
  return child;
}

function daemonServeExecArgv(execArgv: readonly string[]): string[] {
  const keep: string[] = [];
  for (let i = 0; i < execArgv.length; i += 1) {
    const arg = execArgv[i] ?? '';
    const normalized = arg.toLowerCase();
    if (
      normalized === '--import'
      || normalized === '--loader'
      || normalized === '--experimental-loader'
      || normalized === '--require'
      || normalized === '-r'
    ) {
      keep.push(arg);
      const value = execArgv[i + 1];
      if (value !== undefined) {
        keep.push(value);
        i += 1;
      }
      continue;
    }
    if (
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
  return keep;
}

async function waitForDaemonHealth(
  paths: ReturnType<typeof resolveRuntimeDaemonPaths>,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  let latest = await observeRuntimeDaemonHealth(paths);
  while (Date.now() <= deadline) {
    latest = await observeRuntimeDaemonHealth(paths);
    if (classifyRuntimeDaemonHealth(latest) === 'healthy') {
      if (latest.state?.status === 'ready') {
        return latest;
      }
    }
    await delay(100);
  }
  return latest;
}

async function waitForDaemonStopped(
  paths: ReturnType<typeof resolveRuntimeDaemonPaths>,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  let latest = await observeRuntimeDaemonHealth(paths);
  let latestStopped = latest;
  while (Date.now() <= deadline) {
    latest = await observeRuntimeDaemonHealth(paths);
    const health = classifyRuntimeDaemonHealth(latest);
    if (health === 'missing') {
      return latest;
    }
    if (health !== 'healthy') {
      latestStopped = latest;
    }
    await delay(100);
  }
  return latestStopped;
}

async function waitForDaemonProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isRuntimeDaemonPidAlive(pid)) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return false;
    await delay(Math.min(100, remainingMs));
  }
  return true;
}

function waitForShutdownSignal(onShutdown: () => Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    let closing = false;
    const close = (): void => {
      if (closing) return;
      closing = true;
      void onShutdown().then(resolve, reject);
    };
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeCliError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function formatDaemonHealth(health: ReturnType<typeof classifyRuntimeDaemonHealth>): string {
  if (health === 'healthy') return chalk.green(health);
  if (health === 'missing') return chalk.dim(health);
  if (health === 'stale') return chalk.yellow(health);
  return chalk.red(health);
}
// ============== CLI Help Topics ==============

const CLI_HELP_TOPICS: Record<string, () => void> = {
  acp: () => {
    console.log(chalk.cyan('\nACP Server\n'));
    console.log(chalk.bold('Overview:'));
    console.log(chalk.dim('  Run KodaX as a stdio ACP server so editors and IDEs can connect directly.'));
    console.log(chalk.dim('  Session creation, prompt streaming, cancellation, and permission prompts reuse KodaX runtime semantics.\n'));
    console.log(chalk.bold('Command:'));
    console.log(chalk.dim('  kodax acp serve [options]\n'));
    console.log(chalk.bold('Options:'));
    console.log(chalk.dim('  --cwd <dir>                  ') + 'Working directory exposed to ACP sessions');
    console.log(chalk.dim('  -m, --provider <name>        ') + 'Provider to use');
    console.log(chalk.dim('  --model <name>               ') + 'Model override');
    console.log(chalk.dim('  --effort <level>             ') + 'Reasoning effort: off, auto, low, medium, high, xhigh, max, or model-supported value');
    console.log(chalk.dim('  --reasoning <mode>           ') + 'Compatibility mode: off, auto, quick, balanced, deep');
    console.log(chalk.dim('  --repo-intelligence <mode>   ') + 'Repo intelligence mode: auto, full, light, off');
    console.log(chalk.dim('  --repo-intelligence-trace    ') + 'Emit repo intelligence trace metadata/logging');
    console.log(chalk.dim('  -t, --thinking               ') + 'Compatibility alias for --reasoning auto');
    console.log(chalk.dim('  --permission-mode <mode>     ') + 'Initial mode: plan, accept-edits, auto-in-project');
    console.log(chalk.dim('  KODAX_ACP_LOG=<level>        ') + 'stderr log level: off, error, info, debug\n');
    console.log(chalk.bold('Examples:'));
    console.log(chalk.dim('  kodax acp serve'));
    console.log(chalk.dim('  kodax acp serve --cwd C:\\repo --permission-mode accept-edits'));
    console.log(chalk.dim('  kodax acp serve -m openai --model gpt-5.4 --reasoning balanced\n'));
  },
  skill: () => {
    console.log(chalk.cyan('\nSkill Utilities\n'));
    console.log(chalk.bold('Overview:'));
    console.log(chalk.dim('  Use built-in skill packaging commands without starting an agent session.'));
    console.log(chalk.dim('  These commands are thin wrappers around the builtin skill-creator tools.\n'));
    console.log(chalk.bold('Commands:'));
    console.log(chalk.dim('  kodax skill init <name> [options]   ') + 'Create a new skill scaffold');
    console.log(chalk.dim('  kodax skill validate <dir>          ') + 'Validate a skill directory');
    console.log(chalk.dim('  kodax skill eval --skill-path ...   ') + 'Run end-to-end eval workspace generation');
    console.log(chalk.dim('  kodax skill grade <workspace>       ') + 'Grade eval runs into grading.json files');
    console.log(chalk.dim('  kodax skill analyze <workspace>     ') + 'Analyze benchmark variance and failures');
    console.log(chalk.dim('  kodax skill compare <workspace>     ') + 'Blind-compare two configs across runs');
    console.log(chalk.dim('  kodax skill package <dir> [options] ') + 'Package a skill as .skill');
    console.log(chalk.dim('  kodax skill install <input> [opts]  ') + 'Install a skill from dir or .skill');
    console.log(chalk.bold('Examples:'));
    console.log(chalk.dim('  kodax skill init release-notes --dest ./.kodax/skills'));
    console.log(chalk.dim('  kodax skill validate ./.kodax/skills/my-skill'));
    console.log(chalk.dim('  kodax skill eval --skill-path ./.kodax/skills/my-skill --evals ./.kodax/skills/my-skill/evals/evals.json --workspace ./iteration-1'));
    console.log(chalk.dim('  kodax skill grade ./iteration-1'));
    console.log(chalk.dim('  kodax skill analyze ./iteration-1'));
    console.log(chalk.dim('  kodax skill compare ./iteration-1 --config-a with_skill --config-b without_skill'));
    console.log(chalk.dim('  kodax skill package ./.kodax/skills/my-skill --output ./my-skill.skill'));
    console.log(chalk.dim('  kodax skill install ./my-skill.skill --dest ~/.kodax/skills --force\n'));
  },
  sessions: () => {
    console.log(chalk.cyan('\nSession Management\n'));
    console.log(chalk.bold('Overview:'));
    console.log(chalk.dim('  KodaX automatically saves conversation sessions, allowing you to'));
    console.log(chalk.dim('  resume work later or switch between different conversations.\n'));
    console.log(chalk.bold('Options:'));
    console.log(chalk.dim('  -c, --continue       ') + 'Continue most recent conversation');
    console.log(chalk.dim('  -r, --resume [id]    ') + 'Resume session by ID (no ID = list recent sessions, then resume the latest)');
    console.log(chalk.dim('  -n, --new            ') + 'Legacy no-op; current CLI already starts a fresh session by default');
    console.log(chalk.dim('  -s, --session <op>   ') + 'Legacy session operations: list, resume, delete <id>, delete-all, or raw session ID');
    console.log(chalk.dim('  --no-session         ') + 'Disable session persistence (print mode only)\n');
    console.log(chalk.bold('Examples:'));
    console.log(chalk.dim('  kodax                      ') + '# Start new session (interactive)');
    console.log(chalk.dim('  kodax -c                   ') + '# Continue recent conversation');
    console.log(chalk.dim('  kodax -r                   ') + '# List recent sessions, then resume the latest');
    console.log(chalk.dim('  kodax -r 20260219_143052   ') + '# Resume specific session');
    console.log(chalk.dim('  kodax -s list              ') + '# List all sessions');
    console.log(chalk.dim('  kodax -s delete 20260219   ') + '# Delete a session');
    console.log(chalk.dim('  kodax -p "task" --no-session') + ' # Run without saving\n');
  },
  project: () => {
    console.log(chalk.cyan('\nProject Mode\n'));
    console.log(chalk.bold('Overview:'));
    console.log(chalk.dim('  Project mode spans two surfaces: non-REPL bootstrap commands and REPL /project commands.'));
    console.log(chalk.dim('  Current workflow includes planning, quality review, brainstorm sessions, harness-verified execution, and runtime artifacts under .agent/project/.\n'));
    console.log(chalk.bold('REPL /project Commands:'));
    console.log(chalk.dim('  /project status [prompt] [--features|--progress]') + '  Status + guided analysis');
    console.log(chalk.dim('  /project plan [#index|topic]                 ') + '  Generate project or feature planning truth');
    console.log(chalk.dim('  /project quality                             ') + '  Deterministic workflow health + release review');
    console.log(chalk.dim('  /project brainstorm                          ') + '  UI-driven discovery flow');
    console.log(chalk.dim('  /project next [prompt|#index] [--no-confirm] ') + '  Harness-verified feature execution');
    console.log(chalk.dim('  /project auto [prompt] [--max=N|--confirm]   ') + '  REPL-side auto-continue with pause support');
    console.log(chalk.dim('  /project pause                               ') + '  Stop /project auto');
    console.log(chalk.dim('  /project verify [#index|--last]              ') + '  Rerun deterministic harness verification');
    console.log(chalk.dim('  /project edit <prompt>                       ') + '  Edit current-stage truth');
    console.log(chalk.dim('  /project analyze [prompt]                    ') + '  AI project analysis');
    console.log(chalk.dim('  /project reset [--all]                       ') + '  Clear progress or remove project truth files\n');
    console.log(chalk.bold('Current Semantics:'));
    console.log(chalk.dim('  - /project next and /project auto are verifier-gated, not self-declared completion'));
    console.log(chalk.dim('  - /project plan writes the latest plan to .agent/project/session_plan.md'));
    console.log(chalk.dim('  - /project quality combines deterministic checks with optional model-generated guidance'));
    console.log(chalk.dim('  - /project brainstorm aligns requirements into .agent/project/alignment.md\n'));
    console.log(chalk.bold('Examples:'));
    console.log(chalk.dim('  kodax -h project'));
    console.log(chalk.dim('  kodax  # then: /project brainstorm -> /project plan -> /project next'));
    console.log(chalk.dim('  kodax  # then: /project quality | /project verify --last | /project auto --max=3\n'));
  },
  auto: () => {
    console.log(chalk.cyan('\nAuto Mode\n'));
    console.log(chalk.bold('Auto Mode (-y, --auto):'));
    console.log(chalk.dim('  Backward-compatibility alias kept for scripts.'));
    console.log(chalk.dim('  Non-REPL CLI already runs in auto mode by default, so this flag currently has no additional effect.\n'));
    console.log(chalk.bold('Options:'));
    console.log(chalk.dim('  -y, --auto             ') + 'Backward-compat alias (no-op in non-REPL CLI)\n');
    console.log(chalk.bold('Examples:'));
    console.log(chalk.dim('  kodax -y "refactor code"          ') + '# Legacy alias; same as plain non-REPL run\n');
  },
  provider: () => {
    const providerNames = getAvailableProviderNames();
    console.log(chalk.cyan('\nLLM Providers\n'));
    console.log(chalk.bold('Overview:'));
    console.log(chalk.dim('  KodaX supports multiple LLM providers. Configure via -m option'));
    console.log(chalk.dim('  or set default in ~/.kodax/config.json. Use --model to override the default model.\n'));
    console.log(chalk.bold('Available Providers:'));
    providerNames.forEach((name) => {
      const detail = name === 'gemini-cli' || name === 'codex-cli'
        ? 'CLI bridge provider (latest-user-message only, MCP unavailable)'
        : 'Native provider';
      console.log(chalk.dim(`  ${name.padEnd(15)} `) + detail);
    });
    console.log();
    console.log(chalk.bold('Key Options:'));
    console.log(chalk.dim('  -m, --provider <name> ') + 'Provider to use');
    console.log(chalk.dim('  --model <name>        ') + 'Model override for the selected provider\n');
    console.log(chalk.bold('Examples:'));
    console.log(chalk.dim('  kodax -m anthropic "task"     ') + '# Use Claude');
    console.log(chalk.dim('  kodax -m openai --model gpt-5.4 "task"') + '# Override model');
    console.log(chalk.dim('  /model                        ') + '# Switch in REPL (saves to config)\n');
  },
  thinking: () => {
    console.log(chalk.cyan('\nReasoning Effort\n'));
    console.log(chalk.bold('Overview:'));
    console.log(chalk.dim('  Reasoning controls how much deliberate analysis KodaX should apply.'));
    console.log(chalk.dim('  Use --effort for new configs; --reasoning remains as a compatibility alias.\n'));
    console.log(chalk.bold('Options:'));
    console.log(chalk.dim('  --effort <level>     ') + 'Set reasoning effort: off, auto, low, medium, high, xhigh, max, or model-supported value');
    console.log(chalk.dim('  --reasoning <mode>   ') + 'Compatibility mode: off, auto, quick, balanced, deep');
    console.log(chalk.dim('  --agent-mode <mode>  ') + 'Set agent mode: ama, sa');
    console.log(chalk.dim('  -t, --thinking       ') + 'Compatibility alias for --reasoning auto\n');
    console.log(chalk.bold('Examples:'));
    console.log(chalk.dim('  kodax --effort high "design the architecture"     ') + '# High effort');
    console.log(chalk.dim('  kodax --reasoning deep "design the architecture"   ') + '# Legacy alias for high effort');
    console.log(chalk.dim('  kodax --reasoning balanced -p "analyze this bug"   ') + '# Medium-depth reasoning');
    console.log(chalk.dim('  kodax -t "review this PR"                           ') + '# Alias for auto');
    console.log(chalk.dim('  /reasoning balanced                                 ') + '# Set in REPL\n');
  },
  print: () => {
    console.log(chalk.cyan('\nPrint Mode\n'));
    console.log(chalk.bold('Overview:'));
    console.log(chalk.dim('  Run a single task and exit. Useful for scripting and CI/CD.\n'));
    console.log(chalk.dim('  `--mode json` is a scripting surface, not the ACP server protocol.\n'));
    console.log(chalk.bold('Options:'));
    console.log(chalk.dim('  -p, --print <text>  ') + 'Run task and exit');
    console.log(chalk.dim('  --mode json         ') + 'Emit newline-delimited JSON events to stdout for scripts/CI');
    console.log(chalk.dim('  --model <name>      ') + 'Override the selected provider model');
    console.log(chalk.dim('  --no-session        ') + 'Disable session saving\n');
    console.log(chalk.bold('Examples:'));
    console.log(chalk.dim('  kodax -p "fix the bug in auth.ts"   ') + '# Quick fix');
    console.log(chalk.dim('  kodax -p "generate tests" --reasoning balanced') + ' # With reasoning');
    console.log(chalk.dim('  kodax -p "task" -m openai --model gpt-5.4') + ' # Provider + model override');
    console.log(chalk.dim('  kodax -p "task" --no-session        ') + '# Stateless run');
    console.log(chalk.dim('  kodax --mode json "inspect auth flow"') + ' # Structured JSONL output');
    console.log(chalk.dim('  kodax -p "task" -m anthropic --reasoning deep') + ' # Explicit provider selection\n');
  },
};

const CLI_SUBCOMMAND_NAMES = new Set([
  'acp',
  'skill',
  'tools',
  'sessions',
  'constructed',
  'doctor',
  'daemon',
  'completion',
]);

function collectRepeatedOption(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

export function configureKodaXRootCommand(program: Command): Command {
  return program
    // Disable commander default help so the custom topic help can take over.
    .helpOption(false)
    .argument('[prompt...]', 'Prompt text for a single CLI run')
    .option('-h, --help [topic]', 'Show help, or detailed help for a topic')
    .option('-p, --print <text>', 'Print mode: run single task and exit')
    .option('--mode <mode>', 'Output mode: json', parseOutputModeOption)
    .option('--runtime-mode <mode>', 'Interactive runtime mode: embedded, daemon', parseRuntimeModeOption)
    .option('-c, --continue', 'Continue most recent conversation in current directory')
    .option('-n, --new', 'Legacy no-op; current CLI already starts a fresh session by default')
    .option('-r, --resume [id]', 'Resume session by ID (no ID = list recent sessions, then resume the latest)')
    .option('-m, --provider <name>', 'LLM provider')
    .option('--model <name>', 'Model override')
    .option('-t, --thinking', 'Compatibility alias for --reasoning auto')
    .option('--effort <level>', 'Reasoning effort: off, auto, low, medium, high, xhigh, max, or model-supported value', parseEffortOption)
    .option('--reasoning <mode>', 'Reasoning mode: off, auto, quick, balanced, deep', parseReasoningModeOption)
    .option('--agent-mode <mode>', 'Agent mode: ama, amaw, sa', parseAgentModeOption)
    .option('--repo-intelligence <mode>', 'Repo intelligence mode: auto, full, light, off', parseRepoIntelligenceModeOption)
    .option('--repo-intelligence-trace', 'Enable repo intelligence trace metadata/logging')
    .option('-y, --auto', 'Backward-compat alias; no effect in non-REPL CLI')
    .option('-s, --session <op>', 'Legacy session operations: list, resume, delete <id>, delete-all, or raw session ID')
    .option('--extension <path>', 'Load local extension module (.js/.mjs/.cjs/.ts/.mts/.cts)', collectRepeatedOption, [])
    .option('--no-session', 'Disable session persistence (print mode only)')
    .option('--max-iter <n>', 'Max iterations (default: 200 from coding package)')
    .allowUnknownOption(false)
    // Keep the root command executable even when subcommands like `skill` exist.
    .action(() => {});
}

function showCliHelpTopic(topic: string): boolean {
  const helpFn = CLI_HELP_TOPICS[topic.toLowerCase()];
  if (helpFn) {
    helpFn();
    return true;
  }
  return false;
}

function showCliHelpTopics(): void {
  console.log(chalk.cyan('\nDetailed Help Topics:\n'));
  console.log(chalk.dim('  kodax -h acp        ') + 'ACP server mode for editors and IDEs');
  console.log(chalk.dim('  kodax -h sessions   ') + 'Session management (-c, -r, -s options)');
  console.log(chalk.dim('  kodax -h skill      ') + 'Skill packaging and installation helpers');
  console.log(chalk.dim('  kodax -h project    ') + 'Project mode workflow across CLI and /project');
  console.log(chalk.dim('  kodax -h auto       ') + 'Auto mode backward-compat alias');
  console.log(chalk.dim('  kodax -h provider   ') + 'LLM provider options');
  console.log(chalk.dim('  kodax -h thinking   ') + 'Reasoning modes and depth control');
  console.log(chalk.dim('  kodax -h print      ') + 'Print mode for scripting\n');
}

type CliRunResultEvent = {
  type: 'run.result';
  success: boolean;
  signal?: 'COMPLETE' | 'BLOCKED' | 'DECIDE';
  signalReason?: string;
  sessionId: string;
  interrupted?: boolean;
  limitReached?: boolean;
};

function writeJsonStdout(value: CliRunResultEvent): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function emitJsonRunResultIfNeeded(
  outputMode: CliOutputMode,
  result: Awaited<ReturnType<typeof runKodaX>>,
): void {
  if (outputMode !== 'json') {
    return;
  }

  writeJsonStdout({
    type: 'run.result',
    success: result.success,
    signal: result.signal,
    signalReason: result.signalReason,
    sessionId: result.sessionId,
    interrupted: result.interrupted,
    limitReached: result.limitReached,
  });
}

function printAcpSubcommandHelp(name: string): boolean {
  if (name === 'serve') {
    console.log('Usage: kodax acp serve [options]');
    console.log();
    console.log('Run KodaX as a stdio ACP server for editors and IDEs.');
    console.log();
    console.log('Options:');
    console.log('  --cwd <dir>                  Working directory exposed to ACP sessions');
    console.log('  -m, --provider <name>        Provider to use');
    console.log('  --model <name>               Model override');
    console.log('  --effort <level>             Reasoning effort: off, auto, low, medium, high, xhigh, max, or model-supported value');
    console.log('  -t, --thinking               Compatibility alias for --reasoning auto');
    console.log('  --reasoning <mode>           Reasoning mode: off, auto, quick, balanced, deep');
    console.log('  --repo-intelligence <mode>   Repo intelligence mode: auto, full, light, off');
    console.log('  --repo-intelligence-trace    Emit repo intelligence trace metadata/logging');
    console.log('  --permission-mode <mode>     Initial permission mode');
    console.log('  KODAX_ACP_LOG=<level>        stderr log level: off, error, info, debug');
    return true;
  }

  return false;
}

function printSkillSubcommandHelp(name: string): boolean {
  if (name === 'init') {
    console.log('Usage: kodax skill init [options] <name>');
    console.log();
    console.log('Initialize a new skill scaffold.');
    console.log();
    console.log('Options:');
    console.log('  -d, --dest <dir>         Base skills directory');
    console.log('  --description <text>     Initial skill description');
    console.log('  -f, --force              Allow writing into an existing target directory');
    console.log('  --no-evals               Skip creating evals/evals.json');
    return true;
  }

  if (name === 'validate') {
    console.log('Usage: kodax skill validate <skillDir>');
    console.log();
    console.log('Validate a skill directory using builtin skill-creator.');
    return true;
  }

  if (name === 'eval') {
    console.log('Usage: kodax skill eval [options]');
    console.log();
    console.log('Run end-to-end skill evals and write a benchmark/review workspace.');
    console.log();
    console.log('Required Options:');
    console.log('  --skill-path <dir>       Skill directory to evaluate');
    console.log('  --evals <file>           Evals JSON file');
    console.log('  --workspace <dir>        Workspace output directory');
    console.log();
    console.log('Options:');
    console.log('  --provider <name>        Provider to use');
    console.log('  --model <name>           Model override');
    console.log('  --runs <n>               Runs per config');
    console.log('  --max-iter <n>           Max iterations per run');
    console.log('  --reasoning <mode>       Reasoning mode');
    console.log('  --cwd <dir>              Working directory for the runs');
    console.log('  --configs <list>         Comma-separated configs, e.g. with_skill,without_skill');
    console.log('  -o, --output <file>      Optional JSON summary output');
    return true;
  }

  if (name === 'grade') {
    console.log('Usage: kodax skill grade [options] <workspace>');
    console.log();
    console.log('Grade eval runs into grading.json files.');
    console.log();
    console.log('Options:');
    console.log('  --provider <name>        Provider to use');
    console.log('  --model <name>           Model override');
    console.log('  --reasoning <mode>       Reasoning mode');
    console.log('  --max-iter <n>           Max iterations per grading run');
    console.log('  --configs <list>         Comma-separated configs, e.g. with_skill,without_skill');
    console.log('  --overwrite              Re-grade runs that already have grading.json');
    return true;
  }

  if (name === 'analyze') {
    console.log('Usage: kodax skill analyze [options] <workspace>');
    console.log();
    console.log('Analyze benchmark variance and write analysis.json + analysis.md.');
    console.log();
    console.log('Options:');
    console.log('  --benchmark <file>       Optional benchmark.json path');
    console.log('  --output <file>          JSON output path');
    console.log('  --markdown <file>        Markdown output path');
    console.log('  --skill-name <name>      Skill name if benchmark.json must be regenerated');
    console.log('  --provider <name>        Provider to use');
    console.log('  --model <name>           Model override');
    console.log('  --reasoning <mode>       Reasoning mode');
    return true;
  }

  if (name === 'compare') {
    console.log('Usage: kodax skill compare [options] <workspace>');
    console.log();
    console.log('Blind-compare two configs across eval run pairs.');
    console.log();
    console.log('Options:');
    console.log('  --config-a <name>        Primary config (default: with_skill)');
    console.log('  --config-b <name>        Baseline config (default: without_skill)');
    console.log('  --output <file>          JSON output path');
    console.log('  --markdown <file>        Markdown output path');
    console.log('  --max-pairs <n>          Limit pairs per eval');
    console.log('  --provider <name>        Provider to use');
    console.log('  --model <name>           Model override');
    console.log('  --reasoning <mode>       Reasoning mode');
    return true;
  }

  if (name === 'package') {
    console.log('Usage: kodax skill package [options] <skillDir>');
    console.log();
    console.log('Package a skill directory as a .skill archive.');
    console.log();
    console.log('Options:');
    console.log('  -o, --output <file>      Output .skill file path');
    return true;
  }

  if (name === 'install') {
    console.log('Usage: kodax skill install [options] <input>');
    console.log();
    console.log('Install a skill directory or .skill archive into a skills directory.');
    console.log();
    console.log('Options:');
    console.log('  -d, --dest <dir>         Destination skills directory');
    console.log('  -f, --force              Overwrite an existing target skill');
    return true;
  }

  return false;
}

function showBasicHelp(): void {
  const providerNames = getAvailableProviderNames().join(', ');
  console.log('KodaX - Intelligent Coding Agent\n');
  console.log('Usage: kodax [options] [prompt]');
  console.log('       kodax "your task"');
  console.log('       kodax /command_name\n');
  console.log('Options:');
  console.log('  -h, --help [TOPIC]      Show help, or detailed help for a topic');
  console.log('  -p, --print TEXT        Print mode: run single task and exit');
  console.log('  --mode json             Emit newline-delimited JSON events to stdout for scripts/CI');
  console.log('  -c, --continue          Continue most recent conversation');
  console.log('  -r, --resume [id]       Resume session by ID (no ID = list recent sessions, then resume the latest)');
  console.log('  -n, --new               Legacy no-op; current CLI already starts a fresh session by default');
  console.log(`  -m, --provider NAME     LLM provider (${providerNames})`);
  console.log('  --model NAME            Model override for the selected provider');
  console.log('  -t, --thinking          Compatibility alias for --reasoning auto');
  console.log('  --effort LEVEL          Reasoning effort: off, auto, low, medium, high, xhigh, max, or model-supported value');
  console.log('  --reasoning MODE        Compatibility mode: off, auto, quick, balanced, deep');
  console.log('  --agent-mode MODE       Agent mode: ama, amaw, sa');
  console.log('  -y, --auto              Backward-compat alias; no effect in non-REPL CLI');
  console.log('  -s, --session OP        Legacy session operations: list, resume, delete <id>, delete-all, or raw session ID');
  console.log('  --no-session            Disable session persistence (print mode only)');
  console.log('  --max-iter N            Max iterations per session (default: 200)\n');
  console.log('Help Topics (use -h <topic>):');
  console.log('  acp, skill, sessions, project, auto, provider, thinking, print\n');
  console.log('Interactive Commands (in REPL mode):');
  console.log('  /help, /h               Show all commands');
  console.log('  /exit, /quit            Exit interactive mode');
  console.log('  /clear                  Clear conversation history');
  console.log('  /status                 Show session status');
  console.log('  /mode [plan|accept-edits|auto]  Switch permission mode');
  console.log('  /project ...            Project workflow commands');
  console.log('  /sessions               List saved sessions\n');
  console.log('Examples:');
  console.log('  kodax                             # Enter interactive mode');
  console.log('  kodax "create a component"        # Run single task (with session)');
  console.log('  kodax acp serve                   # Start ACP stdio server');
  console.log('  kodax skill init my-skill         # Scaffold a new skill');
  console.log('  kodax skill package ./my-skill    # Package a skill without starting the agent');
  console.log('  kodax -h project                 # Project mode workflow across CLI and REPL');
  console.log('  kodax -p "quick fix" --reasoning balanced  # Quick task with reasoning');
  console.log('  kodax -c                          # Continue recent conversation');
  console.log('  kodax -c "finish this"            # Continue with new task');
  console.log('  kodax -r                          # List recent sessions, then resume the latest');
  console.log('  kodax -p "task" --model gpt-5.4   # Override model for a one-off run');
  console.log('  kodax -p "task" --no-session      # Run without saving session');
  console.log('  kodax -h sessions                 # Detailed help on sessions\n');
}

async function main() {
  const argv = process.argv.slice(2);
  const isDaemonManagementCommand = argv[0] === 'daemon' && argv[1] !== 'serve';

  // FEATURE_208 (v0.7.45): strip dynamic-linker preload env vars
  // (LD_PRELOAD / DYLD_*) before anything spawns children or loads native
  // addons. Opt-out: KODAX_DISABLE_HARDENING=1. Debug-preserving (no
  // PR_SET_DUMPABLE). No-op on Windows.
  applyProcessHardening();
  if (!isDaemonManagementCommand) {
    await cleanupRegisteredManagedChildren();
  }

  // FEATURE_209 (v0.7.45): activate tracing so Runner spans persist to
  // ~/.kodax/.traces/<traceId>.jsonl. FileTracingProcessor flushes per-trace
  // on completion, so completed traces are durable without the beforeExit
  // handler; that handler only flushes a trace still in flight when the event
  // loop drains naturally (it does NOT fire on process.exit()). Opt-out via
  // KODAX_TRACING=0.
  if (!isDaemonManagementCommand) {
    bootstrapTracing();
    process.once('beforeExit', () => {
      void shutdownTracing();
    });
  }

  // Session retention: opt-in best-effort background prune of session files
  // older than KODAX_SESSION_RETENTION_DAYS. DEFAULT OFF (0) — auto-deleting a
  // user's accumulated history is destructive and surprising, so it must be
  // explicitly enabled (e.g. KODAX_SESSION_RETENTION_DAYS=30). The `list()`
  // head-read path already keeps `kodax -c` + the picker fast regardless of
  // file count, so retention is a housekeeping convenience, not a perf
  // requirement. Fire-and-forget — never blocks startup; errors are swallowed
  // inside cleanupOldSessions, and a non-positive value is a no-op.
  // Read from env (shell override) then config.json (persistent). This runs at
  // startup before prepareRuntimeConfig's bridge, so it reads config directly.
  if (!isDaemonManagementCommand) {
    const sessionRetentionDays = Number(
      process.env.KODAX_SESSION_RETENTION_DAYS ?? loadConfig().sessionRetentionDays ?? 0,
    );
    void new FileSessionStorage().cleanupOldSessions(sessionRetentionDays);
  }

  const program = configureKodaXRootCommand(new Command()
    .name('kodax')
    .description('KodaX - Intelligent Coding Agent')
    .version(version));

  // ============== completion subcommand ==============
  program
    .command('completion')
    .description('Generate shell completion script')
    .argument('<shell>', 'Shell type: bash, zsh, or fish')
    .action((shell: string) => {
      const providerNames = getAvailableProviderNames().join(' ');
      const reasoningModes = 'off auto quick balanced deep';
      const effortModes = 'off auto low medium high xhigh max';
      const agentModes = 'ama amaw sa';
      const repoModes = 'auto full light off';
      const rootSubcommands = 'acp skill tools sessions constructed doctor daemon completion';
      const allOptions = [
        '-p', '-c', '-r', '-n', '-m', '-t', '-s', '-y', '-h',
        '--help', '--print', '--mode', '--runtime-mode', '--continue', '--resume', '--new',
        '--provider', '--model', '--thinking', '--effort', '--reasoning', '--agent-mode',
        '--repo-intelligence', '--repo-intelligence-trace',
        '--auto', '--session', '--extension', '--no-session',
        '--max-iter', '--version', '--json', '--ping', '--cwd', '--permission-mode',
        '--dest', '--description', '--force', '--no-evals', '--skill-path',
        '--evals', '--workspace', '--config-a', '--config-b', '--output',
        '--apply', '--all',
      ].join(' ');
      const skillSubcommands = 'init validate eval grade analyze compare package install';
      const toolsSubcommands = 'list inspect revoke';
      const sessionsSubcommands = 'dedupe';
      const constructedSubcommands = 'reset-self-modify-budget audit disable-self-modify rollback';

      if (shell === 'bash') {
        console.log(`# KodaX bash completion — add to ~/.bashrc:
#   eval "$(kodax completion bash)"
_kodax_complete() {
  local cur prev opts subcmds
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  subcmds="${rootSubcommands}"
  opts="${allOptions}"

  case "\${prev}" in
    --provider|-m) COMPREPLY=( $(compgen -W "${providerNames}" -- "\${cur}") ); return 0 ;;
    --mode) COMPREPLY=( $(compgen -W "json" -- "\${cur}") ); return 0 ;;
    --runtime-mode) COMPREPLY=( $(compgen -W "embedded daemon" -- "\${cur}") ); return 0 ;;
    --effort) COMPREPLY=( $(compgen -W "${effortModes}" -- "\${cur}") ); return 0 ;;
    --reasoning) COMPREPLY=( $(compgen -W "${reasoningModes}" -- "\${cur}") ); return 0 ;;
    --agent-mode) COMPREPLY=( $(compgen -W "${agentModes}" -- "\${cur}") ); return 0 ;;
    --repo-intelligence) COMPREPLY=( $(compgen -W "${repoModes}" -- "\${cur}") ); return 0 ;;
    --session|-s) COMPREPLY=( $(compgen -W "list resume delete delete-all" -- "\${cur}") ); return 0 ;;
    completion) COMPREPLY=( $(compgen -W "bash zsh fish" -- "\${cur}") ); return 0 ;;
    acp) COMPREPLY=( $(compgen -W "serve" -- "\${cur}") ); return 0 ;;
    daemon) COMPREPLY=( $(compgen -W "start stop restart status logs serve" -- "\${cur}") ); return 0 ;;
    skill) COMPREPLY=( $(compgen -W "${skillSubcommands}" -- "\${cur}") ); return 0 ;;
    tools) COMPREPLY=( $(compgen -W "${toolsSubcommands}" -- "\${cur}") ); return 0 ;;
    sessions) COMPREPLY=( $(compgen -W "${sessionsSubcommands}" -- "\${cur}") ); return 0 ;;
    constructed) COMPREPLY=( $(compgen -W "${constructedSubcommands}" -- "\${cur}") ); return 0 ;;
  esac

  if [[ "\${cur}" == -* ]]; then
    COMPREPLY=( $(compgen -W "\${opts}" -- "\${cur}") )
  elif [[ \${COMP_CWORD} -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "\${subcmds}" -- "\${cur}") )
  fi
}
complete -F _kodax_complete kodax`);
      } else if (shell === 'zsh') {
        console.log(`# KodaX zsh completion — add to ~/.zshrc:
#   eval "$(kodax completion zsh)"
_kodax() {
  local -a subcmds opts providers reasoning_modes agent_modes repo_modes
  subcmds=(${rootSubcommands})
  providers=(${providerNames.replace(/ /g, ' ')})
  reasoning_modes=(off auto quick balanced deep)
  effort_modes=(off auto low medium high xhigh max)
  agent_modes=(ama amaw sa)
  repo_modes=(${repoModes})

  _arguments -C \\
    '-p[Print mode]+:text:' \\
    '--print+[Print mode]:text:' \\
    '--mode+[Output mode]:mode:(json)' \\
    '--runtime-mode+[Interactive runtime mode]:mode:(embedded daemon)' \\
    '-c[Continue most recent conversation]' \\
    '--continue[Continue most recent conversation]' \\
    '-n[Start fresh session]' \\
    '--new[Start fresh session]' \\
    '-r[Resume session by ID]::id:' \\
    '--resume[Resume session by ID]::id:' \\
    '-m[LLM provider]+:provider:($providers)' \\
    '--provider+[LLM provider]:provider:($providers)' \\
    '--model+[Model override]:model:' \\
    '-t[Enable thinking]' \\
    '--thinking[Enable thinking]' \\
    '--effort+[Reasoning effort]:level:($effort_modes)' \\
    '--reasoning+[Compatibility reasoning mode]:mode:($reasoning_modes)' \\
    '--agent-mode+[Agent mode]:mode:($agent_modes)' \\
    '--repo-intelligence+[Repo intelligence mode]:mode:($repo_modes)' \\
    '--repo-intelligence-trace[Enable repo intelligence trace]' \\
    '-s[Legacy session operation]+:operation:(list resume delete delete-all)' \\
    '--session+[Legacy session operation]:operation:(list resume delete delete-all)' \\
    '--extension+[Load local extension]:path:_files' \\
    '--no-session[Disable session persistence in print mode]' \\
    '--max-iter+[Max iterations]:n:' \\
    '--version[Show version]' \\
    '-h[Show help]::topic:' \\
    '--help[Show help]::topic:' \\
    '1:subcommand:($subcmds)' \\
    '*::arg:->args'
}
compdef _kodax kodax`);
      } else if (shell === 'fish') {
        console.log(`# KodaX fish completion — add to ~/.config/fish/completions/kodax.fish:
#   kodax completion fish > ~/.config/fish/completions/kodax.fish
complete -c kodax -n '__fish_use_subcommand' -a '${rootSubcommands}' -d 'Subcommands'
complete -c kodax -n '__fish_seen_subcommand_from completion' -a 'bash zsh fish' -d 'Shell'
complete -c kodax -n '__fish_seen_subcommand_from acp' -a 'serve' -d 'ACP subcommand'
complete -c kodax -n '__fish_seen_subcommand_from daemon' -a 'start stop restart status logs serve' -d 'Daemon subcommand'
complete -c kodax -n '__fish_seen_subcommand_from skill' -a '${skillSubcommands}' -d 'Skill subcommand'
complete -c kodax -n '__fish_seen_subcommand_from tools' -a '${toolsSubcommands}' -d 'Tools subcommand'
complete -c kodax -n '__fish_seen_subcommand_from sessions' -a '${sessionsSubcommands}' -d 'Sessions subcommand'
complete -c kodax -n '__fish_seen_subcommand_from constructed' -a '${constructedSubcommands}' -d 'Constructed subcommand'
complete -c kodax -s h -l help -d 'Show help'
complete -c kodax -s p -l print -d 'Print mode' -r
complete -c kodax -l mode -d 'Output mode' -xa 'json'
complete -c kodax -l runtime-mode -d 'Interactive runtime mode' -xa 'embedded daemon'
complete -c kodax -s c -l continue -d 'Continue most recent conversation'
complete -c kodax -s n -l new -d 'Start fresh session'
complete -c kodax -s r -l resume -d 'Resume session by ID' -r
complete -c kodax -s m -l provider -d 'LLM provider' -xa '${providerNames}'
complete -c kodax -l model -d 'Model override' -r
complete -c kodax -s t -l thinking -d 'Enable thinking'
complete -c kodax -l effort -d 'Reasoning effort' -xa 'off auto low medium high xhigh max'
complete -c kodax -l reasoning -d 'Reasoning mode' -xa '${reasoningModes}'
complete -c kodax -l agent-mode -d 'Agent mode' -xa '${agentModes}'
complete -c kodax -l repo-intelligence -d 'Repo intelligence mode' -xa '${repoModes}'
complete -c kodax -l repo-intelligence-trace -d 'Enable repo intelligence trace'
complete -c kodax -s y -l auto -d 'Backward-compatible no-op'
complete -c kodax -s s -l session -d 'Legacy session operation' -xa 'list resume delete delete-all'
complete -c kodax -l extension -d 'Load local extension' -r
complete -c kodax -l no-session -d 'Disable session persistence in print mode'
complete -c kodax -l max-iter -d 'Max iterations' -r
complete -c kodax -l version -d 'Show version'`);
      } else {
        console.error(`Unknown shell: ${shell}. Supported: bash, zsh, fish`);
        process.exit(1);
      }
    });

  // ============== sessions subcommands ==============
  const sessionsCommand = program
    .command('sessions')
    .description('Manage saved KodaX sessions')
    .action(() => {
      console.log(chalk.cyan('\nKodaX Sessions\n'));
      console.log(chalk.bold('Commands:'));
      console.log(chalk.dim('  kodax sessions dedupe          ') + 'Dry-run historical runner ghost cleanup');
      console.log(chalk.dim('  kodax sessions dedupe --apply  ') + 'Move uniquely matched runner ghosts to .dedupe-archive');
      console.log(chalk.dim('\nLegacy:'));
      console.log(chalk.dim('  kodax -s list                  ') + 'List saved sessions');
    });

  sessionsCommand
    .command('dedupe')
    .description('Find and optionally move historical runner ghost session files')
    .option('--apply', 'Move uniquely matched runner ghost files into .dedupe-archive')
    .action(async (subOpts: { apply?: boolean }) => {
      const applied = subOpts.apply === true;
      const report = await dedupeSessions({ apply: applied });
      printSessionDedupeReport(report, applied);
    });

  // ============== doctor subcommand (FEATURE_204) ==============
  program
    .command('doctor')
    .description('Print environment diagnostics (runtime, providers, session/trace disk usage)')
    .option('--json', 'Output machine-readable JSON')
    .option('--ping', 'Live-probe each configured provider (network + small token cost)')
    .action(async (opts: { json?: boolean; ping?: boolean }) => {
      await runDoctor(version, Boolean(opts?.json), { ping: Boolean(opts?.ping) });
    });

  const daemonCommand = program
    .command('daemon')
    .description('Inspect and manage the local KodaX runtime daemon')
    .helpOption('-h, --help', 'Show daemon help');

  daemonCommand
    .command('start')
    .description('Start the runtime daemon in a detached background process')
    .option('--profile <name>', 'Daemon profile', 'default')
    .option('--home <dir>', 'Base directory that owns the .kodax runtime daemon state', resolveDefaultRuntimeDaemonHomeDir())
    .option('-m, --provider <name>', 'Default provider for hosted runs')
    .option('--model <name>', 'Default model for hosted runs')
    .option('--timeout-ms <n>', 'Milliseconds to wait for daemon health', parseOptionalNonNegativeInt, 5_000)
    .option('--json', 'Output machine-readable JSON')
    .action(async (subOpts: {
      profile?: string;
      home?: string;
      provider?: string;
      model?: string;
      timeoutMs?: number;
      json?: boolean;
    }) => {
      await startDaemonCommand({
        profile: subOpts.profile ?? 'default',
        homeDir: subOpts.home ?? resolveDefaultRuntimeDaemonHomeDir(),
        provider: subOpts.provider,
        model: subOpts.model,
        timeoutMs: subOpts.timeoutMs ?? 5_000,
        json: subOpts.json === true,
      });
    });

  daemonCommand
    .command('stop')
    .description('Stop a healthy runtime daemon')
    .option('--profile <name>', 'Daemon profile', 'default')
    .option('--home <dir>', 'Base directory that owns the .kodax runtime daemon state', resolveDefaultRuntimeDaemonHomeDir())
    .option('--timeout-ms <n>', 'Milliseconds to wait for daemon shutdown', parseOptionalNonNegativeInt, 5_000)
    .option('--force', 'Clean verified stale daemon ownership without killing unverified live processes')
    .option('--json', 'Output machine-readable JSON')
    .action(async (subOpts: {
      profile?: string;
      home?: string;
      timeoutMs?: number;
      force?: boolean;
      json?: boolean;
    }) => {
      await stopDaemonCommand({
        profile: subOpts.profile ?? 'default',
        homeDir: subOpts.home ?? resolveDefaultRuntimeDaemonHomeDir(),
        timeoutMs: subOpts.timeoutMs ?? 5_000,
        force: subOpts.force === true,
        json: subOpts.json === true,
      });
    });

  daemonCommand
    .command('restart')
    .description('Restart the runtime daemon')
    .option('--profile <name>', 'Daemon profile', 'default')
    .option('--home <dir>', 'Base directory that owns the .kodax runtime daemon state', resolveDefaultRuntimeDaemonHomeDir())
    .option('-m, --provider <name>', 'Default provider for hosted runs')
    .option('--model <name>', 'Default model for hosted runs')
    .option('--timeout-ms <n>', 'Milliseconds to wait for daemon shutdown/startup', parseOptionalNonNegativeInt, 5_000)
    .option('--json', 'Output machine-readable JSON')
    .action(async (subOpts: {
      profile?: string;
      home?: string;
      provider?: string;
      model?: string;
      timeoutMs?: number;
      json?: boolean;
    }) => {
      await restartDaemonCommand({
        profile: subOpts.profile ?? 'default',
        homeDir: subOpts.home ?? resolveDefaultRuntimeDaemonHomeDir(),
        provider: subOpts.provider,
        model: subOpts.model,
        timeoutMs: subOpts.timeoutMs ?? 5_000,
        json: subOpts.json === true,
      });
    });

  daemonCommand
    .command('logs')
    .description('Print the daemon log path and recent lines')
    .option('--profile <name>', 'Daemon profile', 'default')
    .option('--home <dir>', 'Base directory that owns the .kodax runtime daemon state', resolveDefaultRuntimeDaemonHomeDir())
    .option('--lines <n>', 'Number of log lines to print', parseOptionalNonNegativeInt, 80)
    .option('--json', 'Output machine-readable JSON')
    .action(async (subOpts: { profile?: string; home?: string; lines?: number; json?: boolean }) => {
      await printDaemonLogs({
        profile: subOpts.profile ?? 'default',
        homeDir: subOpts.home ?? resolveDefaultRuntimeDaemonHomeDir(),
        lines: subOpts.lines ?? 80,
        json: subOpts.json === true,
      });
    });

  daemonCommand
    .command('serve')
    .description('Run the runtime daemon host in the foreground')
    .option('--profile <name>', 'Daemon profile', 'default')
    .option('--home <dir>', 'Base directory that owns the .kodax runtime daemon state', resolveDefaultRuntimeDaemonHomeDir())
    .option('-m, --provider <name>', 'Default provider for hosted runs')
    .option('--model <name>', 'Default model for hosted runs')
    .action(async (subOpts: { profile?: string; home?: string; provider?: string; model?: string }) => {
      await serveDaemonCommand({
        profile: subOpts.profile ?? 'default',
        homeDir: subOpts.home ?? resolveDefaultRuntimeDaemonHomeDir(),
        provider: subOpts.provider,
        model: subOpts.model,
      });
    });

  daemonCommand
    .command('status')
    .description('Inspect daemon state and endpoint health')
    .option('--profile <name>', 'Daemon profile', 'default')
    .option('--home <dir>', 'Base directory that owns the .kodax runtime daemon state', resolveDefaultRuntimeDaemonHomeDir())
    .option('--json', 'Output machine-readable JSON')
    .action(async (subOpts: { profile?: string; home?: string; json?: boolean }) => {
      await printDaemonStatus({
        profile: subOpts.profile ?? 'default',
        homeDir: subOpts.home ?? resolveDefaultRuntimeDaemonHomeDir(),
        json: subOpts.json === true,
      });
    });

  const skillCommand = program
    .command('skill')
    .description('Built-in skill packaging and installation helpers')
    .helpOption('-h, --help', 'Show skill utility help');

  const acpCommand = program
    .command('acp')
    .description('Run KodaX as an ACP server for editors and IDEs')
    .helpOption('-h, --help', 'Show ACP server help');

  acpCommand
    .command('serve')
    .description('Run the ACP stdio server')
    .option('--cwd <dir>', 'Working directory exposed to ACP sessions')
    .option('-m, --provider <name>', 'Provider to use')
    .option('--model <name>', 'Model override')
    .option('--effort <level>', 'Reasoning effort: off, auto, low, medium, high, xhigh, max, or model-supported value', parseEffortOption)
    .option('-t, --thinking', 'Compatibility alias for --reasoning auto')
    .option('--reasoning <mode>', 'Reasoning mode: off, auto, quick, balanced, deep', parseReasoningModeOption)
    .option('--repo-intelligence <mode>', 'Repo intelligence mode: auto, full, light, off', parseRepoIntelligenceModeOption)
    .option('--repo-intelligence-trace', 'Enable repo intelligence trace metadata/logging')
    .option('--permission-mode <mode>', 'Initial permission mode', parsePermissionModeOption, 'accept-edits')
    .action(async (subcommandOptions: {
      cwd?: string;
      provider?: string;
      model?: string;
      effort?: string;
      thinking?: boolean;
      reasoning?: KodaXReasoningMode;
      repoIntelligence?: string;
      repoIntelligenceTrace?: boolean;
      permissionMode?: AcpPermissionMode;
    }) => {
      if (typeof subcommandOptions.repoIntelligence === 'string' && subcommandOptions.repoIntelligence.trim()) {
        process.env.KODAX_REPO_INTELLIGENCE = subcommandOptions.repoIntelligence.trim();
      }
      if (subcommandOptions.repoIntelligenceTrace === true) {
        process.env.KODAX_REPO_INTELLIGENCE_TRACE = '1';
      }
      await runAcpServer({
        cwd: subcommandOptions.cwd,
        provider: subcommandOptions.provider,
        model: subcommandOptions.model,
        effort: subcommandOptions.effort,
        thinking: subcommandOptions.thinking,
        reasoningMode: subcommandOptions.reasoning,
        permissionMode: subcommandOptions.permissionMode,
        agentVersion: version,
      });
    });

  skillCommand
    .command('init <name>')
    .description('Initialize a new skill scaffold')
    .option('-d, --dest <dir>', 'Base skills directory')
    .option('--description <text>', 'Initial skill description')
    .option('-f, --force', 'Allow writing into an existing target directory')
    .option('--no-evals', 'Skip creating evals/evals.json')
    .action(async (
      name: string,
      subcommandOptions: {
        dest?: string;
        description?: string;
        force?: boolean;
        evals?: boolean;
      }
    ) => {
      const args = [name];
      if (subcommandOptions.dest) {
        args.push('--dest', subcommandOptions.dest);
      }
      if (subcommandOptions.description) {
        args.push('--description', subcommandOptions.description);
      }
      if (subcommandOptions.force) {
        args.push('--force');
      }
      if (subcommandOptions.evals === false) {
        args.push('--no-evals');
      }
      await runSkillCreatorTool('init', args);
    });

  skillCommand
    .command('validate <skillDir>')
    .description('Validate a skill directory using builtin skill-creator')
    .action(async (skillDir: string) => {
      await runSkillCreatorTool('validate', [skillDir]);
    });

  skillCommand
    .command('eval')
    .description('Run end-to-end skill evals and write a benchmark/review workspace')
    .requiredOption('--skill-path <dir>', 'Skill directory to evaluate')
    .requiredOption('--evals <file>', 'Evals JSON file')
    .requiredOption('--workspace <dir>', 'Workspace output directory')
    .option('--provider <name>', 'Provider to use')
    .option('--model <name>', 'Model override')
    .option('--runs <n>', 'Runs per config')
    .option('--max-iter <n>', 'Max iterations per run')
    .option('--reasoning <mode>', 'Reasoning mode', parseReasoningModeOption)
    .option('--cwd <dir>', 'Working directory for the runs')
    .option('--configs <list>', 'Comma-separated configs, e.g. with_skill,without_skill')
    .option('-o, --output <file>', 'Optional JSON summary output')
    .action(async (subcommandOptions: {
      skillPath: string;
      evals: string;
      workspace: string;
      provider?: string;
      model?: string;
      runs?: string;
      maxIter?: string;
      reasoning?: string;
      cwd?: string;
      configs?: string;
      output?: string;
    }) => {
      const args = [
        '--skill-path', subcommandOptions.skillPath,
        '--evals', subcommandOptions.evals,
        '--workspace', subcommandOptions.workspace,
      ];
      if (subcommandOptions.provider) {
        args.push('--provider', subcommandOptions.provider);
      }
      if (subcommandOptions.model) {
        args.push('--model', subcommandOptions.model);
      }
      if (subcommandOptions.runs) {
        args.push('--runs', subcommandOptions.runs);
      }
      if (subcommandOptions.maxIter) {
        args.push('--max-iter', subcommandOptions.maxIter);
      }
      if (subcommandOptions.reasoning) {
        args.push('--reasoning', subcommandOptions.reasoning);
      }
      if (subcommandOptions.cwd) {
        args.push('--cwd', subcommandOptions.cwd);
      }
      if (subcommandOptions.configs) {
        args.push('--configs', subcommandOptions.configs);
      }
      if (subcommandOptions.output) {
        args.push('--output', subcommandOptions.output);
      }
      await runSkillCreatorTool('eval', args);
    });

  skillCommand
    .command('grade <workspace>')
    .description('Grade eval runs into grading.json files')
    .option('--provider <name>', 'Provider to use')
    .option('--model <name>', 'Model override')
    .option('--reasoning <mode>', 'Reasoning mode', parseReasoningModeOption)
    .option('--max-iter <n>', 'Max iterations per grading run')
    .option('--configs <list>', 'Comma-separated configs, e.g. with_skill,without_skill')
    .option('--overwrite', 'Re-grade runs that already have grading.json')
    .action(async (workspace: string, subcommandOptions: {
      provider?: string;
      model?: string;
      reasoning?: string;
      maxIter?: string;
      configs?: string;
      overwrite?: boolean;
    }) => {
      const args = [workspace];
      if (subcommandOptions.provider) {
        args.push('--provider', subcommandOptions.provider);
      }
      if (subcommandOptions.model) {
        args.push('--model', subcommandOptions.model);
      }
      if (subcommandOptions.reasoning) {
        args.push('--reasoning', subcommandOptions.reasoning);
      }
      if (subcommandOptions.maxIter) {
        args.push('--max-iter', subcommandOptions.maxIter);
      }
      if (subcommandOptions.configs) {
        args.push('--configs', subcommandOptions.configs);
      }
      if (subcommandOptions.overwrite) {
        args.push('--overwrite');
      }
      await runSkillCreatorTool('grade', args);
    });

  skillCommand
    .command('analyze <workspace>')
    .description('Analyze benchmark variance and write analysis artifacts')
    .option('--benchmark <file>', 'Optional benchmark.json path')
    .option('--output <file>', 'JSON output path')
    .option('--markdown <file>', 'Markdown output path')
    .option('--skill-name <name>', 'Skill name if benchmark.json must be regenerated')
    .option('--provider <name>', 'Provider to use')
    .option('--model <name>', 'Model override')
    .option('--reasoning <mode>', 'Reasoning mode', parseReasoningModeOption)
    .action(async (workspace: string, subcommandOptions: {
      benchmark?: string;
      output?: string;
      markdown?: string;
      skillName?: string;
      provider?: string;
      model?: string;
      reasoning?: string;
    }) => {
      const args = [workspace];
      if (subcommandOptions.benchmark) {
        args.push('--benchmark', subcommandOptions.benchmark);
      }
      if (subcommandOptions.output) {
        args.push('--output', subcommandOptions.output);
      }
      if (subcommandOptions.markdown) {
        args.push('--markdown', subcommandOptions.markdown);
      }
      if (subcommandOptions.skillName) {
        args.push('--skill-name', subcommandOptions.skillName);
      }
      if (subcommandOptions.provider) {
        args.push('--provider', subcommandOptions.provider);
      }
      if (subcommandOptions.model) {
        args.push('--model', subcommandOptions.model);
      }
      if (subcommandOptions.reasoning) {
        args.push('--reasoning', subcommandOptions.reasoning);
      }
      await runSkillCreatorTool('analyze', args);
    });

  skillCommand
    .command('compare <workspace>')
    .description('Blind-compare two configs across eval run pairs')
    .option('--config-a <name>', 'Primary config', 'with_skill')
    .option('--config-b <name>', 'Baseline config', 'without_skill')
    .option('--output <file>', 'JSON output path')
    .option('--markdown <file>', 'Markdown output path')
    .option('--max-pairs <n>', 'Limit pairs per eval')
    .option('--provider <name>', 'Provider to use')
    .option('--model <name>', 'Model override')
    .option('--reasoning <mode>', 'Reasoning mode', parseReasoningModeOption)
    .action(async (workspace: string, subcommandOptions: {
      configA: string;
      configB: string;
      output?: string;
      markdown?: string;
      maxPairs?: string;
      provider?: string;
      model?: string;
      reasoning?: string;
    }) => {
      const args = [
        workspace,
        '--config-a', subcommandOptions.configA,
        '--config-b', subcommandOptions.configB,
      ];
      if (subcommandOptions.output) {
        args.push('--output', subcommandOptions.output);
      }
      if (subcommandOptions.markdown) {
        args.push('--markdown', subcommandOptions.markdown);
      }
      if (subcommandOptions.maxPairs) {
        args.push('--max-pairs', subcommandOptions.maxPairs);
      }
      if (subcommandOptions.provider) {
        args.push('--provider', subcommandOptions.provider);
      }
      if (subcommandOptions.model) {
        args.push('--model', subcommandOptions.model);
      }
      if (subcommandOptions.reasoning) {
        args.push('--reasoning', subcommandOptions.reasoning);
      }
      await runSkillCreatorTool('compare', args);
    });

  skillCommand
    .command('package <skillDir>')
    .description('Package a skill directory as a .skill archive')
    .option('-o, --output <file>', 'Output .skill file path')
    .action(async (skillDir: string, subcommandOptions: { output?: string }) => {
      const args = [skillDir];
      if (subcommandOptions.output) {
        args.push('--output', subcommandOptions.output);
      }
      await runSkillCreatorTool('package', args);
    });

  skillCommand
    .command('install <input>')
    .description('Install a skill directory or .skill archive into a skills directory')
    .option('-d, --dest <dir>', 'Destination skills directory')
    .option('-f, --force', 'Overwrite an existing target skill')
    .action(async (input: string, subcommandOptions: { dest?: string; force?: boolean }) => {
      const args = [input];
      if (subcommandOptions.dest) {
        args.push('--dest', subcommandOptions.dest);
      }
      if (subcommandOptions.force) {
        args.push('--force');
      }
      await runSkillCreatorTool('install', args);
    });

  if (argv[0] === 'skill') {
    if (argv.length === 1 || argv[1] === '-h' || argv[1] === '--help') {
      console.log(skillCommand.helpInformation());
      return;
    }

    const skillSubcommand = argv[1];
    if (skillSubcommand && (argv.includes('-h') || argv.includes('--help'))) {
      if (printSkillSubcommandHelp(skillSubcommand)) {
        return;
      }
    }
  }

  if (argv[0] === 'acp') {
    if (argv.length === 1 || argv[1] === '-h' || argv[1] === '--help') {
      console.log(acpCommand.helpInformation());
      return;
    }

    const acpSubcommand = argv[1];
    if (acpSubcommand && (argv.includes('-h') || argv.includes('--help'))) {
      if (printAcpSubcommandHelp(acpSubcommand)) {
        return;
      }
    }
  }

  // ============== tools subcommand (constructed-tool inventory) ==============
  // Lifecycle helpers for constructed tools — list / inspect / revoke.
  // Activate is intentionally NOT exposed here (must originate from the
  // REPL where a dialog can solicit user approval; see DD §14.5.4).
  const toolsCommand = program
    .command('tools')
    .description('Inspect and manage constructed tools (FEATURE_088, v0.7.28)')
    .helpOption('-h, --help', 'Show tools subcommand help');

  toolsCommand
    .command('list')
    .description('List constructed tools registered in the current workspace')
    .option('--all', 'Also list builtin / extension tools')
    .option('--cwd <dir>', 'Workspace root to inspect (defaults to current directory)')
    .action(async (subOpts: { all?: boolean; cwd?: string }) => {
      const { runToolsList } = await import('./constructed_cli.js');
      await runToolsList({ all: subOpts.all, cwd: subOpts.cwd ?? process.cwd() });
    });

  toolsCommand
    .command('inspect <spec>')
    .description("Print an artifact manifest. <spec> is '<name>' (active) or '<name>@<version>'.")
    .option('--cwd <dir>', 'Workspace root to inspect (defaults to current directory)')
    .action(async (spec: string, subOpts: { cwd?: string }) => {
      const { runToolsInspect } = await import('./constructed_cli.js');
      await runToolsInspect(spec, { cwd: subOpts.cwd ?? process.cwd() });
    });

  toolsCommand
    .command('revoke <spec>')
    .description("Revoke a constructed tool. <spec> must be '<name>@<version>'.")
    .option('--cwd <dir>', 'Workspace root to inspect (defaults to current directory)')
    .action(async (spec: string, subOpts: { cwd?: string }) => {
      const { runToolsRevoke } = await import('./constructed_cli.js');
      await runToolsRevoke(spec, { cwd: subOpts.cwd ?? process.cwd() });
    });

  // ============== constructed subcommand (FEATURE_090, v0.7.32) ==============
  // Self-modify lifecycle helpers for constructed agents — separate
  // command group from `kodax tools` because the surface targets
  // agent governance (budget reset, rollback, audit, disable), not
  // tool inventory. Activate is intentionally NOT exposed here for
  // the same reason as tools — must originate from the REPL where a
  // dialog can render the diff + LLM summary and solicit user
  // approval.
  const constructedCommand = program
    .command('constructed')
    .description('Manage the self-modify lifecycle of constructed agents (FEATURE_090, v0.7.32)')
    .helpOption('-h, --help', 'Show constructed subcommand help');

  constructedCommand
    .command('reset-self-modify-budget <name>')
    .description(
      'Reset the per-agent self-modify counter to zero. Use after a deliberate, audited decision to allow further self-modifications past the default cap. The reset is recorded in `.kodax/constructed/_audit.jsonl`.',
    )
    .option('--cwd <dir>', 'Workspace root to inspect (defaults to current directory)')
    .action(async (name: string, subOpts: { cwd?: string }) => {
      const { runResetSelfModifyBudget } = await import('./self_modify_cli.js');
      await runResetSelfModifyBudget(name, { cwd: subOpts.cwd ?? process.cwd() });
    });

  constructedCommand
    .command('audit <name>')
    .description(
      'Print every recorded self-modify lifecycle event for the named agent (staged / activated / rejected / rolled-back / disabled / budget-reset). Read-only.',
    )
    .option('--cwd <dir>', 'Workspace root to inspect (defaults to current directory)')
    .action(async (name: string, subOpts: { cwd?: string }) => {
      const { runConstructedAudit } = await import('./self_modify_cli.js');
      await runConstructedAudit(name, { cwd: subOpts.cwd ?? process.cwd() });
    });

  constructedCommand
    .command('disable-self-modify <name>')
    .description(
      'Permanently disable self-modify for the named agent. There is NO re-enable command — to author further changes, stage a separately-named agent. The disable event is recorded in `.kodax/constructed/_audit.jsonl`.',
    )
    .option('--cwd <dir>', 'Workspace root to inspect (defaults to current directory)')
    .action(async (name: string, subOpts: { cwd?: string }) => {
      const { runDisableSelfModify } = await import('./self_modify_cli.js');
      await runDisableSelfModify(name, { cwd: subOpts.cwd ?? process.cwd() });
    });

  constructedCommand
    .command('rollback <name>')
    .description(
      "Roll the agent back to its previous active version. Revokes the current active manifest and re-registers the next-most-recent active version on disk. Re-runs admission against the rollback target so a target that no longer admits (e.g. system caps tightened) cannot be silently re-registered.",
    )
    .option('--cwd <dir>', 'Workspace root to inspect (defaults to current directory)')
    .action(async (name: string, subOpts: { cwd?: string }) => {
      const { runConstructedRollback } = await import('./self_modify_cli.js');
      await runConstructedRollback(name, { cwd: subOpts.cwd ?? process.cwd() });
    });

  // ============== constructed-tool direct dispatch ==============
  // BEFORE commander parses, intercept `kodax <constructed-tool-name> ...`
  // and dispatch to the registered handler. The detection bootstraps the
  // ConstructionRuntime and consults TOOL_REGISTRY — only fires when the
  // name matches an activated constructed tool. On no match we fall
  // through to commander, which preserves existing behavior (skill/acp/
  // help topics/REPL).
  if (argv.length > 0 && argv[0] && !argv[0].startsWith('-') && !CLI_SUBCOMMAND_NAMES.has(argv[0])) {
    const { detectConstructedToolDispatch, runConstructedToolDispatch } = await import('./constructed_cli.js');
    const dispatchTarget = await detectConstructedToolDispatch(argv, process.cwd());
    if (dispatchTarget) {
      await runConstructedToolDispatch(dispatchTarget, argv.slice(1), process.cwd());
      return;
    }
  }

  await program.parseAsync(process.argv);
  if (
    argv[0] !== undefined
    && CLI_SUBCOMMAND_NAMES.has(argv[0])
  ) {
    return;
  }

  const opts = program.opts();
  // Parse CLI options and merge with config defaults.
  const config = prepareRuntimeConfig();
  const configWithExtensions = config as typeof config & { extensions?: string[] };
  if (typeof opts.repoIntelligence === 'string' && opts.repoIntelligence.trim()) {
    process.env.KODAX_REPO_INTELLIGENCE = opts.repoIntelligence.trim();
  }
  if (opts.repoIntelligenceTrace === true) {
    process.env.KODAX_REPO_INTELLIGENCE_TRACE = '1';
  }
  const reasoningMode = resolveCliReasoningMode(program, opts, config);
  const effort = resolveCliEffort(program, opts, config);
  const agentMode = resolveCliAgentMode(program, opts, config);
  const configuredExtensions = Array.isArray(configWithExtensions.extensions)
    ? configWithExtensions.extensions
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .map((value) => path.isAbsolute(value) ? value : path.resolve(path.dirname(KODAX_CONFIG_FILE), value))
    : [];
  const cliExtensions = Array.isArray(opts.extension)
    ? opts.extension
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .map((value) => path.resolve(value))
    : [];
  const discoveredExtensions = await discoverCliDefaultExtensions();
  const dedupedDiscoveredExtensions = await dedupeExtensionPathsByEntrypoint(discoveredExtensions);
  const dedupedConfiguredExtensions = await dedupeExtensionPathsByEntrypoint(configuredExtensions);
  const dedupedCliExtensions = await dedupeExtensionPathsByEntrypoint(cliExtensions);
  const configuredOnlyExtensions = await excludeExtensionPathsByEntrypoint(
    dedupedConfiguredExtensions,
    dedupedCliExtensions,
  );
  const discoveredOnlyExtensions = await excludeExtensionPathsByEntrypoint(
    dedupedDiscoveredExtensions,
    [...dedupedConfiguredExtensions, ...dedupedCliExtensions],
  );
  const activeExtensions = [
    ...discoveredOnlyExtensions,
    ...configuredOnlyExtensions,
    ...dedupedCliExtensions,
  ];
  const hasActiveMcp = hasConfiguredMcpServers(configWithExtensions);
  const selectedProvider = opts.provider ?? config.provider ?? KODAX_DEFAULT_PROVIDER;
  const selectedModel = resolveCliModelSelection(
    opts.provider,
    opts.model,
    config.provider,
    config.model,
  );
  const sessionFlags = normalizeCliSessionFlags(opts);
  // -y/--auto is kept for backward compatibility but has no effect in CLI.
  const options: CliOptions = {
    // Priority: CLI args > config file > defaults.
    provider: selectedProvider,
    model: selectedModel,
    effort,
    thinking: reasoningMode !== 'off',
    reasoningMode,
    agentMode,
    outputMode: (opts.mode as CliOutputMode | undefined) ?? 'text',
    extensions: activeExtensions,
    session: sessionFlags.session,
    maxIter: parseOptionalNonNegativeInt(opts.maxIter),
    prompt: opts.print ? [opts.print] : program.args,
    continue: opts.continue ?? false,
    resume: opts.resume,
    noSession: sessionFlags.noSession,
    print: opts.print ? true : false,
  };
  let extensionRuntime: ReturnType<typeof createExtensionRuntime> | undefined;
  let shouldHardExitAfterInteractiveCleanup = false;

  try {
  const isLegacySessionManagement =
    options.session === 'list'
    || options.session === 'delete'
    || options.session === 'delete-all'
    || options.session?.startsWith('delete ');

  if (options.outputMode === 'json' && isLegacySessionManagement) {
    validateCliModeSelection(options, { resumeWithoutId: opts.resume === true });
  }

  // Session list: show all saved sessions.
  if (options.session === 'list') {
    const storage = new FileSessionStorage();
    const sessions = await storage.list();
    console.log(sessions.length ? 'Sessions:\n' + sessions.map(s => `  ${s.id} [${s.msgCount}] ${s.title}`).join('\n') : 'No sessions.');
    return;
  }

  if (options.session === 'delete-all') {
    const storage = new FileSessionStorage();
    await storage.deleteAll();
    console.log('Deleted all sessions.');
    return;
  }

  const sessionOperation = options.session;
  if (sessionOperation === 'delete' || sessionOperation?.startsWith('delete ')) {
    const quotedId = sessionOperation.startsWith('delete ')
      ? sessionOperation.slice('delete '.length).trim()
      : undefined;
    const positionalId = sessionOperation === 'delete' ? options.prompt[0]?.trim() : undefined;
    const sessionId = quotedId || positionalId;
    if (!sessionId) {
      throw new Error('`-s delete` requires a session id. Usage: kodax -s delete <id>');
    }
    if (sessionOperation === 'delete' && options.prompt.length > 1) {
      throw new Error('`-s delete` accepts exactly one session id.');
    }
    const storage = new FileSessionStorage();
    await storage.delete(sessionId);
    console.log(`Deleted session: ${sessionId}`);
    return;
  }

  let userPrompt = options.prompt.join(' ');

  // -h / --help [topic]: show basic help or a detailed help topic
  if (opts.help !== undefined) {
    if (typeof opts.help === 'string') {
      const topic = opts.help.toLowerCase();
      if (showCliHelpTopic(topic)) {
        return;
      }
      console.log(chalk.yellow(`\n[Unknown help topic: ${topic}]`));
      showCliHelpTopics();
      return;
    }
  // No topic specified: show basic help overview.
    showBasicHelp();
    return;
  }

  validateCliModeSelection(options, { resumeWithoutId: opts.resume === true });

  if ((options.extensions?.length ?? 0) > 0 || hasActiveMcp) {
    extensionRuntime = createExtensionRuntime({ config });
    // FEATURE_222 — expose the workspace as MCP roots, and (interactive mode)
    // serve elicitation through the REPL's live ask-user dialogs. In print /
    // non-interactive mode no interaction surface registers, so elicitation
    // requests safely decline.
    await registerConfiguredMcpCapabilityProvider(extensionRuntime, configWithExtensions.mcpServers, {
      reverse: buildMcpReverseCapabilities({ cwd: process.cwd(), enableElicitation: true }),
    });
    const extensionLoader = extensionRuntime as typeof extensionRuntime & {
      loadExtensions: (
        paths: string[],
        options?: { continueOnError?: boolean; loadSource?: 'discovery' | 'config' | 'cli' | 'api' },
      ) => Promise<void>;
    };
    await extensionLoader.loadExtensions(discoveredOnlyExtensions, {
      continueOnError: true,
      loadSource: 'discovery',
    });
    await extensionLoader.loadExtensions(configuredOnlyExtensions, {
      continueOnError: true,
      loadSource: 'config',
    });
    await extensionLoader.loadExtensions(dedupedCliExtensions, {
      continueOnError: true,
      loadSource: 'cli',
    });
    options.extensionRuntime = extensionRuntime;
    extensionRuntime.activate();
  }

  // -r / --resume without ID: list sessions, then resume the latest.
  if (opts.resume === true) {
    try {
      const storage = new FileSessionStorage({ cwd: process.cwd() });
      const sessions = await storage.list();
      if (sessions.length === 0) {
        console.log(chalk.yellow('No sessions found. Starting new session...'));
      } else {
        console.log(chalk.cyan('Recent sessions:'));
        sessions.forEach((s, i) => {
          console.log(`  ${i + 1}. ${s.id} [${s.msgCount} msgs] ${s.title}`);
        });
        // Auto-select the most recent session for resume.
        const selected = sessions[0]!;
        options.resume = selected.id;
        console.log(chalk.cyan(`\nResuming session: ${selected.id}`));
      }
    } catch (error) {
      console.log(chalk.yellow('Failed to list sessions. Starting new session...'));
    }
  }

  // Command dispatch for /command-style invocations.
  if (userPrompt.startsWith('/')) {
    const parsed = parseCommandCall(userPrompt);
    if (parsed) {
      const [commandName, args] = parsed;
      const commands = await loadCommands();
      if (commands.has(commandName)) {
        const kodaXOptions = createKodaXOptions(options, false);
        const commandPrompt = await processCommandCall(
          commandName,
          args,
          commands,
          (prompt: string) => runManagedTask({
            ...kodaXOptions,
            context: {
              ...kodaXOptions.context,
              taskSurface: 'cli',
            },
          }, prompt)
        );
        if (commandPrompt) {
          const result = await runManagedTask({
            ...kodaXOptions,
            context: {
              ...kodaXOptions.context,
              taskSurface: 'cli',
            },
          }, commandPrompt);
          emitJsonRunResultIfNeeded(options.outputMode, result);
          return;
        }
      }
    }
  }
  // No prompt and not in print mode: enter interactive mode
  if (!userPrompt && !options.print) {
    const kodaXOptions = createKodaXOptions(options, false);
    const interactiveSurface = resolveInteractiveSurfacePreference();
    const useClassicInteractiveMode = interactiveSurface === 'classic';
    // Pass FileSessionStorage for persisted sessions.
    try {
      if (useClassicInteractiveMode) {
        console.error(chalk.dim(
          '\n[Terminal compatibility] Using classic REPL because this terminal host cannot safely run the fullscreen TUI.',
        ));
        console.error(chalk.dim(
          'Set KODAX_FORCE_INK=1 or KODAX_TUI_RENDERER=owned to override, or KODAX_FORCE_CLASSIC_REPL=1 to keep this mode everywhere.\n',
        ));
      }

      const runtimeMode = resolveCliRuntimeMode(options.runtimeMode);
      const runtimeHomeDir = resolveDefaultRuntimeDaemonHomeDir();
      const runtimeProfile = 'default';
      const interactiveRuntime = await createKodaXRuntime({
        mode: runtimeMode,
        homeDir: runtimeHomeDir,
        profile: runtimeProfile,
        autoStartDaemon: runtimeMode === 'daemon',
        ...(kodaXOptions.provider !== undefined ? { defaultProvider: kodaXOptions.provider } : {}),
        ...(kodaXOptions.model !== undefined ? { defaultModel: kodaXOptions.model } : {}),
      });
      const runtimeRunner = async (input: {
        readonly options: KodaXOptions;
        readonly prompt: string;
        readonly sessionId: string;
      }): Promise<Awaited<ReturnType<typeof runManagedTask>>> => {
        try {
          await interactiveRuntime.sessions.load(input.sessionId);
        } catch (error: unknown) {
          if (!(error instanceof Error) || !error.message.startsWith('Session not found:')) {
            throw error;
          }
          await interactiveRuntime.sessions.create({
            sessionId: input.sessionId,
            title: 'REPL Session',
            projectPath: process.cwd(),
            gitRoot: await getGitRoot() ?? process.cwd(),
            surface: 'repl',
          });
        }
        const handle = await interactiveRuntime.runs.start({
          sessionId: input.sessionId,
          prompt: input.prompt,
          mode: 'managed_task',
          options: input.options,
        });
        const result = await handle.result;
        if (result.error) {
          throw result.error;
        }
        if (!result.result) {
          if (result.phase === 'cancelled' || result.phase === 'interrupted') {
            return {
              success: false,
              lastText: '',
              messages: [],
              sessionId: input.sessionId,
              interrupted: true,
              signal: 'BLOCKED',
              signalReason: 'Runtime run cancelled.',
            };
          }
          throw new Error(`Runtime run ${handle.runId} ended without a result.`);
        }
        return result.result;
      };

      const interactiveOptions = {
        provider: kodaXOptions.provider,
        model: kodaXOptions.model,
        effort: kodaXOptions.effort,
        thinking: kodaXOptions.thinking,
        reasoningMode: kodaXOptions.reasoningMode,
        agentMode: kodaXOptions.agentMode,
        maxIter: kodaXOptions.maxIter,
        extensionRuntime: kodaXOptions.extensionRuntime,
        session: kodaXOptions.session,
        storage: new FileSessionStorage({ cwd: process.cwd() }),
        runtimeRunner,
        getRuntimeStatus: () => getInteractiveRuntimeStatus({
          runtime: interactiveRuntime,
          homeDir: runtimeHomeDir,
          profile: runtimeProfile,
        }),
        hardExitOnClose: false,
      };

      // F1 — first launch with no config.json: drop a commented config.example.jsonc
      // reference next to it and point the user at it (one time only).
      const exampleConfigPath = ensureExampleConfigFile();
      if (exampleConfigPath) {
        console.error(chalk.dim(
          `\n[First launch] No config found. Wrote an annotated example to ${exampleConfigPath}\n` +
          `Copy the fields you need into config.json (custom providers, models, thinking config).\n`,
        ));
      }

      if (useClassicInteractiveMode) {
        try {
          await runInteractiveMode(interactiveOptions);
        } finally {
          await interactiveRuntime.close();
        }
      } else {
        try {
          await runInkInteractiveMode(interactiveOptions);
        } finally {
          await interactiveRuntime.close();
        }
      }
      shouldHardExitAfterInteractiveCleanup = true;
    } catch (error) {
      if (error instanceof KodaXTerminalError) {
        console.error(chalk.red(`\n[Error] ${error.message}`));
        console.error(chalk.dim("\nYour terminal environment does not support interactive mode."));
        console.error(chalk.dim("\nPlease use CLI mode instead:"));
        for (const suggestion of error.suggestions) {
          console.error(chalk.cyan(`  ${suggestion}`));
        }
        console.error();
        process.exitCode = 1;
      } else {
        throw error;
      }
    }
    return;
  }

  // No prompt + --print: show basic help and exit.
  if (!userPrompt && options.print) {
    showBasicHelp();
    return;
  }

  // Run a single managed task in print mode and exit.
  const kodaXOptions = createKodaXOptions(options, options.print ?? false);
  const result = await runManagedTask({
    ...kodaXOptions,
    context: {
      ...kodaXOptions.context,
      taskSurface: 'cli',
    },
  }, userPrompt);
  emitJsonRunResultIfNeeded(options.outputMode, result);
  } finally {
    await extensionRuntime?.dispose();
    extensionRuntime = undefined;
    await shutdownDefaultLspService();
    await cleanupRegisteredManagedChildren({ includeCurrentOwner: true });
    await shutdownTracing();
    if (shouldHardExitAfterInteractiveCleanup && process.env.VITEST !== 'true') {
      process.exit(process.exitCode ?? 0);
    }
  }
}

/**
 * Entry Point Detection
 *
 * Determines if this module is being run as the main entry point.
 * This is necessary because:
 * 1. When run directly (e.g., `node dist/kodax_cli.js`), we should execute main()
 * 2. When imported for testing, we should NOT execute main()
 * 3. When run via npm link, the paths may differ due to symlinks
 *
 * Detection logic:
 * - Direct execution: import.meta.url === pathToFileURL(process.argv[1]).href
 * - npm link: import.meta.url ends with '/dist/kodax_cli.js' while process.argv[1]
 *   points to the symlinked global bin
 */
const scriptPath = process.argv[1];
const metaUrl = import.meta.url;
const scriptUrl = scriptPath ? pathToFileURL(scriptPath).href : '';

// Check if this is the main module
// Primary: exact URL match (direct execution)
// Fallback: check if module path ends with the expected dist file (npm link scenario)
const isMainModule = scriptPath && (
  metaUrl === scriptUrl ||
  metaUrl.endsWith('/dist/kodax_cli.js')
);

if (isMainModule) {
  main().catch(e => { console.error(chalk.red(`[Error] ${e.message}`)); process.exit(1); });
}

// Export for testing
export { main };
