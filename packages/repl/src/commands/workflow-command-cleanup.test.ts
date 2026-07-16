import { describe, expect, it, vi } from 'vitest';

import { unsubscribeWorkflowLiveProcessOnDone } from './workflow-command-cleanup.js';

describe('unsubscribeWorkflowLiveProcessOnDone', () => {
  it('cleans the process subscription without surfacing an unhandled rejection when done rejects', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const done = Promise.reject(new Error('classify boom'));
      const unsubscribe = vi.fn();

      unsubscribeWorkflowLiveProcessOnDone({ done }, unsubscribe);

      await done.catch(() => undefined);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      expect(unsubscribe).toHaveBeenCalledTimes(1);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
