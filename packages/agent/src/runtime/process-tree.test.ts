import { type ChildProcess } from 'node:child_process';
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
});
