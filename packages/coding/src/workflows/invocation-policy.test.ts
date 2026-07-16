import { describe, expect, it } from 'vitest';

import {
  decideWorkflowInvocation,
  workflowStartOutcomeConsumesTurn,
} from './invocation-policy.js';

describe('decideWorkflowInvocation', () => {
  // FEATURE_246 A5 (ADR-047): the launch decision is the source alone. An
  // explicit /workflow command suggests; all natural language defers to the
  // agent (AMA/AMAW Workers author via the run_workflow tool; SA has no host).
  it('suggests a workflow only for an explicit /workflow command', () => {
    expect(decideWorkflowInvocation({ source: 'command' })).toEqual({ action: 'suggest' });
  });

  it('never intercepts natural language — defers to the agent', () => {
    expect(decideWorkflowInvocation({ source: 'natural-language' })).toEqual({ action: 'none' });
  });

  it('only consumes turns for started or cancelled workflow outcomes', () => {
    expect(workflowStartOutcomeConsumesTurn({ outcome: 'started' })).toBe(true);
    expect(workflowStartOutcomeConsumesTurn({ outcome: 'cancelled' })).toBe(true);
    expect(workflowStartOutcomeConsumesTurn({ outcome: 'failed' })).toBe(false);
    expect(workflowStartOutcomeConsumesTurn({ outcome: 'declined' })).toBe(false);
  });
});
