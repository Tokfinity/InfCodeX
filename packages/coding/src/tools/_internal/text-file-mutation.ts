import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import type {
  KodaXTextFileMutationRequest,
  KodaXTextFileSnapshot,
  KodaXToolExecutionContext,
} from '../../types.js';
import {
  recordResolvedFileBackup,
  resolveFileBackupPath,
  withFileMutation,
  withSandboxedFileMutation,
} from './file-mutation-queue.js';

export interface TextFileMutationSnapshot extends KodaXTextFileSnapshot {
  readonly execution: 'host' | 'sandbox';
  readonly request: KodaXTextFileMutationRequest;
}

function revision(content: string, device: bigint, inode: bigint): string {
  return `present:${createHash('sha256')
    .update(device.toString())
    .update(':')
    .update(inode.toString())
    .update('\0')
    .update(content)
    .digest('hex')}`;
}

async function readHostSnapshot(filePath: string): Promise<KodaXTextFileSnapshot> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(filePath, 'r');
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        state: 'missing',
        content: '',
        revision: 'missing',
        backupPath: path.resolve(filePath),
      };
    }
    throw error;
  }
  try {
    const [content, stat] = await Promise.all([
      handle.readFile('utf8'),
      handle.stat({ bigint: true }),
    ]);
    return {
      state: 'present',
      content,
      revision: revision(content, stat.dev, stat.ino),
      backupPath: await fs.realpath(filePath),
    };
  } finally {
    await handle?.close();
  }
}

function pathsIdentifySameLocation(left: string, right: string): boolean {
  return path.relative(path.resolve(left), path.resolve(right)) === '';
}

/**
 * A Runtime path outside the workspace has no ASRT sink. Keep its established
 * host behavior only when the reviewed lexical path is not currently routed
 * through a symlink/junction. This check runs after the direct lease is held.
 */
async function assertUnaliasedHostMutationPath(filePath: string): Promise<void> {
  const target = path.resolve(filePath);
  let candidate = target;
  while (true) {
    try {
      const canonical = await fs.realpath(candidate);
      if (!pathsIdentifySameLocation(candidate, canonical)) {
        throw new Error(`Runtime host mutation target is redirected through a link: ${filePath}`);
      }
      if (candidate === target) {
        const stats = await fs.stat(candidate);
        if (stats.isFile() && stats.nlink > 1) {
          throw new Error(`Runtime host mutation target is a hard link: ${filePath}`);
        }
      }
      return;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(candidate);
      if (parent === candidate) throw error;
      candidate = parent;
    }
  }
}

async function writeFileHandleFully(handle: fs.FileHandle, content: string): Promise<void> {
  const encoded = Buffer.from(content, 'utf8');
  let written = 0;
  while (written < encoded.length) {
    const result = await handle.write(encoded, written, encoded.length - written, written);
    if (result.bytesWritten === 0) throw new Error('Text file mutation write made no progress.');
    written += result.bytesWritten;
  }
  await handle.truncate(encoded.length);
}

function textFileMutationRequest(
  filePath: string,
  toolName: KodaXTextFileMutationRequest['toolName'],
  toolInput: Readonly<Record<string, unknown>>,
  ctx: KodaXToolExecutionContext,
): KodaXTextFileMutationRequest {
  return {
    toolCallId: ctx.toolCallId,
    toolName,
    toolInput,
    path: filePath,
    signal: ctx.abortSignal,
  };
}

/**
 * Keep the path queue around the complete read/transform/write transaction.
 * A real workspace sandbox capability bypasses the global direct lease for
 * paths it covers. Uncovered paths and standalone execution retain the legacy
 * host shell/namespace fence; covered-path sandbox failure is fail-closed.
 */
