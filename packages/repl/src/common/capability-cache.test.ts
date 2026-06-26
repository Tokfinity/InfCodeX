import { describe, expect, it } from 'vitest';
import type { KodaXReasoningProfile } from '@kodax-ai/coding';
import {
  addRejectedEffort,
  capabilityCacheKey,
  getRejectedEfforts,
  narrowReasoningProfile,
  removeCacheEntry,
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
