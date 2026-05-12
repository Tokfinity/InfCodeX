/**
 * Unit tests for `toolSendMessage` (FEATURE_120 Phase 2b).
 *
 * Covers:
 *   - happy path: known task_id → message enqueued with KodaX coordinator
 *     framing (`<coordinator-instruction>` tags) at user priority +
 *     prompt mode + addressed to the target child agent
 *   - rejects missing/empty `to` / `content`
 *   - rejects unknown task_id with explicit reason
 *   - rejects `to === '*'` with FEATURE_123 deferral notice
 *   - rejects when childTaskRegistry is unavailable (sync-mode dispatch)
 *   - does NOT mutate queue on rejection paths
 */

import { describe, expect, it, beforeEach } from 'vitest';

import {
  _resetMessageQueueForTests,
  getMessageQueue,
} from '@kodax-ai/agent';

import type { KodaXToolExecutionContext, KodaXChildExecutionResult } from '../types.js';
import type { ChildTaskRegistry } from '@kodax-ai/agent';

import { CHILD_EXCLUDE_TOOLS_BASE } from '../child-executor.js';

import { toolSendMessage } from './send-message.js';

function makeCtx(
  overrides: Partial<KodaXToolExecutionContext> = {},
): KodaXToolExecutionContext {
  return {
    gitRoot: '/tmp/repo',
    executionCwd: '/tmp/repo',
    ...overrides,
  } as KodaXToolExecutionContext;
}

function makeRegistry(
  taskIds: readonly string[],
): ChildTaskRegistry<KodaXChildExecutionResult> {
  const registry = new Map<string, Promise<KodaXChildExecutionResult>>();
  for (const id of taskIds) {
    // Never-settling stub promise — registry lookups only call `.has`,
    // so settlement state is irrelevant.
    registry.set(id, new Promise(() => {}));
  }
  return registry;
}

describe('toolSendMessage — happy path', () => {
  beforeEach(() => {
    _resetMessageQueueForTests();
  });

  it('enqueues a coordinator-instruction at user priority + prompt mode for a known task_id', async () => {
    const ctx = makeCtx({ childTaskRegistry: makeRegistry(['child-a']) });

    const result = await toolSendMessage(
      { to: 'child-a', content: 'also check the auth module' },
      ctx,
    );

    expect(result).toMatch(/^Message sent to child-a/);

    const drained = getMessageQueue().dequeue({
      agentId: 'child-a',
      maxPriority: 'background',
    });
    expect(drained).toHaveLength(1);
    expect(drained[0]).toMatchObject({
      agentId: 'child-a',
      priority: 'user',
      mode: 'prompt',
    });
    expect(drained[0]?.content).toBe(
      '<coordinator-instruction>\nalso check the auth module\n</coordinator-instruction>',
    );
  });

  it('preserves multi-line content inside the coordinator-instruction tag', async () => {
    const ctx = makeCtx({ childTaskRegistry: makeRegistry(['child-b']) });

    await toolSendMessage(
      { to: 'child-b', content: 'line 1\nline 2\nline 3' },
      ctx,
    );

    const drained = getMessageQueue().dequeue({
      agentId: 'child-b',
      maxPriority: 'user',
    });
    expect(drained[0]?.content).toBe(
      '<coordinator-instruction>\nline 1\nline 2\nline 3\n</coordinator-instruction>',
    );
  });
});

describe('toolSendMessage — input validation', () => {
  beforeEach(() => {
    _resetMessageQueueForTests();
  });

  it('rejects missing to', async () => {
    const ctx = makeCtx({ childTaskRegistry: makeRegistry(['child-a']) });
    const result = await toolSendMessage({ content: 'hi' }, ctx);
    expect(result).toMatch(/^\[Tool Error\]/);
    expect(result).toMatch(/to/);
    expect(getMessageQueue().size()).toBe(0);
  });

  it('rejects empty to', async () => {
    const ctx = makeCtx({ childTaskRegistry: makeRegistry(['child-a']) });
    const result = await toolSendMessage({ to: '   ', content: 'hi' }, ctx);
    expect(result).toMatch(/^\[Tool Error\]/);
    expect(getMessageQueue().size()).toBe(0);
  });

  it('rejects missing content', async () => {
    const ctx = makeCtx({ childTaskRegistry: makeRegistry(['child-a']) });
    const result = await toolSendMessage({ to: 'child-a' }, ctx);
    expect(result).toMatch(/^\[Tool Error\]/);
    expect(result).toMatch(/content/);
    expect(getMessageQueue().size()).toBe(0);
  });

  it('rejects empty content', async () => {
    const ctx = makeCtx({ childTaskRegistry: makeRegistry(['child-a']) });
    const result = await toolSendMessage({ to: 'child-a', content: '   ' }, ctx);
    expect(result).toMatch(/^\[Tool Error\]/);
    expect(getMessageQueue().size()).toBe(0);
  });
});

describe('toolSendMessage — coordinator-only invariant', () => {
  it('is listed in CHILD_EXCLUDE_TOOLS_BASE so child agents cannot call it', () => {
    // Pin test: protects against a future rename / typo silently
    // breaking the coordinator-only constraint. Children must not be
    // able to steer their siblings.
    expect(CHILD_EXCLUDE_TOOLS_BASE).toContain('send_message');
  });
});

describe('toolSendMessage — error paths', () => {
  beforeEach(() => {
    _resetMessageQueueForTests();
  });

  it('rejects unknown task_id', async () => {
    const ctx = makeCtx({ childTaskRegistry: makeRegistry(['child-a']) });
    const result = await toolSendMessage(
      { to: 'child-NOPE', content: 'hi' },
      ctx,
    );
    expect(result).toMatch(/^\[Tool Error\]/);
    expect(result).toMatch(/Unknown task_id/i);
    expect(result).toMatch(/child-NOPE/);
    expect(getMessageQueue().size()).toBe(0);
  });

  it('rejects broadcast `to: *` with FEATURE_123 deferral', async () => {
    const ctx = makeCtx({ childTaskRegistry: makeRegistry(['child-a']) });
    const result = await toolSendMessage(
      { to: '*', content: 'hi everyone' },
      ctx,
    );
    expect(result).toMatch(/^\[Tool Error\]/);
    expect(result).toMatch(/Broadcast/i);
    expect(getMessageQueue().size()).toBe(0);
  });

  it('rejects when childTaskRegistry is unavailable (sync-mode dispatch)', async () => {
    const ctx = makeCtx({ childTaskRegistry: undefined });
    const result = await toolSendMessage(
      { to: 'child-a', content: 'hi' },
      ctx,
    );
    expect(result).toMatch(/^\[Tool Error\]/);
    expect(result).toMatch(/async dispatch|registry/i);
    expect(getMessageQueue().size()).toBe(0);
  });
});
