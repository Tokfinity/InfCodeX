import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { setAgentConfigHome } from './agent-home.js';
import {
  cleanupRegisteredManagedChildren,
  registerManagedChildProcess,
} from './managed-child-processes.js';
import { killChildProcessTree } from './process-tree.js';

function childRegistryPath(home: string, pid: number): string {
  return path.join(home, 'processes', 'children', `${pid}.json`);
}

async function writeRegistryRecord(home: string, record: Record<string, unknown>): Promise<void> {
  const pid = record.pid;
  if (typeof pid !== 'number') {
    throw new Error('test registry record needs a numeric pid');
  }
  await mkdir(path.dirname(childRegistryPath(home, pid)), { recursive: true });
  await writeFile(childRegistryPath(home, pid), JSON.stringify(record), 'utf8');
}

function findDeadPid(): number {
  for (let pid = 999_999; pid < 1_010_000; pid += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return pid;
    }
  }
  throw new Error('could not find an unused pid for test');
}

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

  it('prunes an unconfirmed live pid without killing it', async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), 'kodax-managed-child-'));
    setAgentConfigHome(tempHome);
    child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    if (child.pid === undefined) {
      throw new Error('child pid missing');
    }
    await writeRegistryRecord(tempHome, {
      version: 1,
      pid: child.pid,
      ownerPid: 0,
      registeredAtMs: Date.now(),
      kind: 'test-child',
      command: 'definitely-not-this-process',
      args: ['not-present-in-command-line'],
    });

    const summary = await cleanupRegisteredManagedChildren({ includeCurrentOwner: true });

    expect(summary.killed).toBe(0);
    expect(summary.pruned).toBe(1);
    expect(child.exitCode).toBeNull();
  });

  it('does not trust a tampered current-owner registry record', async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), 'kodax-managed-child-'));
    setAgentConfigHome(tempHome);
    child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    if (child.pid === undefined) {
      throw new Error('child pid missing');
    }
    registerManagedChildProcess(child, {
      kind: 'test-child',
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
    });
    await writeRegistryRecord(tempHome, {
      version: 1,
      pid: child.pid,
      ownerPid: process.pid,
      registeredAtMs: Date.now(),
      kind: 'test-child',
      command: 'definitely-not-this-process',
      args: ['not-present-in-command-line'],
    });

    const summary = await cleanupRegisteredManagedChildren({ includeCurrentOwner: true });

    expect(summary.killed).toBe(0);
    expect(summary.pruned).toBe(1);
    expect(child.exitCode).toBeNull();
  });

  it('prunes a dead pid record', async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), 'kodax-managed-child-'));
    setAgentConfigHome(tempHome);
    const deadPid = findDeadPid();
    await writeRegistryRecord(tempHome, {
      version: 1,
      pid: deadPid,
      ownerPid: 0,
      registeredAtMs: Date.now(),
      kind: 'test-child',
      command: process.execPath,
    });

    const summary = await cleanupRegisteredManagedChildren({ includeCurrentOwner: true });

    expect(summary.killed).toBe(0);
    expect(summary.pruned).toBe(1);
  });
});
