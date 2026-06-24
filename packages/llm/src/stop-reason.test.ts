import { describe, expect, it } from 'vitest';

import { classifyStopReason } from './stop-reason.js';

describe('classifyStopReason', () => {
  it.each([
    ['max_tokens', 'truncated'],
    ['length', 'truncated'],
    ['model_context_window_exceeded', 'truncated'],
    ['end_turn', 'end'],
    ['stop', 'end'],
    ['stop_sequence', 'end'],
    ['tool_use', 'tool'],
    ['tool_calls', 'tool'],
    ['function_call', 'tool'],
    ['pause_turn', 'paused'],
    ['refusal', 'refused'],
    ['content_filter', 'refused'],
    ['unexpected-provider-value', 'unknown'],
    [undefined, 'unknown'],
    [null, 'unknown'],
  ] as const)('maps %s to %s', (raw, expected) => {
    expect(classifyStopReason(raw)).toBe(expected);
  });

  it('normalizes provider casing and whitespace before classification', () => {
    expect(classifyStopReason(' LENGTH ')).toBe('truncated');
    expect(classifyStopReason(' Stop ')).toBe('end');
  });
});
