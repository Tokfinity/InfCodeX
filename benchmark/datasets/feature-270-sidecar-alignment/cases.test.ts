import { describe, expect, it } from 'vitest';

import {
  buildSidecarAlignmentInput,
  CASES,
  classifySidecarVerdict,
} from './cases.js';

describe('FEATURE_270 Sidecar alignment eval dataset', () => {
  it('keeps the bounded pre-registered case matrix', () => {
    expect(CASES).toHaveLength(8);
    expect(CASES.filter((item) => item.expectedVerdict === 'accept')).toHaveLength(3);
    expect(CASES.filter((item) => item.expectedVerdict === 'revise')).toHaveLength(4);
    expect(CASES.filter((item) => item.expectedVerdict === 'blocked')).toHaveLength(1);
  });

  it('exposes real intent and structured evidence only in the candidate arm', () => {
    const testCase = CASES.find((item) => item.id === 'synthetic_completion_preserves_request');
    expect(testCase).toBeDefined();
    const baseline = buildSidecarAlignmentInput(testCase!, 'baseline').userMessage;
    const candidate = buildSidecarAlignmentInput(testCase!, 'candidate').userMessage;

    expect(baseline).toContain('=== USER REQUEST (CURRENT TURN) ===\n<agent-completed');
    expect(candidate).toContain('=== USER REQUEST (CURRENT TURN) ===\nReview the race fix');
    expect(candidate).toContain('=== DELEGATED TASK EVIDENCE ===');
    expect(candidate.match(/Review the race fix and report whether it is safe\./gu)).toHaveLength(1);
  });

  it('never copies raw tool output into the candidate verifier message', () => {
    const testCase = CASES.find((item) => item.id === 'tool_error_rejects_false_test_claim');
    expect(testCase).toBeDefined();
    const candidate = buildSidecarAlignmentInput(testCase!, 'candidate').userMessage;

    expect(candidate).toContain('bash: error');
    expect(candidate).not.toContain('RAW_OUTPUT_NOT_FOR_VERIFIER');
  });

  it('classifies only a valid production verdict tool call', () => {
    expect(classifySidecarVerdict('revise', [{
      name: 'emit_sidecar_verdict',
      input: { verdict: 'revise', reason: 'Run the failed test again.' },
    }])).toMatchObject({ emitted: true, schemaValid: true, passed: true });
    expect(classifySidecarVerdict('revise', [{
      name: 'emit_sidecar_verdict',
      input: { verdict: 'unknown', reason: '' },
    }])).toMatchObject({ emitted: true, schemaValid: false, passed: false });
  });
});
