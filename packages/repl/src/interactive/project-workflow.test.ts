import { describe, expect, it } from 'vitest';
import {
  buildFallbackFeatureListFromAlignment,
  formatStage,
  getRecommendedNextStep,
  normalizeAlignment,
  removeAlignmentEntry,
  summarizeActiveScope,
} from './project-workflow.js';
import { createProjectAlignment, createProjectWorkflowState } from './project-state.js';

describe('project workflow helpers', () => {
  it('normalizes and deduplicates alignment lists', () => {
    const alignment = createProjectAlignment('Ship feature');
    alignment.constraints = ['Keep APIs stable', 'keep apis stable', ''];
    alignment.successCriteria = ['Pass focused tests', 'Pass focused tests'];

    const normalized = normalizeAlignment(alignment, '2026-03-23T00:00:00.000Z');

    expect(normalized.constraints).toEqual(['Keep APIs stable']);
    expect(normalized.successCriteria).toEqual(['Pass focused tests']);
    expect(normalized.updatedAt).toBe('2026-03-23T00:00:00.000Z');
  });

  it('removes matching alignment entries using natural-language guidance', () => {
    const alignment = createProjectAlignment('Ship feature');
    alignment.constraints = ['Keep the existing interfaces stable', 'Avoid schema changes'];

    const removal = removeAlignmentEntry(alignment, 'constraints', 'remove constraint: existing interfaces stable');

    expect(removal.removed).toBe(true);
    expect(removal.alignment.constraints).toEqual(['Avoid schema changes']);
  });

  it('builds fallback features from alignment and prefixes change requests', () => {
    const alignment = createProjectAlignment('Improve search');
    alignment.confirmedRequirements = ['Support quoted phrases'];
    alignment.constraints = ['Keep current CLI syntax'];
    alignment.successCriteria = ['Focused tests cover phrase parsing'];

    const generated = buildFallbackFeatureListFromAlignment(alignment, [], 'change_request');

    expect(generated).toHaveLength(1);
    expect(generated[0]?.description).toBe('Change request: Support quoted phrases');
    expect(generated[0]?.steps).toContain('Respect constraint: Keep current CLI syntax');
  });

  it('summarizes scope and recommends next steps by workflow stage', () => {
    const state = createProjectWorkflowState('planned', '2026-03-23T00:00:00.000Z', 'change_request');

    expect(getRecommendedNextStep(state, true, false)).toBe('/project next');
    expect(summarizeActiveScope('change_request', 'CR-42')).toBe('change request (CR-42)');
    expect(formatStage('planned')).toBe('planned');
  });
});
