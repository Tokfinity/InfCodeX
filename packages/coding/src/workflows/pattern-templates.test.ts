/**
 * FEATURE_217 (v0.7.49) Phase J — workflow pattern template tests.
 */

import { describe, expect, it } from 'vitest';

import { validateWorkflowScriptManifest } from '@kodax-ai/agent';

import {
  createWorkflowPatternTemplateModule,
  getWorkflowPatternTemplate,
  listWorkflowPatternTemplates,
} from './pattern-templates.js';
import { validateGeneratedWorkflowSource } from './generator.js';

describe('workflow pattern templates', () => {
  it('ships reusable templates for the richer dynamic workflow patterns', () => {
    const templates = listWorkflowPatternTemplates();
    expect(templates.length).toBeGreaterThanOrEqual(3);
    expect(templates.map((template) => template.pattern)).toEqual(
      expect.arrayContaining([
        'adversarial-verification',
        'tournament',
        'loop-until-done',
      ]),
    );
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

  it('returns undefined for unknown templates and throws on materialization', () => {
    expect(getWorkflowPatternTemplate('missing')).toBeUndefined();
    expect(() => createWorkflowPatternTemplateModule('missing')).toThrow(/unknown workflow pattern/);
  });
});
