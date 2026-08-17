import { EventEmitter, once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { readProcessStartIdentity, SkillRegistry } from '@kodax-ai/agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireFileSystemMutationLease } from '../packages/coding/src/tools/_internal/file-mutation-queue.js';

const capturedBrokerRequests = vi.hoisted(
  () => [] as Array<Readonly<Record<string, unknown>>>,
);
const capturedSpawnEnvironments = vi.hoisted(
  () => [] as NodeJS.ProcessEnv[],
);
const capturedSpawnArgv = vi.hoisted(
  () => [] as string[][],
);
const capturedSpawnCwds = vi.hoisted(
  () => [] as Array<string | undefined>,
);
const capturedSyncSpawns = vi.hoisted(
  () => [] as Array<{
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd?: string;
    readonly input?: string;
  }>,
);
const capturedWrappedCommands = vi.hoisted(
  () => [] as string[],
);
const capturedWorkspaceSessionConfigs = vi.hoisted(
  () => [] as Array<Readonly<Record<string, unknown>>>,
);
const capturedWorkspaceRequests = vi.hoisted(
  () => [] as Array<Readonly<Record<string, unknown>>>,
);
const capturedSandboxWrapConfigs = vi.hoisted(
  () => [] as Array<Readonly<Record<string, unknown>>>,
);
const capturedKillSignals = vi.hoisted(
  () => [] as Array<NodeJS.Signals | number | undefined>,
);
const capturedProcessTreeKillOptions = vi.hoisted(
  () => [] as Array<Readonly<Record<string, unknown>>>,
);
const processTreeKillMock = vi.hoisted(() => ({
  outcome: 'actual' as 'actual' | 'unknown' | 'close_then_unknown' | 'close_then_reject',
  childPid: undefined as number | undefined,
  releaseUnknown: undefined as (() => void) | undefined,
}));
const processIdentityMock = vi.hoisted(() => ({
  windowsBootIdentity: 'windows-boot-100' as string | undefined,
  pid4StartIdentity: '13370000000000' as string | undefined,
  unreadablePids: new Set<number>(),
}));
const recoveryLockMock = vi.hoisted(() => ({
  timeoutFailures: 0,
  timeoutOnCall: undefined as number | undefined,
  calls: 0,
  releaseFailures: 0,
  beforeOperation: undefined as (() => void | Promise<void>) | undefined,
}));
const fileSystemMock = vi.hoisted(() => ({
  rmFailurePath: undefined as string | undefined,
  writeBrokerRequestFailure: false,
  writeAclPoisonMarkerFailure: false,
  renameAclPoisonMarkerFailures: 0,
  aclPoisonMarkerWriteTargets: [] as string[],
}));
const stubbornBroker = vi.hoisted(() => ({
  mode: 'none' as 'none' | 'silent' | 'overflow',
}));
const deferredBrokerRead = vi.hoisted(() => ({
  enabled: false,
  missing: false,
}));
const sandboxInitialize = vi.hoisted(
  () => vi.fn<() => Promise<void>>(() => Promise.resolve()),
);
const sandboxWrapper = vi.hoisted(() => ({
  mode: 'attest' as 'attest' | 'late_marker' | 'missing' | 'spawn_error',
}));
const workspaceSessionControl = vi.hoisted(() => ({
  delayReady: false,
  releaseReady: undefined as (() => void) | undefined,
  delayWrap: false,
  releaseWrap: undefined as (() => void) | undefined,
  wrapFailure: undefined as string | undefined,
  cleanupFailure: undefined as string | undefined,
  delayCleanup: false,
  releaseCleanup: undefined as (() => void) | undefined,
  afterWrapResponse: undefined as (() => void) | undefined,
  cleanupRequests: 0,
  malformedReady: false,
  delayClose: false,
  releaseClose: undefined as (() => void) | undefined,
  closeExitCode: 0,
}));
const windowsSandboxMock = vi.hoisted(() => ({
  runnerSource: '',
  wfpOutcome: 'blocked' as 'blocked' | 'access_denied' | 'timeout',
  aclRecoveryOutcome: 'success' as 'success' | 'failure' | 'malformed',
  aclRecoveryOutcomes: [] as Array<'success' | 'failure' | 'malformed'>,
  guardReady: true,
  user: {
    provisioned: true,
    sid: 'S-1-5-21-1000',
    groupExists: true,
    groupSid: 'S-1-5-21-1001',
    inBuiltinUsers: true,
    inSandboxGroup: true,
    hiddenFromLogon: true,
    credPresent: true,
    markerVersion: 1,
    realUserSid: 'S-1-5-21-1002',
  },
  grantFailure: undefined as string | undefined,
  grants: [] as Array<Readonly<Record<string, unknown>>>,
  revokes: [] as Array<Readonly<Record<string, unknown>>>,
  installCalls: 0,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rm: vi.fn(async (target: string | URL, options?: Parameters<typeof actual.rm>[1]) => {
      if (typeof target === 'string' && target === fileSystemMock.rmFailurePath) {
        throw Object.assign(new Error('injected rm EPERM'), { code: 'EPERM' });
      }
      await actual.rm(target, options);
    }),
    writeFile: vi.fn(async (...args: Parameters<typeof actual.writeFile>) => {
      const target = args[0];
      if (
        fileSystemMock.writeBrokerRequestFailure
        && typeof target === 'string'
        && path.basename(target).startsWith('kodax-asrt-')
      ) {
        throw Object.assign(new Error('injected broker request write failure'), { code: 'EPERM' });
      }
      await actual.writeFile(...args);
    }),
  };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    renameSync: vi.fn((
      oldPath: Parameters<typeof actual.renameSync>[0],
      newPath: Parameters<typeof actual.renameSync>[1],
    ) => {
      if (
        fileSystemMock.renameAclPoisonMarkerFailures > 0
        && typeof newPath === 'string'
        && path.basename(newPath).startsWith('unconfirmed-owner-')
      ) {
        fileSystemMock.renameAclPoisonMarkerFailures -= 1;
        throw Object.assign(new Error('injected ACL poison marker rename failure'), { code: 'EPERM' });
      }
      return actual.renameSync(oldPath, newPath);
    }),
    writeFileSync: vi.fn((
      target: Parameters<typeof actual.writeFileSync>[0],
      data: Parameters<typeof actual.writeFileSync>[1],
      options?: Parameters<typeof actual.writeFileSync>[2],
    ) => {
      if (
        typeof target === 'string'
        && path.basename(path.dirname(target)).startsWith('acl-poison')
      ) {
        fileSystemMock.aclPoisonMarkerWriteTargets.push(target);
      }
      if (
        fileSystemMock.writeAclPoisonMarkerFailure
        && typeof target === 'string'
        && path.basename(path.dirname(target)).startsWith('acl-poison')
      ) {
        throw Object.assign(new Error('injected ACL poison marker write failure'), { code: 'EPERM' });
      }
      return actual.writeFileSync(target, data, options);
    }),
  };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawnSync: vi.fn((
      command: string,
      args: readonly string[] = [],
      options?: { readonly cwd?: string; readonly input?: string },
    ) => {
      capturedSyncSpawns.push({
        command,
        args: [...args],
        cwd: options?.cwd,
        input: options?.input,
      });
      if (command === process.execPath && args.length === 1 && args[0] === '--version') {
        return {
          status: 0,
          signal: null,
          stdout: `${process.version}\n`,
          stderr: '',
        };
      }
      const encodedIndex = args.indexOf('-EncodedCommand');
      if (encodedIndex >= 0) {
        const script = Buffer.from(args[encodedIndex + 1] ?? '', 'base64').toString('utf16le');
        if (script.includes('KodaXWindowsBootIdentity-v1')) {
          return {
            status: processIdentityMock.windowsBootIdentity === undefined ? 1 : 0,
            signal: null,
            stdout: processIdentityMock.windowsBootIdentity?.replace('windows-boot-', '') ?? '',
            stderr: '',
          };
        }
        if (script.includes('KodaXAsrtAclGuard-v1')) {
          const payload = JSON.parse(options?.input ?? '{}') as {
            readonly install?: boolean;
            readonly paths?: readonly { readonly path: string }[];
          };
          const missing = windowsSandboxMock.guardReady || payload.install === true
            ? []
            : (payload.paths ?? []).map((entry) => entry.path);
          if (payload.install === true) windowsSandboxMock.guardReady = true;
          return {
            status: 0,
            signal: null,
            stdout: JSON.stringify({ missing }),
            stderr: '',
          };
        }
      }
      if (args.includes('wfp') && args.includes('verify')) {
        if (windowsSandboxMock.wfpOutcome === 'timeout') {
          return {
            status: null,
            signal: 'SIGTERM',
            stdout: '',
            stderr: '',
            error: Object.assign(new Error('spawnSync ETIMEDOUT'), { code: 'ETIMEDOUT' }),
          };
        }
        if (windowsSandboxMock.wfpOutcome === 'access_denied') {
          return {
            status: 1,
            signal: null,
            stdout: '',
            stderr: 'CreateProcessWithLogonW(srt-sandbox): 拒绝访问。 (0x80070005)',
          };
        }
        return {
          status: 0,
          signal: null,
          stdout: JSON.stringify({
            egress_probe: 'blocked',
            target: '127.0.0.1:49152',
            runner_exit: 0,
          }),
          stderr: 'BLOCKED',
        };
      }
      if (args.includes('acl') && args.includes('recover')) {
        const outcome = windowsSandboxMock.aclRecoveryOutcomes.shift()
          ?? windowsSandboxMock.aclRecoveryOutcome;
        if (outcome === 'failure') {
          return {
            status: 1,
            signal: null,
            stdout: '',
            stderr: 'injected ACL recovery failure',
          };
        }
        return {
          status: 0,
          signal: null,
          stdout: outcome === 'malformed'
            ? 'not-json'
            : JSON.stringify({ deadBrokers: 1, acesRevoked: 2 }),
          stderr: '',
        };
      }
      return actual.spawnSync(command, args, options);
    }),
    spawn: vi.fn((
      command: string,
      argsOrOptions?: readonly string[] | object,
      explicitOptions?: object,
    ) => {
      if (Array.isArray(argsOrOptions)) {
        capturedSpawnArgv.push([command, ...argsOrOptions]);
      }
      const options = Array.isArray(argsOrOptions) ? explicitOptions : argsOrOptions;
      if (options !== undefined) {
        const environment = (options as { readonly env?: NodeJS.ProcessEnv }).env;
        if (environment !== undefined) capturedSpawnEnvironments.push(environment);
        capturedSpawnCwds.push((options as { readonly cwd?: string }).cwd);
      }
      const child = new EventEmitter() as EventEmitter & {
        stdin: PassThrough;
        stdout: PassThrough;
        stderr: PassThrough;
        stdio: [PassThrough, PassThrough, PassThrough, PassThrough];
        kill: ReturnType<typeof vi.fn>;
        ref: ReturnType<typeof vi.fn>;
        unref: ReturnType<typeof vi.fn>;
        pid: number | undefined;
        exitCode: number | null;
        signalCode: NodeJS.Signals | null;
      };
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      const control = new PassThrough();
      child.stdio = [child.stdin, child.stdout, child.stderr, control];
      child.ref = vi.fn();
      child.unref = vi.fn();
      child.pid = processTreeKillMock.childPid;
      child.exitCode = null;
      child.signalCode = null;
      child.kill = vi.fn((signal?: NodeJS.Signals | number) => {
        capturedKillSignals.push(signal);
        if (signal === 'SIGKILL') {
          queueMicrotask(() => {
            child.signalCode = 'SIGKILL';
            child.stdout.end();
            child.stderr.end();
            child.emit('close', null, 'SIGKILL');
            child.emit('exit', null, 'SIGKILL');
          });
        }
        return true;
      });
      const requestFile = Array.isArray(argsOrOptions) ? argsOrOptions.at(-1) : undefined;
      const workspaceSession = Array.isArray(argsOrOptions)
        && typeof requestFile === 'string'
        && path.basename(requestFile).startsWith('workspace-')
        && requestFile.endsWith('.json');
      if (workspaceSession) {
        if (typeof requestFile === 'string') {
          const init = JSON.parse(readFileSync(requestFile, 'utf8')) as {
            readonly config: Readonly<Record<string, unknown>>;
          };
          capturedWorkspaceSessionConfigs.push(init.config);
          rmSync(requestFile, { force: true });
        }
        let input = '';
        child.stdin.on('data', (chunk: Buffer) => {
          input += chunk.toString('utf8');
          let newline = input.indexOf('\n');
          while (newline >= 0) {
            const line = input.slice(0, newline);
            input = input.slice(newline + 1);
            const message = JSON.parse(line) as {
              readonly id: string;
              readonly type: 'wrap' | 'cleanup';
              readonly request?: Readonly<Record<string, unknown>> & {
                readonly targetStartedMarker?: string;
              };
            };
            if (message.type === 'wrap' && message.request !== undefined) {
              capturedWorkspaceRequests.push(message.request);
            }
            if (message.type === 'cleanup') workspaceSessionControl.cleanupRequests += 1;
            const response = message.type === 'wrap'
              ? workspaceSessionControl.wrapFailure === undefined ? {
                  id: message.id,
                  type: 'result',
                  ok: true,
                  invocation: {
                    executable: process.execPath,
                    args: ['--version'],
                    env: {},
                    shell: false,
                  },
                } : {
                  id: message.id,
                  type: 'result',
                  ok: false,
                  error: workspaceSessionControl.wrapFailure,
                }
              : workspaceSessionControl.cleanupFailure === undefined
                ? { id: message.id, type: 'result', ok: true }
                : {
                    id: message.id,
                    type: 'result',
                    ok: false,
                    error: workspaceSessionControl.cleanupFailure,
                  };
            const reportResponse = (): void => {
              control.write(`${JSON.stringify(response)}\n`);
              if (message.type === 'wrap') workspaceSessionControl.afterWrapResponse?.();
            };
            if (message.type === 'wrap' && workspaceSessionControl.delayWrap) {
              workspaceSessionControl.releaseWrap = reportResponse;
            } else if (message.type === 'cleanup' && workspaceSessionControl.delayCleanup) {
              workspaceSessionControl.releaseCleanup = reportResponse;
            } else {
              reportResponse();
            }
            newline = input.indexOf('\n');
          }
        });
        child.stdin.once('finish', () => {
          if (stubbornBroker.mode !== 'none') return;
          const completeClose = (): void => {
            control.end();
            child.exitCode = workspaceSessionControl.closeExitCode;
            child.emit('exit', workspaceSessionControl.closeExitCode, null);
            child.emit('close', workspaceSessionControl.closeExitCode, null);
          };
          if (workspaceSessionControl.delayClose) {
            workspaceSessionControl.releaseClose = completeClose;
          } else {
            completeClose();
          }
        });
        queueMicrotask(() => {
          child.emit('spawn');
          const reportReady = (): void => {
            control.write(workspaceSessionControl.malformedReady
              ? '{malformed\n'
              : `${JSON.stringify({ type: 'ready', ok: true })}\n`);
          };
          if (workspaceSessionControl.delayReady) {
            workspaceSessionControl.releaseReady = reportReady;
          } else {
            reportReady();
          }
        });
        return child;
      }
      const captureRequest = (): void => {
        if (typeof requestFile !== 'string' || !requestFile.endsWith('.json')) return;
        const request = JSON.parse(readFileSync(requestFile, 'utf8')) as { readonly cwd?: string };
        capturedBrokerRequests.push(request);
        if (request.cwd) {
          mkdirSync(path.join(request.cwd, 'outputs'), { recursive: true });
          writeFileSync(path.join(request.cwd, 'outputs', 'report.txt'), 'report');
        }
      };
      const complete = (): void => {
        if (sandboxWrapper.mode === 'spawn_error') {
          sandboxWrapper.mode = 'attest';
          child.stderr.end('wrapper spawn failed');
          child.emit('error', new Error('wrapper spawn failed'));
          child.emit('close', null, null);
          return;
        }
        child.emit('spawn');
        child.stdout.end('sandbox output');
        if (
          sandboxWrapper.mode === 'attest'
          || sandboxWrapper.mode === 'late_marker'
        ) {
          const wrappedCommand = capturedWrappedCommands.at(-1);
          const encoded = wrappedCommand?.trim().split(/\s+/).at(-1);
          if (encoded !== undefined) {
            const payload = JSON.parse(
              Buffer.from(encoded, 'base64').toString('utf8'),
            ) as { readonly targetStartedMarker?: string };
            if (payload.targetStartedMarker !== undefined) {
              if (sandboxWrapper.mode === 'late_marker') {
                child.emit('exit', 0, null);
              }
              child.stderr.write(payload.targetStartedMarker);
            }
          }
        }
        child.stderr.end();
        child.emit('close', sandboxWrapper.mode === 'missing' ? 1 : 0);
        if (sandboxWrapper.mode !== 'late_marker') {
          child.emit('exit', sandboxWrapper.mode === 'missing' ? 1 : 0, null);
        }
      };
      if (deferredBrokerRead.enabled && typeof requestFile === 'string') {
        setImmediate(() => {
          try {
            captureRequest();
          } catch {
            deferredBrokerRead.missing = true;
          }
          complete();
        });
        return child;
      }
      captureRequest();
      if (stubbornBroker.mode !== 'none') {
        queueMicrotask(() => child.emit('spawn'));
        if (stubbornBroker.mode === 'overflow') {
          queueMicrotask(() => child.stdout.write('output-over-limit'));
        }
        return child;
      }
      queueMicrotask(complete);
      return child;
    }),
  };
});

vi.mock('@kodax-ai/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kodax-ai/agent')>();
  return {
    ...actual,
    readProcessStartIdentity: (pid: number) => (
      processIdentityMock.unreadablePids.has(pid)
        ? undefined
        : pid === 4
        ? processIdentityMock.pid4StartIdentity
        : actual.readProcessStartIdentity(pid)
    ),
    killChildProcessTree: (
      child: Parameters<typeof actual.killChildProcessTree>[0],
      options: Parameters<typeof actual.killChildProcessTree>[1] = {},
    ) => {
      capturedProcessTreeKillOptions.push({ ...options });
      if (processTreeKillMock.outcome === 'unknown') {
        processTreeKillMock.releaseUnknown = () => {
          child.emit('exit', null, 'SIGKILL');
          child.emit('close', null, 'SIGKILL');
        };
        return Promise.resolve({ status: 'unknown' as const });
      }
      if (
        processTreeKillMock.outcome === 'close_then_unknown'
        || processTreeKillMock.outcome === 'close_then_reject'
      ) {
        const outcome = processTreeKillMock.outcome;
        queueMicrotask(() => {
          child.emit('close', null, 'SIGTERM');
          child.emit('exit', null, 'SIGTERM');
        });
        return new Promise<{ readonly status: 'unknown' }>((resolve, reject) => {
          processTreeKillMock.releaseUnknown = () => {
            if (outcome === 'close_then_reject') {
              reject(new Error('injected delayed process-tree termination failure'));
            } else {
              resolve({ status: 'unknown' });
            }
          };
        });
      }
      return actual.killChildProcessTree(child, {
        ...options,
        gracefulMs: 0,
        forceMs: 0,
        taskkillMs: 0,
      }).then((result) => (
        result.status === 'unknown' && child.pid === undefined
          ? { status: 'terminated' as const }
          : result
      ));
    },
    withKodaXFileLock: async <T>(
      lockPath: string,
      operation: () => Promise<T>,
      acquireTimeoutMs?: number,
    ): Promise<T> => {
      if (lockPath.endsWith('acl-recovery.lock')) {
        recoveryLockMock.calls += 1;
        if (
          recoveryLockMock.timeoutFailures > 0
          || recoveryLockMock.timeoutOnCall === recoveryLockMock.calls
        ) {
          recoveryLockMock.timeoutFailures = Math.max(0, recoveryLockMock.timeoutFailures - 1);
          throw new Error(`learning store lock timed out: ${lockPath}`);
        }
        await recoveryLockMock.beforeOperation?.();
      }
      const result = await actual.withKodaXFileLock(lockPath, operation, acquireTimeoutMs);
      if (lockPath.endsWith('acl-recovery.lock') && recoveryLockMock.releaseFailures > 0) {
        recoveryLockMock.releaseFailures -= 1;
        throw new Error(`injected recovery lock release failure: ${lockPath}`);
      }
      return result;
    },
  };
});

vi.mock('@anthropic-ai/sandbox-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@anthropic-ai/sandbox-runtime')>();
  return {
    ...actual,
    SandboxManager: {
      isSupportedPlatform: () => true,
      checkDependencies: vi.fn(() => ({ errors: [], warnings: [] })),
      cleanupAfterCommand: () => undefined,
      reset: () => Promise.resolve(),
      initialize: sandboxInitialize,
      wrapWithSandbox: (command: string) => {
        capturedWrappedCommands.push(command);
        return Promise.resolve(command);
      },
      wrapWithSandboxArgv: (
        command: string,
        _binShell?: string,
        customConfig?: Readonly<Record<string, unknown>>,
      ) => {
        capturedWrappedCommands.push(command);
        if (customConfig) capturedSandboxWrapConfigs.push(customConfig);
        return Promise.resolve({
          argv: [
            process.execPath,
            'exec',
            '--quiet',
            '--env',
            'Path=wrapper-path',
            '--env',
            'PATHEXT=.EXE',
            '--env',
            'WRAPPED_ONLY=yes',
            '--',
            process.execPath,
            '-e',
            command,
          ],
          env: process.env,
        });
      },
    },
    getSrtWinPath: () => windowsSandboxMock.runnerSource || process.execPath,
    resolveSrtWin: (config?: { readonly path?: string }) => ({
      exe: config?.path ?? windowsSandboxMock.runnerSource ?? process.execPath,
      prependArgs: ['--srt-win'],
    }),
    grantWindowsAcl: (options: Readonly<Record<string, unknown>>) => {
      windowsSandboxMock.grants.push(options);
      if (windowsSandboxMock.grantFailure !== undefined) {
        throw new Error(windowsSandboxMock.grantFailure);
      }
    },
    revokeWindowsAcl: (options: Readonly<Record<string, unknown>>) => {
      windowsSandboxMock.revokes.push(options);
      return [];
    },
    getWindowsSandboxUserStatus: () => ({ ...windowsSandboxMock.user }),
    verifyWindowsWfpEgress: () => Promise.resolve(),
    installWindowsSandbox: () => {
      windowsSandboxMock.installCalls += 1;
      return { cancelled: false };
    },
  };
});

import {
  KODAX_ASRT_VERSION,
  clearWindowsSandboxAclMarkersForRuntimeOwner,
  createAsrtShellSandbox,
  createAsrtSkillScriptRunner,
  doctorSandboxRuntime,
  overrideWorkspaceSessionRpcTimeoutsForTest,
  prepareSandboxRuntimeForSetup,
  recoverWindowsSandboxAclsForRuntimeOwner,
  runKodaXSandboxed,
  runAsrtBrokerProcess,
  resetAsrtWorkspaceSessionsForTest,
  sandboxRuntimeCapability,
  sandboxSetupGuidance,
  shutdownAsrtWorkspaceSessions,
} from './sandbox-runtime.js';

const tempRoots: string[] = [];

function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

beforeEach(async () => {
  processIdentityMock.windowsBootIdentity = 'windows-boot-100';
  processIdentityMock.pid4StartIdentity = '13370000000000';
  processIdentityMock.unreadablePids.clear();
  recoveryLockMock.timeoutFailures = 0;
  recoveryLockMock.timeoutOnCall = undefined;
  recoveryLockMock.calls = 0;
  recoveryLockMock.releaseFailures = 0;
  recoveryLockMock.beforeOperation = undefined;
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-runner-'));
  tempRoots.push(root);
  const source = path.join(root, 'package', 'srt-win.exe');
  await mkdir(path.dirname(source), { recursive: true });
  await writeFile(source, 'trusted-test-runner', 'utf8');
  windowsSandboxMock.runnerSource = source;
  vi.stubEnv('ProgramData', path.join(root, 'program-data'));
  vi.stubEnv('KODAX_HOME', path.join(root, '.kodax'));
});

afterEach(async () => {
  fileSystemMock.rmFailurePath = undefined;
  fileSystemMock.writeBrokerRequestFailure = false;
  fileSystemMock.writeAclPoisonMarkerFailure = false;
  fileSystemMock.renameAclPoisonMarkerFailures = 0;
  fileSystemMock.aclPoisonMarkerWriteTargets.length = 0;
  processTreeKillMock.releaseUnknown?.();
  processTreeKillMock.releaseUnknown = undefined;
  processTreeKillMock.outcome = 'actual';
  processTreeKillMock.childPid = undefined;
  processIdentityMock.windowsBootIdentity = 'windows-boot-100';
  processIdentityMock.pid4StartIdentity = '13370000000000';
  workspaceSessionControl.releaseReady?.();
  workspaceSessionControl.releaseWrap?.();
  workspaceSessionControl.delayReady = false;
  workspaceSessionControl.releaseReady = undefined;
  workspaceSessionControl.delayWrap = false;
  workspaceSessionControl.releaseWrap = undefined;
  workspaceSessionControl.wrapFailure = undefined;
  workspaceSessionControl.cleanupFailure = undefined;
  workspaceSessionControl.delayCleanup = false;
  workspaceSessionControl.releaseCleanup?.();
  workspaceSessionControl.releaseCleanup = undefined;
  workspaceSessionControl.afterWrapResponse = undefined;
  workspaceSessionControl.cleanupRequests = 0;
  workspaceSessionControl.malformedReady = false;
  workspaceSessionControl.delayClose = false;
  workspaceSessionControl.releaseClose?.();
  workspaceSessionControl.releaseClose = undefined;
  workspaceSessionControl.closeExitCode = 0;
  await resetAsrtWorkspaceSessionsForTest();
  capturedBrokerRequests.length = 0;
  capturedSpawnEnvironments.length = 0;
  capturedSpawnArgv.length = 0;
  capturedSpawnCwds.length = 0;
  capturedSyncSpawns.length = 0;
  capturedWrappedCommands.length = 0;
  capturedWorkspaceSessionConfigs.length = 0;
  capturedWorkspaceRequests.length = 0;
  capturedSandboxWrapConfigs.length = 0;
  capturedKillSignals.length = 0;
  capturedProcessTreeKillOptions.length = 0;
  stubbornBroker.mode = 'none';
  deferredBrokerRead.enabled = false;
  deferredBrokerRead.missing = false;
  sandboxInitialize.mockReset();
  sandboxInitialize.mockResolvedValue();
  windowsSandboxMock.runnerSource = '';
  windowsSandboxMock.wfpOutcome = 'blocked';
  windowsSandboxMock.aclRecoveryOutcome = 'success';
  windowsSandboxMock.aclRecoveryOutcomes.length = 0;
  windowsSandboxMock.guardReady = true;
  windowsSandboxMock.user = {
    provisioned: true,
    sid: 'S-1-5-21-1000',
    groupExists: true,
    groupSid: 'S-1-5-21-1001',
    inBuiltinUsers: true,
    inSandboxGroup: true,
    hiddenFromLogon: true,
    credPresent: true,
    markerVersion: 1,
    realUserSid: 'S-1-5-21-1002',
  };
  windowsSandboxMock.grantFailure = undefined;
  windowsSandboxMock.grants.length = 0;
  windowsSandboxMock.revokes.length = 0;
  windowsSandboxMock.installCalls = 0;
  sandboxWrapper.mode = 'attest';
  vi.unstubAllEnvs();
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 50,
  })));
});

async function createRegistry(script = 'hello.mjs'): Promise<SkillRegistry> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-test-'));
  tempRoots.push(root);
  const skillRoot = path.join(root, 'skills', 'demo');
  await mkdir(path.join(skillRoot, 'scripts'), { recursive: true });
  await writeFile(
    path.join(skillRoot, 'SKILL.md'),
    '---\nname: demo\ndescription: Test isolated scripts\n---\n\nUse the admitted script.\n',
    'utf8',
  );
  await writeFile(path.join(skillRoot, 'scripts', script), 'process.stdout.write("hello")', 'utf8');
  const registry = new SkillRegistry(root, {
    projectPaths: [], userPaths: [path.join(root, 'skills')], pluginPaths: [], builtinPath: path.join(root, 'builtin'),
  });
  await registry.discover();
  return registry;
}

