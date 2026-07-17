import { describe, expect, it } from 'vitest';

import {
  decideWorkflowInvocation,
  hasExplicitNaturalLanguageWorkflowIntent,
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

  it.each([
    'Use the named scoped-review Workflow.',
    '请使用 Workflow 完成这个审查。',
    'Launch two Workflows for comparison.',
  ])('recognizes an explicit natural-language Workflow surface: %s', (input) => {
    expect(hasExplicitNaturalLanguageWorkflowIntent(input)).toBe(true);
  });

  it.each([
    'Review three independent dimensions and synthesize the result.',
    'Audit this complex parallel change.',
    'Explain the run_workflow tool definition.',
  ])('does not infer Workflow intent from complexity or an identifier: %s', (input) => {
    expect(hasExplicitNaturalLanguageWorkflowIntent(input)).toBe(false);
  });

  it('only consumes turns for started or cancelled workflow outcomes', () => {
    expect(workflowStartOutcomeConsumesTurn({ outcome: 'started' })).toBe(true);
    expect(workflowStartOutcomeConsumesTurn({ outcome: 'cancelled' })).toBe(true);
    expect(workflowStartOutcomeConsumesTurn({ outcome: 'failed' })).toBe(false);
    expect(workflowStartOutcomeConsumesTurn({ outcome: 'declined' })).toBe(false);
  });
});
