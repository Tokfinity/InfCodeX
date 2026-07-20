/**
 * Contract tests for CAP-077 dispatch and CAP-079 final-batch capacity.
 *
 * Inventory entries:
 *   - docs/features/v0.7.29-capability-inventory.md#cap-077-tool-dispatch-parallelization-bash-sequential-non-bash-parallel
 *   - docs/features/v0.7.29-capability-inventory.md#cap-079-applytoolresultguardrail-post-tool-truncation-wrapping
 *
 * Test obligations (CAP-077):
 *   - CAP-TOOL-DISPATCH-PAR-001: non-bash tools run in parallel
 *   - CAP-TOOL-DISPATCH-PAR-002: bash tools run sequentially
 *   - CAP-TOOL-DISPATCH-PAR-003: mid-bash abort honored
 *
 * Test obligations (CAP-079):
 *   - complete final batches pass unchanged; over-capacity batches spill
 *
 * Risk: CAP-077 = HIGH (correctness); CAP-079 = MEDIUM
 *
 * Class: 1
 *
 * Verified locations: agent-runtime/tool-dispatch.ts:runToolDispatch and
 * applyPostToolProcessing
 * (extracted from agent.ts:1271-1322 — pre-FEATURE_100 baseline —
 * during FEATURE_100 P3.3d).
 *
 * Time-ordering constraint: dispatch precedes per-result post-processing;
 * aggregate admission follows visibility/reflection and precedes history.
 *
 * Active here:
 *   - bash vs non-bash split via `tc.name === 'bash'`
 *   - non-bash dispatched through `Promise.all` (parallel)
 *   - bash dispatched in a sequential `for` loop
 *   - per-bash-iteration `abortSignal.aborted` recheck (Issue 088)
 *   - raw dispatch preserves concurrency; final visible batch owns capacity
 *
 * STATUS: ACTIVE since FEATURE_100 P3.3d.
 */

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { KodaXEvents, KodaXToolExecutionContext } from '../../types.js';
import type { KodaXToolUseBlock } from '@kodax-ai/llm';

import { applyPostToolProcessing, runToolDispatch } from '../tool-dispatch.js';
import {
  buildRuntimeSessionState,
  type RuntimeSessionState,
} from '../runtime-session-state.js';
import { CANCELLED_TOOL_RESULT_MESSAGE } from '../../constants.js';
import { countTokens } from '../../tokenizer.js';
import { TOOL_OUTPUT_DIR_ENV } from '../../tools/truncate.js';
import type { ToolResultBudget } from '../../tools/tool-result-budget.js';
import { createAgent } from '@kodax-ai/agent';
import type { GuardrailContext, ToolGuardrail } from '@kodax-ai/agent';

function freshState(): RuntimeSessionState {
  return buildRuntimeSessionState({
    activeTools: ['read', 'edit', 'write', 'bash', 'grep'],
    modelSelection: {},
  });
}

function makeCtx(): KodaXToolExecutionContext {
  return { backups: new Map() };
}

function tool(id: string, name: string): KodaXToolUseBlock {
  return { id, name, type: 'tool_use', input: {} } as unknown as KodaXToolUseBlock;
}

function budget(aggregateInlineTokens: number): ToolResultBudget {
  return { aggregateInlineTokens };
}

describe('CAP-077: runToolDispatch — non-bash parallelization', () => {
  it('CAP-TOOL-DISPATCH-PAR-001: non-bash tools run in parallel (all start before any finishes)', async () => {
    const startedIds: string[] = [];
    const finishedIds: string[] = [];
    let releaseAll: () => void = () => undefined;
    const allReleased = new Promise<void>((resolve) => {
      releaseAll = resolve;
    });

    const events: KodaXEvents = {
      beforeToolExecute: async (_name, _input, hint) => {
        startedIds.push(hint?.toolId ?? '');
        // All three tools must enter the gate before ANY resolves —
        // proves Promise.all dispatched them in parallel.
        if (startedIds.length === 3) {
          releaseAll();
        }
        await allReleased;
        finishedIds.push(hint?.toolId ?? '');
        return `result:${hint?.toolId}`;
      },
    };

    const resultMap = await runToolDispatch({
      toolBlocks: [tool('a', 'read'), tool('b', 'grep'), tool('c', 'edit')],
      events,
      ctx: makeCtx(),
      runtimeSessionState: freshState(),
      activeToolNames: ['read', 'grep', 'edit'],
      abortSignal: undefined,
    });

    expect(startedIds).toHaveLength(3);
    // All three started before any finished (parallel invariant).
    // If serial, the gate would have observed start[i+1] only after
    // finish[i], and the `releaseAll` await would deadlock.
    expect(resultMap.get('a')).toBe('result:a');
    expect(resultMap.get('b')).toBe('result:b');
    expect(resultMap.get('c')).toBe('result:c');
  });
});

