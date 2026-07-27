import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

const { killChildProcessTreeMock, spawnMock } = vi.hoisted(() => ({
  killChildProcessTreeMock: vi.fn(async () => undefined),
  spawnMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

vi.mock('./process-tree.js', () => ({
  killChildProcessTree: killChildProcessTreeMock,
}));

const { CLIExecutor } = await import('./executor.js');
type CLIEvent = import('./types.js').CLIEvent;
type CLIExecutionOptions = import('./types.js').CLIExecutionOptions;

class BackgroundTestExecutor extends CLIExecutor {
  constructor(timeout?: number) {
    super({
      command: 'test-cli',
      baseArgs: [],
      ...(timeout !== undefined ? { timeout } : {}),
    });
  }

  protected async checkInstalled(): Promise<boolean> {
    return true;
  }

  protected buildArgs(_options: CLIExecutionOptions): string[] {
    return ['--json'];
  }

  protected parseLine(line: string): CLIEvent | null {
    return line === 'complete'
      ? {
          type: 'complete',
          timestamp: Date.now(),
          status: 'success',
          raw: line,
        }
      : null;
  }
}

describe('CLIExecutor background process', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('hides the provider CLI window in GUI hosts', async () => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: Readable;
      stderr: PassThrough;
    };
    child.stdout = Readable.from([]);
    child.stderr = new PassThrough();
    spawnMock.mockReturnValue(child);
    queueMicrotask(() => {
      child.emit('exit', 0, null);
      child.emit('close', 0, null);
    });

    const events = new BackgroundTestExecutor().execute({ prompt: 'hello' });
    await events.next();

    expect(spawnMock.mock.calls[0]?.[2]?.windowsHide).toBe(true);
  });

  it('rejects a non-zero CLI exit instead of returning an empty successful turn', async () => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: Readable;
      stderr: PassThrough;
    };
    child.stdout = Readable.from([]);
    child.stderr = new PassThrough();
    child.stderr.end('native CLI failed');
    spawnMock.mockReturnValue(child);
    queueMicrotask(() => {
      child.emit('exit', 2, null);
      child.emit('close', 2, null);
    });

    const events = new BackgroundTestExecutor().execute({ prompt: 'hello' });

    await expect(events.next()).rejects.toThrow(/exited with code 2.*native CLI failed/i);
  });

  it('times out and terminates a CLI that reports complete but never exits', async () => {
    vi.useFakeTimers();
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    spawnMock.mockReturnValue(child);
    killChildProcessTreeMock.mockResolvedValueOnce(undefined);

    const events = new BackgroundTestExecutor(25).execute({ prompt: 'hello' });
    const first = events.next();
    child.stdout.write('complete\n');
    await expect(first).resolves.toMatchObject({
      value: { type: 'complete', status: 'success' },
      done: false,
    });

    const drained = events.next();
    const rejection = expect(drained).rejects.toThrow(/timed out after 25ms/i);
    await vi.advanceTimersByTimeAsync(25);

    await rejection;
    expect(killChildProcessTreeMock).toHaveBeenCalledTimes(1);
  }, 1_000);

  it('cancels without waiting for a CLI that keeps stdout open', async () => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    spawnMock.mockReturnValue(child);
    const controller = new AbortController();

    const events = new BackgroundTestExecutor().execute({
      prompt: 'hello',
      signal: controller.signal,
    });
    const drained = events.next();
    controller.abort(new Error('caller cancelled'));

    await expect(drained).rejects.toThrow(/caller cancelled/i);
    expect(killChildProcessTreeMock).toHaveBeenCalledTimes(1);
  });

  it('cancels while waiting for close after stdout already ended', async () => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: Readable;
      stderr: PassThrough;
    };
    child.stdout = Readable.from([]);
    child.stderr = new PassThrough();
    spawnMock.mockReturnValue(child);
    const controller = new AbortController();

    const drained = new BackgroundTestExecutor().execute({
      prompt: 'hello',
      signal: controller.signal,
    }).next();
    const rejection = expect(drained).rejects.toThrow(/caller cancelled after eof/i);
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort(new Error('caller cancelled after EOF'));

    await rejection;
    expect(killChildProcessTreeMock).toHaveBeenCalledTimes(1);
  }, 1_000);
});
