/**
 * Adapter tests — FEATURE_085 (v0.7.26).
 *
 * Per-result guardrails cannot see the final parallel batch or the physical
 * next-request capacity. They therefore remain compatibility no-ops; the
 * Runner batch transform owns capacity admission after all results settle.
 */

import { describe, expect, it } from 'vitest';
import type { KodaXToolExecutionContext } from '../types.js';
import {
  TOOL_RESULT_TRUNCATION_GUARDRAIL_NAME,
  createToolResultTruncationGuardrail,
} from './tool-result-truncation-guardrail.js';

function makeCtx(): KodaXToolExecutionContext {
  return {
    gitRoot: '/tmp/kodax-test-guardrail',
    executionCwd: '/tmp/kodax-test-guardrail',
    events: {},
    kodax: { eventListeners: [], emitRunLog: () => undefined },
  } as unknown as KodaXToolExecutionContext;
}

describe('tool-result-truncation-guardrail adapter', () => {
  it('is a ToolGuardrail with the expected name', () => {
    const g = createToolResultTruncationGuardrail(makeCtx());
    expect(g.kind).toBe('tool');
    expect(g.name).toBe(TOOL_RESULT_TRUNCATION_GUARDRAIL_NAME);
    expect(typeof g.afterTool).toBe('function');
    expect(g.beforeTool).toBeUndefined();
  });

  it('allows short content through without rewrite', async () => {
    const g = createToolResultTruncationGuardrail(makeCtx());
    const verdict = await g.afterTool!(
      { id: 'c1', name: 'read', input: {} },
      { content: 'short output' },
      { agent: { name: 't', instructions: '' } },
    );
    expect(verdict.action).toBe('allow');
  });

  it('does not rewrite large content using a context-blind per-result cap', async () => {
    const big = Array.from({ length: 1000 }, (_, i) => `line-${i}`).join('\n');
    const g = createToolResultTruncationGuardrail(makeCtx());
    const verdict = await g.afterTool!(
      { id: 'c1', name: 'bash', input: {} },
      { content: big },
      { agent: { name: 't', instructions: '' } },
    );
    expect(verdict.action).toBe('allow');
  });

  it('does not reinterpret an existing incomplete marker without a capacity budget', async () => {
    const g = createToolResultTruncationGuardrail(makeCtx());
    const verdict = await g.afterTool!(
      { id: 'c1', name: 'bash', input: {} },
      {
        content: 'preview\n[KODAX_RESULT_INCOMPLETE. Full output saved to: /tmp/full.txt.]',
        metadata: { truncated: true, outputPath: '/tmp/full.txt' },
      },
      { agent: { name: 't', instructions: '' } },
    );
    expect(verdict.action).toBe('allow');
  });

  it('skips inspection when the tool result is an error', async () => {
    const g = createToolResultTruncationGuardrail(makeCtx());
    const verdict = await g.afterTool!(
      { id: 'c1', name: 'read', input: {} },
      { content: 'any length of content here '.repeat(5000), isError: true },
      { agent: { name: 't', instructions: '' } },
    );
    expect(verdict.action).toBe('allow');
  });
});
