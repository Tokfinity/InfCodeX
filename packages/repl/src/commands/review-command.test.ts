import { describe, expect, it } from 'vitest';

import {
  buildReviewWorkflowRequest,
  parseReviewInvocation,
} from './review-command.js';

describe('parseReviewInvocation', () => {
  it('extracts --workflow while preserving review scope args', () => {
    expect(parseReviewInvocation(['--workflow', 'base'])).toEqual({
      workflow: true,
      diffArgs: ['base'],
    });
    expect(parseReviewInvocation(['sha', 'abc123', '--workflow'])).toEqual({
      workflow: true,
      diffArgs: ['sha', 'abc123'],
    });
  });
});

describe('buildReviewWorkflowRequest', () => {
  it('builds a generated workflow request for multi-perspective review', () => {
    const request = buildReviewWorkflowRequest('changes against main');

    expect(request).toContain('changes against main');
    expect(request).toContain('independent reviewers');
    expect(request).toContain('synthesize');
  });
});
