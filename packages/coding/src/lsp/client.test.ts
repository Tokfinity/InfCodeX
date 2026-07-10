import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitForLspProcessExitOrGiveUp } from './client.js';

class FakeLspProcess extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('waitForLspProcessExitOrGiveUp', () => {
  it('keeps the managed-child record registered when kill is not observed as exit', async () => {
    vi.useFakeTimers();
    const proc = new FakeLspProcess();
    const killSync = vi.fn();
    const unregisterManagedChild = vi.fn();

    const result = waitForLspProcessExitOrGiveUp({
      proc,
      killSync,
      unregisterManagedChild,
      exitGraceMs: 10,
      killReapGraceMs: 20,
    });

    await vi.advanceTimersByTimeAsync(10);
    expect(killSync).toHaveBeenCalledTimes(1);
    expect(unregisterManagedChild).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(20);
    await expect(result).resolves.toBe(false);
    expect(unregisterManagedChild).not.toHaveBeenCalled();
  });

  it('unregisters the managed-child record after observing process exit', async () => {
    vi.useFakeTimers();
    const proc = new FakeLspProcess();
    const killSync = vi.fn();
    const unregisterManagedChild = vi.fn();

    const result = waitForLspProcessExitOrGiveUp({
      proc,
      killSync,
      unregisterManagedChild,
      exitGraceMs: 10,
      killReapGraceMs: 20,
    });
    proc.exitCode = 0;
    proc.emit('exit', 0, null);

    await expect(result).resolves.toBe(true);
    expect(unregisterManagedChild).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30);
    expect(killSync).not.toHaveBeenCalled();
  });
});
