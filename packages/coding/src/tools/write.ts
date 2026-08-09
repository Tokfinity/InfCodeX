import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { KodaXToolExecutionContext } from '../types.js';
import { generateDiff, countChanges } from './diff.js';
import { resolveExecutionPath } from '../runtime-paths.js';
import { memoryMutationDenial } from './memory-mutation-guard.js';
import { formatDiffPreview } from './truncate.js';
import { recordFileBackup, withFileMutation } from './_internal/file-mutation-queue.js';
import { buildStaleWriteReason } from '../multi-instance/content-hash-cache.js';
import { formatActiveFileWarning } from '../multi-instance/active-file-warning.js';
import { appendLspDiagnostics } from './_internal/lsp-reflux.js';

export async function toolWrite(input: Record<string, unknown>, ctx: KodaXToolExecutionContext): Promise<string> {
  const filePath = resolveExecutionPath(input.path as string, ctx);
  const memoryDenial = memoryMutationDenial(filePath);
  if (memoryDenial !== undefined) return memoryDenial;
  const content = input.content as string;

  // FEATURE_131 Part A: serialize same-file mutations across the
  // process so concurrent children (Pattern B fan-out) can't race
  // the read-modify-write cycle and silently lose one side's changes.
  const result = await withFileMutation(filePath, async () => {
    let oldContent = '';
    const isNewFile = !fsSync.existsSync(filePath);

    // FEATURE_125 v0.7.41 — Layer 4 hard gate: stale-write check. Only
    // applies to existing files (new-file creation has nothing to be
    // stale against). When the LLM read the file earlier in this task
    // and a peer (or the user) has since modified it, refuse the write
    // and tell the LLM to re-read. Returning a `[Tool Error]` text lets
    // the existing tool-error parsing route the message back to the
    // model without exception propagation.
    if (!isNewFile && ctx.contentHashCache) {
      const stale = ctx.contentHashCache.checkStale(filePath);
      if (stale.stale) {
        return `[Tool Error] ${buildStaleWriteReason(filePath, stale)}`;
      }
    }

    if (!isNewFile) {
      oldContent = await fs.readFile(filePath, 'utf-8');
      recordFileBackup(ctx.backups, filePath, oldContent);
    }

    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, 'utf-8');

    // FEATURE_125 v0.7.41 — record post-write hash so the LLM's own
    // subsequent edit on this file doesn't false-alarm against its own
    // changes. Safe to call after the write succeeded; pre-write the
    // hash would still match the OLD content (we just verified stale
    // == false above) so storing the new content's hash here is the
    // honest record.
    ctx.contentHashCache?.recordWrite(filePath, content);
    // FEATURE_177 v0.7.42 — drop the read-state cache so the next Read
    // sees real content. Belt-and-suspenders against same-second
    // mtime collisions on coarse-resolution filesystems.
    ctx.readFileStateCache?.forget(filePath);

    const diff = generateDiff(oldContent, content, filePath);
    const changes = countChanges(diff);

    // FEATURE_125 v0.7.41 — Layer 3 soft warning. If another KodaX
    // session is editing the same path (per the round's sibling
    // snapshot), prepend an informational banner. The write was
    // already applied — the banner just tells the LLM to consider
    // re-reading next round to integrate the peer's work.
    const warningBanner = ctx.siblingSnapshot
      ? formatActiveFileWarning(filePath, ctx.siblingSnapshot)
      : null;

    let body: string;
    if (isNewFile) {
      const lineCount = content.split('\n').length;
      body = `File created: ${filePath}\n  (${lineCount} lines written)`;
    } else if (diff) {
      const preview = await formatDiffPreview({ diff, toolName: 'write', filePath, ctx });
      body = `File updated: ${filePath}\n  (+${changes.added} lines, -${changes.removed} lines)\n\n${preview}`;
    } else {
      body = `File written: ${filePath} (no changes)`;
    }

    return warningBanner ? `${warningBanner}\n\n${body}` : body;
  });

  // FEATURE_132 v0.7.47 — reflux any type errors the language server finds in
  // the just-written file so the agent fixes them this turn. Done OUTSIDE the
  // mutation lock so a concurrent same-file writer isn't blocked during the
  // (up to 5s) diagnostics wait.
  if (result.startsWith('[Tool Error]')) return result;
  return result + (await appendLspDiagnostics(filePath, ctx));
}
