import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createLearningCenterService } from '@kodax-ai/agent';
import { bindRuntimeLearningClient, createRuntimeLearningOwner } from './runtime-learning.js';
import { createKodaXRuntime } from './sdk-runtime.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function seedReadyCapability(homeDir: string): Promise<void> {
  const service = createLearningCenterService({
    rootDir: join(homeDir, '.kodax', 'learned'),
    clientIdentity: 'seed',
  });
  await service.record({
    schemaVersion: 1,
    capabilityId: 'lc_runtime_test',
    displayName: 'Runtime test Skill',
    slug: 'runtime-test-skill',
    carrier: 'skill',
    lifecycle: 'ready',
    revision: 1,
    createdAt: '2026-07-17T00:00:00.000Z',
    updatedAt: '2026-07-17T00:00:00.000Z',
    source: { kind: 'learning_controller' },
  });
}

describe('runtime.learning inline facade', () => {
  it('defers storage initialization until the learning facade is used', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kodax-runtime-learning-lazy-'));
    tempDirs.push(homeDir);
    const rootDir = join(homeDir, '.kodax', 'learned');

    createRuntimeLearningOwner({
      rootDir,
      defaultClientIdentity: 'unused-client',
    });

    await expect(access(rootDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not retain one facade per transient daemon principal', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kodax-runtime-learning-facades-'));
    tempDirs.push(homeDir);
    const owner = createRuntimeLearningOwner({
      rootDir: join(homeDir, '.kodax', 'learned'),
      defaultClientIdentity: 'default-client',
    });

    const first = bindRuntimeLearningClient(owner, 'transient-principal');
    const second = bindRuntimeLearningClient(owner, 'transient-principal');

    expect(second).not.toBe(first);
    await first.getSnapshot();
    await second.getSnapshot();
  });

  it('cancels a lazy subscription before initialization installs an active iterator', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kodax-runtime-learning-cancel-'));
    tempDirs.push(homeDir);
    const owner = createRuntimeLearningOwner({
      rootDir: join(homeDir, '.kodax', 'learned'),
      defaultClientIdentity: 'default-client',
    });
    const client = bindRuntimeLearningClient(owner, 'disconnecting-principal');
    const iterator = client.subscribe()[Symbol.asyncIterator]();

    await expect(iterator.return?.()).resolves.toEqual({ done: true, value: undefined });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it('persists a stable client cursor independently from other clients', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kodax-runtime-learning-'));
    tempDirs.push(homeDir);
    await seedReadyCapability(homeDir);

    const first = await createKodaXRuntime({
      homeDir,
      clientInfo: { name: 'test', instanceId: 'stable-client' },
    });
    expect(first.capabilities?.learningCenter).toEqual({ version: 1 });
    expect((await first.learning.getSnapshot()).ready).toBe(1);
    await first.learning.acknowledge('runtime-test-skill');
    await first.close();

    const restarted = await createKodaXRuntime({
      homeDir,
      clientInfo: { name: 'test', instanceId: 'stable-client' },
    });
    const other = await createKodaXRuntime({
      homeDir,
      clientInfo: { name: 'test', instanceId: 'other-client' },
    });
    expect((await restarted.learning.getSnapshot()).ready).toBe(0);
    expect((await other.learning.getSnapshot()).ready).toBe(1);
    await restarted.close();
    await other.close();
  });

  it('persists notification state before a Runtime Worker hard stop', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kodax-worker-learning-'));
    tempDirs.push(homeDir);
    await seedReadyCapability(homeDir);

    const worker = await createKodaXRuntime({
      homeDir,
      isolation: 'worker',
      clientInfo: { name: 'test', instanceId: 'worker-client' },
    });
    expect(worker.identity.isolation).toBe('worker');
    expect((await worker.learning.getSnapshot()).ready).toBe(1);
    await worker.learning.acknowledge('runtime-test-skill');
    await worker.close();

    const restarted = await createKodaXRuntime({
      homeDir,
      isolation: 'worker',
      clientInfo: { name: 'test', instanceId: 'worker-client' },
    });
    expect((await restarted.learning.getSnapshot()).ready).toBe(0);
    await restarted.close();
  });
});
