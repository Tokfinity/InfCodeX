import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

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
  constructor() {
    super({ command: 'test-cli', baseArgs: [] });
  }

  protected async checkInstalled(): Promise<boolean> {
    return true;
  }

  protected buildArgs(_options: CLIExecutionOptions): string[] {
    return ['--json'];
  }

  protected parseLine(_line: string): CLIEvent | null {
    return null;
  }
}

describe('CLIExecutor background process', () => {
  it('hides the provider CLI window in GUI hosts', async () => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: Readable;
      stderr: PassThrough;
    };
    child.stdout = Readable.from([]);
    child.stderr = new PassThrough();
    spawnMock.mockReturnValue(child);

    const events = new BackgroundTestExecutor().execute({ prompt: 'hello' });
    await events.next();

    expect(spawnMock.mock.calls[0]?.[2]?.windowsHide).toBe(true);
  });
});
