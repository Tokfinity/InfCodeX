import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { setAgentConfigHome } from './agent-home.js';
import {
  cleanupRegisteredManagedChildren,
  registerManagedChildProcess,
} from './managed-child-processes.js';
import { killChildProcessTree } from './process-tree.js';

function waitForExit(child: ChildProcess, timeoutMs = 5_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      reject(new Error('child did not exit'));
    }, timeoutMs);
    const onExit = (): void => {
      clearTimeout(timer);
      resolve();
    };
    child.once('exit', onExit);
  });
}

describe('managed child process registry', () => {
  let tempHome = '';
  let child: ChildProcess | undefined;

  afterEach(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      await killChildProcessTree(child);
    }
    child = undefined;
    setAgentConfigHome(undefined);
    if (tempHome) {
      await rm(tempHome, { recursive: true, force: true });
      tempHome = '';
    }
  });

  it('cleans up a confirmed registered child process', async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), 'kodax-managed-child-'));
    setAgentConfigHome(tempHome);
    child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    registerManagedChildProcess(child, {
      kind: 'test-child',
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
    });

    const summary = await cleanupRegisteredManagedChildren({ includeCurrentOwner: true });

    expect(summary.killed).toBe(1);
    await expect(waitForExit(child)).resolves.toBeUndefined();
  });

  it('skips children owned by the current live process by default', async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), 'kodax-managed-child-'));
    setAgentConfigHome(tempHome);
    child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    registerManagedChildProcess(child, {
      kind: 'test-child',
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
    });

    const summary = await cleanupRegisteredManagedChildren();

    expect(summary.killed).toBe(0);
    expect(summary.skipped).toBe(1);
    expect(child.exitCode).toBeNull();
  });
});
