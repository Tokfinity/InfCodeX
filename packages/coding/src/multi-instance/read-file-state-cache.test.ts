/**
 * FEATURE_177 (v0.7.42) — read-file-state-cache hermetic tests.
 *
 * Hits every documented edge case using an in-memory fs + injectable
 * clock so mtime drift / time-of-record / killswitch behaviour is
 * fully reproducible.
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildReadFileUnchangedStub,
  createReadFileStateCache,
  type ReadFileStateCacheFs,
} from './read-file-state-cache.js';

class FakeFs implements ReadFileStateCacheFs {
  /** filePath -> mtimeMs */
  readonly files = new Map<string, number>();
  /** Force the next statSync against `filePath` to throw. */
  failNextStat?: { filePath: string; error: Error };

  statSync(p: string): { mtimeMs: number } {
    if (this.failNextStat?.filePath === p) {
      const err = this.failNextStat.error;
      this.failNextStat = undefined;
      throw err;
    }
    const m = this.files.get(p);
    if (m === undefined) throw new Error(`ENOENT: ${p}`);
    return { mtimeMs: m };
  }
}

const KILLSWITCH = 'KODAX_READ_DEDUP_KILLSWITCH';
const originalKillswitch = process.env[KILLSWITCH];
afterEach(() => {
  if (originalKillswitch === undefined) {
    delete process.env[KILLSWITCH];
  } else {
    process.env[KILLSWITCH] = originalKillswitch;
  }
});

describe('createReadFileStateCache — lookup miss / hit base behaviour', () => {
  it('returns miss for an unrecorded (path, offset, limit)', () => {
    const fs = new FakeFs();
    fs.files.set('/r/a.ts', 100);
    const cache = createReadFileStateCache({ fs, clock: () => 1000 });
    expect(cache.lookup('/r/a.ts', 1, 200)).toEqual({ kind: 'miss' });
  });

  it('returns hit after a matching record when mtime is unchanged', () => {
    const fs = new FakeFs();
    fs.files.set('/r/a.ts', 100);
    let now = 1000;
    const cache = createReadFileStateCache({ fs, clock: () => now });

    cache.record('/r/a.ts', 1, 200, 100);
    now = 2000;
    const res = cache.lookup('/r/a.ts', 1, 200);
    expect(res).toEqual({ kind: 'hit', previousReadAtMs: 1000 });
  });

  it('returns miss when offset differs even if path matches', () => {
    const fs = new FakeFs();
    fs.files.set('/r/a.ts', 100);
    const cache = createReadFileStateCache({ fs, clock: () => 1000 });
    cache.record('/r/a.ts', 1, 200, 100);
    expect(cache.lookup('/r/a.ts', 201, 200)).toEqual({ kind: 'miss' });
  });

  it('returns miss when limit differs even if path + offset match', () => {
    const fs = new FakeFs();
    fs.files.set('/r/a.ts', 100);
    const cache = createReadFileStateCache({ fs, clock: () => 1000 });
    cache.record('/r/a.ts', 1, 200, 100);
    expect(cache.lookup('/r/a.ts', 1, 500)).toEqual({ kind: 'miss' });
  });

  it('supports multiple (offset, limit) pairs per file independently', () => {
    const fs = new FakeFs();
    fs.files.set('/r/a.ts', 100);
    const cache = createReadFileStateCache({ fs, clock: () => 1000 });
    cache.record('/r/a.ts', 1, 200, 100);
    cache.record('/r/a.ts', 201, 200, 100);
    expect(cache.lookup('/r/a.ts', 1, 200).kind).toBe('hit');
    expect(cache.lookup('/r/a.ts', 201, 200).kind).toBe('hit');
    expect(cache.lookup('/r/a.ts', 401, 200).kind).toBe('miss');
  });
});

describe('createReadFileStateCache — mtime-change invalidation', () => {
  it('returns miss + drops the entry when mtime changed since record', () => {
    const fs = new FakeFs();
    fs.files.set('/r/a.ts', 100);
    const cache = createReadFileStateCache({ fs, clock: () => 1000 });

    cache.record('/r/a.ts', 1, 200, 100);
    // Peer / user / build tool touched the file.
    fs.files.set('/r/a.ts', 200);
    expect(cache.lookup('/r/a.ts', 1, 200)).toEqual({ kind: 'miss' });

    // Stale entry was dropped — a follow-up lookup with the original
    // mtime in the recorded slot would not re-hit either; the row
    // is gone until a fresh record() puts it back.
    fs.files.set('/r/a.ts', 100);
    expect(cache.lookup('/r/a.ts', 1, 200)).toEqual({ kind: 'miss' });
  });

  it('returns miss when statSync throws (file deleted between record and lookup)', () => {
    const fs = new FakeFs();
    fs.files.set('/r/a.ts', 100);
    const cache = createReadFileStateCache({ fs, clock: () => 1000 });

    cache.record('/r/a.ts', 1, 200, 100);
    fs.files.delete('/r/a.ts');
    expect(cache.lookup('/r/a.ts', 1, 200)).toEqual({ kind: 'miss' });
  });

  it('returns miss when statSync throws a permission error', () => {
    const fs = new FakeFs();
    fs.files.set('/r/a.ts', 100);
    const cache = createReadFileStateCache({ fs, clock: () => 1000 });
    cache.record('/r/a.ts', 1, 200, 100);

    fs.failNextStat = { filePath: '/r/a.ts', error: new Error('EACCES') };
    expect(cache.lookup('/r/a.ts', 1, 200)).toEqual({ kind: 'miss' });
  });
});

