import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants, readdirSync, statSync } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  SandboxManager,
  getWindowsSandboxUserStatus,
  installWindowsSandbox,
  verifyWindowsWfpEgress,
  type SandboxAskCallback,
  type SandboxRuntimeConfig,
} from '@anthropic-ai/sandbox-runtime';
import type { ISkillRegistry, Skill } from '@kodax-ai/agent';
import type {
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
  readonly endpoints: readonly SandboxEndpoint[];
}

const MAX_OUTPUT_BYTES = 1_048_576;
const SCRIPT_TIMEOUT_MS = 120_000;
const moduleRequire = createRequire(import.meta.url);
const ASRT_MODULE_URL = process.env.KODAX_BUNDLED === 'true'
  ? undefined
  : pathToFileURL(moduleRequire.resolve('@anthropic-ai/sandbox-runtime')).href;
const SENSITIVE_PATH_PARTS = new Set(['.ssh', '.aws', '.azure', '.gnupg', '.kodax', '.agents']);
const SENSITIVE_FILES = new Set(['.env', '.npmrc', '.pypirc', 'credentials', 'id_rsa', 'id_ed25519']);
const BROKER_SOURCE = String.raw`
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
const { SandboxManager } = await import(process.argv[1]);
const request = JSON.parse(await readFile(process.argv[2], 'utf8'));
const endpoints = new Set(request.endpoints.map((item) => item.host.toLowerCase() + ':' + item.port));
const callback = request.endpoints.length === 0 ? undefined : async ({ host, port }) => endpoints.has(host.toLowerCase() + ':' + port);
let child;
try {
  await SandboxManager.initialize(request.config, callback);
  const quote = (value) => process.platform === 'win32'
    ? '"' + value.replaceAll('"', '""') + '"'
    : "'" + value.replaceAll("'", "'\"'\"'") + "'";
  const command = [request.command, ...request.args].map(quote).join(' ');
  if (process.platform === 'win32') {
    const wrapped = await SandboxManager.wrapWithSandboxArgv(command, 'cmd', undefined, undefined, request.cwd);
    child = spawn(wrapped.argv[0], wrapped.argv.slice(1), { cwd: request.cwd, env: wrapped.env, shell: false, stdio: 'inherit' });
  } else {
    const wrapped = await SandboxManager.wrapWithSandbox(command);
    child = spawn(wrapped, { cwd: request.cwd, env: process.env, shell: true, stdio: 'inherit' });
  }
  const stop = () => child?.kill('SIGTERM');
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (exitCode, signal) => resolve(signal ? 1 : exitCode ?? 1));
  });
  SandboxManager.cleanupAfterCommand();
  await SandboxManager.reset();
  process.exitCode = code;
} catch (error) {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n');
  await SandboxManager.reset().catch(() => undefined);
  process.exitCode = 1;
}
`;
let doctorPromise: Promise<SandboxRuntimeDoctorResult> | undefined;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function doctorSandboxRuntime(options: { readonly refresh?: boolean } = {}): Promise<SandboxRuntimeDoctorResult> {
  if (options.refresh) doctorPromise = undefined;
  doctorPromise ??= inspectSandboxRuntime();
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
  const nodeCommand = process.env.KODAX_A2A_NODE
    ?? (process.env.KODAX_BUNDLED === 'true' ? 'node' : process.execPath);
  const nodeProbe = spawnSync(nodeCommand, ['--version'], {
    env: sanitizedEnvironment(), shell: false, encoding: 'utf8', windowsHide: true, timeout: 5_000,
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
  const names = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'COMSPEC', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LANG'];
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

async function collectProcess(child: ReturnType<typeof spawn>, signal?: AbortSignal): Promise<{ stdout: string; stderr: string }> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  const append = (chunk: Buffer): void => {
    bytes += chunk.byteLength;
    if (bytes > MAX_OUTPUT_BYTES) child.kill('SIGTERM');
    else chunks.push(chunk);
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  const timer = setTimeout(() => { child.kill('SIGTERM'); }, SCRIPT_TIMEOUT_MS);
  const abort = (): void => { child.kill('SIGTERM'); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => resolve({ code: code ?? 1, stdout: Buffer.concat(chunks).toString('utf8'), stderr: '' }));
    });
    if (bytes > MAX_OUTPUT_BYTES) throw new Error('Sandboxed Skill script output exceeded 1 MiB.');
    if (signal?.aborted) throw signal.reason ?? new Error('Sandboxed Skill script was cancelled.');
    if (result.code !== 0) throw new Error(`Sandboxed Skill script failed (${result.code}): ${result.stdout.trim()}`);
    return { stdout: result.stdout, stderr: result.stderr };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

async function runBroker(request: SandboxBrokerRequest, signal?: AbortSignal): Promise<string> {
  const requestFile = path.join(os.tmpdir(), `kodax-asrt-${process.pid}-${randomUUID()}.json`);
  const protectedRequest: SandboxBrokerRequest = {
    ...request,
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
    const child = spawn(process.execPath, args, {
      env: sanitizedEnvironment(), shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    return (await collectProcess(child, signal)).stdout;
  } finally {
    await rm(requestFile, { force: true });
  }
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

/** Internal entry used only by the standalone binary's isolated broker process. */
export async function runAsrtBrokerProcess(requestFile: string): Promise<number> {
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const request = JSON.parse(await readFile(requestFile, 'utf8')) as SandboxBrokerRequest;
    const endpoints = new Set(request.endpoints.map((item) => `${item.host.toLowerCase()}:${item.port}`));
    const callback: SandboxAskCallback | undefined = request.endpoints.length === 0
      ? undefined
      : async ({ host, port }) => (
          port !== undefined && endpoints.has(`${host.toLowerCase()}:${port}`)
        );
    await SandboxManager.initialize(request.config, callback);
    const quote = (value: string): string => process.platform === 'win32'
      ? `"${value.replaceAll('"', '""')}"`
      : `'${value.replaceAll("'", `'"'"'`)}'`;
    const command = [request.command, ...request.args].map(quote).join(' ');
    if (process.platform === 'win32') {
      const wrapped = await SandboxManager.wrapWithSandboxArgv(command, 'cmd', undefined, undefined, request.cwd);
      child = spawn(wrapped.argv[0], wrapped.argv.slice(1), {
        cwd: request.cwd, env: wrapped.env, shell: false, stdio: 'inherit', windowsHide: true,
      });
    } else {
      const wrapped = await SandboxManager.wrapWithSandbox(command);
      child = spawn(wrapped, { cwd: request.cwd, env: process.env, shell: true, stdio: 'inherit' });
    }
    const stop = (): void => { child?.kill('SIGTERM'); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    return await new Promise<number>((resolve, reject) => {
      child?.once('error', reject);
      child?.once('exit', (code, signal) => resolve(signal ? 1 : code ?? 1));
    });
  } catch (error: unknown) {
    process.stderr.write(`${errorText(error)}\n`);
    return 1;
  } finally {
    SandboxManager.cleanupAfterCommand();
    await SandboxManager.reset().catch(() => undefined);
  }
}