async function markSandboxRuntimeUnavailable(): Promise<void> {
  if (process.platform === 'win32') {
    windowsSandboxMock.user.provisioned = false;
  } else {
    const asrt = await import('@anthropic-ai/sandbox-runtime');
    vi.mocked(asrt.SandboxManager.checkDependencies).mockReturnValueOnce({
      errors: ['bubblewrap is unavailable'],
      warnings: [],
    });
  }
  await doctorSandboxRuntime({ refresh: true });
}

describe('ASRT workspace shell adapter', () => {
  it.runIf(process.platform === 'win32')(
    'recovers only exact daemon-owned primary and legacy ACL markers without force',
    async () => {
      const configHome = path.resolve(process.env.KODAX_HOME!);
      const primaryDirectory = path.join(
        path.resolve(process.env.ProgramData!),
        'KodaX',
        'sandbox-runtime',
        'acl-poison',
      );
      const legacyDirectory = path.join(configHome, 'sandbox-runtime', 'acl-poison');
      const basename = 'unconfirmed-owner-exact-runtime.json';
      const payload = JSON.stringify({
        version: 1,
        state: 'unconfirmed',
        holderPid: 4101,
        holderProcessStartIdentity: 'process-start-4101',
        windowsBootIdentity: processIdentityMock.windowsBootIdentity,
      });
      await mkdir(primaryDirectory, { recursive: true });
      await mkdir(legacyDirectory, { recursive: true });
      await writeFile(path.join(primaryDirectory, basename), payload, 'utf8');
      await writeFile(path.join(legacyDirectory, basename), payload, 'utf8');

      const recovered = await recoverWindowsSandboxAclsForRuntimeOwner(configHome, {
        pid: 4101,
        processStartIdentity: 'process-start-4101',
      }, processIdentityMock.windowsBootIdentity!);

      expect(recovered).toBe(2);
      await expect(readdir(primaryDirectory)).resolves.toEqual([basename]);
      await expect(readdir(legacyDirectory)).resolves.toEqual([basename]);
      const cleared = await clearWindowsSandboxAclMarkersForRuntimeOwner(configHome, {
        pid: 4101,
        processStartIdentity: 'process-start-4101',
      }, processIdentityMock.windowsBootIdentity!);
      expect(cleared).toBe(2);
      await expect(readdir(primaryDirectory)).resolves.toEqual([]);
      await expect(readdir(legacyDirectory)).resolves.toEqual([]);
      const calls = capturedSyncSpawns.filter(({ args }) => (
        args.includes('acl') && args.includes('recover')
      ));
      expect(calls).toHaveLength(1);
      expect(calls[0]?.args).not.toContain('--force');
    },
  );

  it.runIf(process.platform === 'win32')(
    'keeps every marker when exact daemon ACL recovery finds a foreign owner',
    async () => {
      const configHome = path.resolve(process.env.KODAX_HOME!);
      const primaryDirectory = path.join(
        path.resolve(process.env.ProgramData!),
        'KodaX',
        'sandbox-runtime',
        'acl-poison',
      );
      await mkdir(primaryDirectory, { recursive: true });
      const exact = path.join(primaryDirectory, 'unconfirmed-owner-exact.json');
      const foreign = path.join(primaryDirectory, 'unconfirmed-owner-foreign.json');
      await writeFile(exact, JSON.stringify({
        version: 1,
        state: 'unconfirmed',
        holderPid: 4101,
        holderProcessStartIdentity: 'process-start-4101',
        windowsBootIdentity: processIdentityMock.windowsBootIdentity,
      }), 'utf8');
      await writeFile(foreign, JSON.stringify({
        version: 1,
        state: 'unconfirmed',
        holderPid: 5101,
        holderProcessStartIdentity: 'process-start-5101',
        windowsBootIdentity: processIdentityMock.windowsBootIdentity,
      }), 'utf8');

      await expect(recoverWindowsSandboxAclsForRuntimeOwner(configHome, {
        pid: 4101,
        processStartIdentity: 'process-start-4101',
      }, processIdentityMock.windowsBootIdentity!)).rejects.toThrow(/foreign or unverifiable owner marker/i);

      await expect(stat(exact)).resolves.toBeDefined();
      await expect(stat(foreign)).resolves.toBeDefined();
      expect(capturedSyncSpawns.filter(({ args }) => (
        args.includes('acl') && args.includes('recover')
      ))).toHaveLength(0);
    },
  );

  it.runIf(process.platform === 'win32')(
    'rejects an exact PID identity marker from a different Windows boot',
    async () => {
      const configHome = path.resolve(process.env.KODAX_HOME!);
      const primaryDirectory = path.join(
        path.resolve(process.env.ProgramData!),
        'KodaX',
        'sandbox-runtime',
        'acl-poison',
      );
      await mkdir(primaryDirectory, { recursive: true });
      const marker = path.join(primaryDirectory, 'unconfirmed-owner-other-boot.json');
      await writeFile(marker, JSON.stringify({
        version: 1,
        state: 'unconfirmed',
        holderPid: 4101,
        holderProcessStartIdentity: 'process-start-4101',
        windowsBootIdentity: 'windows-boot-100',
      }), 'utf8');

      await expect(recoverWindowsSandboxAclsForRuntimeOwner(configHome, {
        pid: 4101,
        processStartIdentity: 'process-start-4101',
      }, 'windows-boot-200')).rejects.toThrow(/foreign or unverifiable owner marker/i);

      await expect(stat(marker)).resolves.toBeDefined();
      expect(capturedSyncSpawns.filter(({ args }) => (
        args.includes('acl') && args.includes('recover')
      ))).toHaveLength(0);
    },
  );

  it('avoids an eager Windows ACL owner and starts POSIX warm-up with a fresh KODAX_HOME', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-shell-warm-'));
    tempRoots.push(root);

    createAsrtShellSandbox({
      workspaceRoot: root,
      shouldSandbox: () => true,
    });

    if (process.platform === 'win32') {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(capturedWorkspaceSessionConfigs).toHaveLength(0);
      return;
    }
    await vi.waitFor(() => {
      const sessions = capturedSpawnArgv.filter((argv) => argv.some((arg) => (
        arg.includes('sandbox-workspace-session')
        || arg === '__asrt-workspace-session'
      )));
      expect(sessions).toHaveLength(1);
      const importIndex = sessions[0]!.indexOf('--import');
      if (importIndex >= 0) {
        expect(sessions[0]![importIndex + 1]).toMatch(/^file:\/\//);
      }
    }, { timeout: 5_000 });
  });

  it.skipIf(process.platform === 'win32').each(['abort', 'timeout'] as const)(
    'honors a Shell %s while waiting for POSIX workspace warm-up',
    async (stopKind) => {
      const root = await mkdtemp(path.join(os.tmpdir(), `kodax-asrt-warm-${stopKind}-`));
      tempRoots.push(root);
      workspaceSessionControl.delayReady = true;
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: root,
        shouldSandbox: () => true,
      });
      await vi.waitFor(() => expect(workspaceSessionControl.releaseReady).toBeDefined());
      const controller = new AbortController();
      const preparing = sandbox.prepare({
        toolCallId: `bash-warm-${stopKind}`,
        toolInput: { command: 'node --version' },
        command: 'node --version',
        executable: process.execPath,
        args: ['--version'],
        cwd: root,
        env: process.env,
        signal: controller.signal,
        ...(stopKind === 'timeout' ? { deadlineAt: Date.now() + 25 } : {}),
      });
      if (stopKind === 'abort') controller.abort();

      await expect(preparing).rejects.toMatchObject({
        name: stopKind === 'abort' ? 'AbortError' : 'TimeoutError',
      });
      expect(capturedWorkspaceSessionConfigs).toHaveLength(1);
      workspaceSessionControl.delayReady = false;
      workspaceSessionControl.releaseReady?.();
      workspaceSessionControl.releaseReady = undefined;
    },
  );

  it.skipIf(process.platform === 'win32')(
    "does not wait for another workspace's POSIX warm-up",
    async () => {
      const slowRoot = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-warm-slow-'));
      const otherRoot = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-warm-other-'));
      tempRoots.push(slowRoot, otherRoot);
      workspaceSessionControl.delayReady = true;
      createAsrtShellSandbox({
        workspaceRoot: slowRoot,
        shouldSandbox: () => true,
      });
      await vi.waitFor(() => expect(workspaceSessionControl.releaseReady).toBeDefined());
      workspaceSessionControl.delayReady = false;
      const otherSandbox = createAsrtShellSandbox({
        workspaceRoot: otherRoot,
        shouldSandbox: () => true,
      });

      let otherSettled = false;
      let otherResult: unknown;
      let otherFailure: unknown;
      const otherPreparation = otherSandbox.prepare({
        toolCallId: 'bash-other-warm-up',
        toolInput: { command: 'node --version' },
        command: 'node --version',
        executable: process.execPath,
        args: ['--version'],
        cwd: otherRoot,
        env: process.env,
      }).then((result) => {
        otherResult = result;
        otherSettled = true;
      }, (error: unknown) => {
        otherFailure = error;
        otherSettled = true;
      });
      await vi.waitFor(
        () => expect(otherSettled).toBe(true),
        { timeout: 30_000 },
      );

      await otherPreparation;
      expect(otherFailure).toBeUndefined();
      expect(otherResult).toBeUndefined();
      expect(workspaceSessionControl.releaseReady).toBeDefined();
      workspaceSessionControl.releaseReady?.();
      workspaceSessionControl.releaseReady = undefined;
    },
  );

  it('falls back without initializing ACLs while an ordinary filesystem effect is active', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-acl-fence-'));
    tempRoots.push(root);
    const releaseActiveEffect = await acquireFileSystemMutationLease();
    let preparing: ReturnType<ReturnType<typeof createAsrtShellSandbox>['prepare']>;
    let preparedPrematurely = false;
    let sessionCountWhileBlocked = 0;
    try {
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: root,
        shouldSandbox: () => true,
      });
      preparing = sandbox.prepare({
        toolCallId: 'acl-fence',
        toolInput: { command: 'echo safe' },
        command: 'echo safe',
        cwd: root,
        env: process.env,
      });
      preparedPrematurely = await Promise.race([
        preparing.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 300)),
      ]);
      sessionCountWhileBlocked = capturedWorkspaceSessionConfigs.length;
    } finally {
      await releaseActiveEffect();
    }

    const invocation = await preparing!;
    try {
      expect(preparedPrematurely).toBe(true);
      expect(sessionCountWhileBlocked).toBe(0);
      expect(invocation).toBeUndefined();
    } finally {
      await invocation?.cleanup();
    }
  });

  it.runIf(process.platform === 'win32')(
    'does not materialize workspace grants before an admitted Windows command',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-shell-lean-warm-'));
      const agentHome = path.join(root, 'agent-home');
      const workspace = path.join(root, 'workspace');
      tempRoots.push(root);
      await mkdir(workspace, { recursive: true });
      vi.stubEnv('KODAX_HOME', agentHome);

      createAsrtShellSandbox({
        workspaceRoot: workspace,
        shouldSandbox: () => true,
      });

      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(capturedWorkspaceSessionConfigs).toHaveLength(0);
    },
  );

  it.runIf(process.platform === 'win32')(
    'scopes workspace sessions to the actual command toolchain paths',
    async () => {
      const workspace = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-path-workspace-'));
      const profileRoot = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-path-profile-'));
      const externalToolRoot = await mkdtemp(path.join(process.cwd(), '.kodax-asrt-path-external-'));
      tempRoots.push(workspace, profileRoot, externalToolRoot);
      const roamingRoot = path.join(profileRoot, 'Roaming');
      const localRoot = path.join(profileRoot, 'Local');
      const programsRoot = path.join(localRoot, 'Programs');
      const commandTempRoot = path.join(localRoot, 'Temp');
      const managerRoot = path.join(roamingRoot, 'fnm');
      const nodeVersionsRoot = path.join(managerRoot, 'node-versions');
      const versionReleaseRoot = path.join(nodeVersionsRoot, 'v1');
      const versionRoot = path.join(versionReleaseRoot, 'installation');
      const externalVersionReleaseRoot = path.join(nodeVersionsRoot, 'v2');
      const externalLinkVersionRoot = path.join(externalVersionReleaseRoot, 'installation');
      const nvmRoot = path.join(roamingRoot, 'nvm');
      const nvmVersionRoot = path.join(nvmRoot, 'v22');
      const pyenvRoot = path.join(programsRoot, 'pyenv');
      const pyenvVersionsRoot = path.join(pyenvRoot, 'versions');
      const pythonVersionRoot = path.join(pyenvVersionsRoot, '3.12');
      const pythonScripts = path.join(pythonVersionRoot, 'Scripts');
      const miseRoot = path.join(localRoot, 'mise');
      const miseInstallsRoot = path.join(miseRoot, 'installs');
      const miseToolRoot = path.join(miseInstallsRoot, 'python');
      const miseVersionRoot = path.join(miseToolRoot, '3.13');
      const miseBin = path.join(miseVersionRoot, 'bin');
      const activeToolRoot = path.join(localRoot, 'fnm_multishells');
      const activeToolchain = path.join(activeToolRoot, 'active-toolchain');
      const activeNvmToolchain = path.join(activeToolRoot, 'active-nvm');
      const externalActiveToolchain = path.join(externalToolRoot, 'active-toolchain');
      const sensitiveToolchain = path.join(localRoot, 'sensitive-toolchain');
      const missingToolchain = path.join(localRoot, 'missing-toolchain');
      const systemToolchain = path.join(localRoot, 'system-toolchain');
      const shimRoot = path.join(roamingRoot, '.tool-manager');
      const shimDirectory = path.join(shimRoot, 'shims');
      const packageRoot = path.join(roamingRoot, 'node_modules');
      const packageBin = path.join(packageRoot, '.bin');
      const shellManager = path.join(programsRoot, '.shell-manager');
      const shellDirectory = path.join(shellManager, 'bin');
      const shellExecutable = path.join(shellDirectory, 'shell.exe');
      const documentsScripts = path.join(profileRoot, 'Documents', 'venv', 'Scripts');
      const windowsApps = path.join(localRoot, 'Microsoft', 'WindowsApps');
      const sensitiveTarget = path.resolve(process.env.KODAX_HOME!);
      await mkdir(versionRoot, { recursive: true });
      await mkdir(externalLinkVersionRoot, { recursive: true });
      await mkdir(nvmVersionRoot, { recursive: true });
      await mkdir(pythonScripts, { recursive: true });
      await mkdir(miseBin, { recursive: true });
      await mkdir(activeToolRoot, { recursive: true });
      await mkdir(shimDirectory, { recursive: true });
      await mkdir(packageBin, { recursive: true });
      await mkdir(shellDirectory, { recursive: true });
      await mkdir(documentsScripts, { recursive: true });
      await mkdir(windowsApps, { recursive: true });
      await mkdir(sensitiveTarget, { recursive: true });
      await writeFile(path.join(versionRoot, 'tool.exe'), 'tool', 'utf8');
      await writeFile(shellExecutable, 'shell', 'utf8');
      await symlink(versionRoot, activeToolchain, 'junction');
      await symlink(nvmVersionRoot, activeNvmToolchain, 'junction');
      await symlink(externalLinkVersionRoot, externalActiveToolchain, 'junction');
      await symlink(
        path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32'),
        systemToolchain,
        'junction',
      );
      expect(realpathSync(sensitiveTarget)).toBe(sensitiveTarget);
      await symlink(sensitiveTarget, sensitiveToolchain, 'junction');
      vi.stubEnv('APPDATA', roamingRoot);
      vi.stubEnv('LOCALAPPDATA', localRoot);

      const sandbox = createAsrtShellSandbox({
        workspaceRoot: workspace,
        shouldSandbox: () => true,
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(capturedWorkspaceSessionConfigs).toHaveLength(0);

      const commandPath = [
        activeToolchain,
        activeNvmToolchain,
        externalActiveToolchain,
        pythonScripts,
        miseBin,
        shimDirectory,
        packageBin,
        documentsScripts,
        windowsApps,
        missingToolchain,
        systemToolchain,
        sensitiveToolchain,
        path.join(sensitiveTarget, 'bin'),
      ];
      const commandEnvironment = Object.fromEntries(
        Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'PATH'),
      );
      commandEnvironment.APPDATA = path.join(profileRoot, 'forged-roaming');
      commandEnvironment.LOCALAPPDATA = path.join(profileRoot, 'forged-local');
      commandEnvironment.TEMP = commandTempRoot;
      commandEnvironment.TMP = commandTempRoot;
      commandEnvironment.pAtH = commandPath.join(path.delimiter);
      const first = await sandbox.prepare({
        toolCallId: 'profile-toolchain-path-1',
        toolInput: { command: 'tool --version' },
        command: 'tool --version',
        executable: shellExecutable,
        args: ['/c', 'tool --version'],
        cwd: workspace,
        env: commandEnvironment,
      });
      if (!first) throw new Error('expected a command-scoped workspace invocation');
      await first.cleanup();

      expect(capturedWorkspaceSessionConfigs).toHaveLength(1);
      const scopedConfig = capturedWorkspaceSessionConfigs[0] as {
        readonly filesystem: { readonly allowRead: readonly string[] };
      };
      expect(scopedConfig.filesystem.allowRead).toEqual(expect.arrayContaining([
        path.resolve(activeToolchain),
        path.resolve(versionRoot),
        path.resolve(versionReleaseRoot),
        path.resolve(nodeVersionsRoot),
        path.resolve(externalLinkVersionRoot),
        path.resolve(externalVersionReleaseRoot),
        path.resolve(activeNvmToolchain),
        path.resolve(nvmVersionRoot),
        path.resolve(pythonScripts),
        path.resolve(miseBin),
        path.resolve(shimDirectory),
        path.resolve(packageBin),
        path.resolve(shellDirectory),
        path.resolve(documentsScripts),
        path.resolve(windowsApps),
        path.dirname(process.execPath),
      ]));
      expect(scopedConfig.filesystem.allowRead).not.toContain(path.resolve(roamingRoot));
      expect(scopedConfig.filesystem.allowRead).not.toContain(path.resolve(localRoot));
      expect(scopedConfig.filesystem.allowRead).not.toContain(path.resolve(programsRoot));
      expect(scopedConfig.filesystem.allowRead).not.toContain(path.resolve(commandTempRoot));
      expect(scopedConfig.filesystem.allowRead).not.toContain(path.resolve(activeToolRoot));
      expect(scopedConfig.filesystem.allowRead).not.toContain(path.resolve(managerRoot));
      expect(scopedConfig.filesystem.allowRead).not.toContain(path.resolve(nvmRoot));
      expect(scopedConfig.filesystem.allowRead).not.toContain(path.resolve(pyenvRoot));
      expect(scopedConfig.filesystem.allowRead).not.toContain(path.resolve(miseRoot));
      expect(scopedConfig.filesystem.allowRead).not.toContain(path.resolve(shimRoot));
      expect(scopedConfig.filesystem.allowRead).not.toContain(path.resolve(packageRoot));
      expect(scopedConfig.filesystem.allowRead).not.toContain(path.resolve(shellManager));
      expect(scopedConfig.filesystem.allowRead).not.toContain(
        path.resolve(profileRoot, 'Documents'),
      );
      expect(scopedConfig.filesystem.allowRead).not.toContain(
        path.resolve(localRoot, 'Microsoft'),
      );
      expect(scopedConfig.filesystem.allowRead).not.toContain(
        path.resolve(profileRoot, 'forged-local'),
      );
      expect(scopedConfig.filesystem.allowRead).toContain(path.resolve(systemToolchain));
      expect(scopedConfig.filesystem.allowRead).not.toContain(path.resolve(missingToolchain));
      expect(scopedConfig.filesystem.allowRead).not.toContain(
        path.resolve(process.env.SystemRoot ?? 'C:\\Windows', 'System32'),
      );
      expect(scopedConfig.filesystem.allowRead).not.toContain(
        path.resolve(sensitiveTarget, 'bin'),
      );
      expect(scopedConfig.filesystem.allowRead).not.toContain(
        path.resolve(sensitiveToolchain),
      );
      expect(scopedConfig.filesystem.allowRead).not.toContain(
        path.resolve(externalActiveToolchain),
      );

      commandEnvironment.pAtH = [...commandPath].reverse().join(path.delimiter);
      const second = await sandbox.prepare({
        toolCallId: 'profile-toolchain-path-2',
        toolInput: { command: 'tool --version' },
        command: 'tool --version',
        executable: shellExecutable,
        args: ['/c', 'tool --version'],
        cwd: workspace,
        env: commandEnvironment,
      });
      if (!second) throw new Error('expected the normalized toolchain scope to remain available');
      await second.cleanup();
      expect(capturedWorkspaceSessionConfigs).toHaveLength(2);
    },
  );

  it.runIf(process.platform === 'win32')(
    'resets the previous Windows toolchain scope before admitting another one',
    async () => {
      const workspace = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-path-switch-'));
      const toolchainA = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-tool-a-'));
      const toolchainB = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-tool-b-'));
      tempRoots.push(workspace, toolchainA, toolchainB);
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: workspace,
        shouldSandbox: () => true,
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(capturedWorkspaceSessionConfigs).toHaveLength(0);

      const first = await sandbox.prepare({
        toolCallId: 'toolchain-scope-a',
        toolInput: { command: 'tool-a --version' },
        command: 'tool-a --version',
        windowsVerbatimArguments: true,
        cwd: workspace,
        env: { PATH: toolchainA },
      });
      if (!first) throw new Error('expected first toolchain invocation');
      workspaceSessionControl.delayClose = true;
      const firstCleanup = first.cleanup();
      await vi.waitFor(() => expect(workspaceSessionControl.releaseClose).toBeTypeOf('function'));
      expect(capturedWorkspaceRequests.at(-1)?.windowsVerbatimArguments).toBe(true);
      expect(capturedWorkspaceSessionConfigs).toHaveLength(1);

      const secondPending = sandbox.prepare({
        toolCallId: 'toolchain-scope-b',
        toolInput: { command: 'tool-b --version' },
        command: 'tool-b --version',
        cwd: workspace,
        env: { PATH: toolchainB },
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      expect(capturedWorkspaceSessionConfigs).toHaveLength(1);
      workspaceSessionControl.delayClose = false;
      workspaceSessionControl.releaseClose?.();
      workspaceSessionControl.releaseClose = undefined;
      await firstCleanup;

      await expect(secondPending).resolves.toBeUndefined();
      const second = await sandbox.prepare({
        toolCallId: 'toolchain-scope-b-after-reset',
        toolInput: { command: 'tool-b --version' },
        command: 'tool-b --version',
        cwd: workspace,
        env: { PATH: toolchainB },
      });
      if (!second) throw new Error('expected second toolchain invocation after reset');
      await second.cleanup();
      expect(capturedWorkspaceSessionConfigs).toHaveLength(2);
      const firstConfig = capturedWorkspaceSessionConfigs[0] as {
        readonly filesystem: { readonly allowRead: readonly string[] };
      };
      const secondConfig = capturedWorkspaceSessionConfigs[1] as {
        readonly filesystem: { readonly allowRead: readonly string[] };
      };
      expect(firstConfig.filesystem.allowRead).toContain(path.resolve(toolchainA));
      expect(secondConfig.filesystem.allowRead).toContain(path.resolve(toolchainB));
      expect(secondConfig.filesystem.allowRead).not.toContain(path.resolve(toolchainA));
    },
  );

  it.runIf(process.platform === 'win32')(
    'waits for command-scoped ACL initialization before returning an invocation',
    async () => {
      const workspace = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-path-race-'));
      const toolchain = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-path-race-tool-'));
      tempRoots.push(workspace, toolchain);
      workspaceSessionControl.delayReady = true;
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: workspace,
        shouldSandbox: () => true,
      });
      const preparing = sandbox.prepare({
        toolCallId: 'profile-toolchain-path-race',
        toolInput: { command: 'tool --version' },
        command: 'tool --version',
        cwd: workspace,
        env: { PATH: toolchain },
      });

      await vi.waitFor(() => {
        expect(capturedWorkspaceSessionConfigs).toHaveLength(1);
        expect(workspaceSessionControl.releaseReady).toBeTypeOf('function');
      });
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      expect(capturedWorkspaceSessionConfigs).toHaveLength(1);
      workspaceSessionControl.delayReady = false;
      workspaceSessionControl.releaseReady?.();
      workspaceSessionControl.releaseReady = undefined;

      const prepared = await preparing;
      if (!prepared) throw new Error('expected a command-scoped workspace invocation');
      await prepared.cleanup();
      expect(capturedWorkspaceSessionConfigs).toHaveLength(1);
    },
  );

  it('prepares only an admitted concrete call with workspace/temp writes and normal local network', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-shell-'));
    const additionalReadRoot = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-read-'));
    const additionalWriteRoot = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-write-'));
    tempRoots.push(root, additionalReadRoot, additionalWriteRoot);
    const home = path.resolve(os.homedir());
    const customAgentHome = path.join(root, 'custom-agent-home');
    vi.stubEnv('KODAX_HOME', customAgentHome);
    const agentsDirectory = path.join(customAgentHome, 'agents');
    const sessionsDirectory = path.join(customAgentHome, 'sessions');
    const runtimeDirectory = path.join(customAgentHome, 'runtime');
    const legacyProcessesDirectory = path.join(customAgentHome, 'processes');
    const learnedDirectory = path.join(customAgentHome, 'learned');
    const brokenAgentHomeLink = path.join(customAgentHome, 'broken-link');
    const nestedBrokenContainer = path.join(customAgentHome, 'broken-container');
    const nestedBrokenAgentHomeLink = path.join(nestedBrokenContainer, 'broken-link');
    const agentHomeRootAlias = path.join(customAgentHome, 'root-alias');
    const ordinaryWorkingDirectory = path.join(customAgentHome, 'work-output');
    const newOrdinaryOutput = path.join(ordinaryWorkingDirectory, 'nested', 'result.txt');
    await mkdir(agentsDirectory, { recursive: true });
    await mkdir(sessionsDirectory, { recursive: true });
    await mkdir(runtimeDirectory, { recursive: true });
    await mkdir(legacyProcessesDirectory, { recursive: true });
    await mkdir(learnedDirectory, { recursive: true });
    await mkdir(ordinaryWorkingDirectory, { recursive: true });
    await mkdir(nestedBrokenContainer, { recursive: true });
    const reviewableConfig = path.join(customAgentHome, 'config.json');
    const reviewableToken = path.join(customAgentHome, 'mcp-tokens', 'token.json');
    await mkdir(path.dirname(reviewableToken), { recursive: true });
    await writeFile(reviewableConfig, '{}', 'utf8');
    await writeFile(reviewableToken, 'reviewed-token', 'utf8');
    if (process.platform === 'win32') {
      await symlink(
        path.join(customAgentHome, 'missing-target'),
        brokenAgentHomeLink,
        'junction',
      );
      await symlink(
        path.join(customAgentHome, 'missing-nested-target'),
        nestedBrokenAgentHomeLink,
        'junction',
      );
      await symlink(customAgentHome, agentHomeRootAlias, 'junction');
    }
    const homePathEntry = process.platform === 'win32'
      ? `${home[0]!.toLowerCase()}${home.slice(1)}`
      : home;
    const sensitivePathEntry = path.join(home, '.ssh', 'bin');
    const ordinaryHomePathEntry = path.join(root, 'tools', 'bin');
    await mkdir(ordinaryHomePathEntry, { recursive: true });
    vi.stubEnv('PATH', [
      homePathEntry,
      sensitivePathEntry,
      ordinaryHomePathEntry,
      process.env.PATH,
    ].filter((entry): entry is string => entry !== undefined).join(path.delimiter));
    const shouldSandbox = vi.fn(() => ({
      agentHomeAccess: {
        read: [reviewableConfig, reviewableToken],
        write: [
          agentsDirectory,
          sessionsDirectory,
          newOrdinaryOutput,
          customAgentHome,
          runtimeDirectory,
          brokenAgentHomeLink,
          nestedBrokenAgentHomeLink,
          agentHomeRootAlias,
        ],
      },
      filesystemAccess: {
        read: [additionalReadRoot],
        write: [additionalWriteRoot],
      },
    }));
    const reportObservation = vi.fn();
    const sandbox = createAsrtShellSandbox({
      workspaceRoot: root,
      shouldSandbox,
    });
    const childControlledTemp = path.join(path.parse(root).root, 'kodax-child-temp');

    const prepared = await sandbox.prepare({
      toolCallId: 'bash-1',
      toolInput: { command: 'copy a.txt b.txt' },
      command: 'copy a.txt b.txt',
      cwd: root,
      env: {
        PATH: process.env.PATH,
        TEMP: childControlledTemp,
        TEST_API_KEY: 'must-not-cross-the-broker',
        AWS_ACCESS_KEY_ID: 'must-not-cross-the-broker-either',
      },
      reportObservation,
    });

    expect(prepared).toBeDefined();
    if (!prepared) throw new Error('expected an admitted workspace invocation');
    let cleanupResult: Awaited<ReturnType<typeof prepared.cleanup>> | undefined;
    try {
      expect(shouldSandbox).toHaveBeenCalledWith(expect.objectContaining({
        id: 'bash-1',
        name: 'bash',
      }));
      const requestFile = prepared.args.find((arg) => arg.endsWith('.json'));
      expect(requestFile).toBeDefined();
      const request = JSON.parse(readFileSync(requestFile!, 'utf8')) as {
        readonly fallbackToNormalExecution?: boolean;
        readonly config: {
          readonly filesystem: {
            readonly allowRead: readonly string[];
            readonly allowWrite: readonly string[];
            readonly denyRead: readonly string[];
            readonly denyWrite: readonly string[];
          };
          readonly network: {
            readonly allowedDomains: readonly string[];
            readonly strictAllowlist: boolean;
          };
          readonly windows?: {
            readonly srtWin?: { readonly path?: string };
          };
        };
        readonly env: Readonly<Record<string, string>>;
        readonly allowAllNetwork?: boolean;
        readonly observationFile: string;
      };
      if (process.platform === 'win32') {
        expect(request.config.filesystem.allowWrite).not.toContain(path.resolve(root));
        expect(request.config.filesystem.allowWrite).not.toContain(path.resolve(customAgentHome));
        expect(request.config.filesystem.allowWrite).toEqual(expect.arrayContaining([
          path.resolve(agentsDirectory),
          path.resolve(sessionsDirectory),
        ]));
        expect(request.config.filesystem.allowWrite).not.toContain(
          path.resolve(reviewableToken),
        );
        expect(request.config.filesystem.allowWrite).toContain(
          path.resolve(ordinaryWorkingDirectory),
        );
        expect(request.config.filesystem.allowWrite).not.toContain(
          path.resolve(customAgentHome),
        );
        expect(request.config.filesystem.allowRead).toEqual(expect.arrayContaining([
          path.resolve(reviewableConfig),
          path.resolve(reviewableToken),
        ]));
        expect(request.config.filesystem.allowWrite).not.toContain(path.resolve(runtimeDirectory));
        expect(request.config.filesystem.allowWrite).not.toContain(
          path.resolve(brokenAgentHomeLink),
        );
        expect(request.config.filesystem.allowWrite).not.toContain(
          path.resolve(nestedBrokenContainer),
        );
        expect(request.config.filesystem.allowWrite).not.toContain(
          path.resolve(agentHomeRootAlias),
        );
        expect(request.config.filesystem.allowWrite)
          .not.toContain(path.resolve(legacyProcessesDirectory));
        expect(request.config.filesystem.allowWrite).not.toContain(path.resolve(learnedDirectory));
      } else {
        expect(request.config.filesystem.allowWrite).toContain(path.resolve(customAgentHome));
      }
      expect(request.config.filesystem.allowWrite).not.toContain(childControlledTemp);
      expect(request.config.filesystem.allowRead).toContain(path.resolve(additionalReadRoot));
      expect(request.config.filesystem.allowWrite).toContain(path.resolve(additionalWriteRoot));
      const sensitiveHomeReads = [
        '.ssh', '.aws', '.azure', '.gnupg', '.kube', '.docker', '.kodax', '.agents',
        '.codex', '.claude', '.gemini', '.direnv', '.terraform.d',
        path.join('.cargo', 'credentials.toml'),
        path.join('.config', 'gcloud'),
        path.join('.config', 'gh'),
        path.join('.config', 'openai'),
        path.join('.config', 'anthropic'),
        '.gitconfig',
        path.join('.config', 'git', 'config'),
        '.terraformrc',
        path.join('.config', 'pypoetry', 'auth.toml'),
        '.condarc',
        '.bashrc',
        '.bash_profile',
        '.zshrc',
        '.zprofile',
        '.profile',
        path.join('.config', 'fish', 'config.fish'),
        path.join('.config', 'fish', 'fish_variables'),
        '.bash_history',
        '.zsh_history',
        path.join('.m2', 'settings.xml'),
        path.join('.m2', 'settings-security.xml'),
        path.join('.gradle', 'gradle.properties'),
        path.join('.nuget', 'NuGet', 'NuGet.Config'),
        path.join('.pip', 'pip.conf'),
        path.join('.config', 'pip', 'pip.conf'),
        path.join('.cache', 'huggingface', 'token'),
        path.join('.huggingface', 'token'),
        path.join('.config', 'rclone', 'rclone.conf'),
        path.join('.local', 'share', 'keyrings'),
        path.join('Library', 'Keychains'),
        path.join('AppData', 'Roaming', 'Microsoft', 'Credentials'),
        path.join('AppData', 'Roaming', 'Microsoft', 'Protect'),
        path.join('AppData', 'Roaming', 'Microsoft', 'Vault'),
        path.join('AppData', 'Local', 'Microsoft', 'Credentials'),
        path.join('AppData', 'Local', 'Microsoft', 'Protect'),
        path.join('AppData', 'Local', 'Microsoft', 'Vault'),
        '.password-store',
        '.env',
        '.envrc',
        '.pgpass',
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
      ].map((relative) => path.join(home, relative));
      if (process.platform === 'win32') {
        expect(request.config.filesystem.denyRead).toEqual([]);
        expect(request.config.filesystem.denyWrite).toEqual([]);
        const guardCall = capturedSyncSpawns.find((call) => {
          const encodedIndex = call.args.indexOf('-EncodedCommand');
          if (encodedIndex < 0) return false;
          return Buffer.from(call.args[encodedIndex + 1] ?? '', 'base64')
            .toString('utf16le')
            .includes('KodaXAsrtAclGuard-v1');
        });
        expect(guardCall?.input).toBeDefined();
        const guarded = JSON.parse(guardCall!.input!) as {
          readonly paths: readonly {
            readonly path: string;
            readonly directory: boolean;
            readonly mode: string;
          }[];
        };
        expect(guarded.paths).toContainEqual({
          path: path.resolve(customAgentHome),
          directory: true,
          mode: 'read',
        });
        if (statSync(path.join(home, '.ssh'), { throwIfNoEntry: false })) {
          expect(guarded.paths).toContainEqual({
            path: path.resolve(home, '.ssh'),
            directory: true,
            mode: 'read',
          });
        }
      } else {
        expect(request.config.filesystem.denyRead).toEqual(
          expect.arrayContaining(sensitiveHomeReads),
        );
        expect(request.config.filesystem.denyWrite)
          .toContain(path.resolve(customAgentHome, 'runtime'));
        expect(request.config.filesystem.denyWrite)
          .toContain(path.resolve(customAgentHome, 'processes'));
        expect(request.config.filesystem.denyWrite)
          .toContain(path.resolve(customAgentHome, 'learned'));
      }
      expect(request.config.filesystem.denyRead).not.toContain(path.resolve(reviewableToken));
      expect(request.config.filesystem.denyWrite)
        .not.toContain(path.resolve(customAgentHome));
      expect(request.config.filesystem.allowRead).not.toContain(homePathEntry);
      expect(request.config.filesystem.allowRead).not.toContain(sensitivePathEntry);
      if (isPathInside(home, ordinaryHomePathEntry)) {
        expect(request.config.filesystem.allowRead).toContain(ordinaryHomePathEntry);
      } else {
        expect(request.config.filesystem.allowRead).not.toContain(ordinaryHomePathEntry);
      }
      const sessionConfig = capturedWorkspaceSessionConfigs.at(-1) as {
        readonly filesystem: {
          readonly allowRead: readonly string[];
          readonly denyRead: readonly string[];
          readonly denyWrite: readonly string[];
        };
        readonly windows?: {
          readonly srtWin?: { readonly path?: string };
        };
      };
      expect(sessionConfig.filesystem.denyRead).toEqual(
        request.config.filesystem.denyRead,
      );
      if (process.platform === 'win32') {
        const runnerDirectory = request.config.filesystem.allowRead.find(
          (entry) => entry.includes(path.join('sandbox-runtime', 'runner')),
        );
        expect(runnerDirectory).toBeDefined();
        expect(request.config.filesystem.denyWrite).not.toContain(runnerDirectory);
        expect(request.config.windows?.srtWin?.path).toBe(
          path.join(runnerDirectory!, 'srt-win.exe'),
        );
        expect(sessionConfig.filesystem.allowRead).toContain(runnerDirectory);
        expect(sessionConfig.filesystem.denyWrite).not.toContain(runnerDirectory);
        expect(sessionConfig.windows?.srtWin?.path).toBe(
          path.join(runnerDirectory!, 'srt-win.exe'),
        );
        expect(capturedSpawnCwds).toContain(runnerDirectory);
        expect(request.config.filesystem.allowRead).not.toContain(
          path.resolve(process.env.SystemRoot ?? 'C:\\Windows', 'System32'),
        );
        expect(request.config.filesystem.allowWrite).not.toContain(
          path.resolve(process.env.SystemRoot ?? 'C:\\Windows', 'Temp'),
        );
      }
      expect(requestFile).toContain(`${path.sep}sandbox-runtime${path.sep}`);
      expect(request).toHaveProperty('wrappedInvocation');
      expect(request.config.network.allowedDomains).toEqual([]);
      expect(request.config.network.strictAllowlist).toBe(false);
      expect(request.allowAllNetwork).toBe(true);
      expect(request.fallbackToNormalExecution).toBe(true);
      expect(request.env.TEST_API_KEY).toBe('must-not-cross-the-broker');
      expect(request.env.AWS_ACCESS_KEY_ID).toBe('must-not-cross-the-broker-either');
      if (process.platform === 'win32') {
        expect(request.env.TEMP).toContain(`${path.sep}kodax-sandbox${path.sep}`);
        expect(request.env.TMP).toBe(request.env.TEMP);
        expect(request.env.TMPDIR).toBe(request.env.TEMP);
        expect(request.env.TEMP).not.toBe(childControlledTemp);
        expect(request.env.GIT_CONFIG_GLOBAL).toBe('NUL');
        expect(request.env.GIT_CONFIG_NOSYSTEM).toBe('1');
      }
      await writeFile(request.observationFile, JSON.stringify({
        version: 1,
        state: 'applied',
        backend: sandboxRuntimeCapability().backend,
        policyId: 'kodax-workspace-shell-v1',
      }), 'utf8');
      expect(reportObservation).not.toHaveBeenCalled();
    } finally {
      cleanupResult = await prepared.cleanup();
    }
    expect(cleanupResult).toMatchObject({
      state: 'applied',
      backend: sandboxRuntimeCapability().backend,
      policyId: 'kodax-workspace-shell-v1',
    });
  });

  it.runIf(process.platform === 'win32')(
    'uses ordinary permission fallback for a missing external write target',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-missing-write-'));
      const missingTarget = path.join(root, '..', `${path.basename(root)}-missing`, 'output.txt');
      tempRoots.push(root);
      const reportObservation = vi.fn();
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: root,
        shouldSandbox: () => ({
          filesystemAccess: { read: [], write: [missingTarget] },
        }),
      });

      await expect(sandbox.prepare({
        toolCallId: 'missing-external-write',
        toolInput: { command: 'echo content > output.txt' },
        command: 'echo content > output.txt',
        cwd: root,
        env: process.env,
        reportObservation,
      })).resolves.toBeUndefined();
      expect(capturedWorkspaceSessionConfigs).toHaveLength(0);
      expect(reportObservation).toHaveBeenCalledWith({
        version: 1,
        state: 'fallback',
        reason: 'not_ready',
        execution: 'normal_permission_policy',
      });
    },
  );

  it.runIf(process.platform === 'win32')(
    'keeps persistent Windows sensitive-root guards outside ASRT startup propagation',
    async () => {
      const agentHome = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-agent-home-'));
      tempRoots.push(agentHome);
      vi.stubEnv('KODAX_HOME', agentHome);
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: os.homedir(),
        shouldSandbox: () => true,
      });

      const prepared = await sandbox.prepare({
        toolCallId: 'bash-home-workspace',
        toolInput: { command: 'echo safe' },
        command: 'echo safe',
        cwd: os.homedir(),
        env: process.env,
      });
      if (!prepared) throw new Error('expected home workspace invocation');
      try {
        const requestFile = prepared.args.find((arg) => arg.endsWith('.json'));
        if (!requestFile) throw new Error('expected broker request');
        const request = JSON.parse(readFileSync(requestFile, 'utf8')) as {
          readonly config: { readonly filesystem: { readonly denyRead: readonly string[] } };
        };
        expect(request.config.filesystem.denyRead).toEqual([]);
        const guardedPaths = capturedSyncSpawns.flatMap((call) => {
          const encodedIndex = call.args.indexOf('-EncodedCommand');
          if (encodedIndex < 0) return [];
          const script = Buffer.from(call.args[encodedIndex + 1] ?? '', 'base64')
            .toString('utf16le');
          if (!script.includes('KodaXAsrtAclGuard-v1') || !call.input) return [];
          return (JSON.parse(call.input) as {
            readonly paths: readonly { readonly path: string }[];
          }).paths.map((entry) => entry.path);
        });
        expect(guardedPaths).toContain(path.join(os.homedir(), '.ssh'));
        const guardScript = capturedSyncSpawns
          .map((call) => {
            const encodedIndex = call.args.indexOf('-EncodedCommand');
            return encodedIndex < 0
              ? ''
              : Buffer.from(call.args[encodedIndex + 1] ?? '', 'base64')
                .toString('utf16le');
          })
          .find((script) => script.includes('KodaXAsrtAclGuard-v1'));
        expect(guardScript).toContain('icacls.exe');
        expect(guardScript).toContain('Add-KodaXAsrtWriteAclRule');
        expect(guardScript).toContain('PropagationFlags]::InheritOnly');
      } finally {
        await prepared.cleanup();
      }
    },
  );

  it.runIf(process.platform === 'win32')(
    'canonicalizes a junction workspace before granting Agent Home write roots',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-workspace-link-'));
      tempRoots.push(root);
      const physicalWorkspace = path.join(root, 'physical-workspace');
      const workspaceAlias = path.join(root, 'alias-parent', 'workspace-link');
      const agentHome = path.join(physicalWorkspace, 'custom-agent-home');
      const agentsDirectory = path.join(agentHome, 'agents');
      const runtimeDirectory = path.join(agentHome, 'runtime');
      await mkdir(agentsDirectory, { recursive: true });
      await mkdir(runtimeDirectory, { recursive: true });
      await mkdir(path.dirname(workspaceAlias), { recursive: true });
      await symlink(physicalWorkspace, workspaceAlias, 'junction');
      vi.stubEnv('KODAX_HOME', agentHome);

      const sandbox = createAsrtShellSandbox({
        workspaceRoot: workspaceAlias,
        shouldSandbox: () => ({
          agentHomeAccess: { read: [], write: [agentsDirectory] },
        }),
      });
      const prepared = await sandbox.prepare({
        toolCallId: 'bash-junction-workspace',
        toolInput: { command: 'echo safe' },
        command: 'echo safe',
        cwd: workspaceAlias,
        env: process.env,
      });
      if (!prepared) throw new Error('expected junction workspace invocation');
      try {
        const requestFile = prepared.args.find((arg) => arg.endsWith('.json'));
        if (!requestFile) throw new Error('expected junction broker request');
        const request = JSON.parse(readFileSync(requestFile, 'utf8')) as {
          readonly config: { readonly filesystem: { readonly allowWrite: readonly string[] } };
        };
        expect(request.config.filesystem.allowWrite).not.toContain(path.resolve(workspaceAlias));
        expect(request.config.filesystem.allowWrite).not.toContain(path.resolve(physicalWorkspace));
        expect(request.config.filesystem.allowWrite).not.toContain(path.resolve(agentHome));
        expect(request.config.filesystem.allowWrite).not.toContain(path.resolve(runtimeDirectory));
        expect(request.config.filesystem.allowWrite).toContain(path.resolve(agentsDirectory));
      } finally {
        await prepared.cleanup();
      }
    },
  );

  it.runIf(process.platform === 'win32')(
    'installs write-only Git metadata guards before stripping ASRT denies',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-git-guards-'));
      tempRoots.push(root);
      const gitDirectory = path.join(root, '.git');
      const gitConfig = path.join(gitDirectory, 'config');
      const gitHooks = path.join(gitDirectory, 'hooks');
      await mkdir(gitHooks, { recursive: true });
      await writeFile(gitConfig, '[core]\n', 'utf8');

      const sandbox = createAsrtShellSandbox({
        workspaceRoot: root,
        shouldSandbox: () => true,
      });
      const prepared = await sandbox.prepare({
        toolCallId: 'bash-git-guards',
        toolInput: { command: 'git status --short' },
        command: 'git status --short',
        cwd: root,
        env: process.env,
      });
      if (!prepared) throw new Error('expected Git guard workspace invocation');
      const concurrent = await sandbox.prepare({
        toolCallId: 'bash-git-guards-concurrent',
        toolInput: { command: 'git status --short' },
        command: 'git status --short',
        cwd: root,
        env: process.env,
      });
      try {
        expect(concurrent).toBeDefined();
        const guardPayloads = capturedSyncSpawns.flatMap((call) => {
          const encodedIndex = call.args.indexOf('-EncodedCommand');
          if (encodedIndex < 0 || !call.input) return [];
          const script = Buffer.from(call.args[encodedIndex + 1] ?? '', 'base64')
            .toString('utf16le');
          return script.includes('KodaXAsrtAclGuard-v1')
            ? [JSON.parse(call.input) as {
                readonly install: boolean;
                readonly paths: readonly { readonly path: string; readonly mode: string }[];
              }]
            : [];
        });
        expect(guardPayloads).toContainEqual(expect.objectContaining({
          install: true,
          paths: expect.arrayContaining([
            { path: gitConfig, mode: 'write', directory: false },
            { path: gitHooks, mode: 'write', directory: true },
          ]),
        }));
        const sessionConfig = capturedWorkspaceSessionConfigs.at(-1) as {
          readonly filesystem: { readonly denyWrite: readonly string[] };
        };
        expect(sessionConfig.filesystem.denyWrite).toEqual([]);
      } finally {
        await concurrent?.cleanup();
        await prepared.cleanup();
      }
      expect(capturedWorkspaceSessionConfigs).toHaveLength(1);
    },
  );

  it.runIf(process.platform === 'win32')(
    'recovers orphaned Windows ACLs before starting the first workspace session',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-workspace-acl-recovery-'));
      tempRoots.push(root);
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: root,
        shouldSandbox: () => true,
      });
      const prepared = await sandbox.prepare({
        toolCallId: 'bash-workspace-acl-recovery',
        toolInput: { command: 'node --version' },
        command: 'node --version',
        executable: process.execPath,
        args: ['--version'],
        cwd: root,
        env: process.env,
      });
      if (!prepared) throw new Error('expected recovered workspace invocation');
      const requestFile = prepared.args.find((arg) => arg.endsWith('.json'));
      if (!requestFile) throw new Error('expected recovered broker request');
      const request = JSON.parse(readFileSync(requestFile, 'utf8')) as {
        readonly observationFile: string;
      };
      await writeFile(request.observationFile, JSON.stringify({
        version: 1,
        state: 'applied',
        backend: sandboxRuntimeCapability().backend,
        policyId: 'kodax-workspace-shell-v1',
      }), 'utf8');
      await prepared.cleanup();

      expect(capturedSyncSpawns.filter(({ args }) => (
        args.includes('acl') && args.includes('recover') && args.includes('--json')
      ))).toHaveLength(2);
      expect(capturedWorkspaceSessionConfigs).toHaveLength(1);
    },
  );

  it.runIf(process.platform === 'win32')(
    'falls back without spawning a workspace owner when its durable ACL poison marker cannot be written',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-workspace-marker-failure-'));
      tempRoots.push(root);
      await doctorSandboxRuntime({ refresh: true });
      const spawnCount = capturedSpawnArgv.length;
      fileSystemMock.writeAclPoisonMarkerFailure = true;
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: root,
        shouldSandbox: () => true,
      });
      const prepare = (toolCallId: string) => sandbox.prepare({
        toolCallId,
        toolInput: { command: 'node --version' },
        command: 'node --version',
        executable: process.execPath,
        args: ['--version'],
        cwd: root,
        env: process.env,
      });

      await expect(prepare('bash-workspace-marker-failure')).resolves.toBeUndefined();
      expect(capturedSpawnArgv).toHaveLength(spawnCount);
      expect(capturedWorkspaceSessionConfigs).toHaveLength(0);

      fileSystemMock.writeAclPoisonMarkerFailure = false;
      const recovered = await prepare('bash-workspace-marker-recovered');
      expect(recovered).toBeDefined();
      expect(capturedWorkspaceSessionConfigs).toHaveLength(1);
      await recovered?.cleanup();
    },
  );

  it.runIf(process.platform === 'win32')(
    'confirms a clean workspace owner EOF without requiring uncertain tree capture',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-workspace-shutdown-'));
      tempRoots.push(root);
      processTreeKillMock.outcome = 'unknown';
      processTreeKillMock.childPid = 91234;
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: root,
        shouldSandbox: () => true,
      });
      const prepared = await sandbox.prepare({
        toolCallId: 'bash-workspace-shutdown',
        toolInput: { command: 'node --version' },
        command: 'node --version',
        executable: process.execPath,
        args: ['--version'],
        cwd: root,
        env: process.env,
      });
      if (!prepared) throw new Error('expected workspace invocation before shutdown');
      await prepared.cleanup();
      const poisonDirectory = path.join(
        path.resolve(process.env.KODAX_HOME!),
        'sandbox-runtime',
        'acl-poison',
      );
      await expect(readdir(poisonDirectory)).resolves.toEqual([]);
      expect(fileSystemMock.aclPoisonMarkerWriteTargets).not.toEqual([]);
      expect(fileSystemMock.aclPoisonMarkerWriteTargets.every(
        (target) => path.basename(path.dirname(target)) === 'acl-poison-staging',
      )).toBe(true);

      await shutdownAsrtWorkspaceSessions();

      await expect(readdir(poisonDirectory)).resolves.toEqual([]);
      expect(capturedProcessTreeKillOptions).toEqual([]);
    },
  );

  it.runIf(process.platform === 'win32')(
    'releases the Windows workspace owner when command cleanup completes',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-workspace-command-owner-'));
      tempRoots.push(root);
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: root,
        shouldSandbox: () => true,
      });
      const prepare = (toolCallId: string) => sandbox.prepare({
        toolCallId,
        toolInput: { command: 'node --version' },
        command: 'node --version',
        executable: process.execPath,
        args: ['--version'],
        cwd: root,
        env: process.env,
      });
      const poisonDirectory = path.join(
        path.resolve(process.env.KODAX_HOME!),
        'sandbox-runtime',
        'acl-poison',
      );
      const globalPoisonDirectory = path.join(
        path.resolve(process.env.ProgramData!),
        'KodaX',
        'sandbox-runtime',
        'acl-poison',
      );

      const first = await prepare('bash-command-owner-first');
      if (!first) throw new Error('expected first workspace invocation');
      await expect(readdir(poisonDirectory)).resolves.toHaveLength(1);
      await expect(readdir(globalPoisonDirectory)).resolves.toHaveLength(1);
      await first.cleanup();
      await expect(readdir(poisonDirectory)).resolves.toEqual([]);
      await expect(readdir(globalPoisonDirectory)).resolves.toEqual([]);

      const second = await prepare('bash-command-owner-second');
      if (!second) throw new Error('expected second workspace invocation');
      await second.cleanup();
      expect(capturedWorkspaceSessionConfigs).toHaveLength(2);
    },
  );

  it.runIf(process.platform === 'win32')(
    'keeps a shared Runtime close pending until workspace ACL reset is confirmed',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-shared-runtime-shutdown-'));
      tempRoots.push(root);
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: root,
        shouldSandbox: () => true,
      });
      const prepared = await sandbox.prepare({
        toolCallId: 'bash-shared-runtime-shutdown',
        toolInput: { command: 'node --version' },
        command: 'node --version',
        executable: process.execPath,
        args: ['--version'],
        cwd: root,
        env: process.env,
      });
      if (!prepared) throw new Error('expected workspace invocation before Runtime close');
      workspaceSessionControl.delayClose = true;
      const { createKodaXRuntime } = await import('./sdk-runtime.js');
      const runtime = await createKodaXRuntime({
        homeDir: root,
        sharedDaemonHost: true,
      });
      let closeCompleted = false;
      const closing = runtime.close().then(() => { closeCompleted = true; });
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      expect(closeCompleted).toBe(false);
      const cleanup = prepared.cleanup();
      await vi.waitFor(
        () => expect(workspaceSessionControl.releaseClose).toBeDefined(),
        { timeout: 5_000 },
      );
      const poisonDirectory = path.join(
        path.resolve(process.env.KODAX_HOME!),
        'sandbox-runtime',
        'acl-poison',
      );
      expect(closeCompleted).toBe(false);
      await expect(readdir(poisonDirectory)).resolves.toHaveLength(1);

      workspaceSessionControl.delayClose = false;
      workspaceSessionControl.releaseClose?.();
      workspaceSessionControl.releaseClose = undefined;
      await Promise.all([cleanup, closing]);

      await expect(readdir(poisonDirectory)).resolves.toEqual([]);
    },
  );

  it.runIf(process.platform === 'win32')(
    'falls back when post-session ACL recovery fails',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-workspace-reset-recovery-'));
      tempRoots.push(root);
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: root,
        shouldSandbox: () => true,
      });
      const prepare = (toolCallId: string) => sandbox.prepare({
        toolCallId,
        toolInput: { command: 'node --version' },
        command: 'node --version',
        executable: process.execPath,
        args: ['--version'],
        cwd: root,
        env: process.env,
      });
      const first = await prepare('bash-before-reset-recovery-failure');
      if (!first) throw new Error('expected first workspace invocation');
      windowsSandboxMock.aclRecoveryOutcome = 'malformed';
      const cleanupFailure = await first.cleanup().then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(cleanupFailure).toBeInstanceOf(AggregateError);
      expect((cleanupFailure as AggregateError).errors.map(String)).toEqual(
        expect.arrayContaining([
          expect.stringContaining('Windows sandbox ACL recovery failed'),
        ]),
      );
      await expect(prepare('bash-after-reset-recovery-failure')).resolves.toBeUndefined();
      expect(capturedWorkspaceSessionConfigs).toHaveLength(1);
      expect(capturedSyncSpawns.filter(({ args }) => (
        args.includes('acl') && args.includes('recover')
      ))).toHaveLength(2);
    },
  );

  it.runIf(process.platform === 'win32')(
    'resets a cached workspace owner before standalone SDK admission',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-workspace-cached-poison-'));
      tempRoots.push(root);
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: root,
        shouldSandbox: () => true,
      });
      const prepare = (toolCallId: string) => sandbox.prepare({
        toolCallId,
        toolInput: { command: 'node --version' },
        command: 'node --version',
        executable: process.execPath,
        args: ['--version'],
        cwd: root,
        env: process.env,
      });
      const first = await prepare('bash-before-standalone-poison');
      if (!first) throw new Error('expected cached workspace invocation');
      workspaceSessionControl.delayClose = true;
      const firstCleanup = first.cleanup();
      await vi.waitFor(() => expect(workspaceSessionControl.releaseClose).toBeTypeOf('function'));
      const standalone = runKodaXSandboxed({
        command: process.execPath,
        args: ['--version'],
        cwd: root,
        filesystem: { allowRead: [], allowWrite: [] },
      });
      await vi.waitFor(() => expect(workspaceSessionControl.releaseClose).toBeTypeOf('function'));
      expect(capturedBrokerRequests).toHaveLength(0);
      workspaceSessionControl.releaseClose?.();
      workspaceSessionControl.delayClose = false;
      await firstCleanup;
      await expect(standalone).resolves.toMatchObject({ status: 'completed', exitCode: 0 });

      const second = await prepare('bash-after-standalone');
      if (!second) throw new Error('expected cached workspace invocation after contention');
      await second.cleanup();
      expect(capturedWorkspaceSessionConfigs).toHaveLength(2);
    },
  );

  it('uses one Windows workspace owner per command and retains POSIX session reuse', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-session-reuse-'));
    tempRoots.push(root);
    const sandbox = createAsrtShellSandbox({
      workspaceRoot: root,
      shouldSandbox: () => true,
    });
    const prepare = async (toolCallId: string) => sandbox.prepare({
      toolCallId,
      toolInput: { command: 'node --version' },
      command: 'node --version',
      executable: process.execPath,
      args: ['--version'],
      cwd: root,
      env: process.env,
    });
    const first = await prepare('bash-session-1');
    if (!first) throw new Error('expected first workspace invocation');
    const firstRequestFile = first.args.find((arg) => arg.endsWith('.json'));
    if (!firstRequestFile) throw new Error('expected first broker request');
    const firstRequest = JSON.parse(readFileSync(firstRequestFile, 'utf8')) as {
      readonly observationFile: string;
    };
    await writeFile(firstRequest.observationFile, JSON.stringify({
      version: 1,
      state: 'applied',
      backend: sandboxRuntimeCapability().backend,
      policyId: 'kodax-workspace-shell-v1',
    }), 'utf8');
    await first.cleanup();

    const second = await prepare('bash-session-2');
    if (!second) throw new Error('expected second workspace invocation');
    const secondRequestFile = second.args.find((arg) => arg.endsWith('.json'));
    if (!secondRequestFile) throw new Error('expected second broker request');
    const secondRequest = JSON.parse(readFileSync(secondRequestFile, 'utf8')) as {
      readonly observationFile: string;
    };
    await writeFile(secondRequest.observationFile, JSON.stringify({
      version: 1,
      state: 'applied',
      backend: sandboxRuntimeCapability().backend,
      policyId: 'kodax-workspace-shell-v1',
    }), 'utf8');
    await second.cleanup();

    expect(capturedSpawnArgv.filter((argv) => (
      argv.some((arg) => (
        arg.includes('sandbox-workspace-session')
        || arg === '__asrt-workspace-session'
      ))
    ))).toHaveLength(process.platform === 'win32' ? 2 : 1);
  });

  it.runIf(process.platform !== 'win32')(
    'keeps ordinary POSIX workspace sessions outside the scoped-session cache quota',
    async () => {
    const roots: string[] = [];
      for (let index = 0; index < 9; index += 1) {
        const root = await mkdtemp(path.join(os.tmpdir(), `kodax-posix-workspace-${index}-`));
        roots.push(root);
        tempRoots.push(root);
        const sandbox = createAsrtShellSandbox({
          workspaceRoot: root,
          shouldSandbox: () => true,
        });
        const prepared = await sandbox.prepare({
          toolCallId: `bash-posix-workspace-${index}`,
          toolInput: { command: 'node --version' },
          command: 'node --version',
          cwd: root,
          env: process.env,
        });
        if (!prepared) throw new Error(`expected ordinary POSIX workspace invocation ${index}`);
        await prepared.cleanup();
      }

      const scopedSandbox = createAsrtShellSandbox({
        workspaceRoot: roots[0]!,
        shouldSandbox: () => ({
          filesystemAccess: { read: [roots[1]!], write: [] },
        }),
      });
      const scoped = await scopedSandbox.prepare({
        toolCallId: 'bash-posix-scoped',
        toolInput: { command: 'node --version' },
        command: 'node --version',
        cwd: roots[0]!,
        env: process.env,
      });
      if (!scoped) throw new Error('expected scoped POSIX workspace invocation');
      await scoped.cleanup();

      const firstWorkspaceAgain = createAsrtShellSandbox({
        workspaceRoot: roots[0]!,
        shouldSandbox: () => true,
      });
      const reused = await firstWorkspaceAgain.prepare({
        toolCallId: 'bash-posix-workspace-reused',
        toolInput: { command: 'node --version' },
        command: 'node --version',
        cwd: roots[0]!,
        env: process.env,
      });
      if (!reused) throw new Error('expected reused POSIX workspace invocation');
      await reused.cleanup();
      expect(capturedWorkspaceSessionConfigs).toHaveLength(10);
    },
  );

  it('shares one workspace owner across concurrent commands with the same policy', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-session-parallel-'));
    tempRoots.push(root);
    const sandbox = createAsrtShellSandbox({
      workspaceRoot: root,
      shouldSandbox: () => true,
    });
    const reportObservation = vi.fn();
    const prepare = (toolCallId: string) => sandbox.prepare({
      toolCallId,
      toolInput: { command: 'node --version' },
      command: 'node --version',
      executable: process.execPath,
      args: ['--version'],
      cwd: root,
      env: process.env,
      reportObservation,
    });

    const [first, second] = await Promise.all([
      prepare('bash-parallel-1'),
      prepare('bash-parallel-2'),
    ]);
    if (!first || !second) throw new Error('expected parallel workspace invocations');
    if (process.platform === 'win32') {
      const poisonDirectories = [
        path.join(process.env.KODAX_HOME!, 'sandbox-runtime', 'acl-poison'),
        path.join(process.env.ProgramData!, 'KodaX', 'sandbox-runtime', 'acl-poison'),
      ];
      for (const directory of poisonDirectories) {
        await expect(readdir(directory)).resolves.toHaveLength(1);
      }
      await first.cleanup();
      for (const directory of poisonDirectories) {
        await expect(readdir(directory)).resolves.toHaveLength(1);
      }
      await second.cleanup();
      for (const directory of poisonDirectories) {
        await expect(readdir(directory)).resolves.toEqual([]);
      }
    } else {
      await Promise.all([first.cleanup(), second.cleanup()]);
    }

    expect(capturedSpawnArgv.filter((argv) => argv.some((arg) => (
      arg.includes('sandbox-workspace-session')
      || arg === '__asrt-workspace-session'
    )))).toHaveLength(1);
  });

  it.runIf(process.platform === 'win32')(
    'keeps an incompatible local policy as retryable fallback instead of sticky poison',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-local-policy-contention-'));
      const otherToolchain = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-local-policy-other-'));
      tempRoots.push(root, otherToolchain);
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: root,
        shouldSandbox: () => true,
      });
      const prepare = (toolCallId: string, env: NodeJS.ProcessEnv = process.env) => sandbox.prepare({
        toolCallId,
        toolInput: { command: 'node --version' },
        command: 'node --version',
        executable: process.execPath,
        args: ['--version'],
        cwd: root,
        env,
      });

      const first = await prepare('bash-local-policy-a');
      if (!first) throw new Error('expected first local policy invocation');
      await expect(prepare('bash-local-policy-b', {
        ...process.env,
        PATH: otherToolchain,
      })).resolves.toBeUndefined();
      await first.cleanup();

      const retry = await prepare('bash-local-policy-a-retry');
      if (!retry) throw new Error('expected original policy to remain retryable');
      await retry.cleanup();
    },
  );

  it.runIf(process.platform === 'win32')(
    'does not share a sandbox owner when the host temp policy base differs',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-temp-policy-'));
      const tempA = path.join(root, 'temp-a');
      const tempB = path.join(root, 'temp-b');
      await mkdir(tempA, { recursive: true });
      await mkdir(tempB, { recursive: true });
      tempRoots.push(root);
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: root,
        shouldSandbox: () => true,
      });
      const prepare = (toolCallId: string) => sandbox.prepare({
        toolCallId,
        toolInput: { command: 'node --version' },
        command: 'node --version',
        executable: process.execPath,
        args: ['--version'],
        cwd: root,
        env: process.env,
      });

      vi.stubEnv('TEMP', tempA);
      vi.stubEnv('TMP', tempA);
      const first = await prepare('bash-temp-policy-a');
      if (!first) throw new Error('expected first temp policy invocation');
      vi.stubEnv('TEMP', tempB);
      vi.stubEnv('TMP', tempB);
      const incompatible = await prepare('bash-temp-policy-b');
      try {
        expect(incompatible).toBeUndefined();
      } finally {
        await incompatible?.cleanup();
        await first.cleanup();
      }
    },
  );

  it.runIf(process.platform === 'win32')(
    'does not share a policy after a reviewed junction target changes',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-policy-junction-'));
      const physicalA = path.join(root, 'physical-a');
      const physicalB = path.join(root, 'physical-b');
      const reviewedLink = path.join(root, 'reviewed-link');
      await mkdir(physicalA, { recursive: true });
      await mkdir(physicalB, { recursive: true });
      await symlink(physicalA, reviewedLink, 'junction');
      tempRoots.push(root);
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: root,
        shouldSandbox: () => ({
          filesystemAccess: { read: [reviewedLink], write: [] },
        }),
      });
      const prepare = (toolCallId: string) => sandbox.prepare({
        toolCallId,
        toolInput: { command: 'node --version' },
        command: 'node --version',
        executable: process.execPath,
        args: ['--version'],
        cwd: root,
        env: process.env,
      });

      const first = await prepare('bash-policy-junction-a');
      if (!first) throw new Error('expected first junction policy invocation');
      await rm(reviewedLink, { recursive: true, force: true });
      await symlink(physicalB, reviewedLink, 'junction');
      const incompatible = await prepare('bash-policy-junction-b');
      try {
        expect(incompatible).toBeUndefined();
      } finally {
        await incompatible?.cleanup();
        await first.cleanup();
      }
    },
  );

  it.runIf(process.platform === 'win32')(
    'shares an exact policy across independent Windows owner processes and falls back for a different policy',
    async () => {
      const actualChildProcess = await vi.importActual<typeof import('node:child_process')>(
        'node:child_process',
      );
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-cross-process-policy-'));
      const otherToolchain = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-other-policy-'));
      tempRoots.push(root, otherToolchain);
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: root,
        shouldSandbox: () => true,
      });
      const prepare = (toolCallId: string, env: NodeJS.ProcessEnv = process.env) => sandbox.prepare({
        toolCallId,
        toolInput: { command: 'node --version' },
        command: 'node --version',
        executable: process.execPath,
        args: ['--version'],
        cwd: root,
        env,
      });
      const primaryDirectory = path.join(
        process.env.ProgramData!,
        'KodaX',
        'sandbox-runtime',
        'acl-poison',
      );
      const first = await prepare('bash-policy-probe');
      if (!first) throw new Error('expected policy probe invocation');
      const [localMarkerName] = await readdir(primaryDirectory);
      if (!localMarkerName) throw new Error('expected local policy marker');
      const localOwner = JSON.parse(await readFile(
        path.join(primaryDirectory, localMarkerName),
        'utf8',
      )) as { readonly policyKey?: string };
      expect(localOwner.policyKey).toMatch(/^[a-f0-9]{64}$/);
      await first.cleanup();
      await resetAsrtWorkspaceSessionsForTest({ preserveAclPoison: true });

      const holder = actualChildProcess.spawn(process.execPath, [
        '-e',
        'process.stdout.write("ready\\n");setInterval(()=>{},1000)',
      ], {
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
      await once(holder.stdout!, 'data');
      if (holder.pid === undefined) throw new Error('policy holder PID missing');
      const holderIdentity = readProcessStartIdentity(holder.pid);
      if (holderIdentity === undefined) throw new Error('policy holder identity missing');
      const foreignMarker = path.join(primaryDirectory, 'foreign-compatible-policy.json');
      await writeFile(foreignMarker, JSON.stringify({
        version: 1,
        state: 'active',
        policyKey: localOwner.policyKey,
        holderPid: holder.pid,
        holderProcessStartIdentity: holderIdentity,
        windowsBootIdentity: processIdentityMock.windowsBootIdentity,
      }), 'utf8');
      const releaseForeignCompatibleEffect = await acquireFileSystemMutationLease(
        localOwner.policyKey,
      );
      try {
        processIdentityMock.unreadablePids.add(holder.pid);
        await expect(prepare('bash-unverified-foreign-policy')).resolves.toBeUndefined();
        processIdentityMock.unreadablePids.delete(holder.pid);

        const recoveriesBeforeCompatible = capturedSyncSpawns.filter((spawn) => (
          spawn.args.includes('acl') && spawn.args.includes('recover')
        )).length;
        const compatible = await prepare('bash-compatible-foreign-policy');
        if (!compatible) throw new Error('expected compatible cross-process policy admission');
        expect(compatible.fileSystemEffectPolicyKey).toBe(localOwner.policyKey);
        await compatible.cleanup();
        expect(capturedSyncSpawns.filter((spawn) => (
          spawn.args.includes('acl') && spawn.args.includes('recover')
        ))).toHaveLength(recoveriesBeforeCompatible);
        expect(statSync(foreignMarker).isFile()).toBe(true);

        const observation = vi.fn();
        const incompatible = await sandbox.prepare({
          toolCallId: 'bash-incompatible-foreign-policy',
          toolInput: { command: 'node --version' },
          command: 'node --version',
          executable: process.execPath,
          args: ['--version'],
          cwd: root,
          env: { ...process.env, PATH: otherToolchain },
          reportObservation: observation,
        });
        expect(incompatible).toBeUndefined();
        expect(observation).toHaveBeenCalledWith(expect.objectContaining({
          state: 'fallback',
          execution: 'normal_permission_policy',
        }));
        const ordinaryFallbackEffect = await acquireFileSystemMutationLease();
        await ordinaryFallbackEffect();
      } finally {
        processIdentityMock.unreadablePids.delete(holder.pid);
        await releaseForeignCompatibleEffect();
        const holderClosed = once(holder, 'close');
        holder.kill('SIGKILL');
        await holderClosed;
        await rm(foreignMarker, { force: true });
      }
    },
  );

  it('retires a workspace session when sandbox execution cannot be attested', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-session-unattested-'));
    tempRoots.push(root);
    const sandbox = createAsrtShellSandbox({
      workspaceRoot: root,
      shouldSandbox: () => true,
    });
    const prepare = (toolCallId: string) => sandbox.prepare({
      toolCallId,
      toolInput: { command: 'node --version' },
      command: 'node --version',
      executable: process.execPath,
      args: ['--version'],
      cwd: root,
      env: process.env,
    });

    const first = await prepare('bash-unattested-1');
    if (!first) throw new Error('expected first workspace invocation');
    await expect(first.cleanup({ execution: 'started_or_unknown' }))
      .rejects.toThrow('could not be attested');
    await first.retire?.();

    const second = await prepare('bash-unattested-2');
    if (!second) throw new Error('expected replacement workspace invocation');
    const requestFile = second.args.find((arg) => arg.endsWith('.json'));
    if (!requestFile) throw new Error('expected replacement broker request');
    const request = JSON.parse(readFileSync(requestFile, 'utf8')) as {
      readonly observationFile: string;
    };
    await writeFile(request.observationFile, JSON.stringify({
      version: 1,
      state: 'applied',
      backend: sandboxRuntimeCapability().backend,
      policyId: 'kodax-workspace-shell-v1',
    }), 'utf8');
    await second.cleanup();

    expect(capturedSpawnArgv.filter((argv) => argv.some((arg) => (
      arg.includes('sandbox-workspace-session')
      || arg === '__asrt-workspace-session'
    )))).toHaveLength(2);
  });

  it.skipIf(process.platform === 'win32')(
    'evicts an unattested POSIX workspace session without waiting for another active lease',
    async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-session-retire-active-'));
    tempRoots.push(root);
    const sandbox = createAsrtShellSandbox({
      workspaceRoot: root,
      shouldSandbox: () => true,
    });
    const prepare = (toolCallId: string) => sandbox.prepare({
      toolCallId,
      toolInput: { command: 'node --version' },
      command: 'node --version',
      executable: process.execPath,
      args: ['--version'],
      cwd: root,
      env: process.env,
    });

    const [unattested, active] = await Promise.all([
      prepare('bash-retire-unattested'),
      prepare('bash-retire-active'),
    ]);
    if (!unattested || !active) throw new Error('expected parallel workspace invocations');
    const activeEffect = await acquireFileSystemMutationLease();
    workspaceSessionControl.delayClose = true;
    await expect(unattested.cleanup({ execution: 'started_or_unknown' }))
      .rejects.toThrow('could not be attested');

    const retirement = unattested.retire?.() ?? Promise.resolve();
    const retirementState = await Promise.race([
      retirement.then(() => 'retired' as const),
      new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 50)),
    ]);

    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await activeEffect();
    await active.cleanup();
    await retirement;
    const closeDeadline = Date.now() + 500;
    while (workspaceSessionControl.releaseClose === undefined && Date.now() < closeDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const releaseRetiredSession = workspaceSessionControl.releaseClose;
    releaseRetiredSession?.();
    const replacement = await prepare('bash-retire-replacement');
    if (!replacement) throw new Error('expected replacement workspace invocation');
    await replacement.cleanup();

    expect(retirementState).toBe('retired');
    expect(releaseRetiredSession).toBeTypeOf('function');
    expect(capturedSpawnArgv.filter((argv) => argv.some((arg) => (
      arg.includes('sandbox-workspace-session')
      || arg === '__asrt-workspace-session'
    )))).toHaveLength(2);
    },
  );

  it('blocks a replacement queued before command cleanup resets uncleanly', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-session-retire-unclean-'));
    tempRoots.push(root);
    const sandbox = createAsrtShellSandbox({
      workspaceRoot: root,
      shouldSandbox: () => true,
    });
    const prepare = (toolCallId: string) => sandbox.prepare({
      toolCallId,
      toolInput: { command: 'node --version' },
      command: 'node --version',
      executable: process.execPath,
      args: ['--version'],
      cwd: root,
      env: process.env,
    });

    const unattested = await prepare('bash-retire-unclean');
    if (!unattested) throw new Error('expected workspace invocation');
    workspaceSessionControl.delayClose = true;
    workspaceSessionControl.closeExitCode = 1;
    const cleanup = unattested.cleanup({ execution: 'started_or_unknown' }).then(
      () => undefined,
      async (cleanupError: unknown) => {
        try {
          await unattested.retire?.();
          return cleanupError;
        } catch (retirementError: unknown) {
          return new AggregateError(
            [cleanupError, retirementError],
            'Sandbox cleanup and workspace-session retirement both failed.',
          );
        }
      },
    );
    await vi.waitFor(() => expect(workspaceSessionControl.releaseClose).toBeDefined());
    const replacementPending = prepare('bash-retire-after-unclean');
    workspaceSessionControl.releaseClose?.();
    workspaceSessionControl.releaseClose = undefined;

    const cleanupFailure = await cleanup;
    expect(cleanupFailure).toBeInstanceOf(AggregateError);
    const cleanupMessages = (cleanupFailure as AggregateError).errors.map(String);
    expect(cleanupMessages).toEqual(expect.arrayContaining([
      expect.stringContaining('could not be attested'),
    ]));
    if (process.platform === 'win32') {
      expect(cleanupMessages).toEqual(expect.arrayContaining([
        expect.stringContaining('ASRT workspace session ACL reset was not confirmed'),
      ]));
    }
    await expect(replacementPending).resolves.toBeUndefined();
    expect(capturedWorkspaceSessionConfigs).toHaveLength(1);
  });

  it.each(['wrap', 'cleanup'] as const)(
    'retires a workspace session after a %s RPC failure',
    async (failurePoint) => {
      const root = await mkdtemp(path.join(os.tmpdir(), `kodax-asrt-${failurePoint}-failure-`));
      tempRoots.push(root);
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: root,
        shouldSandbox: () => true,
      });
      const prepare = (toolCallId: string) => sandbox.prepare({
        toolCallId,
        toolInput: { command: 'node --version' },
        command: 'node --version',
        executable: process.execPath,
        args: ['--version'],
        cwd: root,
        env: process.env,
      });

      if (failurePoint === 'wrap') {
        workspaceSessionControl.wrapFailure = 'injected wrap failure';
        await expect(prepare('bash-wrap-rpc-failed')).resolves.toBeUndefined();
        workspaceSessionControl.wrapFailure = undefined;
      } else {
        const first = await prepare('bash-cleanup-rpc-failed');
        if (!first) throw new Error('expected cleanup failure workspace invocation');
        workspaceSessionControl.cleanupFailure = 'injected cleanup failure';
        await expect(first.cleanup()).rejects.toThrow('request cleanup failed');
        await first.retire?.();
        workspaceSessionControl.cleanupFailure = undefined;
      }

      const recovered = await prepare(`bash-after-${failurePoint}-failure`);
      if (!recovered) throw new Error('expected replacement workspace invocation');
      await recovered.cleanup();
      expect(capturedSpawnArgv.filter((argv) => argv.some((arg) => (
        arg.includes('sandbox-workspace-session')
        || arg === '__asrt-workspace-session'
      )))).toHaveLength(2);
    },
  );

  it.runIf(process.platform === 'win32')(
    'retires a timed-out cleanup request through an orderly session close without poisoning the ACL owner',
    async () => {
      const restoreTimeouts = overrideWorkspaceSessionRpcTimeoutsForTest({
        rpcMs: 60,
        cleanupMs: 60,
      });
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-cleanup-timeout-'));
      tempRoots.push(root);
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: root,
        shouldSandbox: () => true,
      });
      const prepare = (toolCallId: string) => sandbox.prepare({
        toolCallId,
        toolInput: { command: 'node --version' },
        command: 'node --version',
        executable: process.execPath,
        args: ['--version'],
        cwd: root,
        env: process.env,
      });
      try {
        const first = await prepare('bash-cleanup-timeout');
        if (!first) throw new Error('expected workspace invocation');
        workspaceSessionControl.delayCleanup = true;
        await expect(first.cleanup()).rejects.toThrow('request cleanup failed');
        const globalPoisonDirectory = path.join(
          path.resolve(process.env.ProgramData!),
          'KodaX',
          'sandbox-runtime',
          'acl-poison',
        );
        // The orderly retire must confirm the ACL reset and remove the active
        // owner marker instead of renaming it to unconfirmed-owner-*.json.
        await vi.waitFor(async () => {
          await expect(readdir(globalPoisonDirectory)).resolves.toEqual([]);
        });
        await first.retire?.();
        workspaceSessionControl.delayCleanup = false;
        workspaceSessionControl.releaseCleanup?.();
        workspaceSessionControl.releaseCleanup = undefined;
        const replacement = await prepare('bash-after-cleanup-timeout');
        if (!replacement) throw new Error('expected replacement workspace invocation');
        await replacement.cleanup();
        expect(capturedKillSignals).toHaveLength(0);
        expect(capturedProcessTreeKillOptions).toHaveLength(0);
        expect(capturedSpawnArgv.filter((argv) => argv.some((arg) => (
          arg.includes('sandbox-workspace-session')
          || arg === '__asrt-workspace-session'
        )))).toHaveLength(2);
      } finally {
        workspaceSessionControl.delayCleanup = false;
        restoreTimeouts();
      }
    },
  );

  it.runIf(process.platform === 'win32')(
    'retires a timed-out wrap request without force-killing the session or poisoning the ACL owner',
    async () => {
      const restoreTimeouts = overrideWorkspaceSessionRpcTimeoutsForTest({ rpcMs: 60 });
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-wrap-timeout-'));
      tempRoots.push(root);
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: root,
        shouldSandbox: () => true,
      });
      const prepare = (toolCallId: string) => sandbox.prepare({
        toolCallId,
        toolInput: { command: 'node --version' },
        command: 'node --version',
        executable: process.execPath,
        args: ['--version'],
        cwd: root,
        env: process.env,
      });
      try {
        workspaceSessionControl.delayWrap = true;
        await expect(prepare('bash-wrap-timeout')).resolves.toBeUndefined();
        const globalPoisonDirectory = path.join(
          path.resolve(process.env.ProgramData!),
          'KodaX',
          'sandbox-runtime',
          'acl-poison',
        );
        await vi.waitFor(async () => {
          await expect(readdir(globalPoisonDirectory)).resolves.toEqual([]);
        });
        workspaceSessionControl.releaseWrap?.();
        workspaceSessionControl.delayWrap = false;
        const replacement = await prepare('bash-after-wrap-timeout');
        if (!replacement) throw new Error('expected replacement workspace invocation');
        await replacement.cleanup();
        expect(capturedKillSignals).toHaveLength(0);
        expect(capturedProcessTreeKillOptions).toHaveLength(0);
        expect(capturedSpawnArgv.filter((argv) => argv.some((arg) => (
          arg.includes('sandbox-workspace-session')
          || arg === '__asrt-workspace-session'
        )))).toHaveLength(2);
      } finally {
        workspaceSessionControl.delayWrap = false;
        restoreTimeouts();
      }
    },
  );

  it('gives cleanup requests a longer deadline than wrap requests', async () => {
    const restoreTimeouts = overrideWorkspaceSessionRpcTimeoutsForTest({ rpcMs: 60 });
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-cleanup-deadline-'));
    tempRoots.push(root);
    const sandbox = createAsrtShellSandbox({
      workspaceRoot: root,
      shouldSandbox: () => true,
    });
    const invocation = await sandbox.prepare({
      toolCallId: 'bash-cleanup-deadline',
      toolInput: { command: 'node --version' },
      command: 'node --version',
      executable: process.execPath,
      args: ['--version'],
      cwd: root,
      env: process.env,
    });
    if (!invocation) throw new Error('expected workspace invocation');
    try {
      workspaceSessionControl.delayCleanup = true;
      const stalled = invocation.cleanup();
      await vi.waitFor(() => {
        expect(workspaceSessionControl.releaseCleanup).toBeTypeOf('function');
      });
      // The stalled cleanup outlives the wrap deadline but stays inside the
      // dedicated cleanup deadline, so it must resolve instead of retiring.
      await new Promise((resolve) => setTimeout(resolve, 200));
      workspaceSessionControl.releaseCleanup?.();
      await expect(stalled).resolves.toBeUndefined();
      expect(workspaceSessionControl.cleanupRequests).toBe(1);
      expect(capturedKillSignals).toHaveLength(0);
    } finally {
      workspaceSessionControl.delayCleanup = false;
      restoreTimeouts();
    }
  });

  it('releases a workspace lease even when broker request-file cleanup fails', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-request-cleanup-failure-'));
    tempRoots.push(root);
    const sandbox = createAsrtShellSandbox({
      workspaceRoot: root,
      shouldSandbox: () => true,
    });
    const invocation = await sandbox.prepare({
      toolCallId: 'bash-request-cleanup-failure',
      toolInput: { command: 'node --version' },
      command: 'node --version',
      executable: process.execPath,
      args: ['--version'],
      cwd: root,
      env: process.env,
    });
    if (!invocation) throw new Error('expected workspace invocation');
    const requestFile = invocation.args.find((arg) => arg.endsWith('.json'));
    if (!requestFile) throw new Error('expected broker request file');

    fileSystemMock.rmFailurePath = requestFile;
    let cleanupFailure: unknown;
    try {
      await invocation.cleanup();
    } catch (error: unknown) {
      cleanupFailure = error;
    }
    const cleanupRequestsAfterFailure = workspaceSessionControl.cleanupRequests;
    fileSystemMock.rmFailurePath = undefined;
    await invocation.cleanup();

    expect(cleanupFailure).toBeInstanceOf(Error);
    expect((cleanupFailure as Error).message).toContain('request cleanup failed');
    expect(cleanupRequestsAfterFailure).toBe(1);
  });

  it('preserves missing-attestation diagnostics when request cleanup also fails', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-attestation-cleanup-failure-'));
    tempRoots.push(root);
    const sandbox = createAsrtShellSandbox({
      workspaceRoot: root,
      shouldSandbox: () => true,
    });
    const invocation = await sandbox.prepare({
      toolCallId: 'bash-attestation-cleanup-failure',
      toolInput: { command: 'node --version' },
      command: 'node --version',
      executable: process.execPath,
      args: ['--version'],
      cwd: root,
      env: process.env,
    });
    if (!invocation) throw new Error('expected workspace invocation');
    const requestFile = invocation.args.find((arg) => arg.endsWith('.json'));
    if (!requestFile) throw new Error('expected broker request file');

    fileSystemMock.rmFailurePath = requestFile;
    try {
      await expect(invocation.cleanup({ execution: 'started_or_unknown' })).rejects.toThrow(
        /could not be attested.*request cleanup failed/i,
      );
    } finally {
      fileSystemMock.rmFailurePath = undefined;
      await invocation.retire?.();
    }
  });

  it('retires a workspace session when request construction and lease cleanup both fail', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-request-write-failure-'));
    tempRoots.push(root);
    const sandbox = createAsrtShellSandbox({
      workspaceRoot: root,
      shouldSandbox: () => true,
    });
    const reportObservation = vi.fn();
    const prepare = (toolCallId: string) => sandbox.prepare({
      toolCallId,
      toolInput: { command: 'node --version' },
      command: 'node --version',
      executable: process.execPath,
      args: ['--version'],
      cwd: root,
      env: process.env,
      reportObservation,
    });
    const first = await prepare('bash-before-request-write-failure');
    if (!first) throw new Error('expected initial workspace invocation');
    await first.cleanup();

    fileSystemMock.writeBrokerRequestFailure = true;
    workspaceSessionControl.cleanupFailure = 'injected cleanup after request write failure';
    await expect(prepare('bash-request-write-failure')).resolves.toBeUndefined();
    expect(reportObservation).toHaveBeenLastCalledWith({
      version: 1,
      state: 'fallback',
      reason: 'prepare_failed',
      execution: 'normal_permission_policy',
    });
    fileSystemMock.writeBrokerRequestFailure = false;
    workspaceSessionControl.cleanupFailure = undefined;

    const replacement = await prepare('bash-after-request-write-failure');
    if (!replacement) throw new Error('expected replacement after request write failure');
    await replacement.cleanup();
    expect(capturedWorkspaceSessionConfigs).toHaveLength(
      process.platform === 'win32' ? 3 : 2,
    );
  });

  it.runIf(process.platform === 'win32')(
    'releases the Windows owner when preparation fails after lease acquisition',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-request-write-cleanup-'));
      tempRoots.push(root);
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: root,
        shouldSandbox: () => true,
      });
      const poisonDirectories = [
        path.join(process.env.KODAX_HOME!, 'sandbox-runtime', 'acl-poison'),
        path.join(process.env.ProgramData!, 'KodaX', 'sandbox-runtime', 'acl-poison'),
      ];
      fileSystemMock.writeBrokerRequestFailure = true;

      await expect(sandbox.prepare({
        toolCallId: 'bash-request-write-cleanup',
        toolInput: { command: 'node --version' },
        command: 'node --version',
        executable: process.execPath,
        args: ['--version'],
        cwd: root,
        env: process.env,
      })).resolves.toBeUndefined();
      for (const directory of poisonDirectories) {
        await expect(readdir(directory)).resolves.toEqual([]);
      }

      fileSystemMock.writeBrokerRequestFailure = false;
      const recovered = await sandbox.prepare({
        toolCallId: 'bash-after-request-write-cleanup',
        toolInput: { command: 'node --version' },
        command: 'node --version',
        executable: process.execPath,
        args: ['--version'],
        cwd: root,
        env: process.env,
      });
      if (!recovered) throw new Error('expected preparation after owner cleanup');
      await recovered.cleanup();
    },
  );

  it.runIf(process.platform === 'win32')(
    'preserves the prepare error while rolling back an ephemeral Windows owner',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-review-write-cleanup-'));
      tempRoots.push(root);
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: root,
        shouldSandbox: () => ({
          agentHomeAccess: { read: [], write: [], ephemeral: true },
        }),
      });
      fileSystemMock.writeBrokerRequestFailure = true;

      await expect(sandbox.prepare({
        toolCallId: 'bash-review-request-write-cleanup',
        toolInput: { command: 'node --version' },
        command: 'node --version',
        executable: process.execPath,
        args: ['--version'],
        cwd: root,
        env: process.env,
      })).resolves.toBeUndefined();
      await expect(readdir(path.join(
        process.env.ProgramData!,
        'KodaX',
        'sandbox-runtime',
        'acl-poison',
      ))).resolves.toEqual([]);
    },
  );

  it.runIf(process.platform === 'win32')(
    'does not reuse a rejected Windows workspace owner for a later command',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-warmup-recovery-'));
      const agentHome = path.join(root, 'agent-home');
      const safeDirectory = path.join(agentHome, 'tool-results');
      await mkdir(safeDirectory, { recursive: true });
      vi.stubEnv('KODAX_HOME', agentHome);
      tempRoots.push(root);
      workspaceSessionControl.malformedReady = true;
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: root,
        shouldSandbox: () => ({
          agentHomeAccess: {
            read: [path.join(safeDirectory, 'result.txt')],
            write: [],
          },
        }),
      });

      const rejectedOwner = sandbox.prepare({
        toolCallId: 'bash-warmup-failed',
        toolInput: { command: 'echo first' },
        command: 'echo first',
        cwd: root,
        env: process.env,
      });
      await expect(Promise.race([
        rejectedOwner,
        new Promise((_, reject) => setTimeout(
          () => reject(new Error('rejected workspace owner did not settle')),
          3_000,
        )),
      ])).resolves.toBeUndefined();

      workspaceSessionControl.malformedReady = false;
      const recovered = await sandbox.prepare({
        toolCallId: 'bash-warmup-recovered',
        toolInput: { command: 'echo second' },
        command: 'echo second',
        cwd: root,
        env: process.env,
      });
      if (!recovered) throw new Error('expected a fresh workspace session after warm-up failure');
      const requestFile = recovered.args.find((arg) => arg.endsWith('.json'));
      if (!requestFile) throw new Error('expected recovered broker request');
      const request = JSON.parse(readFileSync(requestFile, 'utf8')) as {
        readonly observationFile: string;
      };
      await writeFile(request.observationFile, JSON.stringify({
        version: 1,
        state: 'applied',
        backend: sandboxRuntimeCapability().backend,
        policyId: 'kodax-workspace-shell-v1',
      }), 'utf8');
      await recovered.cleanup();

      expect(capturedWorkspaceSessionConfigs).toHaveLength(2);
    },
  );

  it.runIf(process.platform === 'win32')(
    'uses command-scoped owners for bounded safe and review-only Agent Home access',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-scoped-session-'));
      const agentHome = path.join(root, 'agent-home');
      const safeDirectory = path.join(agentHome, 'tool-results');
      const reviewedConfig = path.join(agentHome, 'config.json');
      await mkdir(safeDirectory, { recursive: true });
      await writeFile(reviewedConfig, '{}', 'utf8');
      vi.stubEnv('KODAX_HOME', agentHome);
      tempRoots.push(root);

      let access: {
        read: string[];
        write: string[];
        ephemeral?: boolean;
      } = {
        read: [path.join(safeDirectory, 'result.txt')],
        write: [],
      };
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: root,
        shouldSandbox: () => ({ agentHomeAccess: access }),
      });
      const prepare = async (id: string): Promise<void> => {
        const invocation = await sandbox.prepare({
          toolCallId: id,
          toolInput: { command: 'echo safe' },
          command: 'echo safe',
          cwd: root,
          env: process.env,
        });
        if (!invocation) throw new Error('expected scoped sandbox invocation');
        await invocation.cleanup();
      };

      await prepare('safe-1');
      await prepare('safe-2');
      expect(capturedWorkspaceSessionConfigs).toHaveLength(2);

      access = {
        read: [reviewedConfig],
        write: [],
        ephemeral: true,
      };
      await prepare('reviewed-1');
      await prepare('reviewed-2');
      expect(capturedWorkspaceSessionConfigs).toHaveLength(4);
    },
  );

  it.runIf(process.platform === 'win32')(
    'keeps ordinary authorized shell effects available while a review-only ACL is live',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-exclusive-review-'));
      const agentHome = path.join(root, 'agent-home');
      const reviewedConfig = path.join(agentHome, 'config.json');
      await mkdir(agentHome, { recursive: true });
      await writeFile(reviewedConfig, '{}', 'utf8');
      vi.stubEnv('KODAX_HOME', agentHome);
      tempRoots.push(root);
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: root,
        shouldSandbox: () => ({
          agentHomeAccess: { read: [reviewedConfig], write: [], ephemeral: true },
        }),
      });

      const invocation = await sandbox.prepare({
        toolCallId: 'review-exclusive',
        toolInput: { command: 'type config.json' },
        command: 'type config.json',
        cwd: root,
        env: process.env,
      });
      if (!invocation) throw new Error('expected review-only sandbox invocation');
      const overlappingLease = await acquireFileSystemMutationLease();
      await overlappingLease();

      await invocation.cleanup();
      const admittedAfterCleanup = await acquireFileSystemMutationLease();
      await admittedAfterCleanup();
    },
  );

  it.runIf(process.platform === 'win32')(
    'isolates and removes each workspace-session temp directory',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-session-temp-'));
      const agentHome = path.join(root, 'agent-home');
      const safeDirectory = path.join(agentHome, 'tool-results');
      await mkdir(safeDirectory, { recursive: true });
      await writeFile(path.join(safeDirectory, 'one.txt'), '', 'utf8');
      await writeFile(path.join(safeDirectory, 'two.txt'), '', 'utf8');
      vi.stubEnv('KODAX_HOME', agentHome);
      tempRoots.push(root);
      let selectedPath = path.join(safeDirectory, 'one.txt');
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: root,
        shouldSandbox: () => ({
          agentHomeAccess: { read: [], write: [selectedPath] },
        }),
      });
      const prepare = async (id: string): Promise<void> => {
        const invocation = await sandbox.prepare({
          toolCallId: id,
          toolInput: { command: 'echo safe' },
          command: 'echo safe',
          cwd: root,
          env: process.env,
        });
        if (!invocation) throw new Error('expected scoped sandbox invocation');
        await invocation.cleanup();
      };

      await prepare('temp-one');
      selectedPath = path.join(safeDirectory, 'two.txt');
      await prepare('temp-two');
      const sessionTemps = capturedWorkspaceRequests.map((request) => (
        (request.env as NodeJS.ProcessEnv | undefined)?.TEMP
      )).filter((candidate): candidate is string => (
        candidate?.includes(`${path.sep}kodax-sandbox${path.sep}`) === true
      ));
      expect(sessionTemps).toHaveLength(capturedWorkspaceSessionConfigs.length);
      expect(new Set(sessionTemps).size).toBe(sessionTemps.length);

      await resetAsrtWorkspaceSessionsForTest();
      await expect(Promise.all(sessionTemps.map(async (directory) => {
        await expect(stat(directory)).rejects.toThrow();
      }))).resolves.toBeDefined();
    },
  );

  it.runIf(process.platform === 'win32')(
    'does not poison Windows ACL state when only session temp cleanup fails',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-temp-cleanup-failure-'));
      tempRoots.push(root);
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: root,
        shouldSandbox: () => true,
      });
      const prepare = (toolCallId: string) => sandbox.prepare({
        toolCallId,
        toolInput: { command: 'node --version' },
        command: 'node --version',
        executable: process.execPath,
        args: ['--version'],
        cwd: root,
        env: process.env,
      });
      const first = await prepare('bash-before-temp-cleanup-failure');
      if (!first) throw new Error('expected first workspace invocation');
      const config = capturedWorkspaceSessionConfigs.at(-1) as {
        readonly filesystem: { readonly allowWrite: readonly string[] };
      };
      const tempDirectory = config.filesystem.allowWrite.find((candidate) => (
        candidate.includes(`${path.sep}kodax-sandbox${path.sep}`)
      ));
      if (!tempDirectory) throw new Error('expected workspace session temp directory');

      fileSystemMock.rmFailurePath = tempDirectory;
      await first.cleanup();
      const replacement = await prepare('bash-after-temp-cleanup-failure');
      if (!replacement) throw new Error('expected replacement after temp cleanup failure');
      await replacement.cleanup();
      expect(capturedWorkspaceSessionConfigs).toHaveLength(2);
    },
  );

  it.runIf(process.platform === 'win32')(
    'keeps only the current safe Agent Home ACL scope',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-scope-cap-'));
      const agentHome = path.join(root, 'agent-home');
      const safeDirectory = path.join(agentHome, 'tool-results');
      await mkdir(safeDirectory, { recursive: true });
      for (let index = 0; index < 9; index += 1) {
        await writeFile(path.join(safeDirectory, `${index}.txt`), '', 'utf8');
      }
      vi.stubEnv('KODAX_HOME', agentHome);
      tempRoots.push(root);

      let selectedPath = path.join(safeDirectory, '0.txt');
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: root,
        shouldSandbox: () => ({
          agentHomeAccess: { read: [], write: [selectedPath] },
        }),
      });
      const prepare = async (index: number): Promise<void> => {
        selectedPath = path.join(safeDirectory, `${index}.txt`);
        const invocation = await sandbox.prepare({
          toolCallId: `scope-${index}`,
          toolInput: { command: 'echo safe' },
          command: 'echo safe',
          cwd: root,
          env: process.env,
        });
        if (!invocation) throw new Error('expected bounded scoped invocation');
        await invocation.cleanup();
      };

      for (let index = 0; index < 8; index += 1) await prepare(index);
      expect(capturedWorkspaceSessionConfigs).toHaveLength(8);

      workspaceSessionControl.delayClose = true;
      const ninth = prepare(8);
      await vi.waitFor(() => expect(workspaceSessionControl.releaseClose).toBeDefined());
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(capturedWorkspaceSessionConfigs).toHaveLength(9);
      workspaceSessionControl.delayClose = false;
      workspaceSessionControl.releaseClose?.();
      workspaceSessionControl.releaseClose = undefined;
      await ninth;
      expect(capturedWorkspaceSessionConfigs).toHaveLength(9);

      await prepare(8);
      expect(capturedWorkspaceSessionConfigs).toHaveLength(10);
      await prepare(0);
      expect(capturedWorkspaceSessionConfigs).toHaveLength(11);
    },
  );

  it.runIf(process.platform === 'win32')(
    'does not replace an Agent Home scope when its ACL reset exit is unclean',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-reset-fail-'));
      const agentHome = path.join(root, 'agent-home');
      const safeDirectory = path.join(agentHome, 'tool-results');
      await mkdir(safeDirectory, { recursive: true });
      for (let index = 0; index < 9; index += 1) {
        await writeFile(path.join(safeDirectory, `${index}.txt`), '', 'utf8');
      }
      vi.stubEnv('KODAX_HOME', agentHome);
      tempRoots.push(root);

      let selectedPath = path.join(safeDirectory, '0.txt');
      const reportObservation = vi.fn();
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: root,
        shouldSandbox: () => ({
          agentHomeAccess: { read: [], write: [selectedPath] },
        }),
      });
      const prepare = async (index: number) => {
        selectedPath = path.join(safeDirectory, `${index}.txt`);
        const invocation = await sandbox.prepare({
          toolCallId: `reset-fail-${index}`,
          toolInput: { command: 'echo safe' },
          command: 'echo safe',
          cwd: root,
          env: process.env,
          reportObservation,
        });
        await invocation?.cleanup();
        return invocation;
      };

      for (let index = 0; index < 8; index += 1) {
        expect(await prepare(index)).toBeDefined();
      }
      expect(capturedWorkspaceSessionConfigs).toHaveLength(8);

      workspaceSessionControl.closeExitCode = 1;
      const cleanupFailure = await prepare(8).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(cleanupFailure).toBeInstanceOf(AggregateError);
      expect((cleanupFailure as AggregateError).errors.map(String)).toEqual(
        expect.arrayContaining([
          expect.stringContaining('ASRT workspace session ACL reset was not confirmed'),
        ]),
      );
      expect(capturedWorkspaceSessionConfigs).toHaveLength(9);
      expect(reportObservation).not.toHaveBeenCalled();

      workspaceSessionControl.closeExitCode = 0;
      await expect(prepare(8)).resolves.toBeUndefined();
      expect(capturedWorkspaceSessionConfigs).toHaveLength(9);
    },
  );

  it.runIf(process.platform === 'win32')(
    'cancels a session startup promptly but closes the late Windows owner before replacement',
    async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-session-cancel-'));
    tempRoots.push(root);
    workspaceSessionControl.delayReady = true;
    workspaceSessionControl.delayClose = true;
    const controller = new AbortController();
    const sandbox = createAsrtShellSandbox({
      workspaceRoot: root,
      shouldSandbox: () => true,
    });
    const preparing = sandbox.prepare({
      toolCallId: 'bash-session-cancel',
      toolInput: { command: 'node --version' },
      command: 'node --version',
      executable: process.execPath,
      args: ['--version'],
      cwd: root,
      env: process.env,
      signal: controller.signal,
    });
    await vi.waitFor(() => {
      expect(workspaceSessionControl.releaseReady).toBeTypeOf('function');
    });

    controller.abort();
    await expect(preparing).rejects.toMatchObject({ name: 'AbortError' });
    const poisonDirectory = path.join(
      path.resolve(process.env.KODAX_HOME!),
      'sandbox-runtime',
      'acl-poison',
    );
    const globalPoisonDirectory = path.join(
      path.resolve(process.env.ProgramData!),
      'KodaX',
      'sandbox-runtime',
      'acl-poison',
    );
    await expect(readdir(poisonDirectory)).resolves.toHaveLength(1);
    await expect(readdir(globalPoisonDirectory)).resolves.toHaveLength(1);
    workspaceSessionControl.delayReady = false;
    workspaceSessionControl.releaseReady?.();
    workspaceSessionControl.releaseReady = undefined;
    await vi.waitFor(() => expect(workspaceSessionControl.releaseClose).toBeDefined());
    await expect(readdir(poisonDirectory)).resolves.toHaveLength(1);
    await expect(readdir(globalPoisonDirectory)).resolves.toHaveLength(1);
    let effectDuringResetSettled = false;
    const effectDuringResetPending = acquireFileSystemMutationLease().finally(() => {
      effectDuringResetSettled = true;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    expect(effectDuringResetSettled).toBe(false);
    const replacementPending = sandbox.prepare({
      toolCallId: 'bash-after-session-cancel',
      toolInput: { command: 'node --version' },
      command: 'node --version',
      executable: process.execPath,
      args: ['--version'],
      cwd: root,
      env: process.env,
    });
    await expect(replacementPending).resolves.toBeUndefined();
    expect(capturedWorkspaceSessionConfigs).toHaveLength(1);
    workspaceSessionControl.delayClose = false;
    workspaceSessionControl.releaseClose?.();
    workspaceSessionControl.releaseClose = undefined;
    const effectDuringReset = await effectDuringResetPending;
    await effectDuringReset();
    await vi.waitFor(async () => {
      await expect(readdir(poisonDirectory)).resolves.toEqual([]);
      await expect(readdir(globalPoisonDirectory)).resolves.toEqual([]);
    });
    const replacement = await sandbox.prepare({
      toolCallId: 'bash-after-session-cancel-reset',
      toolInput: { command: 'node --version' },
      command: 'node --version',
      executable: process.execPath,
      args: ['--version'],
      cwd: root,
      env: process.env,
    });
    if (!replacement) throw new Error('expected replacement after cancelled startup cleanup');
    await replacement.cleanup();
    const effectAfterCleanup = await acquireFileSystemMutationLease();
    await effectAfterCleanup();
    await expect(readdir(poisonDirectory)).resolves.toEqual([]);
    await expect(readdir(globalPoisonDirectory)).resolves.toEqual([]);
    expect(capturedWorkspaceSessionConfigs).toHaveLength(2);
    },
  );

  it.runIf(process.platform === 'win32')(
    'times out a session startup promptly and closes the late Windows owner',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-session-timeout-'));
      tempRoots.push(root);
      workspaceSessionControl.delayReady = true;
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: root,
        shouldSandbox: () => true,
      });
      const preparing = sandbox.prepare({
        toolCallId: 'bash-session-timeout',
        toolInput: { command: 'node --version' },
        command: 'node --version',
        executable: process.execPath,
        args: ['--version'],
        cwd: root,
        env: process.env,
        deadlineAt: Date.now() + 250,
      });
      const timeoutOutcome = preparing.then(
        () => undefined,
        (error: unknown) => error,
      );
      await vi.waitFor(() => {
        expect(workspaceSessionControl.releaseReady).toBeTypeOf('function');
      });
      await expect(timeoutOutcome).resolves.toMatchObject({ name: 'TimeoutError' });
      workspaceSessionControl.releaseReady?.();
      workspaceSessionControl.releaseReady = undefined;
      const poisonDirectory = path.join(
        path.resolve(process.env.KODAX_HOME!),
        'sandbox-runtime',
        'acl-poison',
      );
      const globalPoisonDirectory = path.join(
        path.resolve(process.env.ProgramData!),
        'KodaX',
        'sandbox-runtime',
        'acl-poison',
      );
      await vi.waitFor(async () => {
        await expect(readdir(poisonDirectory)).resolves.toEqual([]);
        await expect(readdir(globalPoisonDirectory)).resolves.toEqual([]);
      });
    },
  );

  it.runIf(process.platform === 'win32')(
    'keeps a late cancelled owner fail-closed when its ACL reset is unclean',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-session-cancel-unclean-'));
      tempRoots.push(root);
      workspaceSessionControl.delayReady = true;
      workspaceSessionControl.closeExitCode = 1;
      const controller = new AbortController();
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: root,
        shouldSandbox: () => true,
      });
      const preparing = sandbox.prepare({
        toolCallId: 'bash-session-cancel-unclean',
        toolInput: { command: 'node --version' },
        command: 'node --version',
        executable: process.execPath,
        args: ['--version'],
        cwd: root,
        env: process.env,
        signal: controller.signal,
      });
      await vi.waitFor(() => {
        expect(workspaceSessionControl.releaseReady).toBeTypeOf('function');
      });
      controller.abort();
      await expect(preparing).rejects.toMatchObject({ name: 'AbortError' });
      workspaceSessionControl.releaseReady?.();
      workspaceSessionControl.releaseReady = undefined;
      const globalPoisonDirectory = path.join(
        path.resolve(process.env.ProgramData!),
        'KodaX',
        'sandbox-runtime',
        'acl-poison',
      );
      await vi.waitFor(async () => {
        const markers = await readdir(globalPoisonDirectory);
        expect(markers.some((name) => name.startsWith('unconfirmed-'))).toBe(true);
      });
      await expect(sandbox.prepare({
        toolCallId: 'bash-after-session-cancel-unclean',
        toolInput: { command: 'node --version' },
        command: 'node --version',
        executable: process.execPath,
        args: ['--version'],
        cwd: root,
        env: process.env,
      })).resolves.toBeUndefined();
      const authorizedFallbackLease = await acquireFileSystemMutationLease();
      await authorizedFallbackLease();
      expect(capturedWorkspaceSessionConfigs).toHaveLength(1);
    },
  );

  it('cancels a delayed wrap promptly and cleans up its late response', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-wrap-cancel-'));
    tempRoots.push(root);
    workspaceSessionControl.delayWrap = true;
    const controller = new AbortController();
    const sandbox = createAsrtShellSandbox({
      workspaceRoot: root,
      shouldSandbox: () => true,
    });
    const preparing = sandbox.prepare({
      toolCallId: 'bash-wrap-cancel',
      toolInput: { command: 'node --version' },
      command: 'node --version',
      executable: process.execPath,
      args: ['--version'],
      cwd: root,
      env: process.env,
      signal: controller.signal,
    });
    await vi.waitFor(() => {
      expect(workspaceSessionControl.releaseWrap).toBeTypeOf('function');
    });

    const cancelledAt = Date.now();
    controller.abort();
    await expect(preparing).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - cancelledAt).toBeLessThan(500);

    workspaceSessionControl.cleanupFailure = 'injected late cleanup failure';
    workspaceSessionControl.delayWrap = false;
    workspaceSessionControl.releaseWrap?.();
    workspaceSessionControl.releaseWrap = undefined;
    await vi.waitFor(() => expect(workspaceSessionControl.cleanupRequests).toBe(1));
    workspaceSessionControl.cleanupFailure = undefined;
    if (process.platform === 'win32') {
      await vi.waitFor(async () => {
        await expect(readdir(path.join(
          path.resolve(process.env.ProgramData!),
          'KodaX',
          'sandbox-runtime',
          'acl-poison',
        ))).resolves.toEqual([]);
      });
    }
    let next = await sandbox.prepare({
      toolCallId: 'bash-after-wrap-cancel',
      toolInput: { command: 'node --version' },
      command: 'node --version',
      executable: process.execPath,
      args: ['--version'],
      cwd: root,
      env: process.env,
    });
    for (let attempt = 0; next === undefined && attempt < 10; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      next = await sandbox.prepare({
        toolCallId: `bash-after-wrap-cancel-${attempt}`,
        toolInput: { command: 'node --version' },
        command: 'node --version',
        executable: process.execPath,
        args: ['--version'],
        cwd: root,
        env: process.env,
      });
    }
    if (!next) throw new Error('expected replacement after failed late cleanup');
    await next.cleanup();
    expect(capturedWorkspaceSessionConfigs).toHaveLength(2);
  });

  it('retires a workspace session when cancellation races with a failed cleanup response', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-wrap-cancelled-cleanup-'));
    tempRoots.push(root);
    const controller = new AbortController();
    workspaceSessionControl.cleanupFailure = 'injected cancelled cleanup failure';
    workspaceSessionControl.afterWrapResponse = () => controller.abort();
    const sandbox = createAsrtShellSandbox({
      workspaceRoot: root,
      shouldSandbox: () => true,
    });

    await expect(sandbox.prepare({
      toolCallId: 'bash-wrap-cancelled-cleanup',
      toolInput: { command: 'node --version' },
      command: 'node --version',
      executable: process.execPath,
      args: ['--version'],
      cwd: root,
      env: process.env,
      signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });

    await vi.waitFor(() => expect(workspaceSessionControl.cleanupRequests).toBe(1));
    workspaceSessionControl.cleanupFailure = undefined;
    workspaceSessionControl.afterWrapResponse = undefined;
    if (process.platform === 'win32') {
      await vi.waitFor(async () => {
        await expect(readdir(path.join(
          path.resolve(process.env.ProgramData!),
          'KodaX',
          'sandbox-runtime',
          'acl-poison',
        ))).resolves.toEqual([]);
      });
    }
    let next = await sandbox.prepare({
      toolCallId: 'bash-after-cancelled-cleanup',
      toolInput: { command: 'node --version' },
      command: 'node --version',
      executable: process.execPath,
      args: ['--version'],
      cwd: root,
      env: process.env,
    });
    for (let attempt = 0; next === undefined && attempt < 10; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      next = await sandbox.prepare({
        toolCallId: `bash-after-cancelled-cleanup-${attempt}`,
        toolInput: { command: 'node --version' },
        command: 'node --version',
        executable: process.execPath,
        args: ['--version'],
        cwd: root,
        env: process.env,
      });
    }
    if (!next) throw new Error('expected replacement after cancelled cleanup failure');
    await next.cleanup();
    expect(capturedWorkspaceSessionConfigs).toHaveLength(2);
  });

  it('fails closed promptly when workspace process-tree termination cannot be confirmed', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-session-unknown-kill-'));
    tempRoots.push(root);
    workspaceSessionControl.malformedReady = true;
    processTreeKillMock.outcome = 'unknown';
    const sandbox = createAsrtShellSandbox({
      workspaceRoot: root,
      shouldSandbox: () => true,
    });
    const prepare = (toolCallId: string) => sandbox.prepare({
      toolCallId,
      toolInput: { command: 'node --version' },
      command: 'node --version',
      executable: process.execPath,
      args: ['--version'],
      cwd: root,
      env: process.env,
    });
    await expect(prepare('bash-before-unknown-session-kill')).resolves.toBeUndefined();
    const startedAt = Date.now();
    await expect(prepare('bash-after-unknown-session-kill')).resolves.toBeUndefined();
    expect(Date.now() - startedAt).toBeLessThan(1_500);
    expect(capturedWorkspaceSessionConfigs).toHaveLength(1);

    processTreeKillMock.releaseUnknown?.();
    processTreeKillMock.releaseUnknown = undefined;
    processTreeKillMock.outcome = 'actual';
    workspaceSessionControl.malformedReady = false;
  });

  it('force-terminates a malformed owner and recovers after verified ACL cleanup', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-session-poison-'));
    tempRoots.push(root);
    stubbornBroker.mode = 'silent';
    workspaceSessionControl.malformedReady = true;
    const sandbox = createAsrtShellSandbox({
      workspaceRoot: root,
      shouldSandbox: () => true,
    });

    await expect(sandbox.prepare({
      toolCallId: 'bash-poisoned-session',
      toolInput: { command: 'node --version' },
      command: 'node --version',
      executable: process.execPath,
      args: ['--version'],
      cwd: root,
      env: process.env,
    })).resolves.toBeUndefined();
    expect(capturedProcessTreeKillOptions).toContainEqual(expect.objectContaining({
      gracefulStdinEnd: false,
      gracefulMs: 1_500,
    }));
    expect(capturedKillSignals).toContain('SIGTERM');
    expect(capturedKillSignals).toContain('SIGKILL');

    stubbornBroker.mode = 'none';
    workspaceSessionControl.malformedReady = false;
    const recovered = await sandbox.prepare({
      toolCallId: 'bash-recovered-session',
      toolInput: { command: 'node --version' },
      command: 'node --version',
      executable: process.execPath,
      args: ['--version'],
      cwd: root,
      env: process.env,
    });
    if (!recovered) throw new Error('expected recovery after confirmed forced termination');
    await recovered.cleanup();
    expect(capturedSpawnArgv.filter((argv) => argv.some((arg) => (
      arg.includes('sandbox-workspace-session')
      || arg === '__asrt-workspace-session'
    )))).toHaveLength(process.platform === 'win32' ? 2 : 3);
  });

  it('uses the compiled KodaX internal session entry in bundled builds', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-session-bundled-'));
    tempRoots.push(root);
    const original = process.env.KODAX_BUNDLED;
    process.env.KODAX_BUNDLED = 'true';
    try {
      await doctorSandboxRuntime({ refresh: true });
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: root,
        shouldSandbox: () => true,
      });
      const prepared = await sandbox.prepare({
        toolCallId: 'bash-session-bundled',
        toolInput: { command: 'node --version' },
        command: 'node --version',
        executable: process.execPath,
        args: ['--version'],
        cwd: root,
        env: process.env,
      });
      if (!prepared) throw new Error('expected bundled workspace invocation');
      expect(capturedSpawnArgv).toContainEqual([
        process.execPath,
        '__asrt-workspace-session',
        expect.stringMatching(/workspace-.+\.json$/),
      ]);
      await prepared.cleanup();
    } finally {
      if (original === undefined) delete process.env.KODAX_BUNDLED;
      else process.env.KODAX_BUNDLED = original;
    }
  });

  it('uses packaged Electron as the sandbox target JavaScript runtime', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-electron-bootstrap-'));
    tempRoots.push(root);
    const originalBundled = process.env.KODAX_BUNDLED;
    vi.stubEnv('PATH', path.join(root, 'isolated-path'));
    const electronDescriptor = Object.getOwnPropertyDescriptor(process.versions, 'electron');
    process.env.KODAX_BUNDLED = 'true';
    Object.defineProperty(process.versions, 'electron', {
      configurable: true,
      value: 'test-electron',
    });
    try {
      await doctorSandboxRuntime({ refresh: true });
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: root,
        shouldSandbox: () => true,
      });
      const prepared = await sandbox.prepare({
        toolCallId: 'bash-electron-bootstrap',
        toolInput: { command: 'node --version' },
        command: 'node --version',
        executable: process.execPath,
        args: ['--version'],
        cwd: root,
        env: process.env,
      });
      if (!prepared) throw new Error('expected packaged Electron workspace invocation');
      try {
        const requestFile = prepared.args.find((arg) => arg.endsWith('.json'));
        if (!requestFile) throw new Error('expected packaged Electron broker request');
        const request = JSON.parse(readFileSync(requestFile, 'utf8')) as {
          readonly bootstrapCommand?: string;
          readonly config: {
            readonly filesystem: { readonly allowRead: readonly string[] };
          };
        };
        expect(request.bootstrapCommand).toBe(process.execPath);
        expect(request.config.filesystem.allowRead).toContain(path.dirname(process.execPath));
      } finally {
        await prepared.cleanup();
      }
    } finally {
      if (originalBundled === undefined) delete process.env.KODAX_BUNDLED;
      else process.env.KODAX_BUNDLED = originalBundled;
      if (electronDescriptor === undefined) delete process.versions.electron;
      else Object.defineProperty(process.versions, 'electron', electronDescriptor);
    }
  });

  it('drains an active command before closing its workspace session', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-session-drain-'));
    tempRoots.push(root);
    const sandbox = createAsrtShellSandbox({
      workspaceRoot: root,
      shouldSandbox: () => true,
    });
    const prepared = await sandbox.prepare({
      toolCallId: 'bash-session-drain',
      toolInput: { command: 'node --version' },
      command: 'node --version',
      executable: process.execPath,
      args: ['--version'],
      cwd: root,
      env: process.env,
    });
    if (!prepared) throw new Error('expected workspace invocation');
    const requestFile = prepared.args.find((arg) => arg.endsWith('.json'));
    if (!requestFile) throw new Error('expected broker request');
    const request = JSON.parse(readFileSync(requestFile, 'utf8')) as {
      readonly observationFile: string;
    };
    await writeFile(request.observationFile, JSON.stringify({
      version: 1,
      state: 'applied',
      backend: sandboxRuntimeCapability().backend,
      policyId: 'kodax-workspace-shell-v1',
    }), 'utf8');

    const closing = resetAsrtWorkspaceSessionsForTest();
    await expect(prepared.cleanup()).resolves.toMatchObject({ state: 'applied' });
    await expect(closing).resolves.toBeUndefined();
  });

  it('falls back to the ordinary execution plan when an optional ASRT is not ready', async () => {
    await markSandboxRuntimeUnavailable();
    const sandbox = createAsrtShellSandbox({
      workspaceRoot: process.cwd(),
      shouldSandbox: () => true,
    });
    const reportObservation = vi.fn();

    await expect(sandbox.prepare({
      toolCallId: 'bash-no-asrt',
      toolInput: { command: 'copy a.txt b.txt' },
      command: 'copy a.txt b.txt',
      cwd: process.cwd(),
      env: process.env,
      reportObservation,
    })).resolves.toBeUndefined();
    expect(reportObservation).toHaveBeenCalledWith({
      version: 1,
      state: 'fallback',
      reason: 'not_ready',
      execution: 'normal_permission_policy',
    });
  });

  it('does not expose a fail-closed mode when an admitted call is unavailable', async () => {
    await markSandboxRuntimeUnavailable();
    const sandbox = createAsrtShellSandbox({
      workspaceRoot: process.cwd(),
      shouldSandbox: () => true,
    });
    const reportObservation = vi.fn();

    await expect(sandbox.prepare({
      toolCallId: 'bash-no-asrt-required',
      toolInput: { command: 'node --version' },
      command: 'node --version',
      cwd: process.cwd(),
      env: process.env,
      reportObservation,
    })).resolves.toBeUndefined();
    expect(sandbox).not.toHaveProperty('failClosed');
    expect(sandbox.processTreeContainment).toBe(
      process.platform === 'linux' ? 'root-exit-drains' : undefined,
    );
    expect(reportObservation).toHaveBeenCalledWith(expect.objectContaining({
      state: 'fallback',
      reason: 'not_ready',
    }));
  });

  it('returns structured unavailability for a standalone SDK sandbox run', async () => {
    await markSandboxRuntimeUnavailable();

    await expect(runKodaXSandboxed({
      command: process.execPath,
      args: ['--version'],
      cwd: process.cwd(),
      filesystem: {
        allowRead: [process.cwd()],
        allowWrite: [],
      },
    })).resolves.toMatchObject({
      status: 'unavailable',
      sandboxed: false,
      doctor: { ready: false },
    });
  });

  it.runIf(process.platform === 'win32')(
    'recovers Windows ACLs before startup and after each standalone SDK execution',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-sdk-acl-recovery-'));
      tempRoots.push(root);
      const run = () => runKodaXSandboxed({
        command: process.execPath,
        args: ['--version'],
        cwd: root,
        filesystem: { allowRead: [], allowWrite: [] },
      });

      await expect(run()).resolves.toMatchObject({ status: 'completed', exitCode: 0 });
      await expect(run()).resolves.toMatchObject({ status: 'completed', exitCode: 0 });

      expect(capturedSyncSpawns.filter(({ args }) => (
        args.includes('acl') && args.includes('recover') && args.includes('--json')
      ))).toHaveLength(3);
      expect(fileSystemMock.aclPoisonMarkerWriteTargets.some((target) => (
        target.startsWith(path.join(path.resolve(process.env.ProgramData!), 'KodaX'))
      ))).toBe(true);
      expect(fileSystemMock.aclPoisonMarkerWriteTargets.some((target) => (
        target.startsWith(path.resolve(process.env.KODAX_HOME!))
      ))).toBe(true);
    },
  );

  it.runIf(process.platform === 'win32')(
    'retires a workspace owner before admitting a standalone owner in the same module',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-owner-singleton-'));
      tempRoots.push(root);
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: root,
        shouldSandbox: () => true,
      });
      const invocation = await sandbox.prepare({
        toolCallId: 'bash-active-workspace-owner',
        toolInput: { command: 'node --version' },
        command: 'node --version',
        executable: process.execPath,
        args: ['--version'],
        cwd: root,
        env: process.env,
      });
      if (!invocation) throw new Error('expected workspace invocation');
      await invocation.cleanup();

      await expect(runKodaXSandboxed({
        command: process.execPath,
        args: ['--version'],
        cwd: root,
        filesystem: { allowRead: [], allowWrite: [] },
      })).resolves.toMatchObject({ status: 'completed', exitCode: 0 });
    },
  );

  it.runIf(process.platform === 'win32')(
    'fails closed when orphaned Windows ACL recovery is not confirmed',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-sdk-acl-recovery-failure-'));
      tempRoots.push(root);
      windowsSandboxMock.aclRecoveryOutcome = 'failure';
      const run = () => runKodaXSandboxed({
        command: process.execPath,
        args: ['--version'],
        cwd: root,
        filesystem: { allowRead: [], allowWrite: [] },
      });

      await expect(run()).rejects.toThrow('Windows sandbox ACL recovery failed');
      expect(capturedBrokerRequests).toHaveLength(0);

      windowsSandboxMock.aclRecoveryOutcome = 'success';
      await expect(run()).rejects.toThrow('ACL cleanup was not confirmed');
      expect(capturedBrokerRequests).toHaveLength(0);
      expect(capturedSyncSpawns.filter(({ args }) => (
        args.includes('acl') && args.includes('recover')
      ))).toHaveLength(1);
    },
  );

  it.runIf(process.platform === 'win32')(
    'does not spawn a standalone owner when its durable ACL poison marker cannot be written',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-sdk-marker-write-failure-'));
      tempRoots.push(root);
      await doctorSandboxRuntime({ refresh: true });
      const spawnCount = capturedSpawnArgv.length;
      fileSystemMock.writeAclPoisonMarkerFailure = true;

      await expect(runKodaXSandboxed({
        command: process.execPath,
        args: ['--version'],
        cwd: root,
        filesystem: { allowRead: [], allowWrite: [] },
      })).rejects.toThrow('injected ACL poison marker write failure');
      expect(capturedSpawnArgv).toHaveLength(spawnCount);
    },
  );

  it.runIf(process.platform === 'win32')(
    'poisons later SDK runs when post-execution ACL recovery fails',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-sdk-reset-recovery-failure-'));
      tempRoots.push(root);
      windowsSandboxMock.aclRecoveryOutcomes.push('success', 'failure');
      const run = () => runKodaXSandboxed({
        command: process.execPath,
        args: ['--version'],
        cwd: root,
        filesystem: { allowRead: [], allowWrite: [] },
      });

      await expect(run()).rejects.toThrow('Windows sandbox ACL recovery failed');
      expect(capturedBrokerRequests).toHaveLength(1);
      await expect(run()).rejects.toThrow('ACL cleanup was not confirmed');
      expect(capturedBrokerRequests).toHaveLength(1);

      await resetAsrtWorkspaceSessionsForTest({ preserveAclPoison: true });
      windowsSandboxMock.aclRecoveryOutcome = 'success';
      await expect(run()).rejects.toThrow(/unconfirmed Windows sandbox|ACL cleanup was not confirmed/);
      expect(capturedBrokerRequests).toHaveLength(1);
    },
  );

  it.runIf(process.platform === 'win32')(
    'persists a live standalone owner when process-tree termination is unconfirmed',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-sdk-live-owner-poison-'));
      tempRoots.push(root);
      processTreeKillMock.childPid = process.pid;
      processTreeKillMock.outcome = 'unknown';
      stubbornBroker.mode = 'silent';
      const run = () => runKodaXSandboxed({
        command: process.execPath,
        args: ['--version'],
        cwd: root,
        filesystem: { allowRead: [], allowWrite: [] },
        timeoutMs: 10,
      });

      await expect(run()).rejects.toThrow('termination was not confirmed');
      const spawnCount = capturedSpawnArgv.length;
      await resetAsrtWorkspaceSessionsForTest({ preserveAclPoison: true });
      processTreeKillMock.outcome = 'actual';
      stubbornBroker.mode = 'none';

      await expect(run()).rejects.toThrow('same Windows boot');
      expect(capturedSpawnArgv).toHaveLength(spawnCount);

      processTreeKillMock.releaseUnknown?.();
      processTreeKillMock.releaseUnknown = undefined;
      processTreeKillMock.childPid = undefined;
    },
  );

  it.runIf(process.platform === 'win32')(
    'writes fallback unconfirmed evidence directly into the fail-closed marker directory',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-sdk-unconfirmed-fallback-'));
      tempRoots.push(root);
      fileSystemMock.renameAclPoisonMarkerFailures = 1;
      processTreeKillMock.outcome = 'unknown';
      stubbornBroker.mode = 'silent';

      await expect(runKodaXSandboxed({
        command: process.execPath,
        args: ['--version'],
        cwd: root,
        filesystem: { allowRead: [], allowWrite: [] },
        timeoutMs: 10,
      })).rejects.toThrow('termination was not confirmed');

      expect(fileSystemMock.aclPoisonMarkerWriteTargets).toEqual(expect.arrayContaining([
        expect.stringMatching(/[\\/]acl-poison[\\/]unconfirmed-owner-.*\.json$/),
      ]));
      processTreeKillMock.releaseUnknown?.();
      processTreeKillMock.releaseUnknown = undefined;
    },
  );

  it.runIf(process.platform === 'win32').each([
    'close_then_unknown',
    'close_then_reject',
  ] as const)(
    'waits for standalone termination proof after root close when kill ends with %s',
    async (outcome) => {
      const root = await mkdtemp(path.join(os.tmpdir(), `kodax-sdk-close-before-${outcome}-`));
      tempRoots.push(root);
      processTreeKillMock.outcome = outcome;
      stubbornBroker.mode = 'silent';
      const recoveryCountBefore = capturedSyncSpawns.filter(({ args }) => (
        args.includes('acl') && args.includes('recover')
      )).length;
      const running = runKodaXSandboxed({
        command: process.execPath,
        args: ['--version'],
        cwd: root,
        filesystem: { allowRead: [], allowWrite: [] },
        timeoutMs: 10,
      });

      await vi.waitFor(() => expect(processTreeKillMock.releaseUnknown).toBeTypeOf('function'));
      const premature = await Promise.race([
        running.then(() => 'settled', () => 'settled'),
        new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 50)),
      ]);
      const recoveryCountWhilePending = capturedSyncSpawns.filter(({ args }) => (
        args.includes('acl') && args.includes('recover')
      )).length;
      expect(premature).toBe('pending');
      expect(recoveryCountWhilePending).toBe(recoveryCountBefore + 1);

      processTreeKillMock.releaseUnknown?.();
      processTreeKillMock.releaseUnknown = undefined;
      await expect(running).rejects.toThrow(/termination (?:was not confirmed|failed)/);
      expect(capturedSyncSpawns.filter(({ args }) => (
        args.includes('acl') && args.includes('recover')
      ))).toHaveLength(recoveryCountBefore + 1);
      const poisonDirectory = path.join(
        path.resolve(process.env.KODAX_HOME!),
        'sandbox-runtime',
        'acl-poison',
      );
      await expect(readdir(poisonDirectory)).resolves.toHaveLength(1);
    },
  );

  it.runIf(process.platform === 'win32')(
    'fails closed on an active sandbox owner from another process using the same KodaX home',
    async () => {
      const actualChildProcess = await vi.importActual<typeof import('node:child_process')>(
        'node:child_process',
      );
      const holder = actualChildProcess.spawn(process.execPath, [
        '-e',
        'process.stdout.write("ready\\n");setInterval(()=>{},1000)',
      ], {
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
      await once(holder.stdout!, 'data');
      if (holder.pid === undefined) throw new Error('active marker holder PID missing');
      const holderIdentity = readProcessStartIdentity(holder.pid);
      if (holderIdentity === undefined) throw new Error('active marker holder identity missing');
      const poisonDirectory = path.join(
        path.resolve(process.env.KODAX_HOME!),
        'sandbox-runtime',
        'acl-poison',
      );
      const marker = path.join(poisonDirectory, 'foreign-profile-owner.json');
      await mkdir(poisonDirectory, { recursive: true });
      await writeFile(marker, JSON.stringify({
        version: 1,
        state: 'active',
        holderPid: holder.pid,
        holderProcessStartIdentity: holderIdentity,
        windowsBootIdentity: processIdentityMock.windowsBootIdentity,
      }), 'utf8');
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-sdk-foreign-profile-owner-'));
      tempRoots.push(root);
      const run = () => runKodaXSandboxed({
        command: process.execPath,
        args: ['--version'],
        cwd: root,
        filesystem: { allowRead: [], allowWrite: [] },
      });
      try {
        await rm(marker, { force: true });
        await expect(run()).resolves.toMatchObject({ status: 'completed', exitCode: 0 });
        await writeFile(marker, JSON.stringify({
          version: 1,
          state: 'active',
          holderPid: holder.pid,
          holderProcessStartIdentity: holderIdentity,
          windowsBootIdentity: processIdentityMock.windowsBootIdentity,
        }), 'utf8');
        await expect(run()).rejects.toThrow(/sandbox owner.*active/i);
        await expect(stat(marker)).resolves.toBeDefined();
        expect(capturedBrokerRequests).toHaveLength(1);

        await rm(marker, { force: true });
        await expect(run()).resolves.toMatchObject({ status: 'completed', exitCode: 0 });
      } finally {
        const holderClosed = once(holder, 'close');
        holder.kill('SIGKILL');
        await holderClosed;
        await rm(marker, { force: true });
      }
    },
  );

  it.runIf(process.platform === 'win32')(
    'releases a cancelled admission fence after retryable foreign owner contention',
    async () => {
      const actualChildProcess = await vi.importActual<typeof import('node:child_process')>(
        'node:child_process',
      );
      const holder = actualChildProcess.spawn(process.execPath, [
        '-e',
        'process.stdout.write("ready\\n");setInterval(()=>{},1000)',
      ], {
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
      await once(holder.stdout!, 'data');
      if (holder.pid === undefined) throw new Error('active marker holder PID missing');
      const holderIdentity = readProcessStartIdentity(holder.pid);
      if (holderIdentity === undefined) throw new Error('active marker holder identity missing');
      const poisonDirectory = path.join(
        path.resolve(process.env.ProgramData!),
        'KodaX',
        'sandbox-runtime',
        'acl-poison',
      );
      const marker = path.join(poisonDirectory, 'foreign-cancelled-owner.json');
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-foreign-owner-cancel-'));
      tempRoots.push(root);
      await mkdir(poisonDirectory, { recursive: true });
      const controller = new AbortController();
      let releaseAdmission: (() => void) | undefined;
      recoveryLockMock.beforeOperation = async () => {
        recoveryLockMock.beforeOperation = undefined;
        await new Promise<void>((resolve) => { releaseAdmission = resolve; });
      };
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: root,
        shouldSandbox: () => true,
      });
      const preparing = sandbox.prepare({
        toolCallId: 'bash-cancelled-foreign-owner',
        toolInput: { command: 'node --version' },
        command: 'node --version',
        executable: process.execPath,
        args: ['--version'],
        cwd: root,
        env: process.env,
        signal: controller.signal,
      });
      try {
        await vi.waitFor(() => expect(releaseAdmission).toBeTypeOf('function'));
        await writeFile(marker, JSON.stringify({
          version: 1,
          state: 'active',
          holderPid: holder.pid,
          holderProcessStartIdentity: holderIdentity,
          windowsBootIdentity: processIdentityMock.windowsBootIdentity,
        }), 'utf8');
        controller.abort();
        await expect(preparing).rejects.toMatchObject({ name: 'AbortError' });
        releaseAdmission?.();
        releaseAdmission = undefined;
        await vi.waitFor(async () => {
          const effectLease = await acquireFileSystemMutationLease();
          await effectLease();
        });
        expect(capturedWorkspaceSessionConfigs).toHaveLength(0);
        expect(capturedBrokerRequests).toHaveLength(0);
        await expect(stat(marker)).resolves.toBeDefined();
        await rm(marker, { force: true });
        const retry = await sandbox.prepare({
          toolCallId: 'bash-after-cancelled-foreign-owner',
          toolInput: { command: 'node --version' },
          command: 'node --version',
          executable: process.execPath,
          args: ['--version'],
          cwd: root,
          env: process.env,
        });
        if (!retry) throw new Error('expected retry after foreign owner contention');
        await retry.cleanup();
      } finally {
        releaseAdmission?.();
        const holderClosed = once(holder, 'close');
        holder.kill('SIGKILL');
        await holderClosed;
        await rm(marker, { force: true });
      }
    },
  );

  it.runIf(process.platform === 'win32')(
    'reports a dead active owner as unconfirmed cleanup instead of live contention',
    async () => {
      const actualChildProcess = await vi.importActual<typeof import('node:child_process')>(
        'node:child_process',
      );
      const holder = actualChildProcess.spawn(process.execPath, [
        '-e',
        'process.stdout.write("ready\\n");setInterval(()=>{},1000)',
      ], {
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
      await once(holder.stdout!, 'data');
      if (holder.pid === undefined) throw new Error('active marker holder PID missing');
      const holderIdentity = readProcessStartIdentity(holder.pid);
      if (holderIdentity === undefined) throw new Error('active marker holder identity missing');
      const poisonDirectory = path.join(
        path.resolve(process.env.KODAX_HOME!),
        'sandbox-runtime',
        'acl-poison',
      );
      const marker = path.join(poisonDirectory, 'dead-profile-owner.json');
      await mkdir(poisonDirectory, { recursive: true });
      await writeFile(marker, JSON.stringify({
        version: 1,
        state: 'active',
        holderPid: holder.pid,
        holderProcessStartIdentity: holderIdentity,
        windowsBootIdentity: processIdentityMock.windowsBootIdentity,
      }), 'utf8');
      const holderClosed = once(holder, 'close');
      holder.kill('SIGKILL');
      await holderClosed;
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-sdk-dead-profile-owner-'));
      tempRoots.push(root);

      await expect(runKodaXSandboxed({
        command: process.execPath,
        args: ['--version'],
        cwd: root,
        filesystem: { allowRead: [], allowWrite: [] },
      })).rejects.toThrow(/unconfirmed Windows sandbox process tree.*acl recover --force --json/i);
      await expect(stat(marker)).resolves.toBeDefined();
      expect(capturedBrokerRequests).toHaveLength(0);
      await rm(marker, { force: true });
      await expect(runKodaXSandboxed({
        command: process.execPath,
        args: ['--version'],
        cwd: root,
        filesystem: { allowRead: [], allowWrite: [] },
      })).resolves.toMatchObject({ status: 'completed', exitCode: 0 });
    },
  );

  it.runIf(process.platform === 'win32')(
    'keeps an unreadable live owner as retryable contention',
    async () => {
      const actualChildProcess = await vi.importActual<typeof import('node:child_process')>(
        'node:child_process',
      );
      const holder = actualChildProcess.spawn(process.execPath, [
        '-e',
        'process.stdout.write("ready\\n");setInterval(()=>{},1000)',
      ], {
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
      await once(holder.stdout!, 'data');
      if (holder.pid === undefined) throw new Error('active marker holder PID missing');
      const holderIdentity = readProcessStartIdentity(holder.pid);
      if (holderIdentity === undefined) throw new Error('active marker holder identity missing');
      const poisonDirectory = path.join(
        path.resolve(process.env.KODAX_HOME!),
        'sandbox-runtime',
        'acl-poison',
      );
      const marker = path.join(poisonDirectory, 'unreadable-profile-owner.json');
      await mkdir(poisonDirectory, { recursive: true });
      await writeFile(marker, JSON.stringify({
        version: 1,
        state: 'active',
        holderPid: holder.pid,
        holderProcessStartIdentity: holderIdentity,
        windowsBootIdentity: processIdentityMock.windowsBootIdentity,
      }), 'utf8');
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-sdk-unreadable-owner-'));
      tempRoots.push(root);
      const run = () => runKodaXSandboxed({
        command: process.execPath,
        args: ['--version'],
        cwd: root,
        filesystem: { allowRead: [], allowWrite: [] },
      });
      try {
        processIdentityMock.unreadablePids.add(holder.pid);
        await expect(run()).rejects.toThrow(/sandbox owner.*active/i);
        processIdentityMock.unreadablePids.delete(holder.pid);
        await rm(marker, { force: true });
        await expect(run()).resolves.toMatchObject({ status: 'completed', exitCode: 0 });
      } finally {
        processIdentityMock.unreadablePids.delete(holder.pid);
        const holderClosed = once(holder, 'close');
        holder.kill('SIGKILL');
        await holderClosed;
        await rm(marker, { force: true });
      }
    },
  );

  it.runIf(process.platform === 'win32')(
    'rejects an active sandbox owner from another SDK module copy in the same process',
    async () => {
      const holderIdentity = readProcessStartIdentity(process.pid);
      if (holderIdentity === undefined) throw new Error('current process identity missing');
      const poisonDirectory = path.join(
        path.resolve(process.env.KODAX_HOME!),
        'sandbox-runtime',
        'acl-poison',
      );
      const marker = path.join(poisonDirectory, 'same-process-module-owner.json');
      await mkdir(poisonDirectory, { recursive: true });
      await writeFile(marker, JSON.stringify({
        version: 1,
        state: 'active',
        holderPid: process.pid,
        holderProcessStartIdentity: holderIdentity,
        windowsBootIdentity: processIdentityMock.windowsBootIdentity,
      }), 'utf8');
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-sdk-same-process-owner-'));
      tempRoots.push(root);

      try {
        await expect(runKodaXSandboxed({
          command: process.execPath,
          args: ['--version'],
          cwd: root,
          filesystem: { allowRead: [], allowWrite: [] },
        })).rejects.toThrow(/sandbox owner.*active/i);
        expect(capturedBrokerRequests).toHaveLength(0);

        await rm(marker, { force: true });
        await expect(runKodaXSandboxed({
          command: process.execPath,
          args: ['--version'],
          cwd: root,
          filesystem: { allowRead: [], allowWrite: [] },
        })).resolves.toMatchObject({ status: 'completed', exitCode: 0 });
      } finally {
        await rm(marker, { force: true });
      }
    },
  );

  it.runIf(process.platform === 'win32')(
    'coordinates one Windows sandbox SID across different KODAX_HOME values',
    async () => {
      const actualChildProcess = await vi.importActual<typeof import('node:child_process')>(
        'node:child_process',
      );
      const holder = actualChildProcess.spawn(process.execPath, [
        '-e',
        'process.stdout.write("ready\\n");setInterval(()=>{},1000)',
      ], {
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
      await once(holder.stdout!, 'data');
      if (holder.pid === undefined) throw new Error('active marker holder PID missing');
      const holderIdentity = readProcessStartIdentity(holder.pid);
      if (holderIdentity === undefined) throw new Error('active marker holder identity missing');
      const poisonDirectory = path.join(
        path.resolve(process.env.ProgramData!),
        'KodaX',
        'sandbox-runtime',
        'acl-poison',
      );
      const marker = path.join(poisonDirectory, 'different-home-owner.json');
      await mkdir(poisonDirectory, { recursive: true });
      await writeFile(marker, JSON.stringify({
        version: 1,
        state: 'active',
        holderPid: holder.pid,
        holderProcessStartIdentity: holderIdentity,
        windowsBootIdentity: processIdentityMock.windowsBootIdentity,
      }), 'utf8');
      const secondHome = path.join(path.dirname(process.env.KODAX_HOME!), 'second-home');
      vi.stubEnv('KODAX_HOME', secondHome);
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-sdk-different-home-owner-'));
      tempRoots.push(root);

      try {
        await expect(runKodaXSandboxed({
          command: process.execPath,
          args: ['--version'],
          cwd: root,
          filesystem: { allowRead: [], allowWrite: [] },
        })).rejects.toThrow(/sandbox owner.*active/i);
        expect(capturedBrokerRequests).toHaveLength(0);
      } finally {
        const holderClosed = once(holder, 'close');
        holder.kill('SIGKILL');
        await holderClosed;
        await rm(marker, { force: true });
      }
    },
  );

  it.runIf(process.platform === 'win32')(
    'cleans workspace launch artifacts when another module owns the Windows sandbox SID',
    async () => {
      const holderIdentity = readProcessStartIdentity(process.pid);
      if (holderIdentity === undefined) throw new Error('current process identity missing');
      const poisonDirectory = path.join(
        path.resolve(process.env.ProgramData!),
        'KodaX',
        'sandbox-runtime',
        'acl-poison',
      );
      const marker = path.join(poisonDirectory, 'module-owner-before-workspace.json');
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-workspace-owner-contention-'));
      tempRoots.push(root);
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: root,
        shouldSandbox: () => true,
      });
      await doctorSandboxRuntime({ refresh: true });
      recoveryLockMock.calls = 0;
      recoveryLockMock.beforeOperation = async () => {
        if (recoveryLockMock.calls !== 3) return;
        recoveryLockMock.beforeOperation = undefined;
        await mkdir(poisonDirectory, { recursive: true });
        await writeFile(marker, JSON.stringify({
          version: 1,
          state: 'active',
          holderPid: process.pid,
          holderProcessStartIdentity: holderIdentity,
          windowsBootIdentity: processIdentityMock.windowsBootIdentity,
        }), 'utf8');
      };

      try {
        await expect(sandbox.prepare({
          toolCallId: 'bash-module-owner-contention',
          toolInput: { command: 'node --version' },
          command: 'node --version',
          executable: process.execPath,
          args: ['--version'],
          cwd: root,
          env: process.env,
        })).resolves.toBeUndefined();
        expect(capturedWorkspaceSessionConfigs).toHaveLength(0);
        const controlDirectory = path.join(path.resolve(process.env.KODAX_HOME!), 'sandbox-runtime');
        await expect(readdir(controlDirectory)).resolves.not.toEqual(
          expect.arrayContaining([expect.stringMatching(/^workspace-.*\.json$/)]),
        );
      } finally {
        await rm(marker, { force: true });
      }
    },
  );

  it.runIf(process.platform === 'win32')(
    'ignores a partial marker in the backward-compatible staging directory',
    async () => {
      const stagingDirectory = path.join(
        path.resolve(process.env.KODAX_HOME!),
        'sandbox-runtime',
        'acl-poison-staging',
      );
      await mkdir(stagingDirectory, { recursive: true });
      await writeFile(path.join(stagingDirectory, 'owner-in-progress.tmp'), '{', 'utf8');
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-sdk-partial-marker-'));
      tempRoots.push(root);

      await expect(runKodaXSandboxed({
        command: process.execPath,
        args: ['--version'],
        cwd: root,
        filesystem: { allowRead: [], allowWrite: [] },
      })).resolves.toMatchObject({ status: 'completed', exitCode: 0 });
      await expect(readdir(stagingDirectory)).resolves.toEqual(['owner-in-progress.tmp']);
    },
  );

  it.runIf(process.platform === 'win32')(
    'keeps a corrupt completed ACL marker sticky after the file is removed',
    async () => {
      const poisonDirectory = path.join(
        path.resolve(process.env.KODAX_HOME!),
        'sandbox-runtime',
        'acl-poison',
      );
      await mkdir(poisonDirectory, { recursive: true });
      const marker = path.join(poisonDirectory, 'owner-corrupt.json');
      await writeFile(marker, '{', 'utf8');
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-sdk-corrupt-marker-'));
      tempRoots.push(root);
      const run = () => runKodaXSandboxed({
        command: process.execPath,
        args: ['--version'],
        cwd: root,
        filesystem: { allowRead: [], allowWrite: [] },
      });

      await expect(run()).rejects.toThrow('acl recover --force --json');
      await rm(marker, { force: true });
      await expect(run()).rejects.toThrow('ACL cleanup was not confirmed');
      expect(capturedBrokerRequests).toHaveLength(0);
    },
  );

  it.runIf(process.platform === 'win32')(
    'waits for a recovery lock held by another KodaX process',
    async () => {
      await doctorSandboxRuntime({ refresh: true });
      const actualChildProcess = await vi.importActual<typeof import('node:child_process')>(
        'node:child_process',
      );
      const lockFile = path.join(
        path.resolve(process.env.ProgramData!),
        'KodaX',
        'sandbox-runtime',
        'acl-recovery.lock',
      );
      const holderScript = [
        "const fs=require('node:fs')",
        "const path=require('node:path')",
        `const lock=${JSON.stringify(lockFile)}`,
        "fs.mkdirSync(path.dirname(lock),{recursive:true})",
        "const fd=fs.openSync(lock,'wx')",
        "fs.writeSync(fd,process.pid+' 00000000-0000-4000-8000-000000000000\\n')",
        "process.stdout.write('ready\\n')",
        "process.stdin.once('data',()=>{fs.closeSync(fd);fs.rmSync(lock,{force:true});process.exit(0)})",
        'process.stdin.resume()',
      ].join(';');
      const holder = actualChildProcess.spawn(process.execPath, ['-e', holderScript], {
        stdio: ['pipe', 'pipe', 'inherit'],
        windowsHide: true,
      });
      await once(holder.stdout!, 'data');
      const holderClosed = once(holder, 'close');
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-sdk-cross-process-recovery-lock-'));
      tempRoots.push(root);
      const running = runKodaXSandboxed({
        command: process.execPath,
        args: ['--version'],
        cwd: root,
        filesystem: { allowRead: [], allowWrite: [] },
      });
      const recoveriesBeforeRelease = capturedSyncSpawns.filter((spawn) => (
        spawn.args.includes('acl') && spawn.args.includes('recover')
      )).length;

      try {
        const premature = await Promise.race([
          running.then(() => 'settled', () => 'settled'),
          new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 100)),
        ]);
        expect(premature).toBe('pending');
        expect(capturedSyncSpawns.filter((spawn) => (
          spawn.args.includes('acl') && spawn.args.includes('recover')
        ))).toHaveLength(recoveriesBeforeRelease);
        expect(capturedBrokerRequests).toHaveLength(0);
        holder.stdin!.end('release');
        await expect(running).resolves.toMatchObject({ status: 'completed', exitCode: 0 });
        await holderClosed;
      } finally {
        if (holder.exitCode === null) holder.kill('SIGKILL');
      }
    },
  );

  it.runIf(process.platform === 'win32')(
    'allows a safe admission to retry after ordinary ACL recovery lock contention',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-sdk-recovery-lock-retry-'));
      tempRoots.push(root);
      const run = () => runKodaXSandboxed({
        command: process.execPath,
        args: ['--version'],
        cwd: root,
        filesystem: { allowRead: [], allowWrite: [] },
      });
      recoveryLockMock.timeoutFailures = 1;

      await expect(run()).rejects.toThrow('learning store lock timed out');
      await expect(run()).resolves.toMatchObject({ status: 'completed', exitCode: 0 });
    },
  );

  it.runIf(process.platform === 'win32')(
    'keeps a write-ahead poison marker when post-run recovery lock acquisition times out',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-sdk-cleanup-lock-timeout-'));
      tempRoots.push(root);
      const run = () => runKodaXSandboxed({
        command: process.execPath,
        args: ['--version'],
        cwd: root,
        filesystem: { allowRead: [], allowWrite: [] },
      });
      recoveryLockMock.timeoutOnCall = 2;

      await expect(run()).rejects.toThrow('learning store lock timed out');
      expect(capturedBrokerRequests).toHaveLength(1);
      await resetAsrtWorkspaceSessionsForTest({ preserveAclPoison: true });
      recoveryLockMock.timeoutOnCall = undefined;
      recoveryLockMock.calls = 0;
      await expect(run()).rejects.toThrow(/unconfirmed Windows sandbox|ACL cleanup was not confirmed/);
      expect(capturedBrokerRequests).toHaveLength(1);
    },
  );

  it.runIf(process.platform === 'win32')(
    'removes an unspawned active marker when recovery lock release fails after admission',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-sdk-admission-release-failure-'));
      tempRoots.push(root);
      const run = () => runKodaXSandboxed({
        command: process.execPath,
        args: ['--version'],
        cwd: root,
        filesystem: { allowRead: [], allowWrite: [] },
      });
      recoveryLockMock.releaseFailures = 1;

      await expect(run()).rejects.toThrow('injected recovery lock release failure');
      expect(capturedBrokerRequests).toHaveLength(0);
      const poisonDirectory = path.join(
        path.resolve(process.env.KODAX_HOME!),
        'sandbox-runtime',
        'acl-poison',
      );
      await expect(readdir(poisonDirectory)).resolves.not.toContainEqual(
        expect.stringMatching(/\.json$/),
      );
      await expect(run()).resolves.toMatchObject({ status: 'completed', exitCode: 0 });
    },
  );

  it.runIf(process.platform === 'win32')(
    'keeps an unconfirmed process tree poisoned after its root PID is gone in the same Windows boot',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-sdk-gone-root-poison-'));
      tempRoots.push(root);
      processTreeKillMock.childPid = 2_147_000_000;
      processTreeKillMock.outcome = 'unknown';
      stubbornBroker.mode = 'silent';
      const run = () => runKodaXSandboxed({
        command: process.execPath,
        args: ['--version'],
        cwd: root,
        filesystem: { allowRead: [], allowWrite: [] },
        timeoutMs: 10,
      });

      await expect(run()).rejects.toThrow('termination was not confirmed');
      const spawnCount = capturedSpawnArgv.length;
      processTreeKillMock.releaseUnknown?.();
      processTreeKillMock.releaseUnknown = undefined;
      await resetAsrtWorkspaceSessionsForTest({ preserveAclPoison: true });
      processTreeKillMock.outcome = 'actual';
      stubbornBroker.mode = 'none';

      await expect(run()).rejects.toThrow('same Windows boot');
      expect(capturedSpawnArgv).toHaveLength(spawnCount);
    },
  );

  it.runIf(process.platform === 'win32')(
    'recovers an unconfirmed owner without a root PID only after a verified Windows reboot',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-sdk-reboot-poison-'));
      tempRoots.push(root);
      processTreeKillMock.outcome = 'unknown';
      stubbornBroker.mode = 'silent';
      const run = () => runKodaXSandboxed({
        command: process.execPath,
        args: ['--version'],
        cwd: root,
        filesystem: { allowRead: [], allowWrite: [] },
        timeoutMs: 10,
      });

      await expect(run()).rejects.toThrow('termination was not confirmed');
      processTreeKillMock.releaseUnknown?.();
      processTreeKillMock.releaseUnknown = undefined;
      await resetAsrtWorkspaceSessionsForTest({ preserveAclPoison: true });
      processTreeKillMock.outcome = 'actual';
      stubbornBroker.mode = 'none';
      processIdentityMock.windowsBootIdentity = 'windows-boot-200';

      await expect(run()).resolves.toMatchObject({ status: 'completed', exitCode: 0 });
    },
  );

  it.runIf(process.platform === 'win32')(
    'requires explicit ACL repair when an unconfirmed owner has no verifiable boot identity',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-sdk-unverifiable-boot-'));
      tempRoots.push(root);
      processIdentityMock.windowsBootIdentity = undefined;
      processTreeKillMock.outcome = 'unknown';
      stubbornBroker.mode = 'silent';
      const run = () => runKodaXSandboxed({
        command: process.execPath,
        args: ['--version'],
        cwd: root,
        filesystem: { allowRead: [], allowWrite: [] },
        timeoutMs: 10,
      });

      await expect(run()).rejects.toThrow('termination was not confirmed');
      processTreeKillMock.releaseUnknown?.();
      processTreeKillMock.releaseUnknown = undefined;
      await resetAsrtWorkspaceSessionsForTest({ preserveAclPoison: true });
      processTreeKillMock.outcome = 'actual';
      stubbornBroker.mode = 'none';

      await expect(run()).rejects.toThrow('no verifiable Windows boot identity');
    },
  );

  it.runIf(process.platform === 'win32')(
    'reports a legacy ACL poison marker through doctor without requesting sandbox setup',
    async () => {
      const poisonDirectory = path.join(
        path.resolve(process.env.KODAX_HOME!),
        'sandbox-runtime',
        'acl-poison',
      );
      await mkdir(poisonDirectory, { recursive: true });
      await writeFile(
        path.join(poisonDirectory, 'legacy-owner.json'),
        JSON.stringify({ version: 1 }),
        'utf8',
      );

      const doctor = await doctorSandboxRuntime({ refresh: true });

      expect(doctor.ready).toBe(false);
      expect(doctor.setupRequired).toBe(false);
      expect(doctor.diagnostics.join('\n')).toContain('acl recover --force --json');

      const setup = await prepareSandboxRuntimeForSetup();
      expect(setup).toMatchObject({ status: 'unavailable', attempted: false });
      expect(setup.guidance.join('\n')).toContain('acl recover --force --json');
    },
  );

  it.runIf(process.platform === 'win32')(
    'reports a corrupt ACL poison marker with actionable recovery guidance',
    async () => {
      const poisonDirectory = path.join(
        path.resolve(process.env.KODAX_HOME!),
        'sandbox-runtime',
        'acl-poison',
      );
      await mkdir(poisonDirectory, { recursive: true });
      await writeFile(path.join(poisonDirectory, 'corrupt-owner.json'), '{', 'utf8');

      const doctor = await doctorSandboxRuntime({ refresh: true });

      expect(doctor.ready).toBe(false);
      expect(doctor.diagnostics.join('\n')).toContain('acl recover --force --json');
      const setup = await prepareSandboxRuntimeForSetup();
      expect(setup).toMatchObject({ status: 'unavailable', attempted: false });
      expect(setup.guidance.join('\n')).toContain('acl recover --force --json');
    },
  );

  it.runIf(process.platform === 'win32')(
    'does not repair missing setup while a legacy ACL poison marker is unresolved',
    async () => {
      const poisonDirectory = path.join(
        path.resolve(process.env.KODAX_HOME!),
        'sandbox-runtime',
        'acl-poison',
      );
      await mkdir(poisonDirectory, { recursive: true });
      await writeFile(
        path.join(poisonDirectory, 'legacy-owner.json'),
        JSON.stringify({ version: 1 }),
        'utf8',
      );
      windowsSandboxMock.guardReady = false;

      const setup = await prepareSandboxRuntimeForSetup();

      expect(setup).toMatchObject({ status: 'unavailable', attempted: false });
      expect(setup.guidance.join('\n')).toContain('acl recover --force --json');
      expect(windowsSandboxMock.guardReady).toBe(false);
      expect(windowsSandboxMock.installCalls).toBe(0);
    },
  );

  it.runIf(process.platform === 'win32')(
    'rechecks ACL poison under the recovery lock before mutating sandbox setup',
    async () => {
      const poisonDirectory = path.join(
        path.resolve(process.env.KODAX_HOME!),
        'sandbox-runtime',
        'acl-poison',
      );
      windowsSandboxMock.guardReady = false;
      recoveryLockMock.beforeOperation = async () => {
        recoveryLockMock.beforeOperation = undefined;
        await mkdir(poisonDirectory, { recursive: true });
        await writeFile(
          path.join(poisonDirectory, 'concurrent-legacy-owner.json'),
          JSON.stringify({ version: 1 }),
          'utf8',
        );
      };

      const setup = await prepareSandboxRuntimeForSetup();

      expect(setup.status).toBe('unavailable');
      expect(setup.guidance.join('\n')).toContain('acl recover --force --json');
      expect(windowsSandboxMock.guardReady).toBe(false);
      expect(windowsSandboxMock.installCalls).toBe(0);
    },
  );

  it.runIf(process.platform === 'win32')(
    'does not mutate sandbox setup while this process has an active workspace owner',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-setup-active-owner-'));
      tempRoots.push(root);
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: root,
        shouldSandbox: () => true,
      });
      const active = await sandbox.prepare({
        toolCallId: 'active-owner-during-setup',
        toolInput: { command: 'echo active' },
        command: 'echo active',
        cwd: root,
        env: process.env,
      });
      if (!active) throw new Error('expected active workspace owner');
      expect(capturedWorkspaceSessionConfigs).toHaveLength(1);
      windowsSandboxMock.guardReady = false;

      const setup = await prepareSandboxRuntimeForSetup();

      expect(setup).toMatchObject({ status: 'unavailable', attempted: true });
      expect(setup.guidance.join('\n')).toContain('sandbox owner is active');
      expect(windowsSandboxMock.guardReady).toBe(false);
      expect(windowsSandboxMock.installCalls).toBe(0);
      await active.cleanup();
      await shutdownAsrtWorkspaceSessions();
      expect(await sandbox.prepare({
        toolCallId: undefined,
        toolInput: { command: 'echo not-selected' },
        command: 'echo not-selected',
        cwd: root,
        env: process.env,
      })).toBeUndefined();
    },
  );

  it.runIf(process.platform === 'win32')(
    'surfaces legacy ACL recovery guidance through a required workspace shell',
    async () => {
      const poisonDirectory = path.join(
        path.resolve(process.env.KODAX_HOME!),
        'sandbox-runtime',
        'acl-poison',
      );
      await mkdir(poisonDirectory, { recursive: true });
      await writeFile(
        path.join(poisonDirectory, 'legacy-owner.json'),
        JSON.stringify({ version: 1 }),
        'utf8',
      );
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-shell-legacy-poison-'));
      tempRoots.push(root);
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: root,
        shouldSandbox: () => true,
      });

      await expect(sandbox.prepare({
        toolCallId: 'bash-legacy-acl-poison',
        toolInput: { command: 'node --version' },
        command: 'node --version',
        executable: process.execPath,
        args: ['--version'],
        cwd: root,
        env: process.env,
      })).resolves.toBeUndefined();
      expect(capturedWorkspaceSessionConfigs).toHaveLength(0);
    },
  );

  it.runIf(process.platform === 'win32')(
    'surfaces a corrupt ACL marker through a required workspace shell',
    async () => {
      const poisonDirectory = path.join(
        path.resolve(process.env.KODAX_HOME!),
        'sandbox-runtime',
        'acl-poison',
      );
      await mkdir(poisonDirectory, { recursive: true });
      await writeFile(path.join(poisonDirectory, 'corrupt-owner.json'), '{', 'utf8');
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-shell-corrupt-poison-'));
      tempRoots.push(root);
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: root,
        shouldSandbox: () => true,
      });

      await expect(sandbox.prepare({
        toolCallId: 'bash-corrupt-acl-poison',
        toolInput: { command: 'node --version' },
        command: 'node --version',
        executable: process.execPath,
        args: ['--version'],
        cwd: root,
        env: process.env,
      })).resolves.toBeUndefined();
      expect(capturedWorkspaceSessionConfigs).toHaveLength(0);
    },
  );

  it.runIf(process.platform === 'win32')(
    'surfaces a corrupt ACL marker created during owner admission',
    async () => {
      const poisonDirectory = path.join(
        path.resolve(process.env.KODAX_HOME!),
        'sandbox-runtime',
        'acl-poison',
      );
      recoveryLockMock.beforeOperation = async () => {
        recoveryLockMock.beforeOperation = undefined;
        await mkdir(poisonDirectory, { recursive: true });
        await writeFile(path.join(poisonDirectory, 'concurrent-corrupt-owner.json'), '{', 'utf8');
      };
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-sdk-concurrent-corrupt-'));
      tempRoots.push(root);

      await expect(runKodaXSandboxed({
        command: process.execPath,
        args: ['--version'],
        cwd: root,
        filesystem: { allowRead: [], allowWrite: [] },
      })).rejects.toThrow('acl recover --force --json');
      expect(capturedBrokerRequests).toHaveLength(0);
    },
  );

  it('runs a standalone SDK command with the caller-owned containment policy', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-sdk-sandbox-'));
    tempRoots.push(root);
    await mkdir(path.join(root, 'output', 'protected'), { recursive: true });
    await doctorSandboxRuntime({ refresh: true });

    await expect(runKodaXSandboxed({
      command: process.execPath,
      args: ['--version'],
      cwd: root,
      filesystem: {
        allowRead: ['input'],
        allowWrite: ['output'],
        denyRead: [path.join(os.homedir(), '.ssh')],
        denyWrite: ['output/protected'],
      },
      network: {
        mode: 'allowlist',
        origins: ['https://api.example.com'],
      },
      env: {
        KODAX_SDK_SANDBOX_TEST: '1',
        ...(process.platform === 'win32' ? { Path: 'sdk-command-path' } : {}),
      },
      timeoutMs: 5_000,
      maxOutputBytes: 4_096,
    })).resolves.toEqual({
      status: 'completed',
      sandboxed: true,
      exitCode: 0,
      stdout: 'sandbox output',
      stderr: '',
    });

    const request = capturedBrokerRequests.at(-1) as {
      readonly config: {
        readonly filesystem: {
          readonly allowRead: readonly string[];
          readonly allowWrite: readonly string[];
          readonly denyRead: readonly string[];
          readonly denyWrite: readonly string[];
        };
        readonly network: { readonly strictAllowlist: boolean };
        readonly windows?: {
          readonly srtWin?: { readonly path?: string };
        };
      };
      readonly endpoints: ReadonlyArray<{ readonly host: string; readonly port: number }>;
      readonly env: Readonly<Record<string, string>>;
      readonly allowAllNetwork?: boolean;
    };
    const protectedRunnerDirectory = request.config.filesystem.allowRead.find(
      (entry) => entry.includes(path.join('sandbox-runtime', 'runner')),
    );
    expect(request.config.filesystem.allowRead).toContain(path.join(root, 'input'));
    expect(request.config.filesystem.allowWrite).toEqual([path.join(root, 'output')]);
    if (process.platform === 'win32') {
      expect(request.config.filesystem.denyRead).toEqual([]);
      expect(request.config.filesystem.denyWrite).toEqual([
        path.join(root, 'output', 'protected'),
      ]);
      expect(protectedRunnerDirectory).toBeDefined();
      expect(request.config.windows?.srtWin?.path).toBe(
        path.join(protectedRunnerDirectory!, 'srt-win.exe'),
      );
      expect(capturedSpawnCwds).toContain(protectedRunnerDirectory);
      const guardedPaths = capturedSyncSpawns.flatMap((call) => {
        const encodedIndex = call.args.indexOf('-EncodedCommand');
        if (encodedIndex < 0) return [];
        const script = Buffer.from(call.args[encodedIndex + 1] ?? '', 'base64')
          .toString('utf16le');
        if (!script.includes('KodaXAsrtAclGuard-v1') || !call.input) return [];
        return (JSON.parse(call.input) as {
          readonly paths: readonly { readonly path: string }[];
        }).paths.map((entry) => entry.path);
      });
      expect(guardedPaths).toContain(path.join(os.homedir(), '.ssh'));
      expect(guardedPaths).not.toContain(path.join(root, 'output', 'protected'));
    } else {
      expect(request.config.filesystem.denyRead).toContain(path.join(os.homedir(), '.ssh'));
      expect(request.config.filesystem.denyWrite).toContain(
        path.join(root, 'output', 'protected'),
      );
      expect(protectedRunnerDirectory).toBeUndefined();
      expect(request.config.windows).toBeUndefined();
    }
    expect(request.config.network.strictAllowlist).toBe(false);
    expect(request.endpoints).toEqual([{ host: 'api.example.com', port: 443 }]);
    expect(request.allowAllNetwork).toBe(false);
    expect(request.env.KODAX_SDK_SANDBOX_TEST).toBe('1');
    if (process.platform === 'win32') {
      const environmentNames = Object.keys(request.env).map((name) => name.toLowerCase());
      expect(new Set(environmentNames).size).toBe(environmentNames.length);
      expect(Object.entries(request.env).filter(([name]) => name.toLowerCase() === 'path'))
        .toEqual([['Path', 'sdk-command-path']]);
    }
  });

  it('fails a standalone SDK run when sandbox target launch is not attested', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-sdk-sandbox-unattested-'));
    tempRoots.push(root);
    await doctorSandboxRuntime({ refresh: true });
    sandboxWrapper.mode = 'missing';

    await expect(runKodaXSandboxed({
      command: process.execPath,
      args: ['--version'],
      cwd: root,
      filesystem: { allowRead: [], allowWrite: [] },
    })).resolves.toMatchObject({
      status: 'completed',
      sandboxed: true,
      exitCode: 1,
    });
  });

  it('keeps the Windows ASRT state location in the isolated broker environment', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-state-env-'));
    tempRoots.push(root);
    const original = process.env.LOCALAPPDATA;
    process.env.LOCALAPPDATA = 'C:\\Users\\tester\\AppData\\Local';
    try {
      await doctorSandboxRuntime({ refresh: true });
      await runKodaXSandboxed({
        command: process.execPath,
        args: ['--version'],
        cwd: root,
        filesystem: {
          allowRead: [root, process.execPath],
          allowWrite: [os.tmpdir()],
        },
      });

      expect(capturedSpawnEnvironments.at(-1)?.LOCALAPPDATA)
        .toBe('C:\\Users\\tester\\AppData\\Local');
    } finally {
      if (original === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = original;
    }
  });

  it('keeps the broker request alive until a delayed broker reads it', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-deferred-read-'));
    tempRoots.push(root);
    deferredBrokerRead.enabled = true;

    await expect(runKodaXSandboxed({
      command: process.execPath,
      args: ['--version'],
      cwd: root,
      filesystem: {
        allowRead: [root, process.execPath],
        allowWrite: [os.tmpdir()],
      },
    })).resolves.toMatchObject({
      status: 'completed',
      sandboxed: true,
      exitCode: 0,
    });

    expect(deferredBrokerRead.missing).toBe(false);
    expect(capturedBrokerRequests).toHaveLength(1);
  });

  it('leaves non-admitted shell calls on the existing permission path', async () => {
    const sandbox = createAsrtShellSandbox({
      workspaceRoot: process.cwd(),
      shouldSandbox: () => false,
    });
    const reportObservation = vi.fn();
    await expect(sandbox.prepare({
      toolCallId: 'bash-2',
      toolInput: { command: 'echo ok' },
      command: 'echo ok',
      cwd: process.cwd(),
      env: process.env,
      reportObservation,
    })).resolves.toBeUndefined();
    expect(reportObservation).toHaveBeenCalledWith({
      version: 1,
      state: 'not_selected',
    });
  });
});

