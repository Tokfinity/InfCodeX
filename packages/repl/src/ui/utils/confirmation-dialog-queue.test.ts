import { describe, expect, it, vi } from 'vitest';

import { createConfirmationDialogQueue } from './confirmation-dialog-queue.js';

describe('confirmation dialog queue', () => {
  it('waits for the active confirmation before presenting the next one', async () => {
    const queue = createConfirmationDialogQueue();
    let resolveFirst: ((value: string) => void) | undefined;
    const firstPresenter = vi.fn(() => new Promise<string>((resolve) => {
      resolveFirst = resolve;
    }));
    const secondPresenter = vi.fn(async () => 'second');

    const first = queue(firstPresenter);
    const second = queue(secondPresenter);
    await Promise.resolve();

    expect(firstPresenter).toHaveBeenCalledOnce();
    expect(secondPresenter).not.toHaveBeenCalled();

    resolveFirst?.('first');

    await expect(first).resolves.toBe('first');
    await expect(second).resolves.toBe('second');
    expect(secondPresenter).toHaveBeenCalledOnce();
  });

  it('continues after a presenter rejects', async () => {
    const queue = createConfirmationDialogQueue();
    const failure = queue(async () => {
      throw new Error('dialog failed');
    });
    const next = queue(async () => 'recovered');

    await expect(failure).rejects.toThrow('dialog failed');
    await expect(next).resolves.toBe('recovered');
  });
});