describe('CAP-077: runToolDispatch — bash sequentialization', () => {
  it('CAP-TOOL-DISPATCH-PAR-002: bash tools run sequentially (each finishes before the next starts)', async () => {
    const order: string[] = [];

    const events: KodaXEvents = {
      beforeToolExecute: async (_name, _input, hint) => {
        order.push(`start:${hint?.toolId}`);
        // Yield once so any concurrent dispatch would interleave.
        await new Promise((r) => setImmediate(r));
        order.push(`done:${hint?.toolId}`);
        return `result:${hint?.toolId}`;
      },
    };

    const resultMap = await runToolDispatch({
      toolBlocks: [tool('b1', 'bash'), tool('b2', 'bash'), tool('b3', 'bash')],
      events,
      ctx: makeCtx(),
      runtimeSessionState: freshState(),
      activeToolNames: ['bash'],
      abortSignal: undefined,
    });

    // Sequential invariant: each bash tool must complete (`done:`)
    // BEFORE the next one starts (`start:`).
    expect(order).toEqual([
      'start:b1', 'done:b1',
      'start:b2', 'done:b2',
      'start:b3', 'done:b3',
    ]);
    expect(resultMap.get('b1')).toBe('result:b1');
    expect(resultMap.get('b3')).toBe('result:b3');
  });

  it('CAP-TOOL-DISPATCH-PAR-002b: non-bash and bash mix — non-bash parallel, bash sequential, both populate the result map', async () => {
    const events: KodaXEvents = {
      beforeToolExecute: async (_name, _input, hint) => `r:${hint?.toolId}`,
    };

    const resultMap = await runToolDispatch({
      toolBlocks: [
        tool('p1', 'read'),
        tool('b1', 'bash'),
        tool('p2', 'edit'),
        tool('b2', 'bash'),
      ],
      events,
      ctx: makeCtx(),
      runtimeSessionState: freshState(),
      activeToolNames: ['read', 'edit', 'bash'],
      abortSignal: undefined,
    });

    expect(resultMap.size).toBe(4);
    expect(resultMap.get('p1')).toBe('r:p1');
    expect(resultMap.get('p2')).toBe('r:p2');
    expect(resultMap.get('b1')).toBe('r:b1');
    expect(resultMap.get('b2')).toBe('r:b2');
  });
});

describe('CAP-077: runToolDispatch — mid-bash abort (Issue 088)', () => {
  it('CAP-TOOL-DISPATCH-PAR-003: aborting mid-bash-loop yields CANCELLED for remaining bash tools (the first tool was already in flight)', async () => {
    const ctrl = new AbortController();
    const observedNames: string[] = [];

    const events: KodaXEvents = {
      beforeToolExecute: async (_name, _input, hint) => {
        observedNames.push(hint?.toolId ?? '');
        if (hint?.toolId === 'b1') {
          // First bash tool runs to completion, then user aborts.
          ctrl.abort();
          return 'result:b1';
        }
        return `result:${hint?.toolId}`;
      },
    };

    const resultMap = await runToolDispatch({
      toolBlocks: [tool('b1', 'bash'), tool('b2', 'bash'), tool('b3', 'bash')],
      events,
      ctx: makeCtx(),
      runtimeSessionState: freshState(),
      activeToolNames: ['bash'],
      abortSignal: ctrl.signal,
    });

    // b1 ran to completion; b2/b3 short-circuit on the per-iteration
    // abort recheck and never reach the gate.
    expect(observedNames).toEqual(['b1']);
    expect(resultMap.get('b1')).toBe('result:b1');
    expect(resultMap.get('b2')).toBe(CANCELLED_TOOL_RESULT_MESSAGE);
    expect(resultMap.get('b3')).toBe(CANCELLED_TOOL_RESULT_MESSAGE);
  });

  it('CAP-TOOL-DISPATCH-PAR-003b: pre-aborted signal — non-bash still dispatches via executeToolCall whose abort gate fires first (returns CANCELLED), bash short-circuits via the per-iteration gate', async () => {
    const ctrl = new AbortController();
    ctrl.abort();

    const events: KodaXEvents = {
      beforeToolExecute: vi.fn(async () => 'should-not-fire'),
    };

    const resultMap = await runToolDispatch({
      toolBlocks: [tool('a', 'read'), tool('b', 'bash')],
      events,
      ctx: makeCtx(),
      runtimeSessionState: freshState(),
      activeToolNames: ['read', 'bash'],
      abortSignal: ctrl.signal,
    });

    expect(events.beforeToolExecute).not.toHaveBeenCalled();
    expect(resultMap.get('a')).toBe(CANCELLED_TOOL_RESULT_MESSAGE);
    expect(resultMap.get('b')).toBe(CANCELLED_TOOL_RESULT_MESSAGE);
  });
});

