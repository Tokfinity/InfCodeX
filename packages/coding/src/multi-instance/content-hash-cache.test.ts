/**
 * FEATURE_125 (v0.7.41) — content-hash-cache hermetic tests.
 *
 * Drives the cache through every documented edge case using an
 * in-memory fs + deterministic hash function so race conditions are
 * fully reproducible.
 */

import { describe, expect, it } from 'vitest';

import {
  buildStaleWriteReason,
  createContentHashCache,
  type ContentHashCacheFs,
} from './content-hash-cache.js';

class FakeFs implements ContentHashCacheFs {
  readonly files = new Map<string, string>();
  /** Force the next readFileSync against `filePath` to throw the given error. */
  failNextRead?: { filePath: string; error: Error };

  existsSync(p: string): boolean {
    return this.files.has(p);
  }
  readFileSync(p: string, _enc: 'utf8'): string {
    if (this.failNextRead?.filePath === p) {
      const err = this.failNextRead.error;
      this.failNextRead = undefined;
      throw err;
    }
    const v = this.files.get(p);
    if (v === undefined) throw new Error(`ENOENT: ${p}`);
    return v;
  }
}

// Deterministic "hash" stand-in for hermetic predictability: identity.
// Real sha256 is exercised in the small integration test at the bottom.
const idHash = (s: string): string => s;

describe('createContentHashCache — recordRead + checkStale (fresh path)', () => {
  it("returns kind:'no-read' for a file the LLM never read", () => {
    const fs = new FakeFs();
    fs.files.set('/r/a.ts', 'hello');
    const cache = createContentHashCache({ fs, hash: idHash, clock: () => 1000 });
    const res = cache.checkStale('/r/a.ts');
    expect(res).toEqual({ kind: 'no-read', stale: false });
  });

  it("returns kind:'fresh' when the file is unchanged since the recorded read", () => {
    const fs = new FakeFs();
    fs.files.set('/r/a.ts', 'hello');
    let now = 1000;
    const cache = createContentHashCache({ fs, hash: idHash, clock: () => now });

    cache.recordRead('/r/a.ts', 'hello');
    now = 2000;
    const res = cache.checkStale('/r/a.ts');

    expect(res.kind).toBe('fresh');
    expect(res.stale).toBe(false);
    if (res.kind === 'fresh') {
      expect(res.readAt).toBe(1000);
    }
  });

  it("records readAt at the time of the read call (not the check)", () => {
    const fs = new FakeFs();
    fs.files.set('/r/a.ts', 'x');
    let now = 100;
    const cache = createContentHashCache({ fs, hash: idHash, clock: () => now });
    cache.recordRead('/r/a.ts', 'x');
    expect(cache.getReadAt('/r/a.ts')).toBe(100);
    now = 200;
    cache.checkStale('/r/a.ts');
    expect(cache.getReadAt('/r/a.ts')).toBe(100); // unchanged by check
  });
});

describe('createContentHashCache — checkStale (stale path)', () => {
  it("returns kind:'stale' when the file content changed since the recorded read", () => {
    const fs = new FakeFs();
    fs.files.set('/r/a.ts', 'v1');
    const cache = createContentHashCache({ fs, hash: idHash, clock: () => 1000 });
    cache.recordRead('/r/a.ts', 'v1');

    // Peer modifies the file.
    fs.files.set('/r/a.ts', 'v2');

    const res = cache.checkStale('/r/a.ts');
    expect(res.kind).toBe('stale');
    expect(res.stale).toBe(true);
    if (res.kind === 'stale') {
      expect(res.recordedHash).toBe('v1');
      expect(res.currentHash).toBe('v2');
      expect(res.readAt).toBe(1000);
    }
  });

  it("returns kind:'missing' when the file is deleted between read and check", () => {
    const fs = new FakeFs();
    fs.files.set('/r/a.ts', 'v1');
    const cache = createContentHashCache({ fs, hash: idHash, clock: () => 1000 });
    cache.recordRead('/r/a.ts', 'v1');
    fs.files.delete('/r/a.ts');

    const res = cache.checkStale('/r/a.ts');
    expect(res.kind).toBe('missing');
    expect(res.stale).toBe(true);
  });

  it("returns kind:'missing' when readFileSync throws mid-check (transient FS error)", () => {
    const fs = new FakeFs();
    fs.files.set('/r/a.ts', 'v1');
    const cache = createContentHashCache({ fs, hash: idHash, clock: () => 1000 });
    cache.recordRead('/r/a.ts', 'v1');

    fs.failNextRead = { filePath: '/r/a.ts', error: new Error('EBUSY') };
    const res = cache.checkStale('/r/a.ts');
    expect(res.kind).toBe('missing');
    expect(res.stale).toBe(true);
  });
});

