import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { KodaXToolExecutionContext } from '../types.js';
import { generateDiff, countChanges } from './diff.js';
import { resolveExecutionPath } from '../runtime-paths.js';
import { formatDiffPreview } from './truncate.js';

const FILE_BACKUPS = new Map<string, string>();

export function getFileBackups(): Map<string, string> {
  return FILE_BACKUPS;
}

export async function toolWrite(input: Record<string, unknown>, ctx: KodaXToolExecutionContext): Promise<string> {
  const filePath = resolveExecutionPath(input.path as string, ctx);
  const content = input.content as string;

  let oldContent = '';
  const isNewFile = !fsSync.existsSync(filePath);

  if (!isNewFile) {
    oldContent = await fs.readFile(filePath, 'utf-8');
    ctx.backups.set(filePath, oldContent);
    FILE_BACKUPS.set(filePath, oldContent);
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf-8');

  const diff = generateDiff(oldContent, content, filePath);
  const changes = countChanges(diff);

  if (isNewFile) {
    const lineCount = content.split('\n').length;
    return `File created: ${filePath}\n  (${lineCount} lines written)`;
  }

  if (diff) {
    const preview = await formatDiffPreview({ diff, toolName: 'write', filePath, ctx });
    return `File updated: ${filePath}\n  (+${changes.added} lines, -${changes.removed} lines)\n\n${preview}`;
  }

  return `File written: ${filePath} (no changes)`;
}