describe('CAP-077: raw result handoff', () => {
  it('returns short content unchanged for final post-processing', async () => {
    const shortContent = 'fits well within the policy limits';
    const events: KodaXEvents = {
      beforeToolExecute: async () => shortContent,
    };

    const resultMap = await runToolDispatch({
      toolBlocks: [tool('t1', 'read')],
      events,
      ctx: makeCtx(),
      runtimeSessionState: freshState(),
      activeToolNames: ['read'],
      abortSignal: undefined,
    });

    expect(resultMap.get('t1')).toBe(shortContent);
  });
});

describe('CAP-077: concrete ToolGuardrail dispatch', () => {
  const guardrailContext: GuardrailContext = {
    agent: createAgent({ name: 'substrate-guardrail-test', instructions: 'test' }),
    messages: [],
  };

  it('runs before guardrails before permission and exposes the final rewritten call', async () => {
    const observed: string[] = [];
    const rewrite: ToolGuardrail = {
      kind: 'tool',
      name: 'rewrite-to-bash',
      beforeTool: async (call) => {
        observed.push(`guardrail:${call.name}`);
        return {
          action: 'rewrite',
          payload: { id: call.id, name: 'bash', input: { command: 'npm test' } },
        };
      },
    };
    const finalToolBlocks = new Map<string, KodaXToolUseBlock>();
    const resultMap = await runToolDispatch({
      toolBlocks: [tool('rewrite-1', 'read')],
      events: {
        beforeToolExecute: async (name, input, meta) => {
          observed.push(`permission:${name}:${String(input.command)}:${meta?.toolId}`);
          return 'permission-result';
        },
      },
      ctx: makeCtx(),
      runtimeSessionState: freshState(),
      activeToolNames: ['read', 'bash'],
      abortSignal: undefined,
      toolGuardrails: [rewrite],
      guardrailContext,
      finalToolBlocks,
      onToolCallsPrepared: (blocks) => {
        observed.push(`prepared:${blocks[0]?.name}`);
      },
    });

    expect(observed).toEqual([
      'guardrail:read',
      'prepared:bash',
      'permission:bash:npm test:rewrite-1',
    ]);
    expect(finalToolBlocks.get('rewrite-1')).toMatchObject({
      id: 'rewrite-1',
      name: 'bash',
      input: { command: 'npm test' },
    });
    expect(resultMap.get('rewrite-1')).toBe('permission-result');
  });

  it('turns a before guardrail block into a visible blocked result without asking permission', async () => {
    const beforeToolExecute = vi.fn(async () => true);
    const block: ToolGuardrail = {
      kind: 'tool',
      name: 'blocker',
      beforeTool: async () => ({ action: 'block', reason: 'policy denied' }),
    };
    const resultMap = await runToolDispatch({
      toolBlocks: [tool('blocked-1', 'read')],
      events: { beforeToolExecute },
      ctx: makeCtx(),
      runtimeSessionState: freshState(),
      activeToolNames: ['read'],
      abortSignal: undefined,
      toolGuardrails: [block],
      guardrailContext,
    });

    expect(beforeToolExecute).not.toHaveBeenCalled();
    expect(resultMap.get('blocked-1')).toMatch(/^\[Blocked\].*policy denied/);
  });

  it('serializes non-bash calls that guardrails rewrite into bash', async () => {
    let active = 0;
    let maximumActive = 0;
    let preparedBeforeExecution = false;
    const rewrite: ToolGuardrail = {
      kind: 'tool',
      name: 'rewrite-to-bash',
      beforeTool: async (call) => ({
        action: 'rewrite',
        payload: {
          id: call.id,
          name: 'bash',
          input: { command: `echo ${call.id}` },
        },
      }),
    };

    const resultMap = await runToolDispatch({
      toolBlocks: [tool('rewrite-a', 'read'), tool('rewrite-b', 'grep')],
      events: {
        beforeToolExecute: async (_name, _input, meta) => {
          expect(preparedBeforeExecution).toBe(true);
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active -= 1;
          return `result:${meta?.toolId}`;
        },
      },
      ctx: makeCtx(),
      runtimeSessionState: freshState(),
      activeToolNames: ['read', 'grep', 'bash'],
      abortSignal: undefined,
      toolGuardrails: [rewrite],
      guardrailContext,
      onToolCallsPrepared: (blocks) => {
        expect(blocks.map((block) => block.name)).toEqual(['bash', 'bash']);
        preparedBeforeExecution = true;
      },
    });

    expect(maximumActive).toBe(1);
    expect(resultMap.get('rewrite-a')).toBe('result:rewrite-a');
    expect(resultMap.get('rewrite-b')).toBe('result:rewrite-b');
  });
});

