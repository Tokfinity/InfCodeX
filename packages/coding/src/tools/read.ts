import fs from 'fs/promises';
import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import type { KodaXToolExecutionContext } from '../types.js';
import { resolveExecutionPath } from '../runtime-paths.js';
import {
  DEFAULT_TOOL_OUTPUT_MAX_BYTES,
  formatSize,
  READ_DEFAULT_LIMIT,
  READ_MAX_LINE_CHARS,
  READ_PREFLIGHT_SIZE_BYTES,
  READ_TRUNCATED_LINE_SUFFIX,
} from './truncate.js';

const BINARY_SAMPLE_BYTES = 4096;

function buildReadNotes(options: {
  offset: number;
  linesShown: number;
  limit: number;
  totalLines: number;
  hasMoreLines: boolean;
  preflightNote: string;
  truncatedLongLine: boolean;
}): string[] {
  const {
    offset,
    linesShown,
    limit,
    totalLines,
    hasMoreLines,
    preflightNote,
    truncatedLongLine,
  } = options;
  const notes: string[] = [];

  if (preflightNote) {
    notes.push(preflightNote);
  }
  if (truncatedLongLine) {
    notes.push(`[Some long lines were shortened to ${READ_MAX_LINE_CHARS} characters.]`);
  }
  if (hasMoreLines) {
    const nextOffset = offset + linesShown;
    const shownEnd = Math.max(offset, nextOffset - 1);
    notes.push(`[Showing lines ${offset}-${shownEnd}. Use offset=${nextOffset} limit=${limit} to continue.]`);
  } else {
    notes.push(`[End of file${totalLines > 0 ? ` - ${totalLines} lines total` : ''}]`);
  }

  return notes;
}

function renderReadOutput(lines: string[], notes: string[]): string {
  const content = lines.join('\n');
  if (!content) {
    return notes.join('\n');
  }

  return `${content}\n\n${notes.join('\n')}`;
}

async function isProbablyBinary(filePath: string, fileSize: number): Promise<boolean> {
  if (fileSize === 0) {
    return false;
  }

  const handle = await fs.open(filePath, 'r');
  try {
    const sampleSize = Math.min(BINARY_SAMPLE_BYTES, fileSize);
    const sample = Buffer.alloc(sampleSize);
    const { bytesRead } = await handle.read(sample, 0, sampleSize, 0);
    if (bytesRead === 0) {
      return false;
    }

    let nonPrintable = 0;
    for (let index = 0; index < bytesRead; index++) {
      const value = sample[index];
      if (value === 0) {
        return true;
      }
      if (value < 9 || (value > 13 && value < 32)) {
        nonPrintable++;
      }
    }

    return nonPrintable / bytesRead > 0.3;
  } finally {
    await handle.close();
  }
}

export async function toolRead(input: Record<string, unknown>, ctx: KodaXToolExecutionContext): Promise<string> {
  const filePath = resolveExecutionPath(input.path as string, ctx);
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return `[Tool Error] File not found: ${filePath}`;
    }
    const message = error instanceof Error ? error.message : String(error);
    return `[Tool Error] Unable to access file: ${filePath}. ${message}`;
  }

  if (!stat.isFile()) {
    return `[Tool Error] Path is not a file: ${filePath}`;
  }

  if (await isProbablyBinary(filePath, stat.size)) {
    return `[Tool Error] Binary file not supported by read: ${filePath}`;
  }

  const rawOffset = Number.isFinite(input.offset) ? Number(input.offset) : 1;
  const rawLimit = Number.isFinite(input.limit) ? Number(input.limit) : READ_DEFAULT_LIMIT;
  const offset = Math.max(1, Math.floor(rawOffset));
  const limit = Math.max(1, Math.floor(rawLimit));
  const startLine = offset - 1;

  const lines: string[] = [];
  const stream = createReadStream(filePath, { encoding: 'utf-8' });
  const reader = createInterface({
    input: stream,
    crlfDelay: Infinity,
  });

  let totalLines = 0;
  let outputBytes = 0;
  let hasMoreLines = false;
  let truncatedLongLine = false;

  try {
    for await (const rawLine of reader) {
      totalLines++;
      if (totalLines <= startLine) {
        continue;
      }

      if (lines.length >= limit) {
        hasMoreLines = true;
        break;
      }

      const lineNumber = offset + lines.length;
      const displayLine =
        rawLine.length > READ_MAX_LINE_CHARS
          ? `${rawLine.slice(0, READ_MAX_LINE_CHARS)}${READ_TRUNCATED_LINE_SUFFIX}`
          : rawLine;
      truncatedLongLine ||= displayLine !== rawLine;
      const numberedLine = `${lineNumber.toString().padStart(6)}\t${displayLine}`;
      const lineBytes = Buffer.byteLength(numberedLine, 'utf-8') + (lines.length > 0 ? 1 : 0);

      if (outputBytes + lineBytes > DEFAULT_TOOL_OUTPUT_MAX_BYTES) {
        hasMoreLines = true;
        break;
      }

      lines.push(numberedLine);
      outputBytes += lineBytes;
    }
  } finally {
    reader.close();
    stream.destroy();
  }

  if (totalLines < offset && !(totalLines === 0 && offset === 1)) {
    return `[Tool Error] Offset ${offset} is beyond end of file (${totalLines} lines total)`;
  }

  const preflightNote =
    input.limit === undefined && stat.size > READ_PREFLIGHT_SIZE_BYTES
      ? `[Large file: ${formatSize(stat.size)}. Read returns at most ${READ_DEFAULT_LIMIT} lines or ${formatSize(DEFAULT_TOOL_OUTPUT_MAX_BYTES)} per call. Use offset/limit or grep to narrow the scope.]`
      : '';
  let effectiveLines = [...lines];
  let effectiveHasMoreLines = hasMoreLines;

  while (true) {
    const notes = buildReadNotes({
      offset,
      linesShown: effectiveLines.length,
      limit,
      totalLines,
      hasMoreLines: effectiveHasMoreLines,
      preflightNote,
      truncatedLongLine,
    });
    const output = renderReadOutput(effectiveLines, notes);
    if (
      Buffer.byteLength(output, 'utf-8') <= DEFAULT_TOOL_OUTPUT_MAX_BYTES ||
      effectiveLines.length === 0
    ) {
      return output;
    }

    effectiveLines.pop();
    effectiveHasMoreLines = true;
  }
}
