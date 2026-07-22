import { describe, expect, it, vi } from 'vitest';
import { createSessionLineage, type KodaXSessionData } from '@kodax-ai/agent';
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
