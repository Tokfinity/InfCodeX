import type {
  WorkflowApi,
  WorkflowSpawnAgentInput,
  WorkflowTaskResult,
} from '@kodax-ai/agent';

import { buildScopedReviewPrimaryPrompt, scopedReview } from './scoped-review.js';
import type { ReviewPacketMetadata } from '../review-packet.js';

function result(name: string, structured: unknown): WorkflowTaskResult {
  return {
    taskId: `task-${name}`,
    name,
    status: 'completed',
    finalText: 'full report',
    structured,
    verification: { ok: true, reasons: [] },
    usage: { totalTokens: 10 },
  };
}

describe('scopedReview built-in workflow', () => {
  it('teaches primaries that findings contain defects, not approval evidence', () => {
    const prompt = buildScopedReviewPrimaryPrompt({
      packetPath: 'C:/tmp/packet.md',
      contentHash: 'a'.repeat(64),
      rangeId: 'b'.repeat(64),
      partitionKey: 'packages/a/source',
      label: 'test',
      scopePaths: ['packages/a.ts'],
      riskFlags: [],
      budget: { maxBytes: 50_000, maxLines: 2_000, maxLineChars: 2_000 },
      evidenceChunks: [{ path: 'C:/tmp/chunk.diff', contentHash: 'c'.repeat(64) }],
      requirementsPresent: true,
      testEvidencePresent: true,
    }, false, { packets: [] });

    expect(prompt).toContain('findings array contains only actionable defects');
    expect(prompt).toContain('findings must be empty');
    expect(prompt).toContain('absence of evidence is not proof of a defect');
  });

  it('runs two primaries only for routing-high, then one batched verifier and capable synthesis', async () => {
    const calls: WorkflowSpawnAgentInput[] = [];
    const logs: unknown[] = [];
    const artifacts: unknown[] = [];
    const wf = {
      runAgent: async (input: WorkflowSpawnAgentInput): Promise<WorkflowTaskResult> => {
        calls.push(input);
        if (input.phase === 'primary-review') {
          return result(input.name, {
            specVerdict: 'issues',
            qualityVerdict: 'needs-fixes',
            findings: [{
              severity: input.name.startsWith('high-risk') ? 'high' : 'medium',
              location: 'packages/a.ts:10',
              claim: 'boundary is broken',
              evidence: input.name,
            }],
            unverifiedRequirements: [],
          });
        }
        if (input.phase === 'verifier') {
          const findingId = /"findingId":"([a-f0-9]{64})"/.exec(input.prompt)?.[1];
          return result(input.name, {
            findings: [{ findingId, disposition: 'confirmed', evidence: 'focused check failed' }],
          });
        }
        return result(input.name, { summary: 'Confirmed one high-severity boundary issue.' });
      },
      log: (event: unknown) => logs.push(event),
      artifact: async (_name: string, value: unknown) => {
        artifacts.push(value);
        return { name: 'scoped-review-audit' };
      },
      parallel: async <T>(items: readonly (() => Promise<T>)[]): Promise<(T | null)[]> =>
        Promise.all(items.map((item) => item())),
    } as unknown as WorkflowApi;
    const packet: ReviewPacketMetadata = {
      packetPath: 'C:/tmp/packet.md',
      contentHash: 'a'.repeat(64),
      rangeId: 'b'.repeat(64),
      partitionKey: 'packages/a/source',
      label: 'test',
      scopePaths: ['packages/a.ts'],
      riskFlags: ['routing-high'],
      budget: { maxBytes: 50_000, maxLines: 2_000, maxLineChars: 2_000 },
      evidenceChunks: [{ path: 'C:/tmp/chunk.diff', contentHash: 'c'.repeat(64) }],
      requirementsPresent: true,
      testEvidencePresent: false,
    };

    const output = await scopedReview.run(wf, { packets: [packet] });

    expect(calls.map((call) => call.phase)).toEqual([
      'primary-review',
      'primary-review',
      'verifier',
      'final-synthesis',
    ]);
    expect(calls[0]?.verification?.requiredReadPaths).toEqual([
      'C:/tmp/packet.md',
      'C:/tmp/chunk.diff',
    ]);
    expect(calls.map((call) => call.modelHint)).toEqual(['balanced', 'deep', 'deep', 'deep']);
    expect(output.packetResults[0]?.result.actionable[0]?.severity).toBe('high');
    expect(output.packetResults[0]?.result).toMatchObject({
      specVerdict: 'issues',
      qualityVerdict: 'needs-fixes',
      unverifiedRequirements: [],
    });
    expect(output.summary).toContain('Confirmed one high-severity');
    expect(logs).toHaveLength(4);
    expect(artifacts).toHaveLength(1);
  });

  it('fails loudly when a backend violates the declared primary output schema', async () => {
    const wf = {
      runAgent: async (input: WorkflowSpawnAgentInput): Promise<WorkflowTaskResult> =>
        result(input.name, { specVerdict: 'issues' }),
      log: () => {},
      parallel: async <T>(items: readonly (() => Promise<T>)[]): Promise<(T | null)[]> =>
        Promise.all(items.map((item) => item())),
    } as unknown as WorkflowApi;
    const packet: ReviewPacketMetadata = {
      packetPath: 'C:/tmp/packet.md',
      contentHash: 'a'.repeat(64),
      rangeId: 'b'.repeat(64),
      partitionKey: 'packages/a/source',
      label: 'test',
      scopePaths: ['packages/a.ts'],
      riskFlags: [],
      budget: { maxBytes: 50_000, maxLines: 2_000, maxLineChars: 2_000 },
      evidenceChunks: [{ path: 'C:/tmp/chunk.diff', contentHash: 'c'.repeat(64) }],
      requirementsPresent: true,
      testEvidencePresent: false,
    };

    await expect(scopedReview.run(wf, { packets: [packet] }))
      .rejects.toThrow(/primary reviewer structured result is invalid.*qualityVerdict/i);
  });
});
