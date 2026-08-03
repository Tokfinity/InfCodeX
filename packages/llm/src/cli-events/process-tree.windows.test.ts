import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

const { spawnSyncMock } = vi.hoisted(() => ({
  spawnSyncMock: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawnSync: spawnSyncMock,
}));

const {
  killChildProcessTree,
  rememberChildProcessTree,
} = await import('./process-tree.js');

const originalPlatform = process.platform;

function setWindows(): void {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: 'win32',
  });
}

function fakeChild(pid: number) {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    kill: ReturnType<typeof vi.fn>;
  };
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = vi.fn(() => true);
  return child;
}

function snapshot(stdout: string) {
  return {
    error: undefined,
    status: 0,
    signal: null,
    stdout,
    stderr: '',
    pid: 1,
    output: [],
  };
}

describe('LLM Windows process-tree identity fences', () => {
  afterEach(() => {
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: originalPlatform,
    });
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('does not terminate a reused root PID after the tracked child exits', async () => {
    setWindows();
    spawnSyncMock
      .mockReturnValueOnce(snapshot('4242,1,111\n'))
      .mockReturnValueOnce(snapshot('4242,1,222\n'));
    const child = fakeChild(4_242);
    expect(rememberChildProcessTree(child as never)).toBe('111');
    child.exitCode = 0;

    await expect(killChildProcessTree(child as never))
      .resolves.toEqual({ status: 'unknown' });
    expect(spawnSyncMock.mock.calls.some(([, args]) =>
      Array.isArray(args) && /TerminateExact\(\d/.test(String(args.at(-1)))))
      .toBe(false);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('retries one complete snapshot when a newly spawned root is initially absent', () => {
    setWindows();
    spawnSyncMock
      .mockReturnValueOnce(snapshot('1,0,100\n'))
      .mockReturnValueOnce(snapshot('4242,1,111\n'));

    expect(rememberChildProcessTree(fakeChild(4_242) as never)).toBe('111');
    expect(spawnSyncMock).toHaveBeenCalledTimes(2);
  });

  it('attempts the retained exact root identity when a fresh snapshot fails', async () => {
    setWindows();
    const child = fakeChild(4_242);
    const failedSnapshot = {
      ...snapshot(''),
      error: new Error('snapshot unavailable'),
      status: null,
    };
    const terminationScripts: string[] = [];
    spawnSyncMock.mockImplementation((_command, args) => {
      const script = Array.isArray(args) ? String(args.at(-1)) : '';
      if (/TerminateExact\(\d/.test(script)) {
        terminationScripts.push(script);
        child.exitCode = 0;
        return snapshot('');
      }
      if (spawnSyncMock.mock.calls.length === 1) return snapshot('4242,1,111\n');
      return failedSnapshot;
    });
    expect(rememberChildProcessTree(child as never)).toBe('111');

    await expect(killChildProcessTree(child as never))
      .resolves.toEqual({ status: 'unknown' });
    expect(terminationScripts.join('\n')).toContain('TerminateExact(4242');
    expect(spawnSyncMock.mock.calls.some(([command]) => command === 'taskkill.exe'))
      .toBe(false);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('uses lightweight liveness checks before one final identity snapshot', async () => {
    setWindows();
    const child = fakeChild(4_242);
    const snapshots = [
      '4242,1,111\n',
      '4242,1,111\n4343,4242,222\n',
      '9999,1,999\n',
    ];
    const terminationScripts: string[] = [];
    spawnSyncMock.mockImplementation((_command, args) => {
      const script = Array.isArray(args) ? String(args.at(-1)) : '';
      if (/TerminateExact\(\d/.test(script)) {
        terminationScripts.push(script);
        child.exitCode = 0;
        return snapshot('');
      }
      return snapshot(snapshots.shift() ?? '');
    });
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    });
    expect(rememberChildProcessTree(child as never)).toBe('111');

    await expect(killChildProcessTree(child as never))
      .resolves.toEqual({ status: 'terminated' });
    expect(terminationScripts.join('\n')).toContain('TerminateExact(4242');
    expect(terminationScripts.join('\n')).toContain('TerminateExact(4343');
    expect(kill).toHaveBeenCalledTimes(2);
    expect(snapshots).toHaveLength(0);
  });
});
