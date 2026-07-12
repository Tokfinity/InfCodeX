import { describe, expect, it } from 'vitest';

import type { KodaXToolResultBlock, KodaXToolUseBlock } from '../types.js';
import {
  buildToolMemoryObservations,
  codingMemorySourcePolicy,
} from './coding-observations.js';

function tool(name: string, input: Record<string, unknown> = {}): KodaXToolUseBlock {
  return { type: 'tool_use', id: `call-${name}`, name, input };
}

function result(name: string, content: string, isError = false): KodaXToolResultBlock {
  return {
    type: 'tool_result',
    tool_use_id: `call-${name}`,
    content,
    ...(isError ? { is_error: true } : {}),
  };
}

describe('FEATURE_260 coding memory observations', () => {
  it('records a tool failure as a conditional observed outcome', () => {
    const observations = buildToolMemoryObservations({
      toolBlocks: [tool('edit', { path: 'src/app.ts' })],
      toolResults: [result('edit', '[Tool Error] old_string not found', true)],
      startSequence: 3,
      observedAt: '2026-07-12T02:00:00.000Z',
    });

    expect(observations).toMatchObject([{
      id: 'tool-outcome:call-edit',
      sequence: 4,
      kind: 'outcome',
      actionSignature: 'edit',
      summary: expect.stringMatching(/failed under the current inputs and environment/i),
      evidence: [{
        ref: 'tool-result:call-edit',
        requestedGrade: 'observed',
        source: 'tool',
      }],
    }]);
  });

  it('records verification commands but ignores ordinary successful reads and memory_recall', () => {
    const observations = buildToolMemoryObservations({
      toolBlocks: [
        tool('read', { path: 'README.md' }),
        tool('bash', { command: 'npm test' }),
        tool('memory_recall', { need: 'prior failure' }),
      ],
      toolResults: [
        result('read', 'file contents'),
        result('bash', 'Tests: 42 passed'),
        result('memory_recall', 'prior memory'),
      ],
      startSequence: 0,
      observedAt: '2026-07-12T02:00:00.000Z',
    });

    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      sequence: 1,
      actionSignature: 'bash:verify',
      summary: expect.stringContaining('Verification command succeeded'),
    });
  });

  it('drops restricted output before it can enter the runtime memory window', () => {
    const observations = buildToolMemoryObservations({
      toolBlocks: [tool('bash', { command: 'npm test' })],
      toolResults: [result('bash', 'token=super-secret-value')],
      startSequence: 0,
      observedAt: '2026-07-12T02:00:00.000Z',
    });

    expect(observations).toEqual([]);
  });

  it('clamps evidence grades by the built-in coding source registry', () => {
    const evidence = {
      ref: 'source:1',
      requestedGrade: 'authoritative' as const,
      observedAt: '2026-07-12T02:00:00.000Z',
    };

    expect(codingMemorySourcePolicy({ ...evidence, source: 'environment' })).toBe('verified');
    expect(codingMemorySourcePolicy({ ...evidence, source: 'tool' })).toBe('observed');
    expect(codingMemorySourcePolicy({ ...evidence, source: 'agent' })).toBe('inferred');
    expect(codingMemorySourcePolicy({ ...evidence, source: 'user' })).toBe('authoritative');
  });
});
