/**
 * Contract test for CAP-072: incomplete tool call retry chain
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-072-incomplete-tool-call-retry-chain
 *
 * Test obligations:
 * - CAP-INCOMPLETE-TOOL-001: first retry has gentle "be concise" prompt
 * - CAP-INCOMPLETE-TOOL-002: subsequent retries escalate to critical warning
 * - CAP-INCOMPLETE-TOOL-003: max-retries skip-execute fills error tool_results for incomplete ids
 *
 * Risk: MEDIUM
 *
 * Class: 1
 *
 * Verified location: agent-runtime/incomplete-tool-retry.ts (extracted
 * from agent.ts:1233-1285 — pre-FEATURE_100 baseline — during FEATURE_100 P3.3b)
 *
 * Time-ordering constraint: AFTER stream return; BEFORE tool dispatch; counter resets on
 * successful turn (no incomplete blocks).
 *
 * Active here:
 *   - retry path: pop assistant, push synthetic _synthetic:true user message
 *   - retry-1 prompt is the gentle "be concise" tone
 *   - retry-2+ escalates to "⚠️ CRITICAL"
 *   - maxed-out path: emit tool:result + onToolResult per missing-param tool,
 *     push error tool_results block, reset counter
 *   - no-incomplete: counter resets to 0
 *
 * STATUS: ACTIVE since FEATURE_100 P3.3b.
 */

import { describe, expect, it, vi } from 'vitest';

import type { KodaXEvents, KodaXContextTokenSnapshot } from '../../types.js';
import type { KodaXMessage, KodaXToolUseBlock } from '@kodax-ai/llm';

import { checkAndRetryIncompleteTools } from '../incomplete-tool-retry.js';
import { KODAX_MAX_INCOMPLETE_RETRIES } from '../../constants.js';
import type { ExtensionEventEmitter } from '../stream-handler-wiring.js';

function makeSnapshot(label: string): KodaXContextTokenSnapshot {
  return {
    currentTokens: 100,
    source: 'estimated',
    usage: undefined,
    _label: label,
  } as unknown as KodaXContextTokenSnapshot;
}

function fakeEmitter(): ExtensionEventEmitter {
  return vi.fn().mockResolvedValue(undefined) as unknown as ExtensionEventEmitter;
}

function completeTool(id: string): KodaXToolUseBlock {
  return {
    id,
    name: 'read',
    type: 'tool_use',
    input: { path: '/tmp/file.txt' },
  } as unknown as KodaXToolUseBlock;
}

function incompleteWriteTool(id: string): KodaXToolUseBlock {
  // 'write' tool requires `content` — leaving it undefined makes it
  // incomplete per checkIncompleteToolCalls.
  return {
    id,
    name: 'write',
    type: 'tool_use',
    input: { file_path: '/tmp/file.txt' },
  } as unknown as KodaXToolUseBlock;
}

function truncatedFullWriteTool(id: string): KodaXToolUseBlock {
  // All required params LOOK present, but the input was salvaged from a
  // truncated stream (`_truncated`) so the trailing value may be cut
  // mid-string. The truncation guard must treat it as incomplete and
  // retry rather than execute the half-written payload.
  return {
    id,
    name: 'write',
    type: 'tool_use',
    input: { file_path: '/tmp/file.txt', content: 'half a file…' },
    _truncated: true,
  } as unknown as KodaXToolUseBlock;
}

describe('CAP-072: checkAndRetryIncompleteTools — no incomplete', () => {
  it('CAP-INCOMPLETE-TOOL-NOOP: zero incomplete tools → outcome no_incomplete, counter reset to 0', async () => {
    const messages: KodaXMessage[] = [];
    const completed = makeSnapshot('completed');
    const result = await checkAndRetryIncompleteTools({
      toolBlocks: [completeTool('id-1')],
      events: {} as KodaXEvents,
      emitActiveExtensionEvent: fakeEmitter(),
      messages,
      incompleteRetryCount: 2,
      preAssistantTokenSnapshot: makeSnapshot('pre'),
      completedTurnTokenSnapshot: completed,
    });
    expect(result.outcome).toBe('no_incomplete');
    expect(result.nextIncompleteRetryCount).toBe(0); // load-bearing reset
    expect(result.nextContextTokenSnapshot).toBe(completed);
    expect(messages).toHaveLength(0); // no mutation on no_incomplete
  });
});

