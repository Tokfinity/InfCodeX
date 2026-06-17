import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  utimes,
  writeFile,
} from 'fs/promises';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import {
  resolveRepoIntelligenceStorageDir,
  withRepoIntelligenceStorageDir,
  writeJsonFileAtomic,
} from './internal.js';

describe('repo-intelligence internal storage overrides', () => {
  const originalStorageDir = process.env.KODAX_REPO_INTELLIGENCE_STORAGE_DIR;

  afterEach(() => {
    if (originalStorageDir === undefined) {
      delete process.env.KODAX_REPO_INTELLIGENCE_STORAGE_DIR;
    } else {
      process.env.KODAX_REPO_INTELLIGENCE_STORAGE_DIR = originalStorageDir;
    }
  });

  it('keeps concurrent async storage overrides isolated', async () => {
    delete process.env.KODAX_REPO_INTELLIGENCE_STORAGE_DIR;

    const [left, right] = await Promise.all([
      withRepoIntelligenceStorageDir('.repointel-a', async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return resolveRepoIntelligenceStorageDir('.agent/repo-intelligence');
      }),
      withRepoIntelligenceStorageDir('.repointel-b', async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return resolveRepoIntelligenceStorageDir('.agent/repo-intelligence');
      }),
    ]);

    expect(left).toBe('.repointel-a');
    expect(right).toBe('.repointel-b');
  });

  it('falls back to env and then default when no async override is active', () => {
    process.env.KODAX_REPO_INTELLIGENCE_STORAGE_DIR = '.repointel-env';
    expect(resolveRepoIntelligenceStorageDir('.agent/repo-intelligence')).toBe('.repointel-env');

    delete process.env.KODAX_REPO_INTELLIGENCE_STORAGE_DIR;
    expect(resolveRepoIntelligenceStorageDir('.agent/repo-intelligence')).toBe('.agent/repo-intelligence');
  });
});

describe('writeJsonFileAtomic', () => {
  let dir: string;
  const tempFiles = (entries: string[]): string[] =>
    entries.filter((name) => name.endsWith('.tmp')).sort();

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'kodax-ri-atomic-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes JSON atomically and leaves no temp file behind on success', async () => {
    const target = path.join(dir, 'changed-scope.json');
    await writeJsonFileAtomic(target, { a: 1 });

    expect(JSON.parse(await readFile(target, 'utf8'))).toEqual({ a: 1 });
    expect(tempFiles(await readdir(dir))).toEqual([]);
  });

  it('uses distinct temp files for same-millisecond concurrent writes', async () => {
    const target = path.join(dir, 'changed-scope.json');
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    try {
      await Promise.all([
        writeJsonFileAtomic(target, { a: 1 }),
        writeJsonFileAtomic(target, { a: 2 }),
      ]);

      expect([{ a: 1 }, { a: 2 }]).toContainEqual(JSON.parse(await readFile(target, 'utf8')));
      expect(tempFiles(await readdir(dir))).toEqual([]);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('removes its own temp file when rename fails (no orphan accumulation)', async () => {
    // Making the target a directory forces rename() to fail, simulating the
    // Windows EPERM-on-locked-target / interrupted-write failure mode that
    // was leaking one orphan `.tmp` per failed write.
    const target = path.join(dir, 'changed-scope.json');
    await mkdir(target);

    await expect(writeJsonFileAtomic(target, { a: 1 })).rejects.toBeTruthy();
    expect(tempFiles(await readdir(dir))).toEqual([]);
  });

  it('retries a transient EPERM on rename and then succeeds (Windows lock flake)', async () => {
    const target = path.join(dir, 'changed-scope.json');
    const realRename = fs.rename.bind(fs);
    let calls = 0;
    const spy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      calls += 1;
      if (calls === 1) {
        throw Object.assign(new Error('mock transient lock'), { code: 'EPERM' });
      }
      return realRename(from, to);
    });
    try {
      await writeJsonFileAtomic(target, { a: 1 });
      expect(JSON.parse(await readFile(target, 'utf8'))).toEqual({ a: 1 });
      expect(calls).toBeGreaterThanOrEqual(2); // failed once → retried → succeeded
      expect(tempFiles(await readdir(dir))).toEqual([]); // temp consumed by the successful rename
    } finally {
      spy.mockRestore();
    }
  });

  it('sweeps stale orphan temp files for the same base on a successful write', async () => {
    const target = path.join(dir, 'changed-scope.json');
    const orphan = path.join(dir, 'changed-scope.json.99999.1700000000000.tmp');
    await writeFile(orphan, 'stale', 'utf8');
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(orphan, twoHoursAgo, twoHoursAgo);

    await writeJsonFileAtomic(target, { a: 1 });

    expect(tempFiles(await readdir(dir))).toEqual([]);
  });

  it('preserves a recent temp file (concurrent-writer safety)', async () => {
    const target = path.join(dir, 'changed-scope.json');
    const recent = 'changed-scope.json.88888.1700000000001.tmp';
    await writeFile(path.join(dir, recent), 'in-flight', 'utf8');

    await writeJsonFileAtomic(target, { a: 1 });

    expect(tempFiles(await readdir(dir))).toEqual([recent]);
  });

  it('preserves a stale .tmp sibling that does not match the <pid>.<ts> name', async () => {
    const target = path.join(dir, 'changed-scope.json');
    // Same base + `.tmp`, but not the format this module produces — must not
    // be swept even though it is old.
    const foreign = 'changed-scope.json.backup.tmp';
    await writeFile(path.join(dir, foreign), 'keep', 'utf8');
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(path.join(dir, foreign), twoHoursAgo, twoHoursAgo);

    await writeJsonFileAtomic(target, { a: 1 });

    expect(tempFiles(await readdir(dir))).toEqual([foreign]);
  });

  it('only sweeps temps for the same base file, not siblings', async () => {
    const target = path.join(dir, 'changed-scope.json');
    const otherOrphan = path.join(dir, 'repo-overview.json.99999.1700000000000.tmp');
    await writeFile(otherOrphan, 'stale', 'utf8');
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(otherOrphan, twoHoursAgo, twoHoursAgo);

    await writeJsonFileAtomic(target, { a: 1 });

    expect(tempFiles(await readdir(dir))).toEqual([
      'repo-overview.json.99999.1700000000000.tmp',
    ]);
  });
});
