import { describe, expect, it } from 'vitest';

import {
  validateWorkflowScriptManifest,
  type WorkflowScriptManifest,
} from './index.js';

describe('validateWorkflowScriptManifest', () => {
  it('normalizes a valid generated workflow manifest', () => {
    const manifest = validateWorkflowScriptManifest({
      name: 'generated-audit',
      description: 'Audit multiple areas and synthesize findings.',
      phases: ['inspect', 'verify', 'synthesize'],
      readOnly: true,
      plannedAgents: 5,
      maxAgents: 6,
      maxConcurrency: 3,
      tokenBudget: 12000,
      mayUseWorktree: false,
      patterns: ['fan-out-and-synthesize', 'adversarial-verification'],
    });

    expect(manifest).toEqual<WorkflowScriptManifest>({
      name: 'generated-audit',
      description: 'Audit multiple areas and synthesize findings.',
      phases: ['inspect', 'verify', 'synthesize'],
      readOnly: true,
      plannedAgents: 5,
      maxAgents: 6,
      maxConcurrency: 3,
      tokenBudget: 12000,
      mayUseWorktree: false,
      patterns: ['fan-out-and-synthesize', 'adversarial-verification'],
    });
  });

  it('rejects missing caps because approval must be concrete', () => {
    expect(() =>
      validateWorkflowScriptManifest({
        name: 'loose',
        description: 'missing caps',
        phases: ['run'],
        readOnly: true,
        patterns: ['fan-out-and-synthesize'],
      }),
    ).toThrow(/maxAgents/);
  });

  it('rejects plannedAgents when it is not a positive integer', () => {
    expect(() =>
      validateWorkflowScriptManifest({
        name: 'bad-plan',
        description: 'bad planned count',
        phases: ['run'],
        readOnly: true,
        plannedAgents: 0,
        maxAgents: 1,
        maxConcurrency: 1,
        patterns: ['fan-out-and-synthesize'],
      }),
    ).toThrow(/plannedAgents/);
  });

  it('rejects plannedAgents when it exceeds maxAgents', () => {
    expect(() =>
      validateWorkflowScriptManifest({
        name: 'bad-plan',
        description: 'bad planned count',
        phases: ['run'],
        readOnly: true,
        plannedAgents: 3,
        maxAgents: 2,
        maxConcurrency: 1,
        patterns: ['fan-out-and-synthesize'],
      }),
    ).toThrow(/plannedAgents/);
  });

  it('rejects unknown workflow pattern ids', () => {
    expect(() =>
      validateWorkflowScriptManifest({
        name: 'bad-pattern',
        description: 'bad',
        phases: ['run'],
        readOnly: true,
        maxAgents: 1,
        maxConcurrency: 1,
        patterns: ['surprise-me'],
      }),
    ).toThrow(/patterns/);
  });
});
