/**
 * KodaX session storage - filesystem implementation.
 */

import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import chalk from 'chalk';
import type {
  KodaXExtensionSessionRecord,
  KodaXMessage,
  KodaXSessionMeta,
  KodaXSessionStorage,
} from '@kodax/coding';
import { cleanupIncompleteToolCalls } from '@kodax/coding';
import type { SessionData, SessionErrorMetadata } from '../ui/utils/session-storage.js';
import { getGitRoot, KODAX_SESSIONS_DIR } from '../common/utils.js';
import {
  isKodaXExtensionSessionRecord,
  isKodaXExtensionSessionState,
  isKodaXMessage,
  isRecord,
  isSessionErrorMetadata,
} from './json-guards.js';

interface PersistedExtensionRecordLine extends KodaXExtensionSessionRecord {
  _type: 'extension_record';
}

function warnMalformedSessionData(filePath: string, count: number): void {
  if (count === 0 || process.env.NODE_ENV === 'test') {
    return;
  }

  console.warn(`[KodaX] Skipped ${count} malformed session record(s) from ${path.basename(filePath)}.`);
}

function toExtensionRecordLine(
  record: KodaXExtensionSessionRecord,
): PersistedExtensionRecordLine {
  return {
    _type: 'extension_record',
    ...record,
  };
}

function isPersistedExtensionRecordLine(
  value: unknown,
): value is PersistedExtensionRecordLine {
  return isRecord(value)
    && value._type === 'extension_record'
    && isKodaXExtensionSessionRecord(value);
}

function createSessionMeta(id: string, data: SessionData): KodaXSessionMeta {
  return {
    _type: 'meta',
    title: data.title,
    id,
    gitRoot: data.gitRoot,
    createdAt: new Date().toISOString(),
    errorMetadata: data.errorMetadata,
    extensionState: data.extensionState,
    extensionRecordCount: data.extensionRecords?.length ?? 0,
  };
}

export class FileSessionStorage implements KodaXSessionStorage {
  async save(id: string, data: SessionData): Promise<void> {
    await fs.mkdir(KODAX_SESSIONS_DIR, { recursive: true });

    const meta = createSessionMeta(id, data);
    const messageLines = data.messages.map((message) => JSON.stringify(message));
    const extensionRecordLines = (data.extensionRecords ?? [])
      .map((record) => JSON.stringify(toExtensionRecordLine(record)));
    const lines = [JSON.stringify(meta), ...messageLines, ...extensionRecordLines];

    await fs.writeFile(
      path.join(KODAX_SESSIONS_DIR, `${id}.jsonl`),
      lines.join('\n'),
      'utf-8',
    );
  }

