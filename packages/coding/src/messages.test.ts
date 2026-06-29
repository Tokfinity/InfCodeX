/**
 * Unit tests for `checkIncompleteToolCalls`.
 *
 * Covers the original missing-required-param detection AND the
 * truncation guard: a tool block tagged `_truncated` (salvaged from a
 * max_tokens/length-truncated stream) is ALWAYS treated as incomplete —
 * even when every required param looks present — because the last field
 * may have been silently cut mid-value (e.g. half a `write` payload).
 * Without this guard such a block executes with corrupt input.
 */

import { describe, expect, it } from 'vitest';
import type { KodaXToolUseBlock } from '@kodax-ai/llm';
import { checkIncompleteToolCalls } from './messages.js';

function block(partial: Partial<KodaXToolUseBlock> & { name: string }): KodaXToolUseBlock {
  return { type: 'tool_use', id: 'id-1', input: {}, ...partial } as KodaXToolUseBlock;
}

describe('checkIncompleteToolCalls', () => {
  it('returns empty for a complete tool call', () => {
    expect(checkIncompleteToolCalls([block({ name: 'read', input: { path: '/tmp/x' } })])).toEqual([]);
  });

  it('flags a tool call missing a required param', () => {
    // write requires `content`; only file_path supplied.
    const out = checkIncompleteToolCalls([block({ name: 'write', input: { file_path: '/tmp/x' } })]);
    expect(out.length).toBeGreaterThan(0);
    expect(out.join(' ')).toMatch(/write/);
  });

  it('flags a _truncated block even when all required params look present', () => {
    const out = checkIncompleteToolCalls([
      block({ name: 'write', input: { file_path: '/tmp/x', content: 'half a file…' }, _truncated: true }),
    ]);
    expect(out.length).toBe(1);
    expect(out[0]).toMatch(/truncat/i);
  });

  it('flags _truncated once (does not also run the param check for that block)', () => {
    // Even a _truncated block missing params yields exactly one entry —
    // the truncation reason short-circuits the per-param scan.
    const out = checkIncompleteToolCalls([block({ name: 'write', input: {}, _truncated: true })]);
    expect(out.length).toBe(1);
    expect(out[0]).toMatch(/truncat/i);
  });

  it('flags a _truncated read-only tool (guard fires before the param-presence check)', () => {
    // A truncated read with a non-empty path would pass the old param scan;
    // the unconditional _truncated guard must still flag it (we cannot trust
    // the intent of a half-parsed argument, even for side-effect-free tools).
    const out = checkIncompleteToolCalls([
      block({ name: 'read', input: { path: '/some/trunca' }, _truncated: true }),
    ]);
    expect(out.length).toBe(1);
    expect(out[0]).toMatch(/truncat/i);
  });

  it('in a mixed turn flags only the _truncated block, not the complete sibling', () => {
    const out = checkIncompleteToolCalls([
      block({ name: 'write', id: 'w1', input: { file_path: '/x', content: 'half…' }, _truncated: true }),
      block({ name: 'read', id: 'r1', input: { path: '/y' } }),
    ]);
    expect(out.length).toBe(1);
    expect(out[0]).toMatch(/write/);
    expect(out[0]).toMatch(/truncat/i);
  });
});
