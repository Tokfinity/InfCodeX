import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  killChildProcessTree,
  killChildProcessTreeSync,
} from './process-tree.js';

const originalPlatform = process.platform;
const originalKill = process.kill;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: platform,
  });
}

function setKill(mock: typeof process.kill): void {
  Object.defineProperty(process, 'kill', {
    configurable: true,
    value: mock,
  });
}

function exitedChild(pid: number): ChildProcess {
  return {
    pid,
    exitCode: 0,
    signalCode: null,
    kill: vi.fn(),
  } as unknown as ChildProcess;
}

function notFoundError(): NodeJS.ErrnoException {
  const error = new Error('not found') as NodeJS.ErrnoException;
  error.code = 'ESRCH';
  return error;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readSpawnedPid(child: ChildProcess): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let stdout = '';
    const timer = setTimeout(() => reject(new Error('nested child pid was not reported')), 5_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      const line = stdout.split(/\r?\n/, 1)[0];
      const pid = Number(line);
      if (!Number.isInteger(pid) || pid <= 0) return;
      clearTimeout(timer);
      resolve(pid);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (isPidAlive(pid)) {
    if (Date.now() >= deadline) throw new Error(`process ${pid} did not exit`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('process tree cleanup', () => {
  afterEach(() => {
    setPlatform(originalPlatform);
    setKill(originalKill);
    vi.restoreAllMocks();
  });

  it('still signals a POSIX process group when the parent child has already exited', async () => {
    const calls: Array<{ pid: number; signal: NodeJS.Signals | number | undefined }> = [];
    const mockKill = vi.fn((pid: number, signal?: NodeJS.Signals | number) => {
      calls.push({ pid, signal });
      if (signal === 0) {
        throw notFoundError();
      }
      return true;
    }) as typeof process.kill;
    setPlatform('linux');
    setKill(mockKill);

    await killChildProcessTree(exitedChild(12345));

    expect(calls).toContainEqual({ pid: -12345, signal: 'SIGTERM' });
  });

  it('sync cleanup also signals a POSIX process group after parent exit', () => {
    const calls: Array<{ pid: number; signal: NodeJS.Signals | number | undefined }> = [];
    const mockKill = vi.fn((pid: number, signal?: NodeJS.Signals | number) => {
      calls.push({ pid, signal });
      return true;
    }) as typeof process.kill;
    setPlatform('linux');
    setKill(mockKill);

    killChildProcessTreeSync(exitedChild(12345));

    expect(calls).toContainEqual({ pid: -12345, signal: 'SIGTERM' });
    expect(calls).toContainEqual({ pid: -12345, signal: 'SIGKILL' });
  });

  it.skipIf(process.platform !== 'win32')('kills a snapshotted Windows child when taskkill times out', async () => {
    const fixtureDir = await mkdtemp(path.join(tmpdir(), 'kodax-process-tree-'));
    const stopFile = path.join(fixtureDir, 'stop');
    const nestedScript = [
      'const {existsSync}=require("node:fs");',
      `const stopFile=${JSON.stringify(stopFile)};`,
      'setInterval(()=>{if(existsSync(stopFile))process.exit(0)},25);',
      'setTimeout(()=>process.exit(0),30000)',
    ].join('');
    const root = spawn(process.execPath, [
      '-e',
      `const {spawn}=require("node:child_process"); const child=spawn(process.execPath,["-e",${JSON.stringify(nestedScript)}],{stdio:"ignore",windowsHide:true}); process.stdout.write(String(child.pid)+"\\n"); setInterval(()=>{},1000);`,
    ], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const nestedPid = await readSpawnedPid(root);

    try {
      await killChildProcessTree(root, { taskkillMs: 0 });
      await waitForPidExit(nestedPid, 10_000);
    } finally {
      await writeFile(stopFile, 'stop');
      if (root.exitCode === null && root.signalCode === null) root.kill('SIGKILL');
      await waitForPidExit(nestedPid, 2_000).catch(() => undefined);
      await rm(fixtureDir, { recursive: true, force: true });
    }
  }, 20_000);
});
