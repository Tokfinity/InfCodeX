import { describe, expect, it } from 'vitest';

import { classifyStopReason, isCleanStop } from './stop-reason.js';

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

describe('isCleanStop', () => {
  it.each([
    ['end_turn', true],
    ['stop', true],
    ['tool_use', true],
    ['tool_calls', true],
    ['pause_turn', true],
  ] as const)('treats clean stop %s as true', (raw) => {
    expect(isCleanStop(raw)).toBe(true);
  });

  it.each([
    ['max_tokens', false],
    ['length', false],
    ['refusal', false],
    ['unexpected-provider-value', false],
    [undefined, false],
    [null, false],
  ] as const)('treats truncating/ambiguous %s as NOT clean (fail-safe)', (raw) => {
    // The fail-safe property: unknown/undefined must be NOT-clean so a salvaged
    // tool input is retained (retry) rather than executed.
    expect(isCleanStop(raw)).toBe(false);
  });
});