describe('createReadFileStateCache — forget / clear', () => {
  it('forget(path) drops every offset/limit entry for that file', () => {
    const fs = new FakeFs();
    fs.files.set('/r/a.ts', 100);
    fs.files.set('/r/b.ts', 100);
    const cache = createReadFileStateCache({ fs, clock: () => 1000 });

    cache.record('/r/a.ts', 1, 200, 100);
    cache.record('/r/a.ts', 201, 200, 100);
    cache.record('/r/b.ts', 1, 200, 100);

    cache.forget('/r/a.ts');
    expect(cache.lookup('/r/a.ts', 1, 200).kind).toBe('miss');
    expect(cache.lookup('/r/a.ts', 201, 200).kind).toBe('miss');
    // Other file untouched.
    expect(cache.lookup('/r/b.ts', 1, 200).kind).toBe('hit');
  });

  it('clear() drops every file', () => {
    const fs = new FakeFs();
    fs.files.set('/r/a.ts', 100);
    fs.files.set('/r/b.ts', 100);
    const cache = createReadFileStateCache({ fs, clock: () => 1000 });

    cache.record('/r/a.ts', 1, 200, 100);
    cache.record('/r/b.ts', 1, 200, 100);
    expect(cache.size()).toBe(2);

    cache.clear();
    expect(cache.size()).toBe(0);
    expect(cache.lookup('/r/a.ts', 1, 200).kind).toBe('miss');
    expect(cache.lookup('/r/b.ts', 1, 200).kind).toBe('miss');
  });

  it('forget on an unknown path is a no-op (does not throw)', () => {
    const fs = new FakeFs();
    const cache = createReadFileStateCache({ fs, clock: () => 1000 });
    expect(() => cache.forget('/r/never-recorded.ts')).not.toThrow();
  });
});

describe('createReadFileStateCache — killswitch', () => {
  it('disabled=true makes every lookup a miss and every record a no-op', () => {
    const fs = new FakeFs();
    fs.files.set('/r/a.ts', 100);
    const cache = createReadFileStateCache({
      fs,
      clock: () => 1000,
      disabled: true,
    });
    cache.record('/r/a.ts', 1, 200, 100);
    expect(cache.lookup('/r/a.ts', 1, 200)).toEqual({ kind: 'miss' });
    expect(cache.size()).toBe(0);
  });

  it('KODAX_READ_DEDUP_KILLSWITCH=1 disables the cache by default', () => {
    process.env[KILLSWITCH] = '1';
    const fs = new FakeFs();
    fs.files.set('/r/a.ts', 100);
    const cache = createReadFileStateCache({ fs, clock: () => 1000 });

    cache.record('/r/a.ts', 1, 200, 100);
    expect(cache.lookup('/r/a.ts', 1, 200)).toEqual({ kind: 'miss' });
  });

  it('KODAX_READ_DEDUP_KILLSWITCH unset / other value enables the cache', () => {
    delete process.env[KILLSWITCH];
    const fs = new FakeFs();
    fs.files.set('/r/a.ts', 100);
    const cache = createReadFileStateCache({ fs, clock: () => 1000 });

    cache.record('/r/a.ts', 1, 200, 100);
    expect(cache.lookup('/r/a.ts', 1, 200).kind).toBe('hit');
  });

  it('explicit disabled=false overrides the env killswitch', () => {
    process.env[KILLSWITCH] = '1';
    const fs = new FakeFs();
    fs.files.set('/r/a.ts', 100);
    const cache = createReadFileStateCache({
      fs,
      clock: () => 1000,
      disabled: false,
    });

    cache.record('/r/a.ts', 1, 200, 100);
    expect(cache.lookup('/r/a.ts', 1, 200).kind).toBe('hit');
  });
});

describe('buildReadFileUnchangedStub', () => {
  it('mentions the path, offset, limit, and tells the model to look at the prior tool_result', () => {
    const stub = buildReadFileUnchangedStub('/r/a.ts', 1, 200);
    expect(stub).toContain('/r/a.ts');
    expect(stub).toContain('offset=1');
    expect(stub).toContain('limit=200');
    expect(stub).toMatch(/earlier read tool_result/i);
    expect(stub).toMatch(/refer to that/i);
  });

  it('hints at calling read with different offset/limit for new lines', () => {
    const stub = buildReadFileUnchangedStub('/r/a.ts', 1, 200);
    expect(stub).toMatch(/different offset\/limit/i);
  });

  it('mentions mtime-based auto-invalidation', () => {
    const stub = buildReadFileUnchangedStub('/r/a.ts', 1, 200);
    expect(stub).toMatch(/mtime/i);
  });
});
