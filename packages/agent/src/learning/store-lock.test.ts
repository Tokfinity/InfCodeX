import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const fsMockState = vi.hoisted(() => ({
  mode: 'idle',
  lockPath: '',
  staleOwner: '',
  successorOwner: '',
  replaced: false,
  removedSuccessor: false,
  lockRemovals: 0,
  secondRemovalReached: undefined as (() => void) | undefined,
  waitForSecondRemoval: undefined as Promise<void> | undefined,
  operationStarted: undefined as Promise<void> | undefined,
  openFailureCode: '',
  repeatOpenFailure: false,
  injectedOpenFailure: false,
  rmFailureCounts: {} as Record<string, number>,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: vi.fn(async (
      target: Parameters<typeof actual.open>[0],
      flags: Parameters<typeof actual.open>[1],
      mode?: Parameters<typeof actual.open>[2],
    ) => {
      if (String(target) === fsMockState.lockPath
        && flags === 'wx'
        && fsMockState.openFailureCode !== ''
        && (fsMockState.repeatOpenFailure || !fsMockState.injectedOpenFailure)) {
        fsMockState.injectedOpenFailure = true;
        throw Object.assign(new Error('simulated Windows open failure'), {
          code: fsMockState.openFailureCode,
        });
      }
      return actual.open(target, flags, mode);
    }),
    readFile: vi.fn(async (
      target: Parameters<typeof actual.readFile>[0],
      encoding: BufferEncoding,
    ): Promise<string> => {
      const value = await actual.readFile(target, encoding);
      if (fsMockState.mode === 'replace-on-read'
        && !fsMockState.replaced
        && String(target) === fsMockState.lockPath) {
        fsMockState.replaced = true;
        await actual.writeFile(fsMockState.lockPath, fsMockState.successorOwner, 'utf8');
        setTimeout(() => {
          void actual.rm(fsMockState.lockPath, { force: true });
        }, 100);
        return fsMockState.staleOwner;
      }
      return value;
    }),
    rm: vi.fn(async (
      target: Parameters<typeof actual.rm>[0],
      options?: Parameters<typeof actual.rm>[1],
    ): Promise<void> => {
      const targetPath = String(target);
      const cleanupKind = targetPath === fsMockState.lockPath
        ? 'owner'
        : targetPath.startsWith(`${fsMockState.lockPath}.`)
          && targetPath.endsWith('.released')
          ? 'marker'
        : targetPath.includes(`${path.sep}choosing-`)
          ? 'choosing'
          : targetPath.includes(`${path.sep}ticket-`)
            ? 'ticket'
            : undefined;
      if (cleanupKind !== undefined && (fsMockState.rmFailureCounts[cleanupKind] ?? 0) > 0) {
        fsMockState.rmFailureCounts[cleanupKind] -= 1;
        throw Object.assign(new Error(`simulated ${cleanupKind} cleanup contention`), {
          code: 'EPERM',
        });
      }
      if (String(target) === fsMockState.lockPath) {
        if (fsMockState.mode === 'coordinate-reclaimers') {
          fsMockState.lockRemovals += 1;
          if (fsMockState.lockRemovals === 1) {
            await Promise.race([
              fsMockState.waitForSecondRemoval ?? Promise.resolve(),
              new Promise<void>((resolve) => setTimeout(resolve, 100)),
            ]);
          } else if (fsMockState.lockRemovals === 2) {
            fsMockState.secondRemovalReached?.();
            await fsMockState.operationStarted;
          }
        }
        try {
          fsMockState.removedSuccessor ||= await actual.readFile(target, 'utf8')
            === fsMockState.successorOwner;
        } catch {
          // A concurrently released lock is already absent.
        }
      }
      await actual.rm(target, options);
    }),
  };
});

const tempDirs: string[] = [];

