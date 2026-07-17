import { describe, expect, it } from 'vitest';

import { buildWorkflowOutcome } from './outcome.js';

describe('buildWorkflowOutcome', () => {
  it('preserves structured results, artifacts, coverage, and aggregate usage', () => {
    const outcome = buildWorkflowOutcome({
      summary: 'Reviewed the change.',
      state: {
        runId: 'run-1',
        status: 'completed',
        totalSpawned: 2,
        events: [],
        artifacts: [{ name: 'report', path: 'reports/review.md' }],
        results: [
          {
            taskId: 'one',
            name: 'review',
            status: 'completed',
            finalText: 'Looks good.',
            structured: { verdict: 'pass' },
            artifacts: ['reports/review.md'],
            usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
          },
          {
            taskId: 'two',
            name: 'test',
            status: 'failed',
            finalText: 'Test failed.',
            usage: { totalTokens: 7 },
          },
        ],
      },
    });

    expect(outcome).toMatchObject({
      runId: 'run-1',
      status: 'partial',
      summary: 'Reviewed the change.',
      coverage: ['review'],
      unresolved: ['test'],
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 12, totalSpawned: 2 },
    });
    expect(outcome.results[0]?.structured).toEqual({ verdict: 'pass' });
    expect(outcome.errors).toEqual([{ taskId: 'two', name: 'test', message: 'Test failed.' }]);
    expect(outcome.artifacts).toEqual([
      { name: 'report', path: 'reports/review.md' },
      { name: 'reports/review.md', path: 'reports/review.md' },
    ]);
  });
});
