import { describe, expect, it } from 'vitest';
import type { KodaXReasoningProfile } from './types.js';
import {
  addRejectedEffort,
  capabilityCacheKey,
  getRejectedEfforts,
  narrowReasoningProfile,
  removeCacheEntry,
  sanitizeCapabilityCache,
  type CapabilityCache,
} from './capability-learning.js';

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
    expect(narrowed.supportedEfforts?.map((preset) => preset.value)).toEqual([
      'none', 'low', 'high', 'xhigh',
    ]);
    expect(narrowed.localRejectEfforts).toContain('max');
  });

  it('clears defaultEffort when the learned rejection removes that default rung', () => {
    const narrowed = narrowReasoningProfile(glmProfile, ['max']);
    expect(narrowed.defaultEffort).toBeUndefined();
  });

  it('does not mutate the input profile', () => {
    narrowReasoningProfile(glmProfile, ['max']);
    expect(glmProfile.supportedEfforts?.map((preset) => preset.value)).toContain('max');
    expect(glmProfile.localRejectEfforts).toEqual([]);
  });
});

describe('capability cache pure operations', () => {
  it('records a rejection immutably, keyed by provider/model', () => {
    const cache: CapabilityCache = {};
    const next = addRejectedEffort(cache, 'zhipu-coding', 'glm-5.2', 'max', 'observed', 'T0');

    expect(cache).toEqual({});
    expect(capabilityCacheKey('zhipu-coding', 'glm-5.2')).toBe('zhipu-coding/glm-5.2');
    expect(getRejectedEfforts(next, 'zhipu-coding', 'glm-5.2')).toEqual(['max']);
    expect(next['zhipu-coding/glm-5.2']?.source).toBe('observed');
  });

  it('de-dupes a repeated rejection while keeping latest source metadata', () => {
    let cache: CapabilityCache = {};
    cache = addRejectedEffort(cache, 'p', 'm', 'max', 'observed', 'T0');
    cache = addRejectedEffort(cache, 'p', 'm', 'max', 'probed', 'T1');

    expect(getRejectedEfforts(cache, 'p', 'm')).toEqual(['max']);
    expect(cache['p/m']).toMatchObject({ source: 'probed', updatedAt: 'T1' });
  });

  it('removes one entry or clears the whole cache', () => {
    let cache: CapabilityCache = {};
    cache = addRejectedEffort(cache, 'p', 'm1', 'max', 'observed', 'T0');
    cache = addRejectedEffort(cache, 'p', 'm2', 'xhigh', 'observed', 'T0');

    expect(removeCacheEntry(cache, 'p', 'm1')['p/m2']).toBeDefined();
    expect(removeCacheEntry(cache, 'p', 'm1')['p/m1']).toBeUndefined();
    expect(removeCacheEntry(cache)).toEqual({});
  });

  it('sanitizes untrusted on-disk data without throwing', () => {
    expect(sanitizeCapabilityCache(null)).toEqual({});
    expect(sanitizeCapabilityCache({
      'p/m': {
        rejected: ['max', 42, 'xhigh'],
        source: 'unknown',
        updatedAt: 123,
      },
      broken: 42,
    })).toEqual({
      'p/m': {
        rejected: ['max', 'xhigh'],
        source: 'observed',
        updatedAt: '',
      },
    });
  });
});
