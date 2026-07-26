import { describe, expect, it } from 'vitest';

import { WORKFLOW_PATTERN_IDS } from '@kodax-ai/agent';

import { listWorkflowPatternTemplates } from '../workflows/pattern-templates.js';
import {
  COLLABORATION_PATTERN_CATALOG,
  WORKFLOW_REVIEW_COMPOSITION_GUIDANCE,
  renderAmaPatternPlaybook,
  renderWorkflowPatternGuidance,
} from './pattern-catalog.js';

describe('FEATURE_274 collaboration pattern catalog', () => {
  it('is complete, stable, and aligned with explicit Workflow templates', () => {
    const catalogIds = COLLABORATION_PATTERN_CATALOG.map((definition) => definition.id);
    const templateIds = listWorkflowPatternTemplates().map((template) => template.pattern);

    expect(catalogIds).toEqual(WORKFLOW_PATTERN_IDS);
    expect(templateIds).toEqual(expect.arrayContaining([...catalogIds]));
    expect(new Set(templateIds)).toEqual(new Set(catalogIds));
    for (const definition of COLLABORATION_PATTERN_CATALOG) {
      expect(definition.purpose).not.toBe('');
      expect(definition.usefulSignals.length).toBeGreaterThan(0);
      expect(definition.expectedEvidence.length).toBeGreaterThan(0);
      expect(definition.stopRules.length).toBeGreaterThan(0);
    }
  });

  it('renders one compact adaptive AMA playbook with every pattern', () => {
    const playbook = renderAmaPatternPlaybook();
    const workflowGuidance = renderWorkflowPatternGuidance().join('\n');

    expect(playbook).toContain('ADAPTIVE COLLABORATION PATTERNS');
    for (const id of WORKFLOW_PATTERN_IDS) expect(playbook).toContain(`\`${id}\``);
    expect(playbook).toContain('guidance, not deterministic routing');
    expect(playbook).toContain('Root remains accountable for synthesis');
    expect(Buffer.byteLength(`${playbook}\n${workflowGuidance}`, 'utf8'))
      .toBeLessThanOrEqual(3_000);
  });

  it('teaches Workflow authoring without treating a majority as proof', () => {
    const guidance = renderWorkflowPatternGuidance().join('\n');

    for (const id of WORKFLOW_PATTERN_IDS) expect(guidance).toContain(id);
    expect(WORKFLOW_REVIEW_COMPOSITION_GUIDANCE).toContain('common rubric');
    expect(WORKFLOW_REVIEW_COMPOSITION_GUIDANCE).toContain('confirmed');
    expect(WORKFLOW_REVIEW_COMPOSITION_GUIDANCE).toContain('refuted');
    expect(WORKFLOW_REVIEW_COMPOSITION_GUIDANCE).toContain('unresolved');
    expect(WORKFLOW_REVIEW_COMPOSITION_GUIDANCE.toLowerCase()).toContain(
      'verifier count is not proof',
    );
    expect(guidance.toLowerCase()).not.toContain('majority');
  });
});
