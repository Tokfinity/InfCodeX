/**
 * FEATURE_247 (R6) — imperative compactSession.
 *
 * Covers the non-LLM paths (never-throws + no-op + manager exposure). The full
 * summarize-and-rewrite path calls the provider LLM and is exercised by the
 * REPL /compact command's own coverage; here we lock the SDK contract shape.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { FileSessionStorage } from '../interactive/storage.js';
import { compactSession } from './compact-session.js';
import { createSessionManager } from './public-api.js';

function tmpDir(label: string): string {
  const dir = path.join(os.tmpdir(), `kodax-compact-${label}-${process.pid}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe('FEATURE_247 R6: compactSession', () => {
  it('returns compacted:false with a reason for a missing session (never throws)', async () => {
    const r = await compactSession('does-not-exist', { sessionsDir: tmpDir('missing') });
    expect(r.compacted).toBe(false);
    expect(r.reason).toContain('not found');
    expect(r.messages).toEqual([]);
  });

  it('is a no-op (no rewrite) for a session too small to compact', async () => {
    const storage = new FileSessionStorage({ sessionsDir: tmpDir('tiny') });
    await storage.save('tiny', {
      messages: [{ role: 'user', content: 'hi' }],
      title: 'Tiny',
      gitRoot: '/tmp/x',
    });

    const r = await compactSession('tiny', { storage, provider: 'anthropic' });

    expect(r.compacted).toBe(false);
    expect(r.reason).toBe('no compaction needed');
    // The session is left untouched.
    const after = await storage.load('tiny');
    expect(after?.messages.length).toBe(1);
  });

  it('createSessionManager exposes a compactSession method', () => {
    const mgr = createSessionManager({ sessionsDir: tmpDir('mgr') });
    expect(typeof mgr.compactSession).toBe('function');
  });
});
