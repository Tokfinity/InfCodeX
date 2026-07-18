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
    '请用工作流完成这次审查。',
    'ワークフローを使って監査してください。',
    '워크플로우로 검토해 주세요.',
    '请使用 Workflow 完成这个审查。',
    'Launch two Workflows for comparison.',
  ])('recognizes an explicit natural-language Workflow surface: %s', (input) => {
    expect(hasExplicitNaturalLanguageWorkflowIntent(input)).toBe(true);
  });

  it.each([
    'Review three independent dimensions and synthesize the result.',
    'Audit this complex parallel change.',
    '并行检查三个模块并汇总结论。',
    '请优化这个流程。',
    '请优化现有工作流程。',
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