describe('createContentHashCache — recordWrite + self-edit-chain', () => {
  it("treats the LLM's own subsequent edit as fresh after recordWrite", () => {
    const fs = new FakeFs();
    fs.files.set('/r/a.ts', 'v1');
    let now = 1000;
    const cache = createContentHashCache({ fs, hash: idHash, clock: () => now });

    cache.recordRead('/r/a.ts', 'v1');
    // LLM applies edit; disk now holds v2; cache is updated to match.
    now = 1500;
    fs.files.set('/r/a.ts', 'v2');
    cache.recordWrite('/r/a.ts', 'v2');

    // A second self-edit should NOT trip stale alarm.
    now = 2000;
    const res = cache.checkStale('/r/a.ts');
    expect(res.kind).toBe('fresh');
    if (res.kind === 'fresh') {
      expect(res.readAt).toBe(1500);
    }
  });

  it("a peer-edit AFTER our recordWrite still trips stale", () => {
    const fs = new FakeFs();
    fs.files.set('/r/a.ts', 'v1');
    const cache = createContentHashCache({ fs, hash: idHash, clock: () => 1000 });
    cache.recordRead('/r/a.ts', 'v1');
    fs.files.set('/r/a.ts', 'v2');
    cache.recordWrite('/r/a.ts', 'v2');

    fs.files.set('/r/a.ts', 'v3'); // peer modifies
    const res = cache.checkStale('/r/a.ts');
    expect(res.kind).toBe('stale');
    if (res.kind === 'stale') {
      expect(res.recordedHash).toBe('v2');
      expect(res.currentHash).toBe('v3');
    }
  });
});

describe('createContentHashCache — forget', () => {
  it('drops the recorded hash for a path', () => {
    const fs = new FakeFs();
    fs.files.set('/r/a.ts', 'v1');
    const cache = createContentHashCache({ fs, hash: idHash, clock: () => 1000 });
    cache.recordRead('/r/a.ts', 'v1');
    expect(cache.getRecordedHash('/r/a.ts')).toBe('v1');

    cache.forget('/r/a.ts');
    expect(cache.getRecordedHash('/r/a.ts')).toBeUndefined();
    expect(cache.checkStale('/r/a.ts').kind).toBe('no-read');
  });

  it('is idempotent (forgetting an unknown path is a no-op)', () => {
    const fs = new FakeFs();
    const cache = createContentHashCache({ fs, hash: idHash, clock: () => 1000 });
    expect(() => cache.forget('/r/unknown.ts')).not.toThrow();
  });
});

describe('createContentHashCache — isolation (per-task lifetime)', () => {
  it('two caches are fully independent', () => {
    const fs = new FakeFs();
    fs.files.set('/r/a.ts', 'v1');
    const cacheA = createContentHashCache({ fs, hash: idHash, clock: () => 1000 });
    const cacheB = createContentHashCache({ fs, hash: idHash, clock: () => 1000 });

    cacheA.recordRead('/r/a.ts', 'v1');
    expect(cacheA.checkStale('/r/a.ts').kind).toBe('fresh');
    expect(cacheB.checkStale('/r/a.ts').kind).toBe('no-read');
  });
});

describe('createContentHashCache — real sha256 (integration)', () => {
  it('produces identical hashes for identical content under the default hasher', () => {
    const fs = new FakeFs();
    fs.files.set('/r/a.ts', 'hello world');
    const cache = createContentHashCache({ fs, clock: () => 1000 });
    cache.recordRead('/r/a.ts', 'hello world');
    expect(cache.checkStale('/r/a.ts').kind).toBe('fresh');

    fs.files.set('/r/a.ts', 'hello world!');
    expect(cache.checkStale('/r/a.ts').kind).toBe('stale');
  });
});

describe('buildStaleWriteReason', () => {
  it("emits a clear LLM-facing reason for kind:'stale'", () => {
    const reason = buildStaleWriteReason('/r/a.ts', {
      kind: 'stale',
      stale: true,
      readAt: 1000,
      recordedHash: 'v1',
      currentHash: 'v2',
    });
    expect(reason).toContain('/r/a.ts');
    expect(reason).toContain('has changed since you last read it');
    expect(reason.toLowerCase()).toMatch(/re-read|read.*again/);
  });

  it("emits a clear LLM-facing reason for kind:'missing'", () => {
    const reason = buildStaleWriteReason('/r/a.ts', {
      kind: 'missing',
      stale: true,
      readAt: 1000,
    });
    expect(reason).toContain('/r/a.ts');
    expect(reason.toLowerCase()).toMatch(/missing|unreadable|moved|deleted/);
  });

  it("safe-default for 'fresh' / 'no-read' (defensive)", () => {
    expect(buildStaleWriteReason('/r/a.ts', { kind: 'fresh', stale: false, readAt: 0 })).toContain('no stale-write check');
    expect(buildStaleWriteReason('/r/a.ts', { kind: 'no-read', stale: false })).toContain('no stale-write check');
  });
});