afterEach(async () => {
  fsMockState.rmFailureCounts = {};
  fsMockState.openFailureCode = '';
  fsMockState.repeatOpenFailure = false;
  fsMockState.injectedOpenFailure = false;
  vi.restoreAllMocks();
  vi.resetModules();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('learning file lock stale recovery', () => {
  it('does not let a second stale reclaimer remove the successor lock acquired by the first', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-store-lock-reclaim-'));
    tempDirs.push(root);
    const lockPath = path.join(root, 'owner.lock');
    const staleOwner = '2147483647 11111111-1111-4111-8111-111111111111\n';
    const successorOwner = `${process.pid} 22222222-2222-4222-8222-222222222222\n`;
    await writeFile(lockPath, staleOwner, 'utf8');
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old);
    Object.assign(fsMockState, {
      mode: 'replace-on-read',
      lockPath,
      staleOwner,
      successorOwner,
      replaced: false,
      removedSuccessor: false,
    });

    const { withLearningFileLock } = await import('./store-lock.js');
    await withLearningFileLock(lockPath, async () => undefined);

    expect(fsMockState.replaced).toBe(true);
    expect(fsMockState.removedSuccessor).toBe(false);
  });

  it('serializes two reclaimers that both observed the same stale owner', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-store-lock-two-reclaimers-'));
    tempDirs.push(root);
    const lockPath = path.join(root, 'owner.lock');
    const staleOwner = '2147483647 33333333-3333-4333-8333-333333333333\n';
    await writeFile(lockPath, staleOwner, 'utf8');
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old);

    let signalSecondRemoval!: () => void;
    const waitForSecondRemoval = new Promise<void>((resolve) => {
      signalSecondRemoval = resolve;
    });
    let signalOperationStarted!: () => void;
    const operationStarted = new Promise<void>((resolve) => {
      signalOperationStarted = resolve;
    });
    Object.assign(fsMockState, {
      mode: 'coordinate-reclaimers',
      lockPath,
      staleOwner,
      successorOwner: '',
      replaced: false,
      removedSuccessor: false,
      lockRemovals: 0,
      secondRemovalReached: signalSecondRemoval,
      waitForSecondRemoval,
      operationStarted,
    });

    const { withLearningFileLock } = await import('./store-lock.js');
    let active = 0;
    let maxActive = 0;
    const operation = async (): Promise<void> => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      signalOperationStarted();
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      active -= 1;
    };

    await Promise.all([
      withLearningFileLock(lockPath, operation),
      withLearningFileLock(lockPath, operation),
    ]);

    expect(maxActive).toBe(1);
  });

  it('recovers abandoned ticket and choosing entries after their owners die', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-store-lock-dead-ticket-'));
    tempDirs.push(root);
    const lockPath = path.join(root, 'owner.lock');
    const queuePath = `${lockPath}.queue`;
    const deadOwner = '2147483647 44444444-4444-4444-8444-444444444444\n';
    const abandoned = [
      path.join(queuePath, 'choosing-44444444-4444-4444-8444-444444444444.lock'),
      path.join(queuePath, 'ticket-0000000000000001-44444444-4444-4444-8444-444444444444.lock'),
    ];
    await mkdir(queuePath, { recursive: true });
    await Promise.all(abandoned.map((filePath) => writeFile(filePath, deadOwner, 'utf8')));
    const old = new Date(Date.now() - 60_000);
    await Promise.all(abandoned.map((filePath) => utimes(filePath, old, old)));
    Object.assign(fsMockState, {
      mode: 'idle',
      lockPath,
      staleOwner: '',
      successorOwner: '',
      replaced: false,
      removedSuccessor: false,
      lockRemovals: 0,
    });

    const { withLearningFileLock } = await import('./store-lock.js');
    await expect(withLearningFileLock(lockPath, async () => 'acquired')).resolves.toBe('acquired');
  });

  it('treats a Windows access-shaped open failure as contention when the lock exists', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-store-lock-windows-contention-'));
    tempDirs.push(root);
    const lockPath = path.join(root, 'owner.lock');
    await writeFile(
      lockPath,
      `${process.pid} 55555555-5555-4555-8555-555555555555\n`,
      'utf8',
    );
    Object.assign(fsMockState, {
      mode: 'idle',
      lockPath,
      openFailureCode: 'EPERM',
      injectedOpenFailure: false,
    });
    setTimeout(() => {
      void rm(lockPath, { force: true });
    }, 50);

    const { withLearningFileLock } = await import('./store-lock.js');
    await expect(withLearningFileLock(lockPath, async () => 'acquired')).resolves.toBe('acquired');
    expect(fsMockState.injectedOpenFailure).toBe(true);
  });

  it('preserves a Windows access error when no competing lock exists', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-store-lock-windows-permission-'));
    tempDirs.push(root);
    const lockPath = path.join(root, 'owner.lock');
    Object.assign(fsMockState, {
      mode: 'idle',
      lockPath,
      openFailureCode: 'EACCES',
      repeatOpenFailure: true,
      injectedOpenFailure: false,
    });

    const { withLearningFileLock } = await import('./store-lock.js');
    await expect(withLearningFileLock(lockPath, async () => undefined))
      .rejects.toThrow('simulated Windows open failure');
  });

  it('retries once when a Windows access-shaped contention disappears before stat', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-store-lock-windows-race-'));
    tempDirs.push(root);
    const lockPath = path.join(root, 'owner.lock');
    Object.assign(fsMockState, {
      mode: 'idle',
      lockPath,
      openFailureCode: 'EPERM',
      repeatOpenFailure: false,
      injectedOpenFailure: false,
    });

    const { withLearningFileLock } = await import('./store-lock.js');
    await expect(withLearningFileLock(lockPath, async () => 'acquired'))
      .resolves.toBe('acquired');
    expect(fsMockState.injectedOpenFailure).toBe(true);
  });

  it('retries transient Windows cleanup failures for queue entries and the owner lock', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-store-lock-windows-cleanup-'));
    tempDirs.push(root);
    const lockPath = path.join(root, 'owner.lock');
    Object.assign(fsMockState, {
      mode: 'idle',
      lockPath,
      rmFailureCounts: { choosing: 1, ticket: 1, owner: 1 },
    });

    const { withLearningFileLock } = await import('./store-lock.js');
    await expect(withLearningFileLock(lockPath, async () => 'first')).resolves.toBe('first');
    await expect(withLearningFileLock(lockPath, async () => 'second')).resolves.toBe('second');
    expect(fsMockState.rmFailureCounts).toEqual({ choosing: 0, ticket: 0, owner: 0 });
  });

  for (const cleanupKind of ['choosing', 'ticket', 'owner', 'marker'] as const) {
    it(`recovers a ${cleanupKind} entry after every immediate Windows cleanup retry is exhausted`, async () => {
      const root = await mkdtemp(path.join(
        os.tmpdir(),
        `kodax-store-lock-exhausted-${cleanupKind}-`,
      ));
      tempDirs.push(root);
      const lockPath = path.join(root, 'owner.lock');
      Object.assign(fsMockState, {
        mode: 'idle',
        lockPath,
        rmFailureCounts: { [cleanupKind]: 8 },
      });

      const { withLearningFileLock } = await import('./store-lock.js');
      await expect(withLearningFileLock(lockPath, async () => 'first'))
        .resolves.toBe('first');
      await expect(withLearningFileLock(lockPath, async () => 'second'))
        .resolves.toBe('second');
      expect(fsMockState.rmFailureCounts[cleanupKind]).toBe(0);
      if (cleanupKind === 'marker') {
        expect((await readdir(root)).filter((name) => name.endsWith('.released'))).toHaveLength(1);
      }
    });
  }
});
