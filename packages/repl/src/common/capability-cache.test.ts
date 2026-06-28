import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setAgentConfigHome } from '@kodax-ai/agent';
import type { KodaXReasoningProfile } from '@kodax-ai/coding';
import {
  addRejectedEffort,
  capabilityCacheKey,
  clearCapabilityCache,
  getCachedRejectedEfforts,
  getRejectedEfforts,
  loadCapabilityCache,
  narrowReasoningProfile,
  recordRejectedEffort,
  removeCacheEntry,
  resetCapabilityCacheMemoForTesting,
  type CapabilityCache,
} from './capability-cache.js';

const glmProfile: KodaXReasoningProfile = {
  effortStrategy: 'openai-chat-effort',
  thinkingStrategy: 'provider-toggle',
  defaultEffort: 'max',
  supportedEfforts: [
    { value: 'none' },
    { value: 'low' },
    { value: 'high', isDefault: true },
    { value: 'xhigh' },
    { value: 'max' },
  ],
  localRejectEfforts: [],
};

describe('narrowReasoningProfile', () => {
  it('returns the same profile when nothing is rejected', () => {
    expect(narrowReasoningProfile(glmProfile, [])).toBe(glmProfile);
  });

  it('drops rejected efforts from supportedEfforts and folds them into localRejectEfforts', () => {
    const narrowed = narrowReasoningProfile(glmProfile, ['max']);
    expect(narrowed.supportedEfforts?.map((p) => p.value)).toEqual([
      'none', 'low', 'high', 'xhigh',
    ]);
    expect(narrowed.localRejectEfforts).toContain('max');
  });

  it('does not mutate the input profile', () => {
    narrowReasoningProfile(glmProfile, ['max']);
    expect(glmProfile.supportedEfforts?.map((p) => p.value)).toContain('max');
    expect(glmProfile.localRejectEfforts).toEqual([]);
  });
});

describe('capability cache IO', () => {
  let tempHome = '';
  let cacheFile = '';

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'kodax-cap-cache-'));
    setAgentConfigHome(tempHome);
    resetCapabilityCacheMemoForTesting();
    cacheFile = join(tempHome, 'capability-cache.json');
  });

  afterEach(() => {
    resetCapabilityCacheMemoForTesting();
    setAgentConfigHome(undefined);
    if (tempHome) {
      rmSync(tempHome, { recursive: true, force: true });
      tempHome = '';
    }
  });

  it('resets to an empty cache when the on-disk JSON is corrupt', () => {
    writeFileSync(cacheFile, '{not json', 'utf8');
    expect(loadCapabilityCache()).toEqual({});
  });

  it('sanitizes on-disk entries before exposing them', () => {
    writeFileSync(
      cacheFile,
      JSON.stringify({
        'p/m': {
          rejected: ['max', 42, 'xhigh'],
          source: 'unknown',
          updatedAt: 123,
        },
      }),
      'utf8',
    );

    expect(loadCapabilityCache()['p/m']).toEqual({
      rejected: ['max', 'xhigh'],
      source: 'observed',
      updatedAt: '',
    });
  });

  it('memoizes reads until the test hook resets the memo', () => {
    writeFileSync(
      cacheFile,
      JSON.stringify({ 'p/m': { rejected: ['low'], source: 'observed', updatedAt: 'T0' } }),
      'utf8',
    );
    expect(getCachedRejectedEfforts('p', 'm')).toEqual(['low']);

    writeFileSync(
      cacheFile,
      JSON.stringify({ 'p/m': { rejected: ['high'], source: 'observed', updatedAt: 'T1' } }),
      'utf8',
    );
    expect(getCachedRejectedEfforts('p', 'm')).toEqual(['low']);

    resetCapabilityCacheMemoForTesting();
    expect(getCachedRejectedEfforts('p', 'm')).toEqual(['high']);
  });

  it('writes through to the active config home', () => {
    recordRejectedEffort('p', 'm', 'max', 'observed', 'T0');

    expect(existsSync(cacheFile)).toBe(true);
    const raw = JSON.parse(readFileSync(cacheFile, 'utf8')) as CapabilityCache;
    expect(raw['p/m']?.rejected).toEqual(['max']);

    clearCapabilityCache('p', 'm');
    const cleared = JSON.parse(readFileSync(cacheFile, 'utf8')) as CapabilityCache;
    expect(cleared['p/m']).toBeUndefined();
  });
});

describe('capability cache pure ops', () => {
  it('records a rejection immutably, keyed by provider/model', () => {
    const cache: CapabilityCache = {};
    const next = addRejectedEffort(cache, 'zhipu-coding', 'glm-5.2', 'max', 'observed', 'T0');
    expect(cache).toEqual({}); // input untouched
    expect(getRejectedEfforts(next, 'zhipu-coding', 'glm-5.2')).toEqual(['max']);
    expect(next[capabilityCacheKey('zhipu-coding', 'glm-5.2')]?.source).toBe('observed');
  });

  it('de-dupes a repeated rejection', () => {
    let cache: CapabilityCache = {};
    cache = addRejectedEffort(cache, 'p', 'm', 'max', 'observed', 'T0');
    cache = addRejectedEffort(cache, 'p', 'm', 'max', 'probed', 'T1');
    expect(getRejectedEfforts(cache, 'p', 'm')).toEqual(['max']);
    expect(cache['p/m']?.source).toBe('probed'); // latest writer wins for source/time
  });

  it('removes one entry or the whole cache', () => {
    let cache: CapabilityCache = {};
    cache = addRejectedEffort(cache, 'p', 'm1', 'max', 'observed', 'T0');
    cache = addRejectedEffort(cache, 'p', 'm2', 'xhigh', 'observed', 'T0');
    expect(removeCacheEntry(cache, 'p', 'm1')['p/m2']).toBeDefined();
    expect(removeCacheEntry(cache, 'p', 'm1')['p/m1']).toBeUndefined();
    expect(removeCacheEntry(cache)).toEqual({}); // no key → clear all
  });
});