describe('CAP-072: checkAndRetryIncompleteTools — under cap (retry path)', () => {
  it('CAP-INCOMPLETE-TOOL-001: retry count 1 → gentle "be concise" prompt with _synthetic flag', async () => {
    const messages: KodaXMessage[] = [{ role: 'assistant', content: [] }];
    const onRetry = vi.fn();
    const result = await checkAndRetryIncompleteTools({
      toolBlocks: [incompleteWriteTool('id-1')],
      events: { onRetry } as unknown as KodaXEvents,
      emitActiveExtensionEvent: fakeEmitter(),
      messages,
      incompleteRetryCount: 0,
      preAssistantTokenSnapshot: makeSnapshot('pre'),
      completedTurnTokenSnapshot: makeSnapshot('completed'),
    });
    expect(result.outcome).toBe('retry');
    expect(result.nextIncompleteRetryCount).toBe(1);
    expect(messages).toHaveLength(1); // popped assistant + pushed synthetic user
    expect(messages[0]!.role).toBe('user');
    expect(messages[0]!._synthetic).toBe(true);
    const content = messages[0]!.content as string;
    expect(content).toMatch(/truncated/i);
    expect(content).toMatch(/under 50 lines/);
    expect(content).not.toMatch(/CRITICAL/);
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('CAP-INCOMPLETE-TOOL-002: retry count >= 2 → escalated CRITICAL prompt with size limits', async () => {
    const messages: KodaXMessage[] = [{ role: 'assistant', content: [] }];
    const result = await checkAndRetryIncompleteTools({
      toolBlocks: [incompleteWriteTool('id-1')],
      events: { onRetry: vi.fn() } as unknown as KodaXEvents,
      emitActiveExtensionEvent: fakeEmitter(),
      messages,
      incompleteRetryCount: 1, // next retry is 2
      preAssistantTokenSnapshot: makeSnapshot('pre'),
      completedTurnTokenSnapshot: makeSnapshot('completed'),
    });
    expect(result.outcome).toBe('retry');
    const content = messages[0]!.content as string;
    expect(content).toMatch(/CRITICAL/);
    expect(content).toMatch(/task will FAIL/);
  });
});

describe('CAP-072: checkAndRetryIncompleteTools — truncated-input guard', () => {
  // Note: "not executed" is enforced by the run-substrate gate
  // (run-substrate.ts: `if (outcome !== 'no_incomplete') continue;` skips tool
  // dispatch). This unit asserts the gate's INPUT — outcome==='retry' — which
  // is the contract that triggers that skip.
  it('CAP-INCOMPLETE-TOOL-TRUNC-001: _truncated block with all params present → outcome retry (gates dispatch)', async () => {
    const messages: KodaXMessage[] = [{ role: 'assistant', content: [] }];
    const onRetry = vi.fn();
    const result = await checkAndRetryIncompleteTools({
      toolBlocks: [truncatedFullWriteTool('id-1')],
      events: { onRetry } as unknown as KodaXEvents,
      emitActiveExtensionEvent: fakeEmitter(),
      messages,
      incompleteRetryCount: 0,
      preAssistantTokenSnapshot: makeSnapshot('pre'),
      completedTurnTokenSnapshot: makeSnapshot('completed'),
    });
    expect(result.outcome).toBe('retry');
    expect(messages[0]!.role).toBe('user');
    expect(messages[0]!._synthetic).toBe(true);
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('CAP-INCOMPLETE-TOOL-TRUNC-002: at cap → maxed_out pushes error tool_result for _truncated block', async () => {
    const messages: KodaXMessage[] = [{ role: 'assistant', content: [] }];
    const onToolResult = vi.fn();
    const result = await checkAndRetryIncompleteTools({
      toolBlocks: [truncatedFullWriteTool('trunc-1')],
      events: { onRetry: vi.fn(), onToolResult } as unknown as KodaXEvents,
      emitActiveExtensionEvent: fakeEmitter(),
      messages,
      incompleteRetryCount: KODAX_MAX_INCOMPLETE_RETRIES,
      preAssistantTokenSnapshot: makeSnapshot('pre'),
      completedTurnTokenSnapshot: makeSnapshot('completed'),
    });
    expect(result.outcome).toBe('maxed_out');
    expect(onToolResult).toHaveBeenCalledOnce();
    expect((onToolResult.mock.calls[0]![0] as { id: string }).id).toBe('trunc-1');
  });

  it('CAP-INCOMPLETE-TOOL-TRUNC-003: at cap → complete sibling of a truncated block ALSO gets a result (no orphan tool_use)', async () => {
    // [truncated write, complete read] at the cap: both must get a tool_result
    // so the complete read is not left as an orphan tool_use that the next
    // serialize silently drops. The complete sibling gets a "re-issue" result.
    const messages: KodaXMessage[] = [{ role: 'assistant', content: [] }];
    const onToolResult = vi.fn();
    const result = await checkAndRetryIncompleteTools({
      toolBlocks: [truncatedFullWriteTool('w-trunc'), completeTool('r-complete')],
      events: { onRetry: vi.fn(), onToolResult } as unknown as KodaXEvents,
      emitActiveExtensionEvent: fakeEmitter(),
      messages,
      incompleteRetryCount: KODAX_MAX_INCOMPLETE_RETRIES,
      preAssistantTokenSnapshot: makeSnapshot('pre'),
      completedTurnTokenSnapshot: makeSnapshot('completed'),
    });
    expect(result.outcome).toBe('maxed_out');
    // Both tool_use ids get a synthesized result → no orphan.
    const resultIds = (onToolResult.mock.calls as Array<[{ id: string }, unknown]>).map((c) => c[0].id);
    expect(new Set(resultIds)).toEqual(new Set(['w-trunc', 'r-complete']));
    const pushed = messages[messages.length - 1]!.content as Array<{ tool_use_id?: string; content?: unknown }>;
    expect(pushed.map((b) => b.tool_use_id).sort()).toEqual(['r-complete', 'w-trunc']);
    // The complete sibling is told to re-issue.
    const sibling = onToolResult.mock.calls.find((c) => (c[0] as { id: string }).id === 'r-complete');
    expect((sibling?.[0] as { content: string }).content).toMatch(/re-issue|sibling/i);
  });
});

describe('CAP-072: checkAndRetryIncompleteTools — at cap (maxed-out path)', () => {
  it('CAP-INCOMPLETE-TOOL-003: at cap → outcome maxed_out, push error tool_results, reset counter, emit per missing-param tool', async () => {
    const messages: KodaXMessage[] = [{ role: 'assistant', content: [] }];
    const onRetry = vi.fn();
    const onToolResult = vi.fn();
    const emit = fakeEmitter();
    const workflowCorrelation = {
      workflowRunId: 'run-1',
      childAgentId: 'child-1',
      itemId: 'agent:child-1',
    };
    const result = await checkAndRetryIncompleteTools({
      toolBlocks: [incompleteWriteTool('tool-1')],
      events: { onRetry, onToolResult, workflowCorrelation } as unknown as KodaXEvents,
      emitActiveExtensionEvent: emit,
      messages,
      incompleteRetryCount: KODAX_MAX_INCOMPLETE_RETRIES, // next attempt = cap+1
      preAssistantTokenSnapshot: makeSnapshot('pre'),
      completedTurnTokenSnapshot: makeSnapshot('completed'),
    });
    expect(result.outcome).toBe('maxed_out');
    expect(result.nextIncompleteRetryCount).toBe(0); // counter reset

    // Error tool_results pushed (assistant NOT popped — different from retry path).
    expect(messages.length).toBe(2);
    expect(messages[1]!.role).toBe('user');

    expect(onToolResult).toHaveBeenCalledOnce();
    const toolResultArg = onToolResult.mock.calls[0]![0] as { id: string; content: string };
    const toolResultMeta = onToolResult.mock.calls[0]![1] as { toolId?: string; workflowCorrelation?: unknown };
    expect(toolResultArg.id).toBe('tool-1');
    expect(toolResultArg.content).toMatch(/Skipped due to missing required parameters/);
    expect(toolResultMeta).toEqual({ toolId: 'tool-1', workflowCorrelation });
    expect(emit).toHaveBeenCalledOnce();
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onRetry.mock.calls[0]![0]).toMatch(/Max retries exceeded/);
  });
});