describe('ASRT setup guidance', () => {
  it.each([
    ['win32', 'UAC'],
    ['darwin', 'brew install ripgrep'],
    ['linux', 'apt install bubblewrap socat ripgrep'],
  ] as const)('provides actionable %s activation guidance', (platform, expected) => {
    const lines = sandboxSetupGuidance({
      ready: false,
      platform,
      version: KODAX_ASRT_VERSION,
      diagnostics: ['missing dependency'],
      setupRequired: true,
    });
    expect(lines.join('\n')).toContain(expected);
  });
});

describe('ASRT Skill-script adapter', () => {
  it.runIf(process.platform === 'win32')(
    'stages a user-installed Windows runner in a protected KodaX directory',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-global-npm-'));
      tempRoots.push(root);
      const source = path.join(root, 'npm', 'node_modules', 'kodax', 'srt-win.exe');
      await mkdir(path.dirname(source), { recursive: true });
      await writeFile(source, 'trusted-runner', 'utf8');
      windowsSandboxMock.runnerSource = source;
      const relativeAgentHome = path.relative(process.cwd(), path.join(root, '.kodax'));
      vi.stubEnv('KODAX_HOME', relativeAgentHome);

      await expect(doctorSandboxRuntime({ refresh: true })).resolves.toMatchObject({
        ready: true,
        setupRequired: false,
      });

      const grant = windowsSandboxMock.grants.at(-1) as {
        readonly read: readonly string[];
        readonly write: readonly string[];
        readonly sandboxUserSid: string;
      };
      const stagedDirectory = grant.read[0]!;
      const stagedRunner = path.join(stagedDirectory, 'srt-win.exe');
      expect(path.isAbsolute(stagedDirectory)).toBe(true);
      expect(stagedDirectory).toContain(path.resolve(relativeAgentHome));
      expect(stagedDirectory).toContain(path.join('.kodax', 'sandbox-runtime', 'runner'));
      expect(stagedRunner).not.toBe(source);
      await expect(readFile(stagedRunner, 'utf8')).resolves.toBe('trusted-runner');
      expect(grant.read).toContain(stagedRunner);
      expect(grant.write).toEqual([]);
      expect(grant.sandboxUserSid).toBe(windowsSandboxMock.user.sid);
      expect(capturedSyncSpawns).toContainEqual(expect.objectContaining({
        command: stagedRunner,
        cwd: stagedDirectory,
      }));
      await doctorSandboxRuntime({ refresh: true });
      expect(windowsSandboxMock.grants).toHaveLength(1);
      await resetAsrtWorkspaceSessionsForTest();
      expect(windowsSandboxMock.revokes).toHaveLength(1);
    },
  );

  it.runIf(process.platform === 'win32')(
    'uses the staged runner instead of ASRT packaged-binary dependency probes',
    async () => {
      const asrt = await import('@anthropic-ai/sandbox-runtime');
      vi.mocked(asrt.SandboxManager.checkDependencies).mockReturnValueOnce({
        errors: [
          'srt-win user status failed: spawnSync C:\\packaged\\app.asar\\vendor\\srt-win.exe ENOENT',
        ],
        warnings: [],
      });

      await expect(doctorSandboxRuntime({ refresh: true })).resolves.toMatchObject({
        ready: true,
        setupRequired: false,
        diagnostics: [],
      });
      expect(windowsSandboxMock.grants).toHaveLength(1);
      expect(capturedSyncSpawns.some(({ command, args }) => (
        command.includes(path.join('sandbox-runtime', 'runner'))
        && args.includes('wfp')
        && args.includes('verify')
      ))).toBe(true);
    },
  );

  it.runIf(process.platform === 'win32')(
    'fails closed quickly when persistent ACL guards require explicit setup',
    async () => {
      windowsSandboxMock.guardReady = false;

      await expect(doctorSandboxRuntime({ refresh: true })).resolves.toMatchObject({
        ready: false,
        setupRequired: true,
        diagnostics: expect.arrayContaining([
          expect.stringContaining('[acl_guards_missing]'),
        ]),
      });
      const guardPayloads = capturedSyncSpawns.flatMap((call) => {
        const encodedIndex = call.args.indexOf('-EncodedCommand');
        if (encodedIndex < 0 || !call.input) return [];
        const script = Buffer.from(call.args[encodedIndex + 1] ?? '', 'base64')
          .toString('utf16le');
        return script.includes('KodaXAsrtAclGuard-v1')
          ? [JSON.parse(call.input) as { readonly install: boolean }]
          : [];
      });
      expect(guardPayloads).toEqual([expect.objectContaining({ install: false })]);
    },
  );

  it.runIf(process.platform === 'win32')(
    'uses PowerShell 7 for Windows ACL guards when it is installed',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-pwsh-acl-'));
      tempRoots.push(root);
      const pwsh = path.join(root, 'PowerShell', '7', 'pwsh.exe');
      await mkdir(path.dirname(pwsh), { recursive: true });
      await writeFile(pwsh, '', 'utf8');
      const original = process.env.ProgramFiles;
      process.env.ProgramFiles = root;
      try {
        await expect(doctorSandboxRuntime({ refresh: true })).resolves.toMatchObject({
          ready: true,
          setupRequired: false,
        });
        expect(capturedSyncSpawns.some(({ command, args }) => (
          command === pwsh && args.includes('-EncodedCommand')
        ))).toBe(true);
      } finally {
        if (original === undefined) delete process.env.ProgramFiles;
        else process.env.ProgramFiles = original;
      }
    },
  );

  it.runIf(process.platform === 'win32')(
    'reports an incomplete Windows account before attempting the WFP runner',
    async () => {
      windowsSandboxMock.user.inBuiltinUsers = false;

      await expect(doctorSandboxRuntime({ refresh: true })).resolves.toMatchObject({
        ready: false,
        setupRequired: true,
        diagnostics: expect.arrayContaining([
          expect.stringMatching(/built-in Users group/i),
        ]),
      });
      expect(windowsSandboxMock.grants).toHaveLength(0);
      expect(capturedSyncSpawns.some(({ args }) => (
        args.includes('wfp') && args.includes('verify')
      ))).toBe(false);
    },
  );

  it.runIf(process.platform === 'win32')(
    'distinguishes a Windows runner access failure from account and WFP policy failures',
    async () => {
      windowsSandboxMock.wfpOutcome = 'access_denied';

      await expect(doctorSandboxRuntime({ refresh: true })).resolves.toMatchObject({
        ready: false,
        setupRequired: true,
        diagnostics: expect.arrayContaining([
          expect.stringContaining('[runner_launch_access_denied]'),
        ]),
      });
      expect(windowsSandboxMock.grants).toHaveLength(1);
      const probe = capturedSyncSpawns.find(({ args }) => (
        args.includes('wfp') && args.includes('verify')
      ));
      expect(probe?.cwd).toContain(path.join('sandbox-runtime', 'runner'));
    },
  );

  it.runIf(process.platform === 'win32')(
    'reports a bounded Windows WFP verification timeout distinctly',
    async () => {
      windowsSandboxMock.wfpOutcome = 'timeout';

      await expect(doctorSandboxRuntime({ refresh: true })).resolves.toMatchObject({
        ready: false,
        setupRequired: true,
        diagnostics: expect.arrayContaining([
          expect.stringContaining('[wfp_probe_timeout]'),
        ]),
      });
    },
  );

  it.runIf(process.platform === 'win32')(
    'revokes a partial Windows runner ACL grant before a bounded retry',
    async () => {
      windowsSandboxMock.grantFailure = 'partial ACL grant failed';

      await expect(doctorSandboxRuntime({ refresh: true })).resolves.toMatchObject({
        ready: false,
        setupRequired: true,
        diagnostics: expect.arrayContaining([
          expect.stringContaining('partial ACL grant failed'),
        ]),
      });
      expect(windowsSandboxMock.grants).toHaveLength(1);
      expect(windowsSandboxMock.revokes).toHaveLength(1);

      windowsSandboxMock.grantFailure = undefined;
      await expect(doctorSandboxRuntime({ refresh: true })).resolves.toMatchObject({
        ready: true,
        setupRequired: false,
      });
      expect(windowsSandboxMock.grants).toHaveLength(2);
      await resetAsrtWorkspaceSessionsForTest();
      expect(windowsSandboxMock.revokes).toHaveLength(2);
    },
  );

  it('checks the exact installed version and required JavaScript interpreter', async () => {
    await expect(doctorSandboxRuntime({ refresh: true })).resolves.toMatchObject({
      ready: true,
      version: KODAX_ASRT_VERSION,
      setupRequired: false,
    });
  });

  it('fails closed when configuration admits a script absent from the pinned Skill snapshot', async () => {
    const registry = await createRegistry();
    const snapshotRoot = path.join(tempRoots[0]!, 'snapshots');

    await expect(createAsrtSkillScriptRunner({
      registry,
      admissions: { demo: ['scripts/missing.mjs'] },
      snapshotRoot,
      workspaceAccess: 'none',
      network: { mode: 'deny' },
    })).rejects.toThrow(/has no script/i);
    await expect(readdir(snapshotRoot)).resolves.toEqual([]);
  });

  it('rejects call-time scripts outside the exact prepared admission', async () => {
    const registry = await createRegistry();
    const snapshotRoot = path.join(tempRoots[0]!, 'snapshots');
    const runner = await createAsrtSkillScriptRunner({
      registry,
      admissions: { demo: ['scripts/hello.mjs'] },
      snapshotRoot,
      workspaceAccess: 'none',
      network: { mode: 'deny' },
    });
    try {
      await expect(runner.run({
        skill: 'demo', script: 'scripts/other.mjs', args: [], inputs: [], outputs: [],
      }, {
        workspaceRoot: tempRoots[0]!,
      })).rejects.toThrow(/not admitted/i);
    } finally {
      await runner.dispose();
    }
  });

  it('runs one exact admission with a clean broker contract and promotes declared output', async () => {
    const registry = await createRegistry();
    const root = tempRoots[0]!;
    const runner = await createAsrtSkillScriptRunner({
      registry,
      admissions: { demo: ['scripts/hello.mjs'] },
      snapshotRoot: path.join(root, 'snapshots'),
      workspaceAccess: 'write',
      network: { mode: 'allowlist', origins: ['https://reports.example.com'] },
    });
    try {
      await expect(runner.run({
        skill: 'demo', script: 'scripts/hello.mjs', args: [], inputs: [],
        outputs: [{ path: 'report.txt', target: 'result/report.txt' }],
      }, { workspaceRoot: root })).resolves.toBe(JSON.stringify({
        stdout: 'sandbox output', outputs: [path.join('result', 'report.txt')],
      }));
      expect(readFileSync(path.join(root, 'result', 'report.txt'), 'utf8')).toBe('report');
      const request = capturedBrokerRequests.at(-1) as {
        readonly config: {
          readonly filesystem: {
            readonly allowRead: readonly string[];
            readonly denyWrite: readonly string[];
          };
          readonly windows?: {
            readonly srtWin?: { readonly path?: string };
          };
        };
      };
      const runnerDirectory = request.config.filesystem.allowRead.find(
        (entry) => entry.includes(path.join('sandbox-runtime', 'runner')),
      );
      if (process.platform === 'win32') {
        expect(runnerDirectory).toBeDefined();
        expect(request.config.filesystem.allowRead).toContain(path.dirname(process.execPath));
        expect(request.config.filesystem.denyWrite).toEqual([]);
        expect(request.config.windows?.srtWin?.path).toBe(
          path.join(runnerDirectory!, 'srt-win.exe'),
        );
      } else {
        expect(runnerDirectory).toBeUndefined();
        expect(request.config.windows).toBeUndefined();
      }
    } finally {
      await runner.dispose();
    }
  });

  it('enforces argument, mapping, cancellation, and workspace-access bounds before execution', async () => {
    const registry = await createRegistry();
    const root = tempRoots[0]!;
    const runner = await createAsrtSkillScriptRunner({
      registry,
      admissions: { demo: ['scripts/hello.mjs'] },
      snapshotRoot: path.join(root, 'snapshots'),
      workspaceAccess: 'none',
      network: { mode: 'deny' },
    });
    const base = { skill: 'demo', script: 'scripts/hello.mjs', args: [], inputs: [], outputs: [] };
    try {
      await expect(runner.run({ ...base, args: Array.from({ length: 65 }, () => 'x') }, {
        workspaceRoot: root,
      })).rejects.toThrow(/arguments exceed/i);
      await expect(runner.run({
        ...base, inputs: Array.from({ length: 33 }, (_, index) => ({ path: `input-${index}` })),
      }, { workspaceRoot: root })).rejects.toThrow(/file mappings exceed/i);
      await expect(runner.run({ ...base, inputs: [{ path: 'input.txt' }] }, {
        workspaceRoot: root,
      })).rejects.toThrow(/require workspace read/i);
      const controller = new AbortController();
      controller.abort(new Error('cancelled by caller'));
      await expect(runner.run(base, {
        workspaceRoot: root, signal: controller.signal,
      })).rejects.toThrow(/cancelled by caller/i);
    } finally {
      await runner.dispose();
    }
  });

  it('rejects sensitive, escaping, existing, and over-quota workspace outputs', async () => {
    const registry = await createRegistry();
    const root = tempRoots[0]!;
    const inputPath = path.join(root, 'input.txt');
    await writeFile(inputPath, 'input', 'utf8');
    const runner = await createAsrtSkillScriptRunner({
      registry,
      admissions: { demo: ['scripts/hello.mjs'] },
      snapshotRoot: path.join(root, 'snapshots'),
      workspaceAccess: 'write',
      workspaceByteLimit: 1,
      network: { mode: 'deny' },
    });
    const base = { skill: 'demo', script: 'scripts/hello.mjs', args: [], outputs: [] };
    try {
      await expect(runner.run({ ...base, inputs: [{ path: '../outside.txt' }] }, {
        workspaceRoot: root,
      })).rejects.toThrow(/safe relative path/i);
      await expect(runner.run({ ...base, inputs: [{ path: '.env' }] }, {
        workspaceRoot: root,
      })).rejects.toThrow();
      await expect(runner.run({
        ...base, inputs: [{ path: 'input.txt', as: '../escape.txt' }],
      }, { workspaceRoot: root })).rejects.toThrow(/safe relative path/i);
      await expect(runner.run({
        ...base, inputs: [], outputs: [{ path: 'report.txt', target: 'result/report.txt' }],
      }, { workspaceRoot: root })).rejects.toThrow(/byte quota/i);
    } finally {
      await runner.dispose();
    }
  });

  it('rejects unsafe admission paths and unsupported script types', async () => {
    const registry = await createRegistry('notes.txt');
    const root = tempRoots[0]!;
    await expect(createAsrtSkillScriptRunner({
      registry,
      admissions: { demo: ['../notes.txt'] },
      snapshotRoot: path.join(root, 'bad-snapshots'),
      workspaceAccess: 'none',
      network: { mode: 'deny' },
    })).rejects.toThrow(/safe relative path/i);
    const runner = await createAsrtSkillScriptRunner({
      registry,
      admissions: { demo: ['scripts/notes.txt'] },
      snapshotRoot: path.join(root, 'snapshots'),
      workspaceAccess: 'none',
      network: { mode: 'deny' },
    });
    try {
      await expect(runner.run({
        skill: 'demo', script: 'scripts/notes.txt', args: [], inputs: [], outputs: [],
      }, { workspaceRoot: root })).rejects.toThrow(/unsupported admitted/i);
    } finally {
      await runner.dispose();
    }
  });

  it('runs the standalone broker entry with the same pinned request shape', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-broker-test-'));
    tempRoots.push(root);
    const requestFile = path.join(root, 'request.json');
    const observationFile = path.join(root, 'observation.json');
    const sensitiveRead = path.join(os.homedir(), '.ssh');
    await writeFile(requestFile, JSON.stringify({
      config: {
        network: {
          allowedDomains: [], deniedDomains: [], strictAllowlist: true,
          allowUnixSockets: [], allowAllUnixSockets: false, allowLocalBinding: false,
        },
        filesystem: { denyRead: [sensitiveRead], allowRead: [], allowWrite: [], denyWrite: [] },
      },
      command: process.execPath,
      args: ['--version'],
      cwd: root,
      env: { REPORT_FORMAT: 'pdf' },
      endpoints: [],
      observationBackend: sandboxRuntimeCapability().backend,
      observationFile,
    }), 'utf8');
    await expect(runAsrtBrokerProcess(requestFile)).resolves.toBe(0);
    expect(JSON.parse(readFileSync(observationFile, 'utf8'))).toMatchObject({
      state: 'applied',
      backend: sandboxRuntimeCapability().backend,
    });
    if (process.platform === 'win32') {
      const childArgv = capturedSpawnArgv.at(-1) ?? [];
      expect(childArgv).toContain('--env');
      expect(childArgv).toContain('REPORT_FORMAT=pdf');
      expect(capturedSandboxWrapConfigs.at(-1)).toMatchObject({
        filesystem: {
          denyRead: [sensitiveRead],
          allowRead: [],
          allowWrite: [],
        },
      });
    } else {
      expect(capturedSpawnEnvironments.at(-1)).toMatchObject({
        REPORT_FORMAT: 'pdf',
      });
    }
  });

  it('falls back before target launch when the local workspace sandbox backend fails', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-broker-fallback-'));
    tempRoots.push(root);
    const requestFile = path.join(root, 'request.json');
    const observationFile = path.join(root, 'observation.json');
    await writeFile(requestFile, JSON.stringify({
      config: {
        network: {
          allowedDomains: [], deniedDomains: [], strictAllowlist: false,
          allowUnixSockets: [], allowAllUnixSockets: false, allowLocalBinding: false,
        },
        filesystem: { denyRead: [], allowRead: [], allowWrite: [root], denyWrite: [] },
      },
      command: process.execPath,
      args: ['--version'],
      cwd: root,
      env: { KODAX_FALLBACK_VISIBLE: 'yes' },
      endpoints: [],
      fallbackToNormalExecution: true,
      observationFile,
    }), 'utf8');
    sandboxInitialize.mockRejectedValueOnce(new Error('backend initialization failed'));

    await expect(runAsrtBrokerProcess(requestFile)).resolves.toBe(0);
    expect(capturedSpawnArgv.at(-1)).toEqual([process.execPath, '--version']);
    expect(capturedSpawnEnvironments.at(-1)?.KODAX_FALLBACK_VISIBLE).toBe('yes');
    expect(JSON.parse(readFileSync(observationFile, 'utf8'))).toEqual({
      version: 1,
      state: 'fallback',
      reason: 'backend_failed',
      execution: 'normal_permission_policy',
    });
  });

  it(
    'does not replay when a spawned wrapper exits without target attestation',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-attestation-fallback-'));
      tempRoots.push(root);
      const requestFile = path.join(root, 'request.json');
      const observationFile = path.join(root, 'observation.json');
      await writeFile(requestFile, JSON.stringify({
        config: {
          network: {
            allowedDomains: [], deniedDomains: [], strictAllowlist: false,
            allowUnixSockets: [], allowAllUnixSockets: false, allowLocalBinding: false,
          },
          filesystem: { denyRead: [], allowRead: [], allowWrite: [root], denyWrite: [] },
        },
        command: process.execPath,
        args: ['--version'],
        cwd: root,
        env: {},
        endpoints: [],
        fallbackToNormalExecution: true,
        observationFile,
      }), 'utf8');
      sandboxWrapper.mode = 'missing';

      await expect(runAsrtBrokerProcess(requestFile)).resolves.toBe(1);
      expect(capturedSpawnArgv.filter(
        (argv) => JSON.stringify(argv) === JSON.stringify([process.execPath, '--version']),
      )).toHaveLength(0);
      await expect(readFile(observationFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it('falls back once when the sandbox wrapper is proven not to have spawned', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-wrapper-spawn-fallback-'));
    tempRoots.push(root);
    const requestFile = path.join(root, 'request.json');
    const observationFile = path.join(root, 'observation.json');
    await writeFile(requestFile, JSON.stringify({
      config: {
        network: {
          allowedDomains: [], deniedDomains: [], strictAllowlist: false,
          allowUnixSockets: [], allowAllUnixSockets: false, allowLocalBinding: false,
        },
        filesystem: { denyRead: [], allowRead: [], allowWrite: [root], denyWrite: [] },
      },
      command: process.execPath,
      args: ['--version'],
      cwd: root,
      env: {},
      endpoints: [],
      fallbackToNormalExecution: true,
      observationFile,
    }), 'utf8');
    sandboxWrapper.mode = 'spawn_error';

    await expect(runAsrtBrokerProcess(requestFile)).resolves.toBe(0);
    expect(capturedSpawnArgv.filter(
      (argv) => JSON.stringify(argv) === JSON.stringify([process.execPath, '--version']),
    )).toHaveLength(1);
    expect(JSON.parse(readFileSync(observationFile, 'utf8'))).toEqual({
      version: 1,
      state: 'fallback',
      reason: 'backend_failed',
      execution: 'normal_permission_policy',
    });
  });

  it('drains target attestation before deciding whether fallback is safe', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-attestation-race-'));
    tempRoots.push(root);
    const requestFile = path.join(root, 'request.json');
    const observationFile = path.join(root, 'observation.json');
    await writeFile(requestFile, JSON.stringify({
      config: {
        network: {
          allowedDomains: [], deniedDomains: [], strictAllowlist: false,
          allowUnixSockets: [], allowAllUnixSockets: false, allowLocalBinding: false,
        },
        filesystem: { denyRead: [], allowRead: [], allowWrite: [root], denyWrite: [] },
      },
      command: process.execPath,
      args: ['--version'],
      cwd: root,
      env: {},
      endpoints: [],
      fallbackToNormalExecution: true,
      observationBackend: sandboxRuntimeCapability().backend,
      observationFile,
    }), 'utf8');
    sandboxWrapper.mode = 'late_marker';

    await expect(runAsrtBrokerProcess(requestFile)).resolves.toBe(0);
    expect(capturedSpawnArgv).not.toContainEqual([process.execPath, '--version']);
    expect(JSON.parse(readFileSync(observationFile, 'utf8'))).toMatchObject({
      state: 'applied',
      backend: sandboxRuntimeCapability().backend,
    });
  });

  it('does not re-inject host secrets into a POSIX broker child environment', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-broker-env-test-'));
    tempRoots.push(root);
    const requestFile = path.join(root, 'request.json');
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    process.env.KODAX_HOST_ONLY_SECRET = 'must-not-reach-sandbox';
    await writeFile(requestFile, JSON.stringify({
      config: {
        network: {
          allowedDomains: [], deniedDomains: [], strictAllowlist: true,
          allowUnixSockets: [], allowAllUnixSockets: false, allowLocalBinding: false,
        },
        filesystem: { denyRead: [], allowRead: [], allowWrite: [], denyWrite: [] },
      },
      command: '/usr/bin/node',
      args: ['--version'],
      cwd: root,
      env: { KODAX_CHILD_VISIBLE: 'yes' },
      endpoints: [],
    }), 'utf8');
    try {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' });
      await expect(runAsrtBrokerProcess(requestFile)).resolves.toBe(0);
      const childEnvironment = capturedSpawnEnvironments.at(-1);
      expect(childEnvironment?.KODAX_CHILD_VISIBLE).toBe('yes');
      expect(childEnvironment?.KODAX_HOST_ONLY_SECRET).toBeUndefined();
      expect(Object.keys(childEnvironment ?? {})).toEqual(['KODAX_CHILD_VISIBLE']);
    } finally {
      delete process.env.KODAX_HOST_ONLY_SECRET;
      if (platformDescriptor !== undefined) {
        Object.defineProperty(process, 'platform', platformDescriptor);
      }
    }
  });

  it.runIf(process.platform === 'win32')(
    'keeps Windows command arguments exact behind an encoded argv bootstrap',
    async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-broker-argv-test-'));
    tempRoots.push(root);
    const requestFile = path.join(root, 'request.json');
    const exactArgs = [
      '--probe',
      '%KODAX_ENV_PROBE%',
      'a&b',
      'quoted"value',
      'space separated',
    ];
    await writeFile(requestFile, JSON.stringify({
      config: {
        network: {
          allowedDomains: [], deniedDomains: [], strictAllowlist: true,
          allowUnixSockets: [], allowAllUnixSockets: false, allowLocalBinding: false,
        },
        filesystem: { denyRead: [], allowRead: [], allowWrite: [], denyWrite: [] },
      },
      command: process.execPath,
      args: exactArgs,
      windowsVerbatimArguments: true,
      cwd: root,
      env: { PATH: 'command-path', PATHEXT: '.COM;.EXE;.CMD' },
      endpoints: [],
      bootstrapCommand: process.execPath,
    }), 'utf8');

    await expect(runAsrtBrokerProcess(requestFile)).resolves.toBe(0);
    const wrapped = capturedWrappedCommands.at(-1) ?? '';
    const payload = wrapped.trim().split(/\s+/).at(-1);
    if (payload === undefined) throw new Error('expected encoded argv payload');
    expect(JSON.parse(Buffer.from(payload, 'base64').toString('utf8'))).toMatchObject({
      command: process.execPath,
      args: exactArgs,
      windowsVerbatimArguments: true,
      cwd: root,
      targetStartedMarker: expect.stringContaining('KODAX_ASRT_TARGET_STARTED'),
    });
    expect(wrapped).not.toContain('%KODAX_ENV_PROBE%');
    expect(wrapped).not.toContain('a&b');
    const spawned = capturedSpawnArgv.at(-1) ?? [];
    const injectedEnvironment = spawned.flatMap((value, index) => (
      value === '--env' ? [spawned[index + 1] ?? ''] : []
    ));
    expect(injectedEnvironment.filter((value) => /^path=/i.test(value)))
      .toEqual(['PATH=command-path']);
    expect(injectedEnvironment.filter((value) => /^pathext=/i.test(value)))
      .toEqual(['PATHEXT=.COM;.EXE;.CMD']);
    expect(injectedEnvironment).toContain('WRAPPED_ONLY=yes');
    },
  );

  it.runIf(process.platform === 'win32')(
    'rejects case-ambiguous Windows child environment names before spawn',
    async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-broker-env-test-'));
    tempRoots.push(root);
    const requestFile = path.join(root, 'request.json');
    await writeFile(requestFile, JSON.stringify({
      config: {
        network: {
          allowedDomains: [], deniedDomains: [], strictAllowlist: true,
          allowUnixSockets: [], allowAllUnixSockets: false, allowLocalBinding: false,
        },
        filesystem: { denyRead: [], allowRead: [], allowWrite: [], denyWrite: [] },
      },
      command: process.execPath,
      args: ['--version'],
      cwd: root,
      env: { PATH: 'first', Path: 'second' },
      endpoints: [],
      bootstrapCommand: process.execPath,
    }), 'utf8');
    const spawnCount = capturedSpawnArgv.length;

    await expect(runAsrtBrokerProcess(requestFile)).resolves.toBe(1);
    expect(capturedSpawnArgv).toHaveLength(spawnCount);
    },
  );

  it.each([
    {
      name: 'timeout',
      mode: 'silent' as const,
      options: { timeoutMs: 10 },
      expected: /exceeded its 10 ms timeout/i,
    },
    {
      name: 'output overflow',
      mode: 'overflow' as const,
      options: { maxOutputBytes: 1 },
      expected: /output exceeded 1 bytes/i,
    },
  ])('force-terminates a broker that ignores SIGTERM after $name', async ({
    mode,
    options,
    expected,
  }) => {
    stubbornBroker.mode = mode;
    await expect(runKodaXSandboxed({
      command: process.execPath,
      args: ['--version'],
      cwd: os.tmpdir(),
      filesystem: { allowRead: [], allowWrite: [] },
      network: { mode: 'deny' },
      ...options,
    })).rejects.toThrow(expected);
  });

  it('force-terminates a broker that ignores cancellation', async () => {
    stubbornBroker.mode = 'silent';
    const controller = new AbortController();
    const running = runKodaXSandboxed({
      command: process.execPath,
      args: ['--version'],
      cwd: os.tmpdir(),
      filesystem: { allowRead: [], allowWrite: [] },
      network: { mode: 'deny' },
      signal: controller.signal,
    });
    controller.abort(new Error('cancelled by SDK caller'));
    await expect(running).rejects.toThrow(/cancelled by SDK caller/i);
  });
});
