import { describe, expect, it, vi } from 'vitest';
import type { KodaXSessionData } from '../index.js';
import { createSessionLineage } from './kodax-session-lineage.js';
import { persistCompactedSessionHistory } from './compaction-persistence.js';

describe('persistCompactedSessionHistory', () => {
  it('persists active-run exact messages before the compacted replacement', async () => {
    const initial: KodaXSessionData = {
      title: 'durable',
      gitRoot: 'C:/repo',
      messages: [{ role: 'user', content: 'old query' }],
      lineage: createSessionLineage([{ role: 'user', content: 'old query' }]),
    };
    const save = vi.fn<(id: string, data: KodaXSessionData) => Promise<void>>()
      .mockResolvedValue(undefined);
    const lineage = await persistCompactedSessionHistory({
      storage: {
        save,
        load: async () => initial,
      },
      sessionId: 'root-session',
      compactedMessages: [{ role: 'user', content: 'checkpoint' }],
      update: {
        preCompactionMessages: [
          { role: 'user', content: 'old query' },
          { role: 'assistant', content: 'active-run exact detail ZX-4401' },
        ],
        anchor: {
          summary: 'checkpoint',
          entriesRemoved: 2,
          reason: 'automatic_compaction',
        },
      },
    });

    expect(lineage.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'message',
        message: expect.objectContaining({ content: 'active-run exact detail ZX-4401' }),
      }),
    ]));
    expect(save).toHaveBeenCalledOnce();
    expect(save.mock.calls[0]?.[1]).toMatchObject({
      messages: [{ role: 'user', content: 'checkpoint' }],
      lineage,
    });
  });

  it('rejects a missing session instead of inventing incomplete metadata', async () => {
    await expect(persistCompactedSessionHistory({
      storage: {
        save: async () => {},
        load: async () => null,
      },
      sessionId: 'missing',
      compactedMessages: [],
      update: { preCompactionMessages: [] },
    })).rejects.toThrow(/missing session/i);
  });

  it('creates a first durable snapshot from explicit run metadata and exact history', async () => {
    const save = vi.fn<(id: string, data: KodaXSessionData) => Promise<void>>()
      .mockResolvedValue(undefined);
    await persistCompactedSessionHistory({
      storage: { save, load: async () => null },
      sessionId: 'new-root',
      compactedMessages: [{ role: 'user', content: 'checkpoint' }],
      update: {
        preCompactionMessages: [{ role: 'user', content: 'first-run exact BRAVO-204' }],
      },
      initialSessionData: {
        title: 'First run',
        gitRoot: 'C:/repo',
        scope: 'user',
      },
    });

    expect(save).toHaveBeenCalledWith('new-root', expect.objectContaining({
      title: 'First run',
      gitRoot: 'C:/repo',
      scope: 'user',
      messages: [{ role: 'user', content: 'checkpoint' }],
      lineage: expect.objectContaining({
        entries: expect.arrayContaining([
          expect.objectContaining({
            type: 'message',
            message: expect.objectContaining({ content: 'first-run exact BRAVO-204' }),
          }),
        ]),
      }),
    }));
  });
});
