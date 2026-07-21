import { describe, expect, it } from 'vitest';
import type { KodaXMessage } from '@kodax-ai/llm';
import { buildPermissionIntentEvidence } from './permission-intent.js';

describe('buildPermissionIntentEvidence', () => {
  it('marks absent user authority explicitly', () => {
    expect(buildPermissionIntentEvidence([], 'delete build')).toMatchObject({
      status: 'missing', sourceBytes: 0, includedBytes: 0, omittedBytes: 0,
    });
  });

  it('keeps only genuine user text when the evidence fits', () => {
    const messages: KodaXMessage[] = [
      { role: 'user', content: 'Move the report to D:/archive.' },
      { role: 'assistant', content: 'PRIVATE ASSISTANT NARRATION' },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'call-1',
          content: 'PRIVATE TOOL OUTPUT',
        }],
      },
    ];

    const evidence = buildPermissionIntentEvidence(messages, 'move D:/archive');

    expect(evidence.status).toBe('complete');
    expect(evidence.content).toContain('Move the report');
    expect(evidence.content).not.toContain('PRIVATE ASSISTANT');
    expect(evidence.content).not.toContain('PRIVATE TOOL OUTPUT');
    expect(evidence.omittedBytes).toBe(0);
  });

  it('selects explicit relevant slices and reports omitted bytes for oversized intent', () => {
    const messages: KodaXMessage[] = [
      { role: 'user', content: `Background ${'x'.repeat(12_000)}` },
      {
        role: 'user',
        content: 'For the release artifact, Move-Item may write to D:/archive/output.zip.',
      },
    ];

    const evidence = buildPermissionIntentEvidence(
      messages,
      'Move-Item D:/archive/output.zip',
      1_000,
    );

    expect(evidence.status).toBe('targeted');
    expect(evidence.content).toContain('Move-Item may write to D:/archive/output.zip');
    expect(evidence.sourceBytes).toBeGreaterThan(evidence.includedBytes);
    expect(evidence.omittedBytes).toBe(evidence.sourceBytes - evidence.includedBytes);
    expect(evidence.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(Buffer.byteLength(evidence.content, 'utf8')).toBeLessThanOrEqual(1_000);
  });
});
