/**
 * KodaX Undo Tool
 *
 * 撤销工具 - 恢复最后一次文件修改
 */

import { KodaXToolExecutionContext } from '../types.js';
import {
  canonicalizeAgentHomePolicyPath,
} from '../permissions/agent-home-policy.js';
import { normalizePathForKey } from './_internal/file-mutation-queue.js';
import { withTextFileMutation, writeTextFileForMutation } from './_internal/text-file-mutation.js';

export async function toolUndo(_input: Record<string, unknown>, ctx: KodaXToolExecutionContext): Promise<string> {
  const backups = ctx.backups;
  if (backups.size > 0) {
    const entries = [...backups.entries()];
    const [filePath, content] = entries[entries.length - 1]!;
    await withTextFileMutation(filePath, 'undo', _input, ctx, async (snapshot) => {
      const currentIdentity = canonicalizeAgentHomePolicyPath(filePath);
      if (currentIdentity === undefined
        || normalizePathForKey(currentIdentity) !== normalizePathForKey(filePath)) {
        throw new Error(`Backup path identity changed: ${filePath}`);
      }
      await writeTextFileForMutation(snapshot, content, false, ctx);
      backups.delete(filePath);
    });
    return `Restored: ${filePath}`;
  }
  return 'No backups available. Nothing to undo.';
}
