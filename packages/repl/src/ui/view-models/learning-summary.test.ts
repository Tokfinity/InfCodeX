import { describe, expect, it } from 'vitest';

import { formatLearningRecoverySummary, formatLearningStatus } from './learning-summary.js';

describe('learning text surfaces', () => {
  it('formats the full inventory for status output', () => {
    expect(formatLearningStatus({
      ready: 1,
      newlyActive: 2,
      attention: 3,
      active: 6,
      revision: 12,
    })).toBe('ready=1  new=2  attention=3  active=6');
  });

  it('only emits a startup recovery summary for actionable state', () => {
    expect(formatLearningRecoverySummary({
      ready: 0, newlyActive: 0, attention: 0, active: 6, revision: 12,
    })).toBeUndefined();
    expect(formatLearningRecoverySummary({
      ready: 1, newlyActive: 0, attention: 0, active: 6, revision: 12,
    })).toContain('Learning recovery: ready=1');
  });
});
