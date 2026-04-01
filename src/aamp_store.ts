import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AampTaskRecord, AampTaskStore } from './aamp_types.js';

const DEFAULT_AAMP_STATE_DIR = path.join(os.homedir(), '.kodax', 'aamp');

interface PersistedAampTaskStoreState {
  records: Record<string, AampTaskRecord>;
}

function createDefaultState(): PersistedAampTaskStoreState {
  return { records: {} };
}

function cloneRecord(record: AampTaskRecord): AampTaskRecord {
  return {
    ...record,
    ...(record.dispatchContext ? { dispatchContext: { ...record.dispatchContext } } : {}),
  };
}

export class FileAampTaskStore implements AampTaskStore {
  private readonly filePath: string;

  constructor(filePath = path.join(DEFAULT_AAMP_STATE_DIR, 'tasks.json')) {
    this.filePath = filePath;
  }

  async get(taskId: string): Promise<AampTaskRecord | null> {
    const state = await this.readState();
    const record = state.records[taskId];
    return record ? cloneRecord(record) : null;
  }

  async put(record: AampTaskRecord): Promise<void> {
    const state = await this.readState();
    state.records[record.aampTaskId] = cloneRecord(record);
    await this.writeState(state);
  }

  async update(taskId: string, patch: Partial<AampTaskRecord>): Promise<AampTaskRecord> {
    const state = await this.readState();
    const existing = state.records[taskId];
    if (!existing) {
      throw new Error(`AAMP task not found: ${taskId}`);
    }

    const next: AampTaskRecord = {
      ...existing,
      ...patch,
      aampTaskId: existing.aampTaskId,
      updatedAt: patch.updatedAt ?? new Date().toISOString(),
      dispatchContext: patch.dispatchContext
        ? { ...patch.dispatchContext }
        : existing.dispatchContext
          ? { ...existing.dispatchContext }
          : undefined,
    };

    state.records[taskId] = next;
    await this.writeState(state);
    return cloneRecord(next);
  }

  private async readState(): Promise<PersistedAampTaskStoreState> {
    try {
      const content = await fs.readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(content);
      if (!parsed || typeof parsed !== 'object' || !('records' in parsed)) {
        return createDefaultState();
      }

      const records = (parsed as PersistedAampTaskStoreState).records;
      return {
        records: records && typeof records === 'object' ? records : {},
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return createDefaultState();
      }
      throw error;
    }
  }

  private async writeState(state: PersistedAampTaskStoreState): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });

    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fs.writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
      await fs.rename(tempPath, this.filePath);
    } finally {
      if (fsSync.existsSync(tempPath)) {
        await fs.unlink(tempPath).catch(() => undefined);
      }
    }
  }
}
