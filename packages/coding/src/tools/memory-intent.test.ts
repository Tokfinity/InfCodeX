import { describe, expect, it, vi } from 'vitest';

import type { KodaXToolExecutionContext } from '../types.js';
import { getBuiltinRegisteredToolDefinition } from './registry.js';
import {
  activateMemoryIntentTool,
  createMemoryIntentBinding,
  MEMORY_INTENT_TOOL_DESCRIPTION,
  MEMORY_INTENT_TOOL_NAME,
  MEMORY_INTENT_TOOL_SCHEMA,
  toolMemoryIntent,
} from './memory-intent.js';

describe('governed memory_intent tool', () => {
  it('exposes one narrow state-changing intent submission instead of a Memory write', () => {
    const definition = getBuiltinRegisteredToolDefinition(MEMORY_INTENT_TOOL_NAME);

    expect(definition).toMatchObject({
      name: 'memory_intent',
      description: MEMORY_INTENT_TOOL_DESCRIPTION,
      input_schema: MEMORY_INTENT_TOOL_SCHEMA,
      requiredParams: ['operation', 'statement', 'userQuote'],
      sideEffect: 'mutates-state',
    });
    expect(MEMORY_INTENT_TOOL_DESCRIPTION).toContain('write durable Memory');
    expect(MEMORY_INTENT_TOOL_DESCRIPTION).toContain('does not create a durable review job');
    expect(Object.keys(MEMORY_INTENT_TOOL_SCHEMA.properties)).toEqual([
      'operation',
      'statement',
      'userQuote',
    ]);
  });

  it('captures an intent only when the quoted evidence occurs in the current user turn', async () => {
    const onAccepted = vi.fn();
    const currentUserTurn = {
      text: '你下次记得要确认代码，不要光确认文档',
      turnId: 'turn-remember',
    };
    const memoryIntent = createMemoryIntentBinding({
      getCurrentUserTurn: () => currentUserTurn,
      sessionId: 'session-remember',
      onAccepted,
    });
    const ctx = { memoryIntent } as unknown as KodaXToolExecutionContext;

    const result = await toolMemoryIntent({
      operation: 'remember',
      statement: '判断功能完成度时先核对代码和测试，文档只作为线索。',
      userQuote: '下次记得要确认代码，不要光确认文档',
    }, ctx);

    expect(result).toContain('captured for end-of-episode governed submission');
    expect(result).toContain('no durable review job exists yet');
    expect(onAccepted).toHaveBeenCalledOnce();
    expect(onAccepted).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'remember',
      candidateStatement: '判断功能完成度时先核对代码和测试，文档只作为线索。',
      userQuote: '下次记得要确认代码，不要光确认文档',
      evidenceRef: expect.stringMatching(/^user-intent:[a-f0-9]{24}$/),
    }));
  });

  it('rejects a fabricated quote and never upgrades model inference into user evidence', async () => {
    const onAccepted = vi.fn();
    const memoryIntent = createMemoryIntentBinding({
      getCurrentUserTurn: () => ({
        text: '我记得昨天检查过代码。',
        turnId: 'turn-narrative',
      }),
      sessionId: 'session-narrative',
      onAccepted,
    });

    const result = await toolMemoryIntent({
      operation: 'remember',
      statement: 'Always inspect code first.',
      userQuote: 'Please remember to inspect code first.',
    }, { memoryIntent } as unknown as KodaXToolExecutionContext);

    expect(result).toContain('rejected');
    expect(result).toContain('current user turn');
    expect(onAccepted).not.toHaveBeenCalled();
  });

  it('binds against the latest user turn instead of the initial prompt', async () => {
    const onAccepted = vi.fn();
    let currentUserTurn = {
      text: 'Please inspect the current code.',
      turnId: 'turn-initial',
    };
    const memoryIntent = createMemoryIntentBinding({
      getCurrentUserTurn: () => currentUserTurn,
      sessionId: 'session-follow-up',
      onAccepted,
    });
    currentUserTurn = {
      text: 'From now on, remember to run the focused tests too.',
      turnId: 'turn-follow-up',
    };

    const result = await memoryIntent({
      operation: 'remember',
      statement: 'Run focused tests when validating a change.',
      userQuote: 'remember to run the focused tests too',
    });

    expect(result).toMatchObject({
      status: 'captured',
      operation: 'remember',
      evidenceRef: expect.stringMatching(/^user-intent:[a-f0-9]{24}$/),
    });
    expect(onAccepted).toHaveBeenCalledWith(expect.objectContaining({
      candidateStatement: 'Run focused tests when validating a change.',
      userQuote: 'remember to run the focused tests too',
    }));
  });

  it('is one-shot and idempotent for an identical retry', async () => {
    const onAccepted = vi.fn();
    const memoryIntent = createMemoryIntentBinding({
      getCurrentUserTurn: () => ({
        text: 'Remember to inspect code before status documents.',
        turnId: 'turn-one-shot',
      }),
      sessionId: 'session-one-shot',
      onAccepted,
    });
    const input = {
      operation: 'remember' as const,
      statement: 'Inspect code before trusting status documents.',
      userQuote: 'Remember to inspect code before status documents.',
    };

    const first = await memoryIntent(input);
    const retry = await memoryIntent(input);
    const conflicting = await memoryIntent({
      operation: 'remember',
      statement: 'Always run every test suite.',
      userQuote: 'Remember to inspect code before status documents.',
    });

    expect(retry).toEqual(first);
    expect(conflicting).toMatchObject({
      status: 'rejected',
      reason: expect.stringContaining('already captured'),
    });
    expect(onAccepted).toHaveBeenCalledOnce();
  });

  it('is hidden without a root MemorySession and reports unavailable when unbound', async () => {
    expect(activateMemoryIntentTool(['read', 'memory_intent'], false)).toEqual(['read']);
    expect(activateMemoryIntentTool(['read'], true)).toEqual(['read', 'memory_intent']);
    expect(activateMemoryIntentTool(['read', 'memory_intent'], true))
      .toEqual(['read', 'memory_intent']);

    await expect(toolMemoryIntent({
      operation: 'remember',
      statement: 'Inspect code first.',
      userQuote: 'remember this',
    }, {} as KodaXToolExecutionContext)).resolves.toContain('unavailable');
  });
});
