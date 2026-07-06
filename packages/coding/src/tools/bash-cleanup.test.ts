import { describe, expect, it, vi } from 'vitest';

const agentMocks = vi.hoisted(() => ({
  killChildProcessTree: vi.fn(() => Promise.reject(new Error('kill failed'))),
  killChildProcessTreeSync: vi.fn(),
  registerManagedChildProcess: vi.fn(() => () => undefined),
}));

vi.mock('@kodax-ai/agent', () => agentMocks);

import { toolBash } from './bash.js';

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('toolBash cleanup rejection handling', () => {
  it('does not surface unhandled rejections when aborted background cleanup rejects', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      agentMocks.killChildProcessTree.mockClear();
      const controller = new AbortController();
      controller.abort(new Error('stop'));

      const result = await toolBash({
        command: 'node -e "console.log(\'background exits\')"',
        run_in_background: true,
      }, {
        backups: new Map(),
        executionCwd: process.cwd(),
        abortSignal: controller.signal,
      });

      await nextTurn();
      await nextTurn();

      expect(result).toContain('Command started in background');
      expect(agentMocks.killChildProcessTree).toHaveBeenCalledTimes(1);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
