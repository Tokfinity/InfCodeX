import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { spawnSyncMock } = vi.hoisted(() => ({
  spawnSyncMock: vi.fn(),
}));

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>(
    'node:child_process',
  );
  return { ...actual, spawnSync: spawnSyncMock };
});

import { setAgentConfigHome } from './agent-home.js';
import { cleanupRegisteredManagedChildren } from './managed-child-processes.js';

describe.runIf(process.platform === 'win32')('managed child cleanup query reuse', () => {
  let tempHome = '';

  afterEach(async () => {
    spawnSyncMock.mockReset();
    setAgentConfigHome(undefined);
    if (tempHome) await rm(tempHome, { recursive: true, force: true });
    tempHome = '';
  });

  it('queries one current owner identity once for all of its records', async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), 'kodax-managed-owner-cache-'));
    setAgentConfigHome(tempHome);
    const creationDate = '2026-08-01T00:00:00.000Z';
    const creationMs = Date.parse(creationDate);
    const ownerProcessStartIdentity =
      `windows:${(BigInt(creationMs) + 11_644_473_600_000n).toString()}`;
    spawnSyncMock.mockReturnValue({
      pid: 1,
      output: [null, '', ''],
      stdout: JSON.stringify({ ProcessId: process.pid, CreationDate: creationDate }),
      stderr: '',
      status: 0,
      signal: null,
    });

    const registry = path.join(tempHome, 'runtime', 'processes', 'children');
    await mkdir(registry, { recursive: true });
    for (let index = 0; index < 4; index += 1) {
      const registrationId = `same-owner-${index}`;
      await writeFile(path.join(registry, `${90_000 + index}.${registrationId}.json`), JSON.stringify({
        version: 4,
        registrationId,
        pid: 90_000 + index,
        ownerPid: process.pid,
        ownerProcessStartIdentity,
        registeredAtMs: Date.now(),
        kind: 'test-child',
        command: process.execPath,
      }), 'utf8');
    }

    await expect(cleanupRegisteredManagedChildren()).resolves.toMatchObject({
      killed: 0,
      pruned: 0,
      skipped: 4,
    });
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
  });

  it('queries all live owner identities in one Windows process snapshot', async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), 'kodax-managed-owner-batch-'));
    setAgentConfigHome(tempHome);
    const creationDate = '2026-08-01T00:00:00.000Z';
    const creationMs = Date.parse(creationDate);
    const ownerProcessStartIdentity =
      `windows:${(BigInt(creationMs) + 11_644_473_600_000n).toString()}`;
    const ownerPids = [process.pid, process.ppid];
    spawnSyncMock.mockReturnValue({
      pid: 1,
      output: [null, '', ''],
      stdout: JSON.stringify(ownerPids.map((ProcessId) => ({
        ProcessId,
        CreationDate: creationDate,
      }))),
      stderr: '',
      status: 0,
      signal: null,
    });

    const registry = path.join(tempHome, 'runtime', 'processes', 'children');
    await mkdir(registry, { recursive: true });
    for (const [index, ownerPid] of ownerPids.entries()) {
      const registrationId = `distinct-owner-${index}`;
      await writeFile(path.join(registry, `${91_000 + index}.${registrationId}.json`), JSON.stringify({
        version: 4,
        registrationId,
        pid: 91_000 + index,
        ownerPid,
        ownerProcessStartIdentity,
        registeredAtMs: Date.now(),
        kind: 'test-child',
        command: process.execPath,
      }), 'utf8');
    }

    await expect(cleanupRegisteredManagedChildren()).resolves.toMatchObject({
      killed: 0,
      pruned: 0,
      skipped: ownerPids.length,
    });
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
  });
});