describe('CAP-079: single aggregate capacity owner', () => {
  let tempDir = '';

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-dispatch-budget-'));
    process.env[TOOL_OUTPUT_DIR_ENV] = tempDir;
  });

  afterEach(async () => {
    delete process.env[TOOL_OUTPUT_DIR_ENV];
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('keeps one large result complete when the final batch token budget can hold it', async () => {
    const content = Array.from({ length: 8_000 }, (_, index) => `complete-evidence-${index}`).join('\n');
    expect(Buffer.byteLength(content, 'utf8')).toBeGreaterThan(64 * 1024);
    const toolBlocks = [tool('large', 'read')];
    const executionContext = makeCtx();
    const toolResultBudget = budget(countTokens(content) + 100);
    const runtimeSessionState = freshState();
    const resultMap = await runToolDispatch({
      toolBlocks,
      events: { beforeToolExecute: async () => content },
      ctx: executionContext,
      runtimeSessionState,
      activeToolNames: ['read'],
      abortSignal: undefined,
    });
    const processed = await applyPostToolProcessing({
      toolBlocks,
      resultMap,
      events: {},
      emitActiveExtensionEvent: vi.fn().mockResolvedValue(undefined),
      ctx: executionContext,
      runtimeSessionState,
      toolResultBudget,
    });

    expect(processed.toolResults[0]!.content).toBe(content);
    expect(await fs.readdir(tempDir)).toEqual([]);
  });

  it('spills only after the complete result batch exceeds its aggregate token budget', async () => {
    const first = Array.from({ length: 1_800 }, (_, index) => `first-${index}`).join('\n');
    const second = Array.from({ length: 1_800 }, (_, index) => `second-${index}`).join('\n');
    const aggregateLimit = Math.floor((countTokens(first) + countTokens(second)) * 0.7);
    const toolBlocks = [tool('first', 'read'), tool('second', 'grep')];
    const executionContext = makeCtx();
    const toolResultBudget = budget(aggregateLimit);
    const runtimeSessionState = freshState();
    const onToolResult = vi.fn();
    const emitActiveExtensionEvent = vi.fn().mockResolvedValue(undefined);
    const events: KodaXEvents = {
      beforeToolExecute: async (_name, _input, hint) => hint?.toolId === 'first' ? first : second,
      onToolResult,
    };
    const resultMap = await runToolDispatch({
      toolBlocks,
      events,
      ctx: executionContext,
      runtimeSessionState,
      activeToolNames: ['read', 'grep'],
      abortSignal: undefined,
    });
    const processed = await applyPostToolProcessing({
      toolBlocks,
      resultMap,
      events,
      emitActiveExtensionEvent,
      ctx: executionContext,
      runtimeSessionState,
      toolResultBudget,
    });

    const outputs = processed.toolResults.map((result) => result.content as string);
    expect(outputs.filter((content) => content.includes('Full output saved to:'))).toHaveLength(1);
    expect(4 + outputs.reduce((total, content) => total + countTokens(content) + 4, 0))
      .toBeLessThanOrEqual(aggregateLimit);
    expect(await fs.readdir(tempDir)).toHaveLength(1);
    expect(onToolResult.mock.calls.map(([event]) => event.content)).toEqual(outputs);
    expect(emitActiveExtensionEvent.mock.calls.map(([, event]) => event.content)).toEqual(outputs);
  });
});
