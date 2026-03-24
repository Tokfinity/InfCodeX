import fs from 'fs/promises';
import fsSync from 'fs';
import { KodaXToolExecutionContext } from '../types.js';
import { getFileBackups } from './write.js';
import { generateDiff, countChanges } from './diff.js';
import { resolveExecutionPath } from '../runtime-paths.js';
import { formatDiffPreview } from './truncate.js';

export async function toolEdit(input: Record<string, unknown>, ctx: KodaXToolExecutionContext): Promise<string> {
  const filePath = resolveExecutionPath(input.path as string, ctx);
  if (!fsSync.existsSync(filePath)) return `[Tool Error] File not found: ${filePath}`;

  const oldStr = input.old_string as string;
  const newStr = input.new_string as string;
  const replaceAll = input.replace_all as boolean;

  const content = await fs.readFile(filePath, 'utf-8');
  ctx.backups.set(filePath, content);
  getFileBackups().set(filePath, content);

  if (!content.includes(oldStr)) return `[Tool Error] old_string not found`;

  const count = content.split(oldStr).length - 1;
  if (count > 1 && !replaceAll) return `[Tool Error] old_string appears ${count} times. Use replace_all=true`;

  const newContent = replaceAll ? content.split(oldStr).join(newStr) : content.replace(oldStr, newStr);
  await fs.writeFile(filePath, newContent, 'utf-8');

  const diff = generateDiff(content, newContent, filePath);
  const changes = countChanges(diff);

  let result = `File edited: ${filePath}`;

  if (replaceAll && count > 1) {
    result += ` (${count} replacements)`;
  }

  result += `\n  (+${changes.added} lines, -${changes.removed} lines)`;

  const oldStrPreview = oldStr.length > 100 ? oldStr.slice(0, 100) + '...' : oldStr;
  const newStrPreview = newStr.length > 100 ? newStr.slice(0, 100) + '...' : newStr;

  if (!oldStr.includes('\n') && !newStr.includes('\n')) {
    result += `\n\n- ${oldStrPreview}\n+ ${newStrPreview}`;
  } else if (diff) {
    const preview = await formatDiffPreview({ diff, toolName: 'edit', filePath, ctx });
    result += `\n\n${preview}`;
  }

  return result;
}
