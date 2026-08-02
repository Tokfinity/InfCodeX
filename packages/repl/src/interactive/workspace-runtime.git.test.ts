import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  active: 0,
  maxActive: 0,
  execFile: vi.fn(),
}));

vi.mock('child_process', () => ({
  execFile: mocks.execFile,
}));

import { inspectWorkspaceRuntime } from './workspace-runtime.js';

describe('workspace runtime Git inspection', () => {
  beforeEach(() => {
    mocks.active = 0;
    mocks.maxActive = 0;
    mocks.execFile.mockReset();
    mocks.execFile.mockImplementation((
      _file: string,
      args: readonly string[],
      _options: unknown,
      callback: (error: Error | null, result: { stdout: string; stderr: string }) => void,
    ) => {
      mocks.active += 1;
      mocks.maxActive = Math.max(mocks.maxActive, mocks.active);
      const stdout = args.includes('--show-toplevel')
        ? 'C:/repo\n'
        : args.includes('--git-common-dir')
          ? 'C:/repo/.git\n'
          : 'main\n';
      setTimeout(() => {
        mocks.active -= 1;
        callback(null, { stdout, stderr: '' });
      }, 10);
      return {};
    });
  });

  it('queries repository identity and branch concurrently after locating the root', async () => {
    await expect(inspectWorkspaceRuntime({ cwd: 'C:/repo' })).resolves.toMatchObject({
      canonicalRepoRoot: expect.stringMatching(/repo$/i),
      branch: 'main',
    });
    expect(mocks.execFile).toHaveBeenCalledTimes(3);
    expect(mocks.maxActive).toBe(2);
  });
});
