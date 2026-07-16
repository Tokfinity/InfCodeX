/**
 * FEATURE_141 (v0.7.37) — ToolCallDisplay output-rendering integration tests.
 *
 * Locks the contract that:
 *   1. Successful tool with string output gets rendered (this is the
 *      first time KodaX's transcript shows tool result content at all).
 *   2. Output containing unified-diff text is parsed and DiffHunk
 *      renders the diff portion separately from preamble.
 *   3. Non-success states (error / executing / cancelled) do NOT render
 *      tool.output (avoids leaking partial results during execution).
 */

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { ToolCallDisplay } from './ToolGroup.js';
import { ToolCallStatus, type ToolCall } from '../types.js';

const baseTool = (overrides: Partial<ToolCall>): ToolCall => ({
  id: 't1',
  name: 'edit',
  status: ToolCallStatus.Success,
  startTime: 1,
  endTime: 2,
  ...overrides,
});

describe('ToolCallDisplay — FEATURE_141 output rendering', () => {
  it('renders plain-text tool output for a successful call', () => {
    const tool = baseTool({
      output: 'File edited: foo.ts\n  (+1 lines, -0 lines)',
    });
    const { lastFrame } = render(<ToolCallDisplay tool={tool} />);
    const out = lastFrame() ?? '';
    expect(out).toContain('File edited: foo.ts');
  });

  it('renders unified-diff content with coloured DiffHunk when output contains @@', () => {
    const tool = baseTool({
      output: [
        'File edited: foo.ts',
        '  (+2 lines, -1 lines)',
        '',
        '--- foo.ts',
        '+++ foo.ts',
        '@@ -1,3 +1,4 @@',
        ' const a = 1;',
        '-const b = 2;',
        '+const b = 3;',
        '+const c = 4;',
        ' const d = 5;',
      ].join('\n'),
    });
    const { lastFrame } = render(<ToolCallDisplay tool={tool} />);
    const out = lastFrame() ?? '';
    // Preamble text shows
    expect(out).toContain('File edited: foo.ts');
    // Hunk header shows
    expect(out).toContain('@@ -1,3 +1,4 @@');
    // Add/remove lines show with their prefix
    expect(out).toContain('-const b = 2');
    expect(out).toContain('+const b = 3');
    expect(out).toContain('+const c = 4');
  });

  it('does NOT render tool.output for an Executing tool', () => {
    const tool = baseTool({
      status: ToolCallStatus.Executing,
      output: 'partial output should not leak',
    });
    const { lastFrame } = render(<ToolCallDisplay tool={tool} />);
    const out = lastFrame() ?? '';
    expect(out).not.toContain('partial output should not leak');
  });

  it('does NOT render tool.output for an Error tool (output is for the LLM, error message goes through tool.error)', () => {
    const tool = baseTool({
      status: ToolCallStatus.Error,
      error: '[Tool Error] read: ENOENT',
      output: '<should not show>',
    });
    const { lastFrame } = render(<ToolCallDisplay tool={tool} />);
    const out = lastFrame() ?? '';
    expect(out).toContain('[Tool Error] read: ENOENT');
    expect(out).not.toContain('<should not show>');
  });

  it('skips output rendering when output is non-string or empty', () => {
    const t1 = baseTool({ output: '' });
    const r1 = render(<ToolCallDisplay tool={t1} />).lastFrame() ?? '';
    expect(r1).toContain('edit'); // tool name still renders
    // No crash; no extra content section.

    const t2 = baseTool({ output: undefined });
    const r2 = render(<ToolCallDisplay tool={t2} />).lastFrame() ?? '';
    expect(r2).toContain('edit');

    const t3 = baseTool({ output: { not: 'a string' } as unknown as string });
    const r3 = render(<ToolCallDisplay tool={t3} />).lastFrame() ?? '';
    expect(r3).toContain('edit');
    // Object outputs are intentionally skipped (string-only contract).
  });
});
