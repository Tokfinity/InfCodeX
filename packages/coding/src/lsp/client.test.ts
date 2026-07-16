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
    const killProcess = vi.fn(async () => undefined);
    const unregisterManagedChild = vi.fn();

    const result = waitForLspProcessExitOrGiveUp({
      proc,
      killProcess,
      unregisterManagedChild,
      exitGraceMs: 10,
      killReapGraceMs: 20,
    });

    await vi.advanceTimersByTimeAsync(10);
    expect(killProcess).toHaveBeenCalledTimes(1);
    expect(unregisterManagedChild).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(20);
    await expect(result).resolves.toBe(false);
    expect(unregisterManagedChild).not.toHaveBeenCalled();
  });

  it('unregisters the managed-child record only after process stdio closes', async () => {
    vi.useFakeTimers();
    const proc = new FakeLspProcess();
    const killProcess = vi.fn(async () => undefined);
    const unregisterManagedChild = vi.fn();

    const result = waitForLspProcessExitOrGiveUp({
      proc,
      killProcess,
      unregisterManagedChild,
      exitGraceMs: 10,
      killReapGraceMs: 20,
    });
    proc.exitCode = 0;
    proc.emit('exit', 0, null);
    expect(unregisterManagedChild).not.toHaveBeenCalled();
    proc.emit('close', 0, null);

    await expect(result).resolves.toBe(true);
    expect(unregisterManagedChild).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30);
    expect(killProcess).not.toHaveBeenCalled();
  });

  it('does not treat an exit code as proof that stdio has closed', async () => {
    vi.useFakeTimers();
    const proc = new FakeLspProcess();
    proc.exitCode = 0;
    const killProcess = vi.fn(async () => undefined);
    const unregisterManagedChild = vi.fn();

    const result = waitForLspProcessExitOrGiveUp({
      proc,
      killProcess,
      unregisterManagedChild,
      exitGraceMs: 10,
      killReapGraceMs: 20,
    });

    expect(unregisterManagedChild).not.toHaveBeenCalled();
    proc.emit('close', 0, null);
    await expect(result).resolves.toBe(true);
    expect(unregisterManagedChild).toHaveBeenCalledOnce();
  });

  it('finishes immediately when the caller already observed close', async () => {
    const proc = new FakeLspProcess();
    const killProcess = vi.fn(async () => undefined);
    const unregisterManagedChild = vi.fn();

    await expect(waitForLspProcessExitOrGiveUp({
      proc,
      isClosed: () => true,
      killProcess,
      unregisterManagedChild,
    })).resolves.toBe(true);

    expect(killProcess).not.toHaveBeenCalled();
    expect(unregisterManagedChild).toHaveBeenCalledOnce();
  });
});
