import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';

import {
  commitResumeIndexEntry,
  completeResumeIndex,
  prepareResumeIndexEntry,
  readResumeIndex,
  type ResumeIndexEntry,
  type ResumeIndexScanEntry,
  type ResumeIndexScannedFile,
} from './resume-index.js';

describe('resume index', () => {
  const tempDirs: string[] = [];
  const entry = (id: string): ResumeIndexEntry => ({
    id,
    title: `Session ${id}`,
    msgCount: 1,
    createdAt: '2026-08-16T00:00:00.000Z',
    surface: 'repl',
  });

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  async function projectDir(): Promise<string> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-resume-index-'));
    tempDirs.push(directory);
    return directory;
  }

  async function canonicalEntry(directory: string, id: string): Promise<ResumeIndexScanEntry> {
    await fs.writeFile(path.join(directory, `${id}.jsonl`), `${id}\n`, 'utf8');
    const stat = await fs.stat(path.join(directory, `${id}.jsonl`));
    return {
      ...entry(id),
      sourceSize: stat.size,
      sourceMtimeMs: stat.mtimeMs,
      sourceCtimeMs: stat.ctimeMs,
      sourceDev: stat.dev,
      sourceIno: stat.ino,
    };
  }

  function scannedFile(entryValue: ResumeIndexScanEntry): ResumeIndexScannedFile {
    return {
      name: `${entryValue.id}.jsonl`,
      sourceSize: entryValue.sourceSize,
      sourceMtimeMs: entryValue.sourceMtimeMs,
      sourceCtimeMs: entryValue.sourceCtimeMs,
      sourceDev: entryValue.sourceDev,
      sourceIno: entryValue.sourceIno,
    };
  }

  it('rejects a corrupted marker so the caller can rebuild from canonical sessions', async () => {
    const directory = await projectDir();
    const one = await canonicalEntry(directory, 'one');
    await completeResumeIndex(directory, [one], [scannedFile(one)]);
    const indexDir = path.join(directory, '.resume-index');
    const marker = (await fs.readdir(indexDir)).find((name) => name.endsWith('.resume'));
    expect(marker).toBeDefined();
    await fs.writeFile(path.join(indexDir, marker!), '{broken', 'utf8');

    await expect(readResumeIndex(directory)).resolves.toBeUndefined();
    await completeResumeIndex(directory, [one], [scannedFile(one)]);
    await expect(readResumeIndex(directory)).resolves.toEqual([entry('one')]);
  });

  it('does not certify a concurrent marker until its canonical commit completes', async () => {
    const directory = await projectDir();
    const existing = await canonicalEntry(directory, 'existing');
    await completeResumeIndex(directory, [existing], [scannedFile(existing)]);
    await prepareResumeIndexEntry(directory, entry('pending'));

    await completeResumeIndex(directory, [existing], [scannedFile(existing)]);
    await expect(readResumeIndex(directory)).resolves.toEqual([entry('existing')]);

    const pending = await canonicalEntry(directory, 'pending');
    await commitResumeIndexEntry(directory, entry('pending'), true);
    await expect(readResumeIndex(directory)).resolves.toEqual(expect.arrayContaining([
      entry('existing'),
      entry('pending'),
    ]));
  });

  it('recovers an abandoned pending marker during the next canonical rebuild', async () => {
    const directory = await projectDir();
    await completeResumeIndex(directory, [], []);
    await prepareResumeIndexEntry(directory, entry('abandoned'));

    await completeResumeIndex(directory, [], []);

    await expect(readResumeIndex(directory)).resolves.toEqual([]);
  });

  it('does not publish a scan when the canonical file set changed after enumeration', async () => {
    const directory = await projectDir();
    const current = await canonicalEntry(directory, 'current');
    await canonicalEntry(directory, 'concurrent');

    await completeResumeIndex(directory, [current], [scannedFile(current)]);

    await expect(readResumeIndex(directory)).resolves.toBeUndefined();
  });

  it('does not invalidate a newer manifest when a stale rebuild reaches the publish lock', async () => {
    const directory = await projectDir();
    await completeResumeIndex(directory, [], []);
    const current = await canonicalEntry(directory, 'current');
    await commitResumeIndexEntry(directory, entry('current'), true);
    await expect(readResumeIndex(directory)).resolves.toEqual([entry('current')]);

    await completeResumeIndex(directory, [], []);

    await expect(readResumeIndex(directory)).resolves.toEqual([entry('current')]);
  });

  it('does not publish negative membership when a scanned file changed in place', async () => {
    const directory = await projectDir();
    const excluded = await canonicalEntry(directory, 'excluded');
    await fs.appendFile(path.join(directory, 'excluded.jsonl'), 'became-resumable\n', 'utf8');

    await completeResumeIndex(directory, [], [scannedFile(excluded)]);

    await expect(readResumeIndex(directory)).resolves.toBeUndefined();
  });

  it('invalidates published negative membership when an excluded file changes in place', async () => {
    const directory = await projectDir();
    const excluded = await canonicalEntry(directory, 'excluded');
    await completeResumeIndex(directory, [], [scannedFile(excluded)]);
    await expect(readResumeIndex(directory)).resolves.toEqual([]);

    await fs.appendFile(path.join(directory, 'excluded.jsonl'), 'became-resumable\n', 'utf8');

    await expect(readResumeIndex(directory)).resolves.toBeUndefined();
  });

  it('incrementally keeps a complete manifest after canonical writer membership changes', async () => {
    const directory = await projectDir();
    const existing = await canonicalEntry(directory, 'existing');
    await completeResumeIndex(directory, [existing], [scannedFile(existing)]);

    await canonicalEntry(directory, 'worker');
    await commitResumeIndexEntry(directory, entry('worker'), false);
    await expect(readResumeIndex(directory)).resolves.toEqual([entry('existing')]);

    await canonicalEntry(directory, 'new-session');
    await commitResumeIndexEntry(directory, entry('new-session'), true);
    await expect(readResumeIndex(directory)).resolves.toEqual(expect.arrayContaining([
      entry('existing'),
      entry('new-session'),
    ]));
  });

  it('serializes concurrent project-wide manifest updates from different sessions', async () => {
    const directory = await projectDir();
    await completeResumeIndex(directory, [], []);
    const workers = await Promise.all(Array.from({ length: 50 }, (_, index) => (
      canonicalEntry(directory, `worker-${index}`)
    )));

    const startedAt = performance.now();
    await Promise.all(workers.map((worker) => (
      commitResumeIndexEntry(directory, entry(worker.id), false)
    )));

    expect(performance.now() - startedAt).toBeLessThan(5_000);
    await expect(readResumeIndex(directory)).resolves.toEqual([]);
  });

  it('immediately reclaims a publish lock left by a dead process', async () => {
    const directory = await projectDir();
    const indexDir = path.join(directory, '.resume-index');
    await fs.mkdir(indexDir, { recursive: true });
    await fs.writeFile(
      path.join(indexDir, 'publish.lock'),
      JSON.stringify({ pid: 2_147_483_646, token: 'abandoned' }),
      'utf8',
    );

    const startedAt = performance.now();
    await completeResumeIndex(directory, [], []);

    expect(performance.now() - startedAt).toBeLessThan(1_000);
    await expect(readResumeIndex(directory)).resolves.toEqual([]);
  });

  it('drops stale ready markers during a canonical rebuild', async () => {
    const directory = await projectDir();
    const current = await canonicalEntry(directory, 'current');
    const deleted = await canonicalEntry(directory, 'deleted');
    await completeResumeIndex(
      directory,
      [current, deleted],
      [scannedFile(current), scannedFile(deleted)],
    );
    await fs.rm(path.join(directory, 'deleted.jsonl'));

    await completeResumeIndex(directory, [current], [scannedFile(current)]);

    await expect(readResumeIndex(directory)).resolves.toEqual([entry('current')]);
  });

  it('rejects a summary when its canonical session changed after the scan', async () => {
    const directory = await projectDir();
    const current = await canonicalEntry(directory, 'current');
    await completeResumeIndex(directory, [current], [scannedFile(current)]);

    await fs.appendFile(path.join(directory, 'current.jsonl'), 'changed\n', 'utf8');

    await expect(readResumeIndex(directory)).resolves.toBeUndefined();
  });

  it('rejects a same-size replacement even when its mtime is restored', async () => {
    const directory = await projectDir();
    const current = await canonicalEntry(directory, 'current');
    const sessionPath = path.join(directory, 'current.jsonl');
    const before = await fs.stat(sessionPath);
    await completeResumeIndex(directory, [current], [scannedFile(current)]);

    await fs.writeFile(sessionPath, 'replace\n', 'utf8');
    await fs.utimes(sessionPath, before.atime, before.mtime);

    await expect(readResumeIndex(directory)).resolves.toBeUndefined();
  });

  it('rejects a complete manifest when a canonical session file was added out of band', async () => {
    const directory = await projectDir();
    const current = await canonicalEntry(directory, 'current');
    await completeResumeIndex(directory, [current], [scannedFile(current)]);

    await canonicalEntry(directory, 'out-of-band');

    await expect(readResumeIndex(directory)).resolves.toBeUndefined();
  });
});
