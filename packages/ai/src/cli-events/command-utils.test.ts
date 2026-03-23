import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

const { checkCliCommandInstalled } = await import('./command-utils.js');

describe('checkCliCommandInstalled', () => {
  afterEach(() => {
    spawnMock.mockReset();
    vi.restoreAllMocks();
  });

  it('returns true when the version probe exits successfully', async () => {
    const child = new EventEmitter() as EventEmitter & { on: EventEmitter['on'] };
    spawnMock.mockReturnValue(child);

    const pending = checkCliCommandInstalled('codex');
    child.emit('close', 0);

    await expect(pending).resolves.toBe(true);
  });

  it('returns false when the probe exits with failure or errors', async () => {
    const child = new EventEmitter() as EventEmitter & { on: EventEmitter['on'] };
    spawnMock.mockReturnValueOnce(child);
    const first = checkCliCommandInstalled('codex');
    child.emit('close', 1);

    const erroredChild = new EventEmitter() as EventEmitter & { on: EventEmitter['on'] };
    spawnMock.mockReturnValueOnce(erroredChild);
    const second = checkCliCommandInstalled('gemini');
    erroredChild.emit('error', new Error('missing'));

    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(false);
  });
});
