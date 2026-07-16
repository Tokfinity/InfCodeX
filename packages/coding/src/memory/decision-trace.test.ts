import { describe, expect, it } from 'vitest';

import type { MemoryDecisionReceipt } from '@kodax-ai/agent/experimental-memory';
import {
  recordMemoryDecisionReceipt,
  withMemoryDecisionTrace,
} from './decision-trace.js';

const receipt: MemoryDecisionReceipt = {
  id: 'memory-decision:1',
  decisionEpoch: 'epoch-1',
  decisionRevision: 'revision-1',
  policyVersion: 'f260-v0.7.68.2',
  candidateSetFingerprint: 'sha256:candidates',
  candidateRefs: ['memory:candidate'],
  selectedRefs: ['memory:candidate'],
  injectedRefs: ['memory:candidate'],
  selectionModes: ['exact'],
  throughSequence: 1,
};

describe('FEATURE_260 trace-only memory decisions', () => {
  it('annotates only the current trace scope without creating a durable event', async () => {
    const first: MemoryDecisionReceipt[] = [];
    const second: MemoryDecisionReceipt[] = [];

    await Promise.all([
      withMemoryDecisionTrace(first, async () => {
        recordMemoryDecisionReceipt(receipt);
        await Promise.resolve();
        recordMemoryDecisionReceipt({ ...receipt, id: 'memory-decision:2' });
      }),
      withMemoryDecisionTrace(second, async () => {
        recordMemoryDecisionReceipt({ ...receipt, id: 'memory-decision:other' });
      }),
    ]);

    expect(first.map((entry) => entry.id)).toEqual(['memory-decision:1', 'memory-decision:2']);
    expect(second.map((entry) => entry.id)).toEqual(['memory-decision:other']);
  });

  it('is non-blocking when tracing is disabled', () => {
    expect(() => recordMemoryDecisionReceipt(receipt)).not.toThrow();
  });
});
