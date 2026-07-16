import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { A2AFileTaskStore } from './task-store.js';

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('A2AFileTaskStore lock ownership', () => {
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
});
