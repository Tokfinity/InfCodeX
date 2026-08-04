import { describe, expect, it } from 'vitest';

import { buildManagedProgressGateReminder } from './managed-progress-gate.js';

describe('managed semantic-progress checkpoints', () => {
  it.each([1, 11, 13, 23, 25, 39, 41])(
    'emits nothing outside a checkpoint (iteration %i)',
    (iteration) => {
      expect(buildManagedProgressGateReminder(iteration)).toBeUndefined();
    },
  );

  it('requires hypothesis invalidation at iteration 12', () => {
    const reminder = buildManagedProgressGateReminder(12);
    expect(reminder).toContain('SEMANTIC PROGRESS CHECKPOINT 12');
    expect(reminder).toContain('disconfirming evidence');
    expect(reminder).toContain('invalidate it now');
    expect(reminder).toContain('Do not re-verify facts already established');
  });

  it('forces a pivot or conclusion at iteration 24', () => {
    const reminder = buildManagedProgressGateReminder(24);
    expect(reminder).toContain('SEMANTIC PROGRESS CHECKPOINT 24');
    expect(reminder).toContain('pivot');
    expect(reminder).toContain('diagnosis/report only');
  });

  it('stops broad exploration at iteration 40', () => {
    const reminder = buildManagedProgressGateReminder(40);
    expect(reminder).toContain('SEMANTIC PROGRESS CHECKPOINT 40');
    expect(reminder).toContain('Stop broad exploratory probing');
    expect(reminder).toContain('Do not invent more scope');
  });
});
