import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@kodax-ai/agent', async (importOriginal) => ({
  ...await importOriginal<typeof import('@kodax-ai/agent')>(),
  isCurrentProcessWindowsJobContained: () => true,
}));

import { acquireRuntimeDaemonLease } from './manager.js';

const temporaryDirectories: string[] = [];
const originalSupervisorPid = process.env.KODAX_DAEMON_JOB_SUPERVISOR_PID;

afterEach(() => {
  if (originalSupervisorPid === undefined) {
    delete process.env.KODAX_DAEMON_JOB_SUPERVISOR_PID;
  } else {
    process.env.KODAX_DAEMON_JOB_SUPERVISOR_PID = originalSupervisorPid;
  }
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('runtime daemon containment ownership', () => {
  it('refuses to publish a new Windows Job owner without the supervisor generation', async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-daemon-contained-manager-'));
    temporaryDirectories.push(homeDir);
    process.env.KODAX_DAEMON_JOB_SUPERVISOR_PID = '2147483000';
    const createRuntime = vi.fn(async () => {
      throw new Error('Runtime creation must not start without an exact supervisor identity.');
    });

    await expect(acquireRuntimeDaemonLease({
      homeDir,
      createRuntime,
    })).rejects.toThrow('Could not read the Windows Job supervisor process identity');
    expect(createRuntime).not.toHaveBeenCalled();
  });
});
