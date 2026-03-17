import { describe, expect, it } from 'vitest';
import { buildProjectPlan, formatProjectPlan } from './project-planner.js';

describe('project-planner', () => {
  it('builds a four-phase plan from a freeform request', () => {
    const plan = buildProjectPlan(
      {
        title: 'Project Mode 2.0 planner command',
      },
      '2026-03-17T12:00:00.000Z',
    );

    expect(plan.id).toBe('plan_2026-03-17T12-00-00-000Z');
    expect(plan.phases).toHaveLength(4);
    expect(plan.phases.map(phase => phase.title)).toEqual([
      'Design',
      'Implementation',
      'Validation',
      'Release',
    ]);
    expect(plan.totalEstimateMinutes).toBeGreaterThan(0);
    expect(plan.nextCheckpoint).toContain('Finish "Clarify scope');
  });

  it('maps explicit feature steps into implementation tasks', () => {
    const plan = buildProjectPlan(
      {
        title: 'Brainstorm continuation',
        steps: [
          'Persist the active brainstorm session',
          'Add /project brainstorm continue',
          'Cover done/complete behavior with tests',
        ],
      },
      '2026-03-17T12:00:00.000Z',
    );

    const implementationPhase = plan.phases[1];
    expect(implementationPhase?.tasks.map(task => task.title)).toEqual([
      'Persist the active brainstorm session',
      'Add /project brainstorm continue',
      'Cover done/complete behavior with tests',
    ]);
    expect(implementationPhase?.tasks[1]?.dependsOn).toEqual(['impl-1']);
    expect(implementationPhase?.tasks[2]?.dependsOn).toEqual(['impl-2']);
  });

  it('formats a readable markdown plan', () => {
    const plan = buildProjectPlan(
      {
        title: 'Project quality improvements',
        steps: ['Add deterministic report builder', 'Expose /project quality'],
      },
      '2026-03-17T12:00:00.000Z',
    );

    const text = formatProjectPlan(plan);

    expect(text).toContain('# Project Plan: Project quality improvements');
    expect(text).toContain('## Design');
    expect(text).toContain('## Implementation');
    expect(text).toContain('- [ ] impl-1: Add deterministic report builder');
    expect(text).toContain('## Risks');
    expect(text).toContain('## Next Checkpoint');
  });
});
