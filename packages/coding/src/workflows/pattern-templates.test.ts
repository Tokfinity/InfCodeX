/**
 * FEATURE_217 (v0.7.49) Phase J — workflow pattern template tests.
 */

import { describe, expect, it } from 'vitest';

import { WORKFLOW_PATTERN_IDS, validateWorkflowScriptManifest } from '@kodax-ai/agent';

import {
  createWorkflowPatternTemplateModule,
  getWorkflowPatternTemplate,
  listWorkflowPatternTemplates,
} from './pattern-templates.js';
import { validateGeneratedWorkflowSource } from './generator.js';

describe('workflow pattern templates', () => {
  it('ships reusable templates for the richer dynamic workflow patterns', () => {
    const templates = listWorkflowPatternTemplates();
    const shippedPatterns = templates.map((template) => template.pattern);

    expect(shippedPatterns).toEqual(expect.arrayContaining([...WORKFLOW_PATTERN_IDS]));
    expect(new Set(shippedPatterns).size).toBe(WORKFLOW_PATTERN_IDS.length);
  });

  it('keeps every template manifest and generated source valid', () => {
    for (const template of listWorkflowPatternTemplates()) {
      expect(validateWorkflowScriptManifest(template.manifest).name).toBe(template.manifest.name);
      expect(validateGeneratedWorkflowSource(template.source)).toBe(template.source);
      expect(template.manifest.patterns).toContain(template.pattern);
    }
  });

  it('materializes a template as a restricted workflow module', () => {
    const module = createWorkflowPatternTemplateModule('tournament');
    expect(module.meta.name).toBe('tournament-template');
    expect(typeof module.run).toBe('function');
  });

  it('declares read-only templates as read-only for approval accuracy', () => {
    expect(getWorkflowPatternTemplate('tournament')?.manifest.readOnly).toBe(true);
    expect(getWorkflowPatternTemplate('loop-until-done')?.manifest.readOnly).toBe(true);
    expect(getWorkflowPatternTemplate('generate-and-filter')?.manifest.readOnly).toBe(true);
    expect(getWorkflowPatternTemplate('fan-out-and-synthesize')?.manifest.readOnly).toBe(true);
    expect(getWorkflowPatternTemplate('adversarial-verification')?.manifest.readOnly).toBe(true);
    expect(getWorkflowPatternTemplate('classify-and-act')?.manifest.readOnly).toBe(true);
  });

  it('returns undefined for unknown templates and throws on materialization', () => {
    expect(getWorkflowPatternTemplate('missing')).toBeUndefined();
    expect(() => createWorkflowPatternTemplateModule('missing')).toThrow(/unknown workflow pattern/);
  });
});
