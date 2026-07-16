import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { A2AFileTaskStore, type A2AServerTaskRecord } from './task-store.js';

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('A2AFileTaskStore durability and lock ownership', () => {
  it('does not steal a lock when the owner probe is denied', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-a2a-lock-'));
    roots.push(root);
    const lock = path.join(root, '.server.lock');
    fs.writeFileSync(lock, '42\n', 'utf8');
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const error = new Error('operation not permitted') as NodeJS.ErrnoException;
      error.code = 'EPERM';
      throw error;
    });

    expect(() => new A2AFileTaskStore(root)).toThrow(/already owned/i);
    expect(fs.readFileSync(lock, 'utf8')).toBe('42\n');
  });

  it('rolls back an in-memory task when durable persistence fails', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-a2a-persist-'));
    roots.push(root);
    const store = new A2AFileTaskStore(root);
    const timestamp = '2026-07-17T00:00:00.000Z';
    const message = {
      messageId: 'persist-failure-message', contextId: 'persist-failure-context',
      role: 'ROLE_USER' as const, parts: [{ text: 'persist' }],
    };
    const record: A2AServerTaskRecord = {
      taskId: 'persist-failure-task',
      contextId: message.contextId,
      principalKey: 'principal-key',
      runtimeIdentity: 'runtime',
      sessionId: 'session',
      messageDigests: { [message.messageId]: 'digest' },
      runIds: [],
      task: {
        id: 'persist-failure-task', contextId: message.contextId,
        status: { state: 'TASK_STATE_SUBMITTED', timestamp },
        history: [message],
      },
      history: [message],
      createdAt: timestamp,
      updatedAt: timestamp,
      eventSeq: 0,
      lastRuntimeEventSeq: 0,
      runtimeEventCount: 0,
      runtimeEventBytes: 0,
    };
    fs.mkdirSync(path.join(root, 'tasks.json'));
    try {
      expect(() => store.save(record)).toThrow();
      expect(store.all()).toEqual([]);
    } finally {
      store.close();
    }
  });
});
