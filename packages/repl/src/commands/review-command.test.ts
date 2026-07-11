import { describe, expect, it } from 'vitest';

import {
  buildReviewPrompt,
  buildReviewWorkflowRequest,
  parseReviewInvocation,
} from './review-command.js';

describe('parseReviewInvocation', () => {
  it('extracts --workflow while preserving review scope args', () => {
    expect(parseReviewInvocation(['--workflow', 'base'])).toEqual({
      workflow: true,
      lean: false,
      diffArgs: ['base'],
      prompt: undefined,
    });
    expect(parseReviewInvocation(['sha', 'abc123', '--workflow'])).toEqual({
      workflow: true,
      lean: false,
      diffArgs: ['sha', 'abc123'],
      prompt: undefined,
    });
  });

  it('extracts --lean and prompt text without polluting diff scope args', () => {
    expect(parseReviewInvocation(['--lean', 'base', 'focus', 'security'])).toEqual({
      workflow: false,
      lean: true,
      diffArgs: ['base'],
      prompt: 'focus security',
    });
  });

  it('supports -- separator for prompt text after sha scope', () => {
    expect(parseReviewInvocation(['sha', 'abc123', '--lean', '--', 'native', 'input'])).toEqual({
      workflow: false,
      lean: true,
      diffArgs: ['sha', 'abc123'],
      prompt: 'native input',
    });
  });

  it('allows flags between sha and the commit hash', () => {
    expect(parseReviewInvocation(['sha', '--lean', '--workflow', 'abc123', 'focus'])).toEqual({
      workflow: true,
      lean: true,
      diffArgs: ['sha', 'abc123'],
      prompt: 'focus',
    });
  });

  it('reports an error when sha scope has no commit hash', () => {
    expect(parseReviewInvocation(['sha', '--lean'])).toMatchObject({
      workflow: false,
      lean: true,
      diffArgs: ['sha'],
      error: 'missing commit hash for sha scope; use /review sha <hash>',
    });
  });
});

describe('buildReviewWorkflowRequest', () => {
  it('builds a generated workflow request with scope-level review and verification', () => {
    const request = buildReviewWorkflowRequest('changes against main');

    expect(request).toContain('changes against main');
    expect(request).toContain('changed_scope');
    expect(request).toContain('specVerdict');
    expect(request).toContain('independent verifier');
    expect(request).toContain('synthesis');
  });

  it('adds lean reviewer instructions only when requested', () => {
    const normal = buildReviewWorkflowRequest('uncommitted changes');
    const lean = buildReviewWorkflowRequest('uncommitted changes', {
      lean: true,
      customPrompt: 'focus on deletion candidates',
    });

    expect(normal).not.toContain('lean/minimal-diff reviewer');
    expect(lean).toContain('lean/minimal-diff reviewer');
    expect(lean).toContain('trust-boundary validation');
    expect(lean).toContain('User review focus: focus on deletion candidates');
  });
});

describe('buildReviewPrompt', () => {
  it('omits lean instructions by default', () => {
    const prompt = buildReviewPrompt({
      label: 'uncommitted changes',
      diff: 'diff --git a/a.ts b/a.ts\n',
    });

    expect(prompt).not.toContain('Lean pass');
    expect(prompt).toContain('```diff');
  });

  it('adds lean safety guardrails and prompt focus when requested', () => {
    const prompt = buildReviewPrompt({
      label: 'changes against main',
      diff: 'diff --git a/a.ts b/a.ts\n',
      lean: true,
      customPrompt: 'prefer native browser controls',
    });

    expect(prompt).toContain('Lean pass');
    expect(prompt).toContain('stdlib/native platform features');
    expect(prompt).toContain('trust-boundary validation');
    expect(prompt).toContain('when it should be added back');
    expect(prompt).toContain('User review focus: prefer native browser controls');
  });
});
