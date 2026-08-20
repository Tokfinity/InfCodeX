import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { KodaXToolExecutionContext } from '../../types.js';
import {
  withTextFileMutation,
  writeTextFileForMutation,
} from './text-file-mutation.js';
import { acquireFileSystemMutationLease } from './file-mutation-queue.js';

describe('text file mutation capability', () => {
  let root = '';

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-text-mutation-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('uses the sandbox snapshot and compare-and-write capability when available', async () => {
    const filePath = path.join(root, 'target.txt');
    const read = vi.fn(async () => ({
      status: 'ok' as const,
      snapshot: {
        state: 'present' as const,
        content: 'before',
        revision: 'r1',
        backupPath: filePath,
      },
    }));
    const write = vi.fn(async () => ({ status: 'written' as const }));
    const ctx: KodaXToolExecutionContext = {
      backups: new Map(),
      toolCallId: 'tool-1',
      textFileMutationSandbox: { read, write },
    };
    await withTextFileMutation(filePath, 'edit', { path: filePath }, ctx, async (snapshot) => {
      expect(snapshot.execution).toBe('sandbox');
      expect(snapshot.content).toBe('before');
      await writeTextFileForMutation(snapshot, 'after', false, ctx);
    });

    expect(write).toHaveBeenCalledWith(expect.objectContaining({
      path: filePath,
      expectedRevision: 'r1',
      content: 'after',
    }));
  });

  it('never falls back to a host write after a sandboxed read', async () => {
    const filePath = path.join(root, 'target.txt');
    await fs.writeFile(filePath, 'host-before', 'utf8');
    const ctx: KodaXToolExecutionContext = {
      backups: new Map(),
      textFileMutationSandbox: {
        read: async () => ({
          status: 'ok',
          snapshot: {
            state: 'present',
            content: 'sandbox-before',
            revision: 'r1',
            backupPath: filePath,
          },
        }),
        write: async () => ({ status: 'unavailable' }),
      },
    };

    await expect(withTextFileMutation(
      filePath,
      'write',
      { path: filePath },
      ctx,
      async (snapshot) => writeTextFileForMutation(snapshot, 'must-not-write', false, ctx),
    ))
      .rejects.toThrow('became unavailable');
    await expect(fs.readFile(filePath, 'utf8')).resolves.toBe('host-before');
  });

  it('records sandbox backups against the helper-bound canonical identity', async () => {
    const actualDirectory = path.join(root, 'actual');
    const aliasDirectory = path.join(root, 'alias');
    await fs.mkdir(actualDirectory);
    await fs.symlink(
      actualDirectory,
      aliasDirectory,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const target = path.join(aliasDirectory, 'target.txt');
    await fs.writeFile(path.join(actualDirectory, 'target.txt'), 'before', 'utf8');
    const canonicalTarget = await fs.realpath(target);
    const ctx: KodaXToolExecutionContext = {
      backups: new Map(),
      textFileMutationSandbox: {
        read: async () => ({
          status: 'ok',
          snapshot: {
            state: 'present',
            content: 'before',
            revision: 'r1',
            backupPath: canonicalTarget,
          },
        }),
        write: async () => ({ status: 'written' }),
      },
    };
    await withTextFileMutation(target, 'edit', { path: target }, ctx, async (snapshot) => {
      await writeTextFileForMutation(snapshot, 'after', false, ctx, 'before');
    });

    expect([...ctx.backups.keys()]).toEqual([canonicalTarget]);
  });

  it('never falls back to a host read when the runtime sandbox is unavailable', async () => {
    const filePath = path.join(root, 'target.txt');
    await fs.writeFile(filePath, 'host-content', 'utf8');
    const ctx: KodaXToolExecutionContext = {
      backups: new Map(),
      textFileMutationSandbox: {
        read: async () => ({ status: 'unavailable' }),
        write: async () => ({ status: 'written' }),
      },
    };

    await expect(withTextFileMutation(
      filePath,
      'edit',
      { path: filePath },
      ctx,
      async () => 'unsafe',
    )).rejects.toThrow('Runtime sandboxed file mutation is unavailable');
    await expect(fs.readFile(filePath, 'utf8')).resolves.toBe('host-content');
  });

  it('uses the legacy host fence for paths outside the runtime capability', async () => {
    const filePath = path.join(root, 'reviewed-outside.txt');
    await fs.writeFile(filePath, 'before', 'utf8');
    const read = vi.fn(async () => ({ status: 'unavailable' as const }));
    const ctx: KodaXToolExecutionContext = {
      backups: new Map(),
      textFileMutationSandbox: {
        canHandlePath: () => false,
        read,
        write: async () => ({ status: 'unavailable' }),
      },
    };

    await withTextFileMutation(filePath, 'write', { path: filePath }, ctx, async (snapshot) => {
      expect(snapshot.execution).toBe('host');
      await writeTextFileForMutation(snapshot, 'after', false, ctx);
    });

    expect(read).not.toHaveBeenCalled();
    await expect(fs.readFile(filePath, 'utf8')).resolves.toBe('after');
  });

  it('rejects a redirected host path outside the runtime capability', async () => {
    const actualDirectory = path.join(root, 'outside-actual');
    const aliasDirectory = path.join(root, 'outside-alias');
    await fs.mkdir(actualDirectory);
    await fs.symlink(
      actualDirectory,
      aliasDirectory,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const actualTarget = path.join(actualDirectory, 'target.txt');
    const aliasTarget = path.join(aliasDirectory, 'target.txt');
    await fs.writeFile(actualTarget, 'before', 'utf8');
    const ctx: KodaXToolExecutionContext = {
      backups: new Map(),
      textFileMutationSandbox: {
        canHandlePath: () => false,
        read: async () => ({ status: 'unavailable' }),
        write: async () => ({ status: 'unavailable' }),
      },
    };

    const releaseShell = await acquireFileSystemMutationLease();
    try {
      await expect(withTextFileMutation(
        aliasTarget,
        'write',
        { path: aliasTarget },
        ctx,
        async () => 'unsafe',
      )).rejects.toThrow('filesystem effect is already active');
    } finally {
      await releaseShell();
    }
    await expect(withTextFileMutation(
      aliasTarget,
      'write',
      { path: aliasTarget },
      ctx,
      async () => 'unsafe',
    )).rejects.toThrow('redirected through a link');
    await expect(fs.readFile(actualTarget, 'utf8')).resolves.toBe('before');
  });

  it('rejects a missing host target below a redirected ancestor', async () => {
    const actualDirectory = path.join(root, 'missing-actual');
    const aliasDirectory = path.join(root, 'missing-alias');
    await fs.mkdir(actualDirectory);
    await fs.symlink(
      actualDirectory,
      aliasDirectory,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const aliasTarget = path.join(aliasDirectory, 'new', 'target.txt');
    const ctx: KodaXToolExecutionContext = {
      backups: new Map(),
      textFileMutationSandbox: {
        canHandlePath: () => false,
        read: async () => ({ status: 'unavailable' }),
        write: async () => ({ status: 'unavailable' }),
      },
    };

    await expect(withTextFileMutation(
      aliasTarget,
      'write',
      { path: aliasTarget },
      ctx,
      async () => 'unsafe',
    )).rejects.toThrow('redirected through a link');
    await expect(fs.stat(path.join(actualDirectory, 'new'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('rejects a hard-linked host target outside the runtime capability', async () => {
    const actualTarget = path.join(root, 'hard-link-actual.txt');
    const linkedTarget = path.join(root, 'hard-link-target.txt');
    await fs.writeFile(actualTarget, 'before', 'utf8');
    await fs.link(actualTarget, linkedTarget);
    const ctx: KodaXToolExecutionContext = {
      backups: new Map(),
      textFileMutationSandbox: {
        canHandlePath: () => false,
        read: async () => ({ status: 'unavailable' }),
        write: async () => ({ status: 'unavailable' }),
      },
    };

    await expect(withTextFileMutation(
      linkedTarget,
      'write',
      { path: linkedTarget },
      ctx,
      async () => 'unsafe',
    )).rejects.toThrow('is a hard link');
    await expect(fs.readFile(actualTarget, 'utf8')).resolves.toBe('before');
  });

  it('rejects a host fallback commit when another writer changed the snapshot', async () => {
    const filePath = path.join(root, 'target.txt');
    await fs.writeFile(filePath, 'before', 'utf8');
    const ctx: KodaXToolExecutionContext = { backups: new Map() };
    await expect(withTextFileMutation(
      filePath,
      'edit',
      { path: filePath },
      ctx,
      async (snapshot) => {
        await fs.writeFile(filePath, 'peer-change', 'utf8');
        await writeTextFileForMutation(snapshot, 'after', false, ctx);
      },
    ))
      .rejects.toThrow('File changed during mutation');
    await expect(fs.readFile(filePath, 'utf8')).resolves.toBe('peer-change');
  });

  it('rejects an equal-content replacement with a different file identity', async () => {
    const filePath = path.join(root, 'target.txt');
    const replacement = path.join(root, 'replacement.txt');
    await fs.writeFile(filePath, 'same-content', 'utf8');
    const ctx: KodaXToolExecutionContext = { backups: new Map() };
    await expect(withTextFileMutation(
      filePath,
      'edit',
      { path: filePath },
      ctx,
      async (snapshot) => {
        await fs.writeFile(replacement, 'same-content', 'utf8');
        await fs.rm(filePath);
        await fs.rename(replacement, filePath);
        await writeTextFileForMutation(snapshot, 'must-not-write', false, ctx);
      },
    ))
      .rejects.toThrow('File changed during mutation');
    await expect(fs.readFile(filePath, 'utf8')).resolves.toBe('same-content');
  });

  it('bypasses a live shell lease only after a sandbox snapshot is acquired', async () => {
    const releaseShell = await acquireFileSystemMutationLease();
    const filePath = path.join(root, 'target.txt');
    try {
      const sandboxedCtx: KodaXToolExecutionContext = {
        backups: new Map(),
        textFileMutationSandbox: {
          read: async () => ({
            status: 'ok',
            snapshot: {
              state: 'present',
              content: 'before',
              revision: 'r1',
              backupPath: filePath,
            },
          }),
          write: async () => ({ status: 'written' }),
        },
      };
      await expect(withTextFileMutation(
        filePath,
        'edit',
        { path: filePath },
        sandboxedCtx,
        async (snapshot) => snapshot.content,
      )).resolves.toBe('before');

      const unavailableCtx: KodaXToolExecutionContext = {
        backups: new Map(),
        textFileMutationSandbox: {
          read: async () => ({ status: 'unavailable' }),
          write: async () => ({ status: 'unavailable' }),
        },
      };
      await expect(withTextFileMutation(
        filePath,
        'edit',
        { path: filePath },
        unavailableCtx,
        async () => 'unsafe',
      )).rejects.toThrow('Runtime sandboxed file mutation is unavailable');

      const uncoveredCtx: KodaXToolExecutionContext = {
        backups: new Map(),
        textFileMutationSandbox: {
          canHandlePath: () => false,
          read: async () => ({ status: 'unavailable' }),
          write: async () => ({ status: 'unavailable' }),
        },
      };
      await expect(withTextFileMutation(
        filePath,
        'edit',
        { path: filePath },
        uncoveredCtx,
        async () => 'unsafe',
      )).rejects.toThrow('filesystem effect is already active');

      await expect(withTextFileMutation(
        filePath,
        'edit',
        { path: filePath },
        { backups: new Map() },
        async () => 'unsafe',
      )).rejects.toThrow('filesystem effect is already active');
    } finally {
      await releaseShell();
    }
  });

  it('preserves an older undo record when a sandbox commit fails ambiguously', async () => {
    const filePath = path.join(root, 'target.txt');
    const backups = new Map([[filePath, 'oldest']]);
    const ctx: KodaXToolExecutionContext = {
      backups,
      textFileMutationSandbox: {
        read: async () => ({
          status: 'ok',
          snapshot: {
            state: 'present',
            content: 'before',
            revision: 'r1',
            backupPath: filePath,
          },
        }),
        write: async () => { throw new Error('ambiguous cleanup failure'); },
      },
    };

    await expect(withTextFileMutation(
      filePath,
      'edit',
      { path: filePath },
      ctx,
      async (snapshot) => writeTextFileForMutation(snapshot, 'after', false, ctx, 'before'),
    )).rejects.toThrow('ambiguous cleanup failure');
    expect(backups.get(filePath)).toBe('oldest');
  });

  it('does not reorder older backups after a definite sandbox conflict', async () => {
    const firstPath = path.join(root, 'first.txt');
    const latestPath = path.join(root, 'latest.txt');
    const backups = new Map([
      [firstPath, 'first-before'],
      [latestPath, 'latest-before'],
    ]);
    const ctx: KodaXToolExecutionContext = {
      backups,
      textFileMutationSandbox: {
        read: async () => ({
          status: 'ok',
          snapshot: {
            state: 'present',
            content: 'first-current',
            revision: 'r1',
            backupPath: firstPath,
          },
        }),
        write: async () => ({ status: 'conflict' }),
      },
    };

    await expect(withTextFileMutation(
      firstPath,
      'edit',
      { path: firstPath },
      ctx,
      async (snapshot) => writeTextFileForMutation(
        snapshot,
        'first-after',
        false,
        ctx,
        'first-current',
      ),
    )).rejects.toThrow('File changed during mutation');
    expect([...backups.keys()]).toEqual([firstPath, latestPath]);
  });
});
