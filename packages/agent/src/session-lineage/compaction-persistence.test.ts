import { describe, expect, it, vi } from 'vitest';
import type { KodaXSessionData, KodaXSessionMessageEntry } from '../index.js';
import {
  applySessionCompaction,
  createSessionLineage,
  getSessionMessagesFromLineage,
} from './kodax-session-lineage.js';
import {
  COMPACTED_HISTORY_RECOVERY_GUIDANCE,
  COMPACTION_SUMMARY_PREFIX,
} from './compaction/compaction.js';
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

  it('inherits retained provenance across reload and prior inline attachments', async () => {
    const base = createSessionLineage([{ role: 'assistant', content: 'retained exact tail' }]);
    const source = base.entries[0]!;
    const sourceLineage = {
      ...base,
      entries: [{
        ...source,
        logicalId: 'logical_retained_origin',
        sourceEntryId: 'entry_retained_origin',
      }],
    };
    const sourceMessage = sourceLineage.entries[0];
    if (sourceMessage?.type !== 'message') {
      throw new Error('expected source message');
    }
    const firstCompaction = applySessionCompaction(
      sourceLineage,
      [
        {
          role: 'user',
          content: `${COMPACTION_SUMMARY_PREFIX}first checkpoint${COMPACTED_HISTORY_RECOVERY_GUIDANCE}`,
          _synthetic: true,
          _source: 'compaction-checkpoint',
        },
        sourceMessage.message,
      ],
      { summary: 'first checkpoint' },
      [{
        role: 'user',
        content: '[Post-compact: recent operations]\nread file',
        _synthetic: true,
        _source: 'compaction-context',
      }],
    );
    const firstCompactionClone = firstCompaction.entries
      .filter((entry): entry is KodaXSessionMessageEntry =>
        entry.type === 'message' && entry.message.content === 'retained exact tail')
      .at(-1);
    if (!firstCompactionClone) {
      throw new Error('expected the first-compaction retained clone');
    }
    const persisted: KodaXSessionData = {
      title: 'reloaded provenance',
      gitRoot: 'C:/repo',
      messages: getSessionMessagesFromLineage(firstCompaction),
      lineage: firstCompaction,
    };
    const preCompactionMessages = structuredClone(persisted.messages);
    expect(preCompactionMessages.map((message) => message._source)).toEqual([
      'compaction-checkpoint',
      'compaction-context',
      undefined,
    ]);
    const retainedCopy = preCompactionMessages.at(-1)!;
    const lineage = await persistCompactedSessionHistory({
      storage: {
        save: async () => {},
        load: async () => structuredClone(persisted),
      },
      sessionId: 'reloaded-session',
      compactedMessages: [
        {
          role: 'user',
          content: `${COMPACTION_SUMMARY_PREFIX}second checkpoint${COMPACTED_HISTORY_RECOVERY_GUIDANCE}`,
          _synthetic: true,
          _source: 'compaction-checkpoint',
        },
        retainedCopy,
      ],
      update: {
        preCompactionMessages,
        anchor: { summary: 'second checkpoint' },
      },
    });
    const rematerialized = lineage.entries
      .filter((entry) =>
        entry.type === 'message' && entry.message.content === 'retained exact tail')
      .at(-1);

    expect(rematerialized).toEqual(expect.objectContaining({
      logicalId: 'logical_retained_origin',
      // Direct addressing: the post-reload compaction clone names the
      // reloaded entry's own physical id, not the collapsed archived
      // original's 'entry_retained_origin'.
      sourceEntryId: firstCompactionClone.id,
    }));
    expect(rematerialized?.id).not.toBe(source.id);
    expect(lineage.entries).not.toContainEqual(expect.objectContaining({
      type: 'message',
      message: expect.objectContaining({ _source: 'compaction-context' }),
    }));
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
