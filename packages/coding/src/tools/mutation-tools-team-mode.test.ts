/**
 * FEATURE_125 (v0.7.41) W2 — Edit / MultiEdit / Write tool wiring tests.
 *
 * Covers the three new behaviors each mutation tool gained:
 *   1. `checkStale` hard gate before mutating (Layer 4).
 *   2. `recordWrite` after successful mutation (cache stays consistent
 *      across self-edits).
 *   3. `formatActiveFileWarning` soft banner prepended when sibling
 *      session is editing the same path (Layer 3).
 *
 * Hermetic: real fs in a temp dir, real ContentHashCache, fabricated
 * `siblingSnapshot` (no actual sibling process).
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { DiscoveredInstance, SessionMeta } from '@kodax-ai/agent';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createContentHashCache } from '../multi-instance/content-hash-cache.js';
import { toolEdit } from './edit.js';
import { toolMultiEdit } from './multi-edit.js';
import { toolWrite } from './write.js';
import type { KodaXToolExecutionContext } from '../types.js';

const baseMeta: SessionMeta = {
  cwd: '/tmp/test',
  startedAt: 1_700_000_000_000,
  gitBranch: 'main',
};

function makeSibling(pid: number, activeFiles: string[], intent?: string): DiscoveredInstance {
  return {
    pid,
    state: {
      version: '1',
      pid,
      updatedAt: 1_700_000_500_000,
      meta: baseMeta,
      agentPhase: 'running_tool',
      activeFiles,
      ...(intent !== undefined ? { currentIntent: intent } : {}),
    },
    heartbeatMtimeMs: 1_700_000_500_000,
  };
}

describe('FEATURE_125 W2 — write tool', () => {
  let tempDir: string;
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-w2-write-'));
  });
  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('blocks an overwrite when the file has been peer-modified since the recorded read', async () => {
    const filePath = path.join(tempDir, 'foo.ts');
    await fs.writeFile(filePath, 'v1', 'utf-8');

    const cache = createContentHashCache();
    cache.recordRead(filePath, 'v1');

    // Peer (or user) writes v2.
    await fs.writeFile(filePath, 'v2', 'utf-8');

    const ctx: KodaXToolExecutionContext = {
      backups: new Map(),
      executionCwd: tempDir,
      contentHashCache: cache,
    };
    const result = await toolWrite({ path: filePath, content: 'v3-from-llm' }, ctx);
    expect(result).toContain('[Tool Error]');
    expect(result).toContain('has changed since you last read it');
    // Disk content must not have been overwritten.
    expect(await fs.readFile(filePath, 'utf-8')).toBe('v2');
  });

  it('proceeds normally when the cache is unwired (solo-mode regression guard)', async () => {
    const filePath = path.join(tempDir, 'foo.ts');
    await fs.writeFile(filePath, 'old', 'utf-8');
    const ctx: KodaXToolExecutionContext = {
      backups: new Map(),
      executionCwd: tempDir,
    };
    const result = await toolWrite({ path: filePath, content: 'new' }, ctx);
    expect(result).toContain('File updated');
    expect(await fs.readFile(filePath, 'utf-8')).toBe('new');
  });

  it('records the post-write hash so a follow-up self-edit does not false-alarm', async () => {
    const filePath = path.join(tempDir, 'foo.ts');
    await fs.writeFile(filePath, 'v1', 'utf-8');
    const cache = createContentHashCache();
    cache.recordRead(filePath, 'v1');

    const ctx: KodaXToolExecutionContext = {
      backups: new Map(),
      executionCwd: tempDir,
      contentHashCache: cache,
    };
    await toolWrite({ path: filePath, content: 'v2' }, ctx);
    expect(cache.getRecordedHash(filePath)).toBeDefined();
    // The next checkStale should be fresh — the cache now holds v2.
    expect(cache.checkStale(filePath).kind).toBe('fresh');
  });

  it('prepends an active-file warning when a sibling is editing the same path', async () => {
    const filePath = path.join(tempDir, 'foo.ts');
    await fs.writeFile(filePath, 'old', 'utf-8');
    const siblings = [makeSibling(2222, [filePath], 'editing foo')];
    const ctx: KodaXToolExecutionContext = {
      backups: new Map(),
      executionCwd: tempDir,
      siblingSnapshot: siblings,
    };
    const result = await toolWrite({ path: filePath, content: 'new' }, ctx);
    expect(result).toContain('[Warning: Another session is editing this file]');
    expect(result).toContain('pid 2222');
    // The actual write still happened.
    expect(await fs.readFile(filePath, 'utf-8')).toBe('new');
  });

  it("does NOT prepend warning when sibling's activeFiles do not match", async () => {
    const filePath = path.join(tempDir, 'foo.ts');
    await fs.writeFile(filePath, 'old', 'utf-8');
    const siblings = [makeSibling(2222, ['/tmp/other.ts'])];
    const ctx: KodaXToolExecutionContext = {
      backups: new Map(),
      executionCwd: tempDir,
      siblingSnapshot: siblings,
    };
    const result = await toolWrite({ path: filePath, content: 'new' }, ctx);
    expect(result).not.toContain('[Warning');
  });

  it('new-file creation skips the stale check (cache miss → no-read is the natural path)', async () => {
    const filePath = path.join(tempDir, 'new.ts');
    const cache = createContentHashCache();
    const ctx: KodaXToolExecutionContext = {
      backups: new Map(),
      executionCwd: tempDir,
      contentHashCache: cache,
    };
    const result = await toolWrite({ path: filePath, content: 'fresh' }, ctx);
    expect(result).toContain('File created');
    expect(await fs.readFile(filePath, 'utf-8')).toBe('fresh');
  });
});

describe('FEATURE_125 W2 — edit tool', () => {
  let tempDir: string;
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-w2-edit-'));
  });
  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('blocks an edit when the file has been peer-modified since the recorded read', async () => {
    const filePath = path.join(tempDir, 'foo.ts');
    await fs.writeFile(filePath, 'const v = 1;', 'utf-8');
    const cache = createContentHashCache();
    cache.recordRead(filePath, 'const v = 1;');

    await fs.writeFile(filePath, 'const v = 1; // peer wrote', 'utf-8');

    const ctx: KodaXToolExecutionContext = {
      backups: new Map(),
      executionCwd: tempDir,
      contentHashCache: cache,
    };
    const result = await toolEdit(
      { path: filePath, old_string: 'const v = 1;', new_string: 'const v = 2;' },
      ctx,
    );
    expect(result).toContain('[Tool Error] edit:');
    expect(result).toContain('has changed since you last read it');
    expect(await fs.readFile(filePath, 'utf-8')).toBe('const v = 1; // peer wrote');
  });

  it('proceeds normally when the cache is unwired (solo-mode regression guard)', async () => {
    const filePath = path.join(tempDir, 'foo.ts');
    await fs.writeFile(filePath, 'const v = 1;', 'utf-8');
    const ctx: KodaXToolExecutionContext = {
      backups: new Map(),
      executionCwd: tempDir,
    };
    const result = await toolEdit(
      { path: filePath, old_string: 'const v = 1;', new_string: 'const v = 2;' },
      ctx,
    );
    expect(result).toContain('File edited');
    expect(await fs.readFile(filePath, 'utf-8')).toBe('const v = 2;');
  });

  it('records post-edit hash so self-chain edits stay fresh', async () => {
    const filePath = path.join(tempDir, 'foo.ts');
    await fs.writeFile(filePath, 'a = 1; b = 2;', 'utf-8');
    const cache = createContentHashCache();
    cache.recordRead(filePath, 'a = 1; b = 2;');

    const ctx: KodaXToolExecutionContext = {
      backups: new Map(),
      executionCwd: tempDir,
      contentHashCache: cache,
    };
    await toolEdit({ path: filePath, old_string: 'a = 1', new_string: 'a = 10' }, ctx);
    expect(cache.checkStale(filePath).kind).toBe('fresh');
    // Second self-edit should NOT trip stale alarm.
    const result2 = await toolEdit(
      { path: filePath, old_string: 'b = 2', new_string: 'b = 20' },
      ctx,
    );
    expect(result2).toContain('File edited');
  });

  it('prepends the active-file warning when sibling overlap exists', async () => {
    const filePath = path.join(tempDir, 'foo.ts');
    await fs.writeFile(filePath, 'x = 1;', 'utf-8');
    const siblings = [makeSibling(3333, [filePath], 'concurrent edit')];
    const ctx: KodaXToolExecutionContext = {
      backups: new Map(),
      executionCwd: tempDir,
      siblingSnapshot: siblings,
    };
    const result = await toolEdit(
      { path: filePath, old_string: 'x = 1', new_string: 'x = 2' },
      ctx,
    );
    expect(result).toContain('[Warning: Another session is editing this file]');
    expect(result).toContain('pid 3333');
    expect(result).toContain('File edited');
  });
});

describe('FEATURE_125 W2 — multi_edit tool', () => {
  let tempDir: string;
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-w2-medit-'));
  });
  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('blocks the batch when the file has been peer-modified since the recorded read', async () => {
    const filePath = path.join(tempDir, 'foo.ts');
    await fs.writeFile(filePath, 'a = 1\nb = 2\nc = 3\n', 'utf-8');
    const cache = createContentHashCache();
    cache.recordRead(filePath, 'a = 1\nb = 2\nc = 3\n');

    await fs.writeFile(filePath, 'a = 1\nb = 2\nc = 99\n', 'utf-8'); // peer

    const ctx: KodaXToolExecutionContext = {
      backups: new Map(),
      executionCwd: tempDir,
      contentHashCache: cache,
    };
    const result = await toolMultiEdit(
      {
        path: filePath,
        edits: [
          { old_string: 'a = 1', new_string: 'a = 10' },
          { old_string: 'b = 2', new_string: 'b = 20' },
        ],
      },
      ctx,
    );
    expect(result).toContain('[Tool Error] multi_edit:');
    expect(result).toContain('has changed since you last read it');
    // Atomicity: no edit landed.
    expect(await fs.readFile(filePath, 'utf-8')).toBe('a = 1\nb = 2\nc = 99\n');
  });

  it('records post-batch hash so subsequent edits stay fresh', async () => {
    const filePath = path.join(tempDir, 'foo.ts');
    await fs.writeFile(filePath, 'a = 1\nb = 2\n', 'utf-8');
    const cache = createContentHashCache();
    cache.recordRead(filePath, 'a = 1\nb = 2\n');

    const ctx: KodaXToolExecutionContext = {
      backups: new Map(),
      executionCwd: tempDir,
      contentHashCache: cache,
    };
    await toolMultiEdit(
      {
        path: filePath,
        edits: [
          { old_string: 'a = 1', new_string: 'a = 10' },
          { old_string: 'b = 2', new_string: 'b = 20' },
        ],
      },
      ctx,
    );
    expect(cache.checkStale(filePath).kind).toBe('fresh');
  });

  it('prepends the active-file warning when sibling overlap exists', async () => {
    const filePath = path.join(tempDir, 'foo.ts');
    await fs.writeFile(filePath, 'a = 1\nb = 2\n', 'utf-8');
    const siblings = [makeSibling(4444, [filePath], 'concurrent batch')];
    const ctx: KodaXToolExecutionContext = {
      backups: new Map(),
      executionCwd: tempDir,
      siblingSnapshot: siblings,
    };
    const result = await toolMultiEdit(
      {
        path: filePath,
        edits: [{ old_string: 'a = 1', new_string: 'a = 10' }],
      },
      ctx,
    );
    expect(result).toContain('[Warning: Another session is editing this file]');
    expect(result).toContain('pid 4444');
    expect(result).toContain('File edited');
  });

  it('proceeds normally when the cache is unwired', async () => {
    const filePath = path.join(tempDir, 'foo.ts');
    await fs.writeFile(filePath, 'a = 1\n', 'utf-8');
    const ctx: KodaXToolExecutionContext = {
      backups: new Map(),
      executionCwd: tempDir,
    };
    const result = await toolMultiEdit(
      {
        path: filePath,
        edits: [{ old_string: 'a = 1', new_string: 'a = 10' }],
      },
      ctx,
    );
    expect(result).toContain('File edited');
  });
});
