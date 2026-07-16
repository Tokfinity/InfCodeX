/**
 * FEATURE_131 v0.7.36 Part A — file-mutation-queue contract tests.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  _peekFileMutationQueueSizeForTests,
  _resetFileMutationQueueForTests,
  normalizePathForKey,
  withFileMutation,
} from './file-mutation-queue.js';

afterEach(() => {
  _resetFileMutationQueueForTests();
  delete process.env.KODAX_PATH_KEY_PLATFORM;
});

describe('normalizePathForKey — POSIX mode', () => {
  beforeEach(() => {
    process.env.KODAX_PATH_KEY_PLATFORM = 'posix';
  });

  it('lowercases the drive letter on Windows-style paths but preserves component case', () => {
    expect(normalizePathForKey('C:\\Foo\\Bar')).toBe('c:/Foo/Bar');
    expect(normalizePathForKey('D:/x')).toBe('d:/x');
  });

  it('treats backslash and forward-slash variants as the same key', () => {
    expect(normalizePathForKey('C:\\Foo\\Bar')).toBe(normalizePathForKey('c:/Foo/Bar'));
  });

  it('collapses repeated separators', () => {
    expect(normalizePathForKey('/a//b///c')).toBe('/a/b/c');
  });

  it('preserves the leading // on UNC-style paths', () => {
    expect(normalizePathForKey('//server/share/file')).toBe('//server/share/file');
  });

  it('trims a trailing slash unless the path is the root', () => {
    expect(normalizePathForKey('/foo/')).toBe('/foo');
    expect(normalizePathForKey('/')).toBe('/');
  });

  it('returns an empty string for empty input', () => {
    expect(normalizePathForKey('')).toBe('');
  });

  it('preserves component case on POSIX (case-sensitive filesystem)', () => {
    expect(normalizePathForKey('/Foo/Bar')).toBe('/Foo/Bar');
  });
});

describe('normalizePathForKey — Windows mode', () => {
  beforeEach(() => {
    process.env.KODAX_PATH_KEY_PLATFORM = 'win32';
  });

  it('lowercases the entire path (case-insensitive filesystem)', () => {
    expect(normalizePathForKey('C:\\Foo\\Bar')).toBe('c:/foo/bar');
    expect(normalizePathForKey('c:/foo/Bar')).toBe('c:/foo/bar');
    expect(normalizePathForKey('C:/FOO/bar')).toBe('c:/foo/bar');
  });

  it('keeps backslash/forward-slash + case variants on the same queue key', () => {
    expect(normalizePathForKey('C:\\Foo\\Bar.txt')).toBe(normalizePathForKey('c:/foo/Bar.txt'));
  });
});

describe('withFileMutation — same path serialization', () => {
  it('runs same-path mutations in arrival order', async () => {
    const log: string[] = [];
    const slow = (label: string, ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(() => {
          log.push(label);
          resolve();
        }, ms);
      });

    // First call is slower than the second; without the queue the
    // second would record before the first.
    const a = withFileMutation('/tmp/file.txt', () => slow('A', 30));
    const b = withFileMutation('/tmp/file.txt', () => slow('B', 5));
    await Promise.all([a, b]);
    expect(log).toEqual(['A', 'B']);
  });

  it('serializes calls with equivalent Windows path spellings (acceptance #9)', async () => {
    process.env.KODAX_PATH_KEY_PLATFORM = 'win32';
    const log: string[] = [];
    const slow = (label: string, ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(() => {
          log.push(label);
          resolve();
        }, ms);
      });

    const a = withFileMutation('C:\\Foo\\Bar.txt', () => slow('A', 25));
    const b = withFileMutation('c:/foo/Bar.txt', () => slow('B', 5));
    await Promise.all([a, b]);
    expect(log).toEqual(['A', 'B']);
  });

  it('returns each caller their own result', async () => {
    const a = withFileMutation('/tmp/file.txt', async () => 'A');
    const b = withFileMutation('/tmp/file.txt', async () => 'B');
    const c = withFileMutation('/tmp/file.txt', async () => 'C');
    expect(await a).toBe('A');
    expect(await b).toBe('B');
    expect(await c).toBe('C');
  });

  it('queue continues after a previous mutation rejects', async () => {
    const result = withFileMutation('/tmp/file.txt', async () => {
      throw new Error('boom');
    });
    await expect(result).rejects.toThrow('boom');
    const next = await withFileMutation('/tmp/file.txt', async () => 'after');
    expect(next).toBe('after');
  });
});

describe('withFileMutation — different path concurrency', () => {
  it('runs different paths concurrently (wall-clock ≈ slowest, not the sum)', async () => {
    const start = Date.now();
    await Promise.all([
      withFileMutation('/tmp/a.txt', () => new Promise<void>((r) => setTimeout(r, 30))),
      withFileMutation('/tmp/b.txt', () => new Promise<void>((r) => setTimeout(r, 30))),
      withFileMutation('/tmp/c.txt', () => new Promise<void>((r) => setTimeout(r, 30))),
    ]);
    const elapsed = Date.now() - start;
    // Sequential would be 90ms+; concurrent is ~30ms. Allow 80ms
    // headroom for slow CI without making the test flaky.
    expect(elapsed).toBeLessThan(80);
  });
});

describe('withFileMutation — cleanup', () => {
  it('clears the queue entry after the chain settles (no leak)', async () => {
    for (let i = 0; i < 100; i++) {
      await withFileMutation(`/tmp/file-${i}.txt`, async () => i);
    }
    expect(_peekFileMutationQueueSizeForTests()).toBe(0);
  });

  it('clears the entry even when the mutation rejects', async () => {
    await withFileMutation('/tmp/file.txt', async () => {
      throw new Error('boom');
    }).catch(() => undefined);
    // Allow the microtask to run so the finally fires.
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(_peekFileMutationQueueSizeForTests()).toBe(0);
  });
});
