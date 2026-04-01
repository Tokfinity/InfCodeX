import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileAampTaskStore } from '../src/aamp_store.js';

describe('FileAampTaskStore', () => {
  let tempDir: string;
  let storePath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-aamp-store-'));
    storePath = path.join(tempDir, 'tasks.json');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('persists and updates AAMP task records', async () => {
    const store = new FileAampTaskStore(storePath);
    const now = new Date().toISOString();

    await store.put({
      aampTaskId: 'task-1',
      sessionId: 'session-1',
      status: 'received',
      senderEmail: 'agent@example.com',
      dispatchContext: { project_key: 'proj_1' },
      createdAt: now,
      updatedAt: now,
    });

    expect(await store.get('task-1')).toMatchObject({
      aampTaskId: 'task-1',
      sessionId: 'session-1',
      status: 'received',
      senderEmail: 'agent@example.com',
      dispatchContext: { project_key: 'proj_1' },
    });

    const updated = await store.update('task-1', {
      status: 'completed',
      resultSummary: 'done',
    });

    expect(updated).toMatchObject({
      status: 'completed',
      resultSummary: 'done',
    });

    const reloaded = new FileAampTaskStore(storePath);
    expect(await reloaded.get('task-1')).toMatchObject({
      status: 'completed',
      resultSummary: 'done',
    });
  });
});
