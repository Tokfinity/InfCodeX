import { EventEmitter } from 'node:events';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { SkillRegistry } from '@kodax-ai/agent';
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
const capturedSandboxWrapConfigs = vi.hoisted(
  () => [] as Array<Readonly<Record<string, unknown>>>,
);
const capturedKillSignals = vi.hoisted(
  () => [] as Array<NodeJS.Signals | number | undefined>,
);
const capturedProcessTreeKillOptions = vi.hoisted(
  () => [] as Array<Readonly<Record<string, unknown>>>,
);
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
  malformedReady: false,
  delayClose: false,
  releaseClose: undefined as (() => void) | undefined,
  closeExitCode: 0,
}));
const windowsSandboxMock = vi.hoisted(() => ({
  runnerSource: '',
  wfpOutcome: 'blocked' as 'blocked' | 'access_denied' | 'timeout',
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
}));

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
      const encodedIndex = args.indexOf('-EncodedCommand');
      if (encodedIndex >= 0) {
        const script = Buffer.from(args[encodedIndex + 1] ?? '', 'base64').toString('utf16le');
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
      child.exitCode = null;
      child.signalCode = null;
      child.kill = vi.fn((signal?: NodeJS.Signals | number) => {
        capturedKillSignals.push(signal);
        if (stubbornBroker.mode !== 'none' && signal === 'SIGKILL') {
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
        && argsOrOptions.some((arg) => (
          arg.includes('sandbox-workspace-session')
          || arg === '__asrt-workspace-session'
        ));
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
              readonly request?: {
                readonly targetStartedMarker?: string;
              };
            };
            const response = message.type === 'wrap'
              ? {
                  id: message.id,
                  type: 'result',
                  ok: true,
                  invocation: {
                    executable: process.execPath,
                    args: ['--version'],
                    env: {},
                    shell: false,
                  },
                }
              : { id: message.id, type: 'result', ok: true };
            const reportResponse = (): void => {
              control.write(`${JSON.stringify(response)}\n`);
            };
            if (message.type === 'wrap' && workspaceSessionControl.delayWrap) {
              workspaceSessionControl.releaseWrap = reportResponse;
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
        child.emit('close', 0);
        if (sandboxWrapper.mode !== 'late_marker') {
          child.emit('exit', 0, null);
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
    killChildProcessTree: (
      child: Parameters<typeof actual.killChildProcessTree>[0],
      options: Parameters<typeof actual.killChildProcessTree>[1] = {},
    ) => {
      capturedProcessTreeKillOptions.push({ ...options });
      return actual.killChildProcessTree(child, {
        ...options,
        gracefulMs: 0,
        forceMs: 0,
        taskkillMs: 0,
      });
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
          argv: [process.execPath, 'exec', '--quiet', '--', process.execPath, '-e', command],
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
  };
});

import {
  KODAX_ASRT_VERSION,
  createAsrtShellSandbox,
  createAsrtSkillScriptRunner,
  doctorSandboxRuntime,
  runKodaXSandboxed,
  runAsrtBrokerProcess,
  resetAsrtWorkspaceSessionsForTest,
  sandboxRuntimeCapability,
  sandboxSetupGuidance,
} from './sandbox-runtime.js';

const tempRoots: string[] = [];

beforeEach(async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-runner-'));
  tempRoots.push(root);
  const source = path.join(root, 'package', 'srt-win.exe');
  await mkdir(path.dirname(source), { recursive: true });
  await writeFile(source, 'trusted-test-runner', 'utf8');
  windowsSandboxMock.runnerSource = source;
  vi.stubEnv('KODAX_HOME', path.join(root, '.kodax'));
});

afterEach(async () => {
  workspaceSessionControl.releaseReady?.();
  workspaceSessionControl.releaseWrap?.();
  workspaceSessionControl.delayReady = false;
  workspaceSessionControl.releaseReady = undefined;
  workspaceSessionControl.delayWrap = false;
  workspaceSessionControl.releaseWrap = undefined;
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
  sandboxWrapper.mode = 'attest';
  vi.unstubAllEnvs();
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
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

describe('ASRT workspace shell adapter', () => {
  it('starts the shared fail-closed workspace warm-up before the first shell call', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-shell-warm-'));
    tempRoots.push(root);

    createAsrtShellSandbox({
      workspaceRoot: root,
      shouldSandbox: () => true,
      failClosed: true,
    });

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
    });
  });

  it('serializes workspace ACL initialization behind active filesystem effects', async () => {
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
        failClosed: true,
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
      expect(preparedPrematurely).toBe(false);
      expect(sessionCountWhileBlocked).toBe(0);
      expect(invocation).toBeDefined();
    } finally {
      await invocation?.cleanup();
    }
  });

  it.runIf(process.platform === 'win32')(
    'keeps the eager workspace session free of broad Agent Home grants',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-shell-lean-warm-'));
      const agentHome = path.join(root, 'agent-home');
      const agentsDirectory = path.join(agentHome, 'agents');
      const sessionsDirectory = path.join(agentHome, 'sessions');
      const workspace = path.join(root, 'workspace');
      tempRoots.push(root);
      await mkdir(workspace, { recursive: true });
      await mkdir(agentsDirectory, { recursive: true });
      await mkdir(sessionsDirectory, { recursive: true });
      vi.stubEnv('KODAX_HOME', agentHome);

      createAsrtShellSandbox({
        workspaceRoot: workspace,
        shouldSandbox: () => true,
        failClosed: true,
      });

      await vi.waitFor(() => expect(capturedWorkspaceSessionConfigs).toHaveLength(1));
      const config = capturedWorkspaceSessionConfigs[0] as {
        readonly filesystem: {
          readonly allowWrite: readonly string[];
          readonly denyWrite: readonly string[];
        };
      };
      expect(config.filesystem.allowWrite).not.toContain(path.resolve(agentsDirectory));
      expect(config.filesystem.allowWrite).not.toContain(path.resolve(sessionsDirectory));
      expect(config.filesystem.denyWrite).not.toContain(
        path.resolve(agentHome, 'runtime'),
      );
      expect(config.filesystem.denyWrite).toEqual([]);
      expect(config.filesystem.allowWrite.length).toBeLessThan(20);
    },
  );

  it('prepares only an admitted concrete call with workspace/temp writes and normal local network', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-shell-'));
    tempRoots.push(root);
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
    const ordinaryHomePathEntry = path.join(home, 'tools', 'bin');
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
    }));
    const reportObservation = vi.fn();
    const sandbox = createAsrtShellSandbox({
      workspaceRoot: root,
      shouldSandbox,
      failClosed: true,
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
      expect(request.config.filesystem.allowRead).toContain(ordinaryHomePathEntry);
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
      expect(request.fallbackToNormalExecution).toBe(false);
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
    'keeps persistent Windows sensitive-root guards outside ASRT startup propagation',
    async () => {
      const agentHome = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-agent-home-'));
      tempRoots.push(agentHome);
      vi.stubEnv('KODAX_HOME', agentHome);
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: os.homedir(),
        shouldSandbox: () => true,
        failClosed: true,
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
        failClosed: true,
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
        failClosed: true,
      });
      const prepared = await sandbox.prepare({
        toolCallId: 'bash-git-guards',
        toolInput: { command: 'git status --short' },
        command: 'git status --short',
        cwd: root,
        env: process.env,
      });
      if (!prepared) throw new Error('expected Git guard workspace invocation');
      try {
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
        await prepared.cleanup();
      }
    },
  );

  it('reuses one workspace session across sequential admitted commands', async () => {
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
    ))).toHaveLength(1);
  });

  it('does not hold the workspace session lock across target lifetimes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-session-parallel-'));
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

    const [first, second] = await Promise.all([
      prepare('bash-parallel-1'),
      prepare('bash-parallel-2'),
    ]);
    if (!first || !second) throw new Error('expected parallel workspace invocations');
    await Promise.all([first.cleanup(), second.cleanup()]);

    expect(capturedSpawnArgv.filter((argv) => argv.some((arg) => (
      arg.includes('sandbox-workspace-session')
      || arg === '__asrt-workspace-session'
    )))).toHaveLength(1);
  });

  it.runIf(process.platform === 'win32')(
    'reuses bounded safe Agent Home scopes but retires review-only scopes after cleanup',
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
        failClosed: true,
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
    'holds an exclusive filesystem fence while a review-only Agent Home ACL is live',
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
        failClosed: true,
      });

      const invocation = await sandbox.prepare({
        toolCallId: 'review-exclusive',
        toolInput: { command: 'type config.json' },
        command: 'type config.json',
        cwd: root,
        env: process.env,
      });
      if (!invocation) throw new Error('expected review-only sandbox invocation');
      let overlappingLease: Awaited<ReturnType<typeof acquireFileSystemMutationLease>> | undefined;
      let overlapError: unknown;
      try {
        overlappingLease = await acquireFileSystemMutationLease();
      } catch (error: unknown) {
        overlapError = error;
      } finally {
        await overlappingLease?.();
      }
      expect(overlapError).toBeInstanceOf(Error);

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
        failClosed: true,
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
      const sessionTemps = capturedWorkspaceSessionConfigs.map((config) => {
        const filesystem = config.filesystem as { readonly allowWrite: readonly string[] };
        return filesystem.allowWrite.find((candidate) => (
          candidate.includes(`${path.sep}kodax-sandbox${path.sep}`)
        ));
      }).filter((candidate): candidate is string => candidate !== undefined);
      expect(sessionTemps).toHaveLength(capturedWorkspaceSessionConfigs.length);
      expect(new Set(sessionTemps).size).toBe(sessionTemps.length);

      await resetAsrtWorkspaceSessionsForTest();
      await expect(Promise.all(sessionTemps.map(async (directory) => {
        await expect(stat(directory)).rejects.toThrow();
      }))).resolves.toBeDefined();
    },
  );

  it.runIf(process.platform === 'win32')(
    'bounds cached safe Agent Home ACL scopes',
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
        failClosed: true,
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
      expect(capturedWorkspaceSessionConfigs).toHaveLength(9);

      workspaceSessionControl.delayClose = true;
      const ninth = prepare(8);
      await vi.waitFor(() => expect(workspaceSessionControl.releaseClose).toBeDefined());
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(capturedWorkspaceSessionConfigs).toHaveLength(9);
      workspaceSessionControl.delayClose = false;
      workspaceSessionControl.releaseClose?.();
      workspaceSessionControl.releaseClose = undefined;
      await ninth;
      expect(capturedWorkspaceSessionConfigs).toHaveLength(10);

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
        failClosed: true,
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
      expect(capturedWorkspaceSessionConfigs).toHaveLength(9);

      workspaceSessionControl.closeExitCode = 1;
      await expect(prepare(8)).resolves.toBeUndefined();
      expect(capturedWorkspaceSessionConfigs).toHaveLength(9);
      expect(reportObservation).toHaveBeenLastCalledWith({
        version: 1,
        state: 'fallback',
        reason: 'prepare_failed',
        execution: 'normal_permission_policy',
      });
    },
  );

  it('cancels a prepare wait without cancelling the shared warm-up', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-session-cancel-'));
    tempRoots.push(root);
    workspaceSessionControl.delayReady = true;
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
    workspaceSessionControl.releaseReady?.();
    workspaceSessionControl.releaseReady = undefined;
  });

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

    workspaceSessionControl.delayWrap = false;
    workspaceSessionControl.releaseWrap?.();
    workspaceSessionControl.releaseWrap = undefined;
    await new Promise((resolve) => setTimeout(resolve, 10));
    const next = await sandbox.prepare({
      toolCallId: 'bash-after-wrap-cancel',
      toolInput: { command: 'node --version' },
      command: 'node --version',
      executable: process.execPath,
      args: ['--version'],
      cwd: root,
      env: process.env,
    });
    if (!next) throw new Error('expected session reuse after cancelled wrap');
    await next.cleanup();
  });

  it('evicts and force-terminates a poisoned workspace session', async () => {
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
      gracefulStdinEnd: true,
      gracefulMs: process.platform === 'win32' ? 15_000 : 1_500,
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
    if (!recovered) throw new Error('expected replacement workspace session');
    await recovered.cleanup();
    expect(capturedSpawnArgv.filter((argv) => argv.some((arg) => (
      arg.includes('sandbox-workspace-session')
      || arg === '__asrt-workspace-session'
    )))).toHaveLength(2);
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
    const asrt = await import('@anthropic-ai/sandbox-runtime');
    const checkDependencies = vi.mocked(asrt.SandboxManager.checkDependencies);
    checkDependencies.mockReturnValueOnce({
      errors: ['bubblewrap is unavailable'],
      warnings: [],
    });
    await doctorSandboxRuntime({ refresh: true });
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

  it('marks an admitted fail-closed call unavailable instead of permitting normal execution', async () => {
    const asrt = await import('@anthropic-ai/sandbox-runtime');
    const checkDependencies = vi.mocked(asrt.SandboxManager.checkDependencies);
    checkDependencies.mockReturnValueOnce({
      errors: ['bubblewrap is unavailable'],
      warnings: [],
    });
    await doctorSandboxRuntime({ refresh: true });
    const sandbox = createAsrtShellSandbox({
      workspaceRoot: process.cwd(),
      shouldSandbox: () => true,
      failClosed: true,
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
    expect(sandbox.failClosed).toBe(true);
    expect(sandbox.processTreeContainment).toBe(
      process.platform === 'linux' ? 'root-exit-drains' : undefined,
    );
    expect(reportObservation).toHaveBeenCalledWith(expect.objectContaining({
      state: 'fallback',
      reason: 'not_ready',
    }));
  });

  it('returns structured unavailability for a standalone SDK sandbox run', async () => {
    const asrt = await import('@anthropic-ai/sandbox-runtime');
    const checkDependencies = vi.mocked(asrt.SandboxManager.checkDependencies);
    checkDependencies.mockReturnValueOnce({
      errors: ['bubblewrap is unavailable'],
      warnings: [],
    });
    await doctorSandboxRuntime({ refresh: true });

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
      env: { KODAX_SDK_SANDBOX_TEST: '1' },
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

  it.each(['missing', 'spawn_error'] as const)(
    'falls back exactly once when target attestation ends with %s',
    async (mode) => {
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
      sandboxWrapper.mode = mode;

      await expect(runAsrtBrokerProcess(requestFile)).resolves.toBe(0);
      expect(capturedSpawnArgv.filter(
        (argv) => JSON.stringify(argv) === JSON.stringify([process.execPath, '--version']),
      )).toHaveLength(1);
      expect(JSON.parse(readFileSync(observationFile, 'utf8'))).toMatchObject({
        state: 'fallback',
        reason: 'backend_failed',
      });
    },
  );

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

  it('keeps Windows command arguments exact behind an encoded argv bootstrap', async () => {
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
      cwd: root,
      env: {},
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
      cwd: root,
      targetStartedMarker: expect.stringContaining('KODAX_ASRT_TARGET_STARTED'),
    });
    expect(wrapped).not.toContain('%KODAX_ENV_PROBE%');
    expect(wrapped).not.toContain('a&b');
  });

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