export function withTextFileMutation<T>(
  filePath: string,
  toolName: KodaXTextFileMutationRequest['toolName'],
  toolInput: Readonly<Record<string, unknown>>,
  ctx: KodaXToolExecutionContext,
  operation: (snapshot: TextFileMutationSnapshot) => Promise<T>,
): Promise<T> {
  const request = textFileMutationRequest(filePath, toolName, toolInput, ctx);
  const sandbox = ctx.textFileMutationSandbox;
  const uncoveredRuntimePath = sandbox?.canHandlePath?.(filePath) === false;
  if (sandbox === undefined || uncoveredRuntimePath) {
    return withFileMutation(filePath, async () => {
      if (uncoveredRuntimePath) await assertUnaliasedHostMutationPath(filePath);
      return operation({
        ...await readHostSnapshot(filePath),
        execution: 'host',
        request,
      });
    });
  }
  return withSandboxedFileMutation(filePath, async () => {
    const sandboxed = await sandbox.read(request);
    if (sandboxed.status === 'ok') {
      return operation({ ...sandboxed.snapshot, execution: 'sandbox', request });
    }
    throw new Error('The Runtime sandboxed file mutation is unavailable.');
  });
}

export async function writeTextFileForMutation(
  snapshot: TextFileMutationSnapshot,
  content: string,
  createParentDirectories: boolean,
  ctx: KodaXToolExecutionContext,
  backupContent?: string,
): Promise<void> {
  const backup = backupContent === undefined
    ? undefined
    : (() => {
        const backupPath = snapshot.execution === 'sandbox'
          ? snapshot.backupPath
          : resolveFileBackupPath(snapshot.request.path);
        return {
          path: backupPath,
          content: backupContent,
          hadPrevious: ctx.backups.has(backupPath),
          previous: ctx.backups.get(backupPath),
        };
      })();
  let backupReserved = false;
  const reserveBackup = (): void => {
    if (backup !== undefined) {
      recordResolvedFileBackup(ctx.backups, backup.path, backup.content);
      backupReserved = true;
    }
  };
  const rollbackBackup = (): void => {
    if (backup === undefined || !backupReserved) return;
    ctx.backups.delete(backup.path);
    if (backup.hadPrevious && backup.previous !== undefined) {
      ctx.backups.set(backup.path, backup.previous);
    }
    backupReserved = false;
  };
  // Preserve an older valid undo record across an ambiguous commit failure.
  // With no prior record, reserve before the sink so a partial write remains
  // recoverable even when cleanup subsequently throws.
  if (backup !== undefined && !backup.hadPrevious) reserveBackup();
  if (snapshot.execution === 'sandbox') {
    const result = await ctx.textFileMutationSandbox?.write({
      ...snapshot.request,
      content,
      createParentDirectories,
      expectedRevision: snapshot.revision,
    });
    if (result?.status === 'written') {
      if (backup?.hadPrevious) reserveBackup();
      return;
    }
    if (result?.status === 'conflict') {
      rollbackBackup();
      throw new Error(`File changed during mutation: ${snapshot.request.path}. Re-read and retry.`);
    }
    rollbackBackup();
    throw new Error('The sandboxed file mutation became unavailable before commit.');
  }

  if (createParentDirectories) {
    await fs.mkdir(path.dirname(snapshot.request.path), { recursive: true });
  }
  let handle: fs.FileHandle | undefined;
  let commitStarted = false;
  try {
    if (snapshot.state === 'missing') {
      handle = await fs.open(snapshot.request.path, 'wx');
    } else {
      handle = await fs.open(snapshot.request.path, 'r+');
      const [currentContent, stat] = await Promise.all([
        handle.readFile('utf8'),
        handle.stat({ bigint: true }),
      ]);
      if (revision(currentContent, stat.dev, stat.ino) !== snapshot.revision) {
        throw new Error(`File changed during mutation: ${snapshot.request.path}. Re-read and retry.`);
      }
    }
    commitStarted = true;
    await writeFileHandleFully(handle, content);
    if (backup?.hadPrevious) reserveBackup();
  } catch (error: unknown) {
    if (!commitStarted) rollbackBackup();
    if (snapshot.state === 'missing' && (error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`File changed during mutation: ${snapshot.request.path}. Re-read and retry.`);
    }
    throw error;
  } finally {
    await handle?.close();
  }
}