  async load(id: string): Promise<SessionData | null> {
    const filePath = path.join(KODAX_SESSIONS_DIR, `${id}.jsonl`);
    if (!fsSync.existsSync(filePath)) {
      return null;
    }

    const rawContent = await fs.readFile(filePath, 'utf-8');
    const trimmedContent = rawContent.trim();
    if (!trimmedContent) {
      return null;
    }

    const lines = trimmedContent.split('\n');
    const messages: KodaXMessage[] = [];
    const extensionRecords: KodaXExtensionSessionRecord[] = [];
    let title = '';
    let gitRoot = '';
    let errorMetadata: SessionErrorMetadata | undefined;
    let extensionState: SessionData['extensionState'];
    let malformedCount = 0;

    for (let i = 0; i < lines.length; i++) {
      try {
        const data = JSON.parse(lines[i]!);
        if (i === 0 && isRecord(data) && data._type === 'meta') {
          title = typeof data.title === 'string' ? data.title : '';
          gitRoot = typeof data.gitRoot === 'string' ? data.gitRoot : '';
          errorMetadata = isSessionErrorMetadata(data.errorMetadata) ? data.errorMetadata : undefined;
          extensionState = isKodaXExtensionSessionState(data.extensionState)
            ? data.extensionState
            : undefined;
          continue;
        }

        if (isPersistedExtensionRecordLine(data)) {
          extensionRecords.push({
            id: data.id,
            extensionId: data.extensionId,
            type: data.type,
            ts: data.ts,
            data: data.data,
            dedupeKey: data.dedupeKey,
          });
          continue;
        }

        if (isKodaXMessage(data)) {
          messages.push(data);
        } else {
          malformedCount += 1;
        }
      } catch {
        malformedCount += 1;
      }
    }

    warnMalformedSessionData(filePath, malformedCount);

    const currentGitRoot = await getGitRoot();
    if (currentGitRoot && gitRoot && currentGitRoot !== gitRoot) {
      console.log(chalk.yellow(`\n[Warning] Session project mismatch:`));
      console.log(`  Current:  ${currentGitRoot}`);
      console.log(`  Session:  ${gitRoot}`);
      console.log(`  Continuing anyway...\n`);
    }

    if (errorMetadata?.consecutiveErrors && errorMetadata.consecutiveErrors > 0) {
      const cleaned = cleanupIncompleteToolCalls(messages);
      if (cleaned !== messages) {
        console.log(chalk.cyan('[Session Recovery] Cleaned incomplete tool calls from previous session'));
        errorMetadata.consecutiveErrors = 0;
        await this.save(id, {
          messages: cleaned,
          title,
          gitRoot,
          errorMetadata,
          extensionState,
          extensionRecords,
        });
        return {
          messages: cleaned,
          title,
          gitRoot,
          errorMetadata,
          extensionState,
          extensionRecords,
        };
      }
    }

    return {
      messages,
      title,
      gitRoot,
      errorMetadata,
      extensionState,
      extensionRecords,
    };
  }

  async list(gitRoot?: string): Promise<Array<{ id: string; title: string; msgCount: number }>> {
    await fs.mkdir(KODAX_SESSIONS_DIR, { recursive: true });
    const currentGitRoot = gitRoot ?? await getGitRoot();
    const files = (await fs.readdir(KODAX_SESSIONS_DIR)).filter((file) => file.endsWith('.jsonl'));
    const sessions: Array<{ id: string; title: string; msgCount: number }> = [];

    for (const file of files) {
      try {
        const content = (await fs.readFile(path.join(KODAX_SESSIONS_DIR, file), 'utf-8')).trim();
        const firstLine = content.split('\n')[0];
        if (!firstLine) {
          continue;
        }

        const first = JSON.parse(firstLine);
        if (isRecord(first) && first._type === 'meta') {
          const sessionGitRoot = typeof first.gitRoot === 'string' ? first.gitRoot : '';
          if (currentGitRoot) {
            if (!sessionGitRoot || sessionGitRoot !== currentGitRoot) {
              continue;
            }
          }

          const lineCount = content.split('\n').length;
          const extensionRecordCount =
            typeof first.extensionRecordCount === 'number' && first.extensionRecordCount > 0
              ? first.extensionRecordCount
              : 0;
          sessions.push({
            id: file.replace('.jsonl', ''),
            title: typeof first.title === 'string' ? first.title : '',
            msgCount: Math.max(0, lineCount - 1 - extensionRecordCount),
          });
        } else {
          const lineCount = content.split('\n').length;
          sessions.push({ id: file.replace('.jsonl', ''), title: '', msgCount: lineCount });
        }
      } catch {
        continue;
      }
    }

    return sessions.sort((left, right) => right.id.localeCompare(left.id)).slice(0, 10);
  }

  async delete(id: string): Promise<void> {
    const filePath = path.join(KODAX_SESSIONS_DIR, `${id}.jsonl`);
    if (fsSync.existsSync(filePath)) {
      await fs.unlink(filePath);
    }
  }

  async deleteAll(gitRoot?: string): Promise<void> {
    const currentGitRoot = gitRoot ?? await getGitRoot();
    const sessions = await this.list(currentGitRoot ?? undefined);
    for (const session of sessions) {
      await this.delete(session.id);
    }
  }
}
