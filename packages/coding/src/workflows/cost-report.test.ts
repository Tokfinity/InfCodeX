import type { WorkflowEvent } from '@kodax-ai/agent';

import { buildWorkflowCostReport } from './cost-report.js';

describe('buildWorkflowCostReport', () => {
  it('counts model tokens exactly once while retaining digest and packet subsets', () => {
    const events: WorkflowEvent[] = [
      { seq: 0, type: 'agent_spawned', data: { taskId: 'a', role: 'primary-review', requestedTier: 'balanced' } },
      { seq: 1, type: 'agent_completed', data: {
        taskId: 'a',
        usage: { inputTokens: 80, outputTokens: 20, totalTokens: 100 },
        digestUsage: { totalTokens: 10 },
      } },
      { seq: 2, type: 'workflow_log', data: { message: 'read', data: {
        kind: 'review_packet_read', role: 'primary', contentHash: 'hash-a',
      } } },
      { seq: 3, type: 'workflow_log', data: { message: 'read', data: {
        kind: 'review_packet_read', role: 'primary', contentHash: 'hash-a',
      } } },
      { seq: 4, type: 'workflow_log', data: { message: 'verify', data: {
        kind: 'review_packet_read', role: 'verification', contentHash: 'hash-a', reason: 'candidate findings',
      } } },
    ];

    expect(buildWorkflowCostReport(events)).toMatchObject({
      totalModelTokens: 100,
      digestTokens: 10,
      primaryReviewStarts: 1,
      duplicatePrimaryPacketReads: 1,
      verificationPacketReads: [{ contentHash: 'hash-a', reason: 'candidate findings' }],
    });
  });

  it('fails token coverage instead of estimating missing required usage', () => {
    const report = buildWorkflowCostReport([
      { seq: 0, type: 'agent_spawned', data: { taskId: 'missing', role: 'verifier', requestedTier: 'deep' } },
      { seq: 1, type: 'agent_completed', data: { taskId: 'missing' } },
    ]);
    expect(report.tokenCoverage).toEqual({ ok: false, missingTaskIds: ['missing'] });
  });

  it('counts an asynchronous digest update once and excludes unknown external usage from local coverage', () => {
    const report = buildWorkflowCostReport([
      { seq: 0, type: 'agent_spawned', data: { taskId: 'local' } },
      { seq: 1, type: 'agent_completed', data: { taskId: 'local', usage: { totalTokens: 20 } } },
      { seq: 2, type: 'agent_summary_updated', data: {
        taskId: 'local', summaryKind: 'digest', usage: { totalTokens: 4 },
      } },
      { seq: 3, type: 'agent_spawned', data: { taskId: 'external', externalTarget: 'external:reviewer' } },
      { seq: 4, type: 'agent_completed', data: { taskId: 'external' } },
    ]);
    expect(report.totalModelTokens).toBe(24);
    expect(report.digestTokens).toBe(4);
    expect(report.tokenCoverage).toEqual({ ok: true, missingTaskIds: [] });
    expect(report.excludedExternalTaskIds).toEqual(['external']);
  });
});
