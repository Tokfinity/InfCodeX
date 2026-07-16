import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { resolveToolOutputDir } from './truncate.js';

export const BASH_CAPTURE_SPOOL_THRESHOLD_BYTES = 512 * 1024;
export const BASH_CAPTURE_INCOMPLETE_MARKER = 'KODAX_CAPTURE_INCOMPLETE';
export const BASH_CAPTURE_COMPLETE_MARKER = 'KODAX_CAPTURE_COMPLETE';

export interface BashOutputCollector {
  chunks: Buffer[];
  memoryBytes: number;
  totalBytes: number;
  spoolPath?: string;
  spoolFd?: number;
  spoolDisabled: boolean;
  preserveSpoolOnDispose: boolean;
  closed: boolean;
  finalBuffer?: Buffer;
}

export function createBashOutputCollector(): BashOutputCollector {
  return {
    chunks: [],
    memoryBytes: 0,
    totalBytes: 0,
    spoolDisabled: false,
    preserveSpoolOnDispose: false,
    closed: false,
  };
}

function createSpoolPath(): string {
  const suffix = Math.random().toString(36).slice(2, 10);
  const outputDir = resolveToolOutputDir();
  mkdirSync(outputDir, { recursive: true });
  return join(outputDir, `kodax-bash-${process.pid}-${Date.now()}-${suffix}.txt`);
}

function writeBuffer(fd: number, buffer: Buffer): number {
  let offset = 0;
  try {
    while (offset < buffer.length) {
      const written = writeSync(fd, buffer, offset, buffer.length - offset);
      if (written === 0) break;
      offset += written;
    }
  } catch {
    // The unwritten suffix remains in memory, so a spool failure never drops output.
  }
  return offset;
}

function closeSpool(collector: BashOutputCollector): void {
  if (collector.spoolFd === undefined) return;
  try {
    closeSync(collector.spoolFd);
  } catch {
    // Best-effort cleanup after all successfully written bytes are already on disk.
  }
  collector.spoolFd = undefined;
}

function tryStartSpool(collector: BashOutputCollector): void {
  let spoolPath: string | undefined;
  let fd: number | undefined;
  try {
    spoolPath = createSpoolPath();
    fd = openSync(spoolPath, 'wx', 0o600);
    for (const chunk of collector.chunks) {
      if (writeBuffer(fd, chunk) !== chunk.length) {
        throw new Error('Could not write complete Bash output chunk to spool');
      }
    }
  } catch {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Best-effort cleanup of an unusable spool.
      }
    }
    try {
      if (spoolPath) unlinkSync(spoolPath);
    } catch {
      // The file may not have been created; memory capture remains complete.
    }
    collector.spoolDisabled = true;
    return;
  }

  collector.spoolPath = spoolPath;
  collector.spoolFd = fd;
  collector.chunks = [];
  collector.memoryBytes = 0;
}

export function appendBashOutputChunk(collector: BashOutputCollector, chunk: Buffer): void {
  if (collector.closed) return;
  const copy = Buffer.from(chunk);
  collector.totalBytes += copy.length;

  if (collector.spoolFd !== undefined) {
    const written = writeBuffer(collector.spoolFd, copy);
    if (written === copy.length) return;
    closeSpool(collector);
    collector.spoolDisabled = true;
    const suffix = copy.subarray(written);
    collector.chunks.push(suffix);
    collector.memoryBytes += suffix.length;
    return;
  }

  collector.chunks.push(copy);
  collector.memoryBytes += copy.length;
  if (!collector.spoolDisabled && collector.memoryBytes > BASH_CAPTURE_SPOOL_THRESHOLD_BYTES) {
    tryStartSpool(collector);
  }
}

/** Promote a live collector to a durable artifact without ending capture. */
export function startBashOutputRecovery(collector: BashOutputCollector): string {
  if (collector.closed) {
    throw new Error('Cannot recover a closed Bash output collector');
  }
  if (collector.spoolFd !== undefined && collector.spoolPath) {
    collector.preserveSpoolOnDispose = true;
    return collector.spoolPath;
  }

  const existingPath = collector.spoolPath;
  const spoolPath = existingPath ?? createSpoolPath();
  const fd = openSync(spoolPath, existingPath ? 'a' : 'wx', 0o600);
  try {
    for (const chunk of collector.chunks) {
      if (writeBuffer(fd, chunk) !== chunk.length) {
        throw new Error('Could not persist complete Bash recovery output');
      }
    }
  } catch (error) {
    try {
      closeSync(fd);
    } catch {
      // Preserve the primary persistence failure below.
    }
    if (!existingPath) {
      try {
        unlinkSync(spoolPath);
      } catch {
        // The incomplete artifact is not returned to the caller.
      }
    }
    throw error;
  }

  collector.spoolPath = spoolPath;
  collector.spoolFd = fd;
  collector.spoolDisabled = false;
  collector.preserveSpoolOnDispose = true;
  collector.chunks = [];
  collector.memoryBytes = 0;
  return spoolPath;
}

/** Seal a recovery artifact only after the child `close` event drains stdio. */
export function finishBashOutputRecovery(collector: BashOutputCollector): boolean {
  let complete = false;
  try {
    startBashOutputRecovery(collector);
    const marker = Buffer.from(`\n[${BASH_CAPTURE_COMPLETE_MARKER}]\n`, 'utf-8');
    complete = collector.spoolFd !== undefined
      && writeBuffer(collector.spoolFd, marker) === marker.length;
  } catch {
    complete = false;
  }
  collector.closed = true;
  closeSpool(collector);
  collector.chunks = [];
  collector.memoryBytes = 0;
  return complete;
}

function removeSpoolFile(collector: BashOutputCollector): void {
  if (!collector.spoolPath) return;
  try {
    unlinkSync(collector.spoolPath);
  } catch {
    // Best-effort temporary-file cleanup; captured bytes have already been read.
  }
  collector.spoolPath = undefined;
}

export function finishBashOutputCollector(collector: BashOutputCollector): Buffer {
  if (collector.finalBuffer) return collector.finalBuffer;
  collector.closed = true;
  closeSpool(collector);

  let spooled = Buffer.alloc(0);
  if (collector.spoolPath) {
    try {
      spooled = readFileSync(collector.spoolPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const suffix = Buffer.concat(collector.chunks);
      const notice = Buffer.from(
        `[${BASH_CAPTURE_INCOMPLETE_MARKER}] Bash output spool could not be read.\n`
        + `Spool recovery path (if still present): ${collector.spoolPath}\n`
        + `Read error: ${message}\n`
        + (suffix.length > 0 ? 'In-memory suffix follows:\n' : ''),
        'utf-8',
      );
      collector.preserveSpoolOnDispose = true;
      collector.chunks = [];
      collector.memoryBytes = 0;
      collector.finalBuffer = Buffer.concat([notice, suffix]);
      return collector.finalBuffer;
    }
  }
  const finalBuffer = collector.chunks.length === 0
    ? spooled
    : Buffer.concat([spooled, ...collector.chunks]);
  removeSpoolFile(collector);
  collector.chunks = [];
  collector.memoryBytes = 0;
  collector.finalBuffer = finalBuffer;
  return finalBuffer;
}

export function disposeBashOutputCollector(collector: BashOutputCollector): void {
  collector.closed = true;
  closeSpool(collector);
  if (collector.preserveSpoolOnDispose) {
    collector.spoolPath = undefined;
  } else {
    removeSpoolFile(collector);
  }
  collector.chunks = [];
  collector.memoryBytes = 0;
  collector.finalBuffer = undefined;
}
