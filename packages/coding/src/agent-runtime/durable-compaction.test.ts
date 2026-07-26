import { describe, expect, it, vi } from 'vitest';
import {
  createSessionLineage,
  getSessionMessagesFromLineage,
  type KodaXSessionData,
} from '@kodax-ai/agent';
import { withDurableCompactionPersistence } from './durable-compaction.js';

describe('withDurableCompactionPersistence', () => {
  it('publishes the root compaction callback only after exact storage succeeds', async () => {
    const initial: KodaXSessionData = {
      title: 'root',
      gitRoot: 'C:/repo',
      messages: [{ role: 'user', content: 'old' }],
      lineage: createSessionLineage([{ role: 'user', content: 'old' }]),
    };
    const order: string[] = [];
    const events = withDurableCompactionPersistence({
      events: {
        onCompactedMessages: () => {
          order.push('event');
        },
      },
      storage: {
        load: async () => initial,
        save: async () => {
          order.push('save');
        },
      },
      sessionId: 'root',
    });

    await events.onCompactedMessages?.(
      [{ role: 'user', content: 'checkpoint' }],
      {
        preCompactionMessages: [
          { role: 'user', content: 'old' },
          { role: 'assistant', content: 'exact active-run detail' },
        ],
      },
    );
    expect(order).toEqual(['save', 'event']);
  });

  it('does not persist Runner-owned leading System messages', async () => {
    const saved: KodaXSessionData[] = [];
    const initial: KodaXSessionData = {
      title: 'root',
      gitRoot: 'C:/repo',
      messages: [{ role: 'user', content: 'old' }],
      lineage: createSessionLineage([{ role: 'user', content: 'old' }]),
    };
    const events = withDurableCompactionPersistence({
      events: {},
      storage: {
        load: async () => initial,
        save: async (_id, data) => {
          saved.push(data);
        },
      },
      sessionId: 'root',
    });

    await events.onCompactedMessages?.(
      [
        { role: 'system', content: 'stable worker instructions' },
        {
          role: 'user',
          content: '[对话历史摘要]\n\ncheckpoint',
          _synthetic: true,
          _source: 'compaction-checkpoint',
        },
      ],
      {
        preCompactionMessages: [
          { role: 'system', content: 'stable worker instructions' },
          { role: 'user', content: 'old' },
        ],
      },
    );

    expect(saved[0]?.messages).toEqual([expect.objectContaining({
      role: 'user',
      _source: 'compaction-checkpoint',
    })]);
    expect(getSessionMessagesFromLineage(saved[0]!.lineage!))
      .not.toContainEqual(expect.objectContaining({ role: 'system' }));
  });

  it('leaves host-owned and child persistence untouched', async () => {
    const save = vi.fn();
    const hostEvents = { onCompactedMessages: vi.fn() };
    expect(withDurableCompactionPersistence({
      events: hostEvents,
      storage: { load: async () => null, save },
      sessionId: 'root',
      persistedByHost: true,
    })).toBe(hostEvents);
    const childEvents = { onCompactedMessages: vi.fn() };
    expect(withDurableCompactionPersistence({
      events: childEvents,
      storage: { load: async () => null, save },
      sessionId: 'root',
      currentAgentId: 'child',
    })).toBe(childEvents);
    expect(save).not.toHaveBeenCalled();
  });

  it('persists child compaction only when the child owns an isolated worker session', async () => {
    const initial: KodaXSessionData = {
      title: 'child',
      gitRoot: 'C:/repo',
      scope: 'managed-task-worker',
      messages: [{ role: 'user', content: 'old child detail' }],
      lineage: createSessionLineage([{ role: 'user', content: 'old child detail' }]),
    };
    const save = vi.fn(async () => undefined);
    const events = withDurableCompactionPersistence({
      events: {},
      storage: { load: async () => initial, save },
      sessionId: 'worker-session',
      sessionScope: 'managed-task-worker',
      currentAgentId: 'child-1',
    });

    await events.onCompactedMessages?.(
      [{ role: 'user', content: 'child checkpoint' }],
      { preCompactionMessages: [{ role: 'user', content: 'old child detail' }] },
      { contextKind: 'child' },
    );

    expect(save).toHaveBeenCalledOnce();
  });

  it('does not persist an explicitly child-attributed compaction through the root session', async () => {
    const save = vi.fn();
    const original = vi.fn();
    const events = withDurableCompactionPersistence({
      events: { onCompactedMessages: original },
      storage: { load: async () => null, save },
      sessionId: 'root',
    });

    await events.onCompactedMessages?.(
      [{ role: 'user', content: 'child checkpoint' }],
      { preCompactionMessages: [{ role: 'user', content: 'child detail' }] },
      { contextKind: 'child' },
    );

    expect(save).not.toHaveBeenCalled();
    expect(original).toHaveBeenCalledOnce();
  });
});
