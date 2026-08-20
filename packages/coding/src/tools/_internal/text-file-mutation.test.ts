import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { KodaXToolExecutionContext } from '../../types.js';
import { toolUndo } from '../undo.js';
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

  it.runIf(process.platform === 'win32')(
    'accepts a differently-cased spelling of an unaliased host path',
    async () => {
      const filePath = path.join(root, 'case-target.txt');
      await fs.writeFile(filePath, 'before', 'utf8');
      const spellingVariant = filePath.toUpperCase();
      const ctx: KodaXToolExecutionContext = {
        backups: new Map(),
        textFileMutationSandbox: {
          canHandlePath: () => false,
          read: async () => ({ status: 'unavailable' }),
          write: async () => ({ status: 'unavailable' }),
        },
      };

      await withTextFileMutation(
        spellingVariant,
        'write',
        { path: spellingVariant },
        ctx,
        async (snapshot) => writeTextFileForMutation(snapshot, 'after', false, ctx),
      );

      await expect(fs.readFile(filePath, 'utf8')).resolves.toBe('after');
    },
  );

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

  it('does not expose a pending alias backup to concurrent undo', async () => {
    const alias = path.join(root, 'pending-alias.txt');
    const canonicalTarget = path.join(root, 'pending-canonical.txt');
    let releaseWrite: (() => void) | undefined;
    const writeBlocked = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const writeStarted = vi.fn();
    const backups = new Map<string, string>();
    const ctx: KodaXToolExecutionContext = {
      backups,
      textFileMutationSandbox: {
        read: async (request) => ({
          status: 'ok',
          snapshot: {
            state: 'present',
            content: request.path === alias ? 'before' : 'current',
            revision: request.path,
            backupPath: canonicalTarget,
          },
        }),
        write: async (request) => {
          if (request.path === alias) {
            writeStarted();
            await writeBlocked;
          }
          return { status: 'written' };
        },
      },
    };
    const edit = withTextFileMutation(
      alias,
      'edit',
      { path: alias },
      ctx,
      async (snapshot) => writeTextFileForMutation(
        snapshot,
        'after',
        false,
        ctx,
        'before',
      ),
    );
    await vi.waitFor(() => expect(writeStarted).toHaveBeenCalledOnce());

    await expect(toolUndo({}, ctx)).resolves.toBe('No backups available. Nothing to undo.');
    releaseWrite?.();
    await expect(edit).resolves.toBeUndefined();
    expect(backups.get(canonicalTarget)).toBe('before');
  });

  it('serializes different lexical aliases by their sandbox-bound canonical identity', async () => {
    const firstAlias = path.join(root, 'fifo-first-alias.txt');
    const secondAlias = path.join(root, 'fifo-second-alias.txt');
    const canonicalTarget = path.join(root, 'fifo-canonical.txt');
    let releaseFirstWrite: (() => void) | undefined;
    const firstWriteBlocked = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    let writeCalls = 0;
    const writeStarted = vi.fn();
    const read = vi.fn(async (request: { readonly path: string }) => ({
      status: 'ok' as const,
      snapshot: {
        state: 'present' as const,
        content: `${request.path}-before`,
        revision: request.path,
        backupPath: canonicalTarget,
      },
    }));
    const ctx: KodaXToolExecutionContext = {
      backups: new Map(),
      textFileMutationSandbox: {
        read,
        write: async () => {
          writeCalls += 1;
          writeStarted();
          if (writeCalls === 1) await firstWriteBlocked;
          return { status: 'written' };
        },
      },
    };
    const mutate = (filePath: string) => withTextFileMutation(
      filePath,
      'edit',
      { path: filePath },
      ctx,
      async (snapshot) => writeTextFileForMutation(
        snapshot,
        `${filePath}-after`,
        false,
        ctx,
        `${filePath}-before`,
      ),
    );

    const first = mutate(firstAlias);
    const second = mutate(secondAlias);
    await vi.waitFor(() => expect(read.mock.calls.length).toBeGreaterThanOrEqual(2));
    await vi.waitFor(() => expect(writeStarted).toHaveBeenCalled());
    await new Promise<void>((resolve) => setImmediate(resolve));
    const callsBeforeRelease = writeStarted.mock.calls.length;
    releaseFirstWrite?.();
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);

    expect(callsBeforeRelease).toBe(1);
    expect(writeStarted).toHaveBeenCalledTimes(2);
  });

  it('refreshes an alias snapshot after entering the canonical queue', async () => {
    const firstAlias = path.join(root, 'refresh-first-alias.txt');
    const secondAlias = path.join(root, 'refresh-second-alias.txt');
    const canonicalTarget = path.join(root, 'refresh-canonical.txt');
    const initialReaders = new Set<string>();
    let releaseInitialReads: (() => void) | undefined;
    const initialReadsReady = new Promise<void>((resolve) => {
      releaseInitialReads = resolve;
    });
    let releaseFirstWrite: (() => void) | undefined;
    const firstWriteBlocked = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    let content = 'before';
    let revision = 'r0';
    let writes = 0;
    const ctx: KodaXToolExecutionContext = {
      backups: new Map(),
      textFileMutationSandbox: {
        read: async (request) => {
          if (!initialReaders.has(request.path)) {
            initialReaders.add(request.path);
            if (initialReaders.size === 2) releaseInitialReads?.();
            await initialReadsReady;
          }
          return {
            status: 'ok',
            snapshot: {
              state: 'present',
              content,
              revision,
              backupPath: canonicalTarget,
            },
          };
        },
        write: async (request) => {
          writes += 1;
          if (writes === 1) await firstWriteBlocked;
          if (request.expectedRevision !== revision) return { status: 'conflict' };
          content = request.content;
          revision = `r${writes}`;
          return { status: 'written' };
        },
      },
    };
    const mutate = (filePath: string) => withTextFileMutation(
      filePath,
      'edit',
      { path: filePath },
      ctx,
      async (snapshot) => writeTextFileForMutation(
        snapshot,
        `${snapshot.content}|${path.basename(filePath)}`,
        false,
        ctx,
        snapshot.content,
      ),
    );

    const first = mutate(firstAlias);
    const second = mutate(secondAlias);
    await vi.waitFor(() => expect(writes).toBe(1));
    releaseFirstWrite?.();
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);

    expect(content).toContain(path.basename(firstAlias));
    expect(content).toContain(path.basename(secondAlias));
  });

  it('undo reads the latest backup after waiting for a canonical alias edit', async () => {
    const alias = path.join(root, 'undo-latest-alias.txt');
    const canonicalTarget = path.join(root, 'undo-latest-canonical.txt');
    let releaseEditWrite: (() => void) | undefined;
    const editWriteBlocked = new Promise<void>((resolve) => {
      releaseEditWrite = resolve;
    });
    const editWriteStarted = vi.fn();
    let content = 'before-edit';
    let revision = 'r0';
    const backups = new Map([[canonicalTarget, 'old-backup']]);
    const ctx: KodaXToolExecutionContext = {
      backups,
      textFileMutationSandbox: {
        read: async () => ({
          status: 'ok',
          snapshot: {
            state: 'present',
            content,
            revision,
            backupPath: canonicalTarget,
          },
        }),
        write: async (request) => {
          if (request.expectedRevision !== revision) return { status: 'conflict' };
          if (request.path === alias) {
            editWriteStarted();
            await editWriteBlocked;
          }
          content = request.content;
          revision = request.path === alias ? 'r1' : 'r2';
          return { status: 'written' };
        },
      },
    };
    const edit = withTextFileMutation(
      alias,
      'edit',
      { path: alias },
      ctx,
      async (snapshot) => writeTextFileForMutation(
        snapshot,
        'after-edit',
        false,
        ctx,
        snapshot.content,
      ),
    );
    await vi.waitFor(() => expect(editWriteStarted).toHaveBeenCalledOnce());

    const undo = toolUndo({}, ctx);
    releaseEditWrite?.();
    await expect(Promise.all([edit, undo])).resolves.toEqual([undefined, `Restored: ${canonicalTarget}`]);

    expect(content).toBe('before-edit');
    expect(backups.has(canonicalTarget)).toBe(false);
  });
});
