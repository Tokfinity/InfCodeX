import { describe, expect, it } from 'vitest';
import { createSessionLineage, getSessionMessagesFromLineage } from '@kodax-ai/agent';
import {
  prepareRootCompactionLineage,
  withSessionHistoryReadBarrier,
} from './compaction-commit.js';

describe('prepareRootCompactionLineage', () => {
  it('rejects child compaction events instead of overwriting root history', () => {
    const root = createSessionLineage([{ role: 'user', content: 'root query' }]);
    expect(prepareRootCompactionLineage(
      root,
      [{ role: 'user', content: 'child summary' }],
      undefined,
      { contextKind: 'child' },
    )).toBeNull();
    expect(getSessionMessagesFromLineage(root)).toEqual([{ role: 'user', content: 'root query' }]);
  });

  it('reconciles the exact pre-compaction snapshot before creating a new island', () => {
    const stale = createSessionLineage([{ role: 'user', content: 'older root state' }]);
    const preCompactionMessages = [
      { role: 'user' as const, content: 'older root state' },
      { role: 'assistant' as const, content: 'exact detail DELTA-773' },
    ];
    const next = prepareRootCompactionLineage(
      stale,
      [{ role: 'user', content: 'checkpoint' }],
      {
        preCompactionMessages,
        anchor: {
          summary: 'checkpoint',
          tokensBefore: 80_000,
          tokensAfter: 20_000,
          entriesRemoved: 2,
          reason: 'automatic_compaction',
        },
      },
      { contextKind: 'root' },
    );
    expect(next).not.toBeNull();
    expect(next?.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'message',
        message: expect.objectContaining({ content: 'exact detail DELTA-773' }),
      }),
    ]));
  });
});

describe('withSessionHistoryReadBarrier', () => {
  it('waits for the current durable compaction write before loading exact history', async () => {
    let releaseWrite: (() => void) | undefined;
    const durableWrite = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let loaded = false;
    const lineage = createSessionLineage([{ role: 'user', content: 'exact history' }]);
    const storage = {
      async save() {},
      async load() { return null; },
      async loadFullLineage() {
        loaded = true;
        return lineage;
      },
    };
    const guarded = withSessionHistoryReadBarrier(storage, () => durableWrite);

    const pending = guarded.loadFullLineage?.('session-1');
    await Promise.resolve();
    expect(loaded).toBe(false);
    releaseWrite?.();

    await expect(pending).resolves.toBe(lineage);
    expect(loaded).toBe(true);
  });

  it('does not advertise full-history loading when the backing storage lacks it', () => {
    const storage = {
      async save() {},
      async load() { return null; },
    };
    expect(withSessionHistoryReadBarrier(storage, () => Promise.resolve())).toBe(storage);
  });

  it('preserves optional storage capabilities and their receiver binding', async () => {
    const storage = {
      marker: 'bound-storage',
      async save() {},
      async load() { return null; },
      async loadFullLineage() { return null; },
      async list(this: { marker: string }) {
        return [{ id: this.marker, title: 'session', msgCount: 1 }];
      },
    };
    const guarded = withSessionHistoryReadBarrier(storage, () => Promise.resolve());

    await expect(guarded.list?.()).resolves.toEqual([
      { id: 'bound-storage', title: 'session', msgCount: 1 },
    ]);
  });
});
