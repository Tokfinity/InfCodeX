import { describe, expect, it } from 'vitest';

import type { ReasoningPlan } from '../../../reasoning.js';
import type { KodaXOptions } from '../../../types.js';
import { createManagedBudgetController } from './budget.js';

function reasoningPlan(harnessProfile: 'H0_DIRECT' | 'H1_EXECUTE_EVAL' | 'H2_PLAN_EXECUTE_EVAL'): ReasoningPlan {
  return {
    mode: 'off',
    depth: 'off',
    decision: {
      primaryTask: 'conversation',
      harnessProfile,
    },
    promptOverlay: '',
  } as unknown as ReasoningPlan;
}

describe('createManagedBudgetController', () => {
  it('treats AMAW as a managed AMA-family mode for budget selection', () => {
    const controller = createManagedBudgetController(
      {} as KodaXOptions,
      reasoningPlan('H2_PLAN_EXECUTE_EVAL'),
      'amaw',
    );

    expect(controller.currentHarness).toBe('H2_PLAN_EXECUTE_EVAL');
  });
});
