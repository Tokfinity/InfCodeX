import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { WorkflowTaskResult } from '@kodax-ai/agent';
import { afterEach, describe, expect, it } from 'vitest';

import { createFsResultCache } from './result-cache.js';

const RESULT = (text: string): WorkflowTaskResult => ({
  taskId: 't1',
  name: 'agent',
  status: 'completed',
  finalText: text,
});

describe('createFsResultCache (FEATURE_246 Part D)', () => {
  const dirs: string[] = [];
  const mk = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'kodax-result-cache-'));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('round-trips set/get within a run and persists under results/', () => {
    const runDir = mk();
    const cache = createFsResultCache(runDir);
    expect(cache.get('abc#0')).toBeUndefined();
    cache.set('abc#0', RESULT('hello'));
    expect(cache.get('abc#0')?.finalText).toBe('hello');
    expect(existsSync(join(runDir, 'results', 'abc_0.json'))).toBe(true);
  });

  it('seeds from a prior run dir and copies a hit forward into the current run', () => {
    const prior = mk();
    createFsResultCache(prior).set('k#0', RESULT('from-prior'));

    const current = mk();
    const resumed = createFsResultCache(current, { readFrom: prior });
    expect(resumed.get('k#0')?.finalText).toBe('from-prior');
    // Copy-forward: the resumed run dir is now self-contained for a further resume.
    expect(existsSync(join(current, 'results', 'k_0.json'))).toBe(true);
  });

  it('returns undefined for a missing key and for a corrupt entry', () => {
    const runDir = mk();
    const cache = createFsResultCache(runDir);
    expect(cache.get('missing#0')).toBeUndefined();
    // Corrupt JSON → treated as a miss (effect re-runs live), not a throw.
    mkdirSync(join(runDir, 'results'), { recursive: true });
    writeFileSync(join(runDir, 'results', 'bad_0.json'), '{not json', 'utf8');
    expect(cache.get('bad#0')).toBeUndefined();
  });

  it('own (current-run) entry wins over the prior run', () => {
    const prior = mk();
    createFsResultCache(prior).set('k#0', RESULT('prior'));
    const current = mk();
    const cache = createFsResultCache(current, { readFrom: prior });
    cache.set('k#0', RESULT('current'));
    expect(cache.get('k#0')?.finalText).toBe('current');
  });
});
