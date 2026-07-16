/**
 * FEATURE_246 (P2 review): the inline `run_workflow` path is the PRIMARY workflow
 * path, so it must apply the same static source checks the generator fallback
 * uses (`validateGeneratedWorkflowSource`). This pins two things:
 *  1. The canonical pattern-template sources (the shapes the run_workflow textbook
 *     teaches the Worker to write) all PASS — the static checks do not false-reject
 *     valid inline scripts.
 *  2. The known LLM mistakes the validator exists to catch (literal task targets,
 *     legacy `.output`, forbidden host/IO tokens, non-displayable return) are
 *     still rejected — so the inline path fails fast with an actionable message
 *     instead of a late runtime error.
 */

import { describe, expect, it } from 'vitest';

import { listWorkflowPatternTemplates } from './pattern-templates.js';
import { validateGeneratedWorkflowSource } from './generator.js';

describe('inline workflow source validation (FEATURE_246 P2)', () => {
  it('every canonical pattern-template source passes the static validator (no false-reject)', () => {
    const templates = listWorkflowPatternTemplates();
    expect(templates.length).toBeGreaterThan(0);
    for (const template of templates) {
      expect(
        () => validateGeneratedWorkflowSource(template.source),
        `pattern template "${template.name}" must pass validateGeneratedWorkflowSource`,
      ).not.toThrow();
    }
  });

  it('rejects a literal task target (wf.wait("name")) — the late-error case the review flagged', () => {
    const bad = 'async function run(wf, args) { await wf.wait("candidate-worker"); return "done"; }';
    expect(() => validateGeneratedWorkflowSource(bad)).toThrow(/taskId variables/);
  });

  it('rejects legacy wf.output(taskId)', () => {
    const bad = 'async function run(wf, args) { const r = await wf.runAgent({ name: "x", prompt: "y" }); return wf.output(r.taskId); }';
    expect(() => validateGeneratedWorkflowSource(bad)).toThrow(/wf\.snapshot/);
  });

  it('rejects forbidden host/IO tokens (require/process/fs)', () => {
    const bad = 'async function run(wf, args) { const fs = require("node:fs"); return "x"; }';
    expect(() => validateGeneratedWorkflowSource(bad)).toThrow(/forbidden/);
  });

  it('rejects a non-displayable run() return', () => {
    const bad = 'async function run(wf, args) { await wf.runAgent({ name: "x", prompt: "y" }); }';
    expect(() => validateGeneratedWorkflowSource(bad)).toThrow(/displayable/);
  });
});
