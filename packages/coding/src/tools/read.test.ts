import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyToolResultGuardrail } from './tool-result-policy.js';
import { DEFAULT_TOOL_OUTPUT_MAX_BYTES } from './truncate.js';
import { toolRead } from './read.js';

describe('toolRead', () => {
  let tempDir = '';

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-read-'));
  });

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
      tempDir = '';
    }
  });

  it('streams a bounded first chunk for large files and hints continuation', async () => {
    const filePath = path.join(tempDir, 'large.txt');
    const content = Array.from({ length: 4000 }, (_, index) => `line-${index + 1}-${'x'.repeat(90)}`).join('\n');
    await fs.writeFile(filePath, content, 'utf-8');

    const result = await toolRead({ path: filePath }, {
      backups: new Map(),
      executionCwd: tempDir,
    });

    expect(result).toContain('line-1');
    expect(result).toContain('Use offset=');
    expect(result).toContain('Large file:');
  });

  it('keeps the exact continuation hint after the global read guardrail runs', async () => {
    const filePath = path.join(tempDir, 'guarded-large.txt');
    const content = Array.from(
      { length: 2200 },
      (_, index) => `line-${index + 1}-${'x'.repeat(120)}`,
    ).join('\n');
    await fs.writeFile(filePath, content, 'utf-8');

    const result = await toolRead({ path: filePath }, {
      backups: new Map(),
      executionCwd: tempDir,
    });
    const guarded = await applyToolResultGuardrail('read', result, {
      backups: new Map(),
      executionCwd: tempDir,
    });

    expect(Buffer.byteLength(result, 'utf-8')).toBeLessThanOrEqual(DEFAULT_TOOL_OUTPUT_MAX_BYTES);
    expect(result).toContain('Use offset=');
    expect(guarded.truncated).toBe(false);
    expect(guarded.content).toContain('Use offset=');
  });

  it('supports offset-based continuation', async () => {
    const filePath = path.join(tempDir, 'offset.txt');
    const content = Array.from({ length: 20 }, (_, index) => `line-${index + 1}`).join('\n');
    await fs.writeFile(filePath, content, 'utf-8');

    const result = await toolRead({ path: filePath, offset: 10, limit: 3 }, {
      backups: new Map(),
      executionCwd: tempDir,
    });

    expect(result).toContain('line-10');
    expect(result).toContain('line-12');
    expect(result).not.toContain('line-9');
  });

  it('rejects binary files', async () => {
    const filePath = path.join(tempDir, 'binary.bin');
    await fs.writeFile(filePath, Buffer.from([0, 159, 146, 150]));

    const result = await toolRead({ path: filePath }, {
      backups: new Map(),
      executionCwd: tempDir,
    });

    expect(result).toContain('Binary file not supported');
  });

  // 2026-05-20 — claudecode parity: `read` on image extensions returns a
  // multimodal `tool_result` content array (text descriptor + image block)
  // instead of the legacy `[Tool Error] Binary file not supported`. This
  // is the fail-safe that lets the model actually see attached images
  // even when it routes through the read tool (e.g., post-compaction
  // when the original inline image block was stripped to a marker).
  describe('image branch (claudecode parity)', () => {
    it('returns a multimodal content array for PNG files (not a Binary-error string)', async () => {
      const filePath = path.join(tempDir, 'pic.png');
      // 89 50 4E 47 = "\x89PNG" magic. Bytes after are filler for
      // `formatSize` to render something reasonable.
      await fs.writeFile(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array(120).fill(0)]));

      const result = await toolRead({ path: filePath }, {
        backups: new Map(),
        executionCwd: tempDir,
      });

      // Critical: must NOT hit the binary-error fallback.
      expect(typeof result).not.toBe('string');
      expect(Array.isArray(result)).toBe(true);

      const items = result as ReadonlyArray<{ type: string; text?: string; path?: string; mediaType?: string }>;
      expect(items).toHaveLength(2);

      expect(items[0]).toMatchObject({ type: 'text' });
      expect(items[0].text).toContain('image/png');
      expect(items[0].text).toContain(filePath);

      expect(items[1]).toMatchObject({
        type: 'image',
        path: filePath,
        mediaType: 'image/png',
      });
    });

    it.each<[string, string]>([
      ['.jpg', 'image/jpeg'],
      ['.jpeg', 'image/jpeg'],
      ['.gif', 'image/gif'],
      ['.webp', 'image/webp'],
    ])('handles %s as %s', async (ext, expectedMime) => {
      const filePath = path.join(tempDir, `pic${ext}`);
      await fs.writeFile(filePath, Buffer.from(Array(64).fill(0xff)));

      const result = await toolRead({ path: filePath }, {
        backups: new Map(),
        executionCwd: tempDir,
      });

      expect(Array.isArray(result)).toBe(true);
      const items = result as ReadonlyArray<{ type: string; mediaType?: string }>;
      expect(items[1]).toMatchObject({ type: 'image', mediaType: expectedMime });
    });

    it('returns a text error (not the multimodal array) for images over the 10 MB cap', async () => {
      const filePath = path.join(tempDir, 'huge.png');
      // 11 MB > READ_IMAGE_MAX_BYTES (10 MB)
      await fs.writeFile(filePath, Buffer.alloc(11 * 1024 * 1024, 0xff));

      const result = await toolRead({ path: filePath }, {
        backups: new Map(),
        executionCwd: tempDir,
      });

      expect(typeof result).toBe('string');
      expect(result).toContain('Image too large to inline');
      expect(result).toContain('Resize before reading');
    });
  });

  // FEATURE_125 v0.7.41 — Read tool records the on-disk content hash
  // when `ctx.contentHashCache` is wired, so a subsequent
  // Edit/Write tool's `checkStale` can detect cross-session races.
  describe('FEATURE_125 — contentHashCache integration', () => {
    it('records the content hash after a successful read when ctx.contentHashCache is wired', async () => {
      const { createContentHashCache } = await import('../multi-instance/content-hash-cache.js');
      const cache = createContentHashCache();
      const filePath = path.join(tempDir, 'hashed.txt');
      await fs.writeFile(filePath, 'hello world\n', 'utf-8');

      const result = await toolRead({ path: filePath }, {
        backups: new Map(),
        executionCwd: tempDir,
        contentHashCache: cache,
      });

      // Tool output is unchanged by the hash recording.
      expect(result).toContain('hello world');
      // After read, the cache holds the hash → checkStale returns 'fresh'.
      expect(cache.checkStale(filePath).kind).toBe('fresh');

      // A peer modifies the file → cache flips to 'stale'.
      await fs.writeFile(filePath, 'hello world v2\n', 'utf-8');
      expect(cache.checkStale(filePath).kind).toBe('stale');
    });

    it('is a no-op when ctx.contentHashCache is absent (no regression on solo mode)', async () => {
      const filePath = path.join(tempDir, 'unhashed.txt');
      await fs.writeFile(filePath, 'content', 'utf-8');

      // No contentHashCache on ctx → tool path proceeds unchanged.
      const result = await toolRead({ path: filePath }, {
        backups: new Map(),
        executionCwd: tempDir,
      });
      expect(result).toContain('content');
    });

    it('swallows hash-recording errors so a transient I/O failure never breaks the tool', async () => {
      const filePath = path.join(tempDir, 'ok.txt');
      await fs.writeFile(filePath, 'good', 'utf-8');

      // Inject a cache whose recordRead throws — the tool must still return.
      const fakeCache = {
        recordRead: () => {
          throw new Error('synthetic recordRead failure');
        },
        checkStale: () => ({ kind: 'no-read', stale: false }) as const,
        recordWrite: () => undefined,
        forget: () => undefined,
        getReadAt: () => undefined,
        getRecordedHash: () => undefined,
      };

      const result = await toolRead({ path: filePath }, {
        backups: new Map(),
        executionCwd: tempDir,
        contentHashCache: fakeCache,
      });
      expect(result).toContain('good');
    });

    it('skips recording for files above READ_HASH_MAX_BYTES (5 MB)', async () => {
      const { createContentHashCache } = await import('../multi-instance/content-hash-cache.js');
      const cache = createContentHashCache();
      const filePath = path.join(tempDir, 'huge.txt');
      // 6 MB of one-char lines.
      const bigContent = ('x\n'.repeat(3_000_000));
      await fs.writeFile(filePath, bigContent, 'utf-8');

      await toolRead({ path: filePath, limit: 10 }, {
        backups: new Map(),
        executionCwd: tempDir,
        contentHashCache: cache,
      });

      // File > 5 MB threshold → recordRead skipped → no hash captured.
      expect(cache.getRecordedHash(filePath)).toBeUndefined();
      expect(cache.checkStale(filePath).kind).toBe('no-read');
    });
  });
});
