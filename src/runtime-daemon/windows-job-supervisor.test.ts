import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildWindowsCommandLine,
  quoteWindowsCommandLineArg,
  spawnWindowsJobContainedProcess,
} from './windows-job-supervisor.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
});

describe('Windows Job daemon supervisor', () => {
  it('quotes Windows command-line arguments with spaces, quotes, and trailing slashes', () => {
    expect(quoteWindowsCommandLineArg('plain')).toBe('plain');
    expect(quoteWindowsCommandLineArg('two words')).toBe('"two words"');
    expect(quoteWindowsCommandLineArg('say"hello')).toBe('"say\\"hello"');
    expect(quoteWindowsCommandLineArg('C:\\Program Files\\')).toBe('"C:\\Program Files\\\\"');
    expect(buildWindowsCommandLine('node.exe', ['-e', 'hello world']))
      .toBe('node.exe -e "hello world"');
  });

  it.skipIf(process.platform !== 'win32')(
    'accepts the ready file before the matching owner IPC identity arrives',
    async () => {
      const directory = mkdtempSync(path.join(os.tmpdir(), 'kodax-job-owner-order-'));
      temporaryDirectories.push(directory);
      const logFile = path.join(directory, 'supervisor.log');
      const contained = await spawnWindowsJobContainedProcess({
        executable: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
        cwd: process.cwd(),
        env: {
          ...process.env,
          KODAX_INTERNAL_WINDOWS_JOB_TEST_OWNER_AFTER_READY: '1',
        },
        logFile,
      });

      await contained.terminate();
      await waitForPidExit(contained.containmentSupervisorPid);
      await waitForPidExit(contained.processPid);
    },
    30_000,
  );

  it.skipIf(process.platform !== 'win32')(
    'contains descendants before the target can run and exits only after the Job is empty',
    async () => {
      const directory = mkdtempSync(path.join(os.tmpdir(), 'kodax-job-supervisor-'));
      temporaryDirectories.push(directory);
      const descendantPidFile = path.join(directory, 'descendant.pid');
      const logFile = path.join(directory, 'supervisor.log');
      let contained;
      try {
        contained = await spawnWindowsJobContainedProcess({
            executable: process.execPath,
            args: [
              '-e',
              [
                "const { spawn } = require('node:child_process');",
                "const { writeFileSync } = require('node:fs');",
                "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });",
                "writeFileSync(process.env.KODAX_TEST_DESCENDANT_PID, String(child.pid));",
                'setInterval(() => {}, 1000);',
              ].join(' '),
            ],
            cwd: process.cwd(),
            env: { ...process.env, KODAX_TEST_DESCENDANT_PID: descendantPidFile },
          logFile,
        });
      } catch (error: unknown) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}\n${
            existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''
          }`,
        );
      }

      await waitForFile(descendantPidFile);
      const wrapperExit = once(contained.supervisor, 'exit');
      await contained.terminate();
      await wrapperExit;
      expect(contained.supervisor.pid).not.toBe(contained.containmentSupervisorPid);
      const descendantPid = Number(readFileSync(descendantPidFile, 'utf8'));
      expect(contained.processPid).toBeGreaterThan(0);
      expect(contained.containmentSupervisorPid).toBeGreaterThan(0);
      expect(descendantPid).toBeGreaterThan(0);
      await waitForPidExit(contained.containmentSupervisorPid);
      await waitForPidExit(contained.processPid);
      await waitForPidExit(descendantPid);
      expect(isPidAlive(contained.processPid)).toBe(false);
      expect(isPidAlive(descendantPid)).toBe(false);
    },
    30_000,
  );
});

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidExit(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (isPidAlive(pid)) {
    if (Date.now() >= deadline) throw new Error(`PID ${pid} did not exit in time.`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForFile(file: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`File ${file} did not appear in time.`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}
