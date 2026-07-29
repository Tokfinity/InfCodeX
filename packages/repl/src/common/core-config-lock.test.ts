import {
  closeSync,
  mkdtempSync,
  openSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CoreConfigWriteConflictError,
  coreConfigWriteLockPath,
  withCoreConfigWriteLock,
} from './core-config-lock.js';

describe('withCoreConfigWriteLock', () => {
  it('serializes cooperating core-config writers and releases the lock', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'kodax-core-lock-'));
    const configPath = path.join(home, 'config.json');
    const lockPath = coreConfigWriteLockPath(configPath);
    const lock = openSync(lockPath, 'wx');
    try {
      expect(() => withCoreConfigWriteLock(configPath, () => undefined))
        .toThrow(CoreConfigWriteConflictError);
    } finally {
      closeSync(lock);
      rmSync(lockPath, { force: true });
    }

    expect(withCoreConfigWriteLock(configPath, () => 'written')).toBe('written');
    const released = openSync(lockPath, 'wx');
    closeSync(released);
    rmSync(home, { recursive: true, force: true });
  });
});
