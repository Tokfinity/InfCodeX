import { describe, expect, it } from 'vitest';
import type { KodaXMessage } from '@kodax-ai/llm';

import { applySessionCompaction, createSessionLineage } from './kodax-session-lineage.js';
import {
  readSessionHistoryEntry,
  searchSessionHistory,
  searchSessionHistoryCooperatively,
} from './history-retrieval.js';

function compactedFixture() {
  const oldMessages: KodaXMessage[] = [
    { role: 'user', content: '请检查权限测试输出捕获为什么失败' },
    {
      role: 'assistant',
      content: '根因是 Windows 管道重定向与测试进程退出码组合错误。',
    },
    {
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: 'tool-old',
        name: 'bash',
        input: { command: 'npx vitest run permission' },
      }],
    },
    {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'tool-old',
        content: 'Test Files 2 passed; Tests 17 passed',
      }],
    },
  ];
  const lineage = applySessionCompaction(
    createSessionLineage(oldMessages),
    [
      {
        role: 'user',
        content: '[对话历史摘要]\n\n已检查权限测试。',
        _synthetic: true,
        _source: 'compaction-checkpoint',
      },
      { role: 'user', content: '继续检查当前实现' },
    ],
    { summary: '已检查权限测试。', tokensBefore: 90_000, tokensAfter: 20_000 },
  );
  return { lineage, oldMessages };
}

describe('FEATURE_272 durable Session history retrieval', () => {
  it('ranks compacted Unicode phrase, assistant explanation, and tool evidence with stable citations', () => {
    const { lineage } = compactedFixture();

    const user = searchSessionHistory(lineage, { query: '权限测试输出捕获', limit: 5 });
    expect(user.hits[0]).toMatchObject({
      role: 'user',
      active: false,
      snippet: expect.stringContaining('权限测试输出捕获'),
      citation: expect.stringMatching(/^session-history:entry_/),
    });

    const assistant = searchSessionHistory(lineage, {
      query: 'Windows 管道重定向',
      role: 'assistant',
    });
    expect(assistant.hits[0]?.snippet).toContain('Windows 管道重定向');

    const tool = searchSessionHistory(lineage, { query: 'Tests 17 passed' });
    expect(tool.hits[0]).toMatchObject({ source: 'tool', active: false });
    const oldUser = lineage.entries.find(
      (entry) => entry.type === 'message' && entry.message.content === '请检查权限测试输出捕获为什么失败',
    );
    expect(oldUser?.logicalId).toBeTruthy();
    expect(searchSessionHistory(lineage, { query: oldUser?.logicalId ?? '' }).hits[0]).toMatchObject({
      entryId: oldUser?.id,
      logicalId: oldUser?.logicalId,
    });
    expect(user.revision).toMatch(/^sha256:/);
  });

  it('defaults to compacted history but can include the active tail explicitly', () => {
    const { lineage } = compactedFixture();

    expect(searchSessionHistory(lineage, { query: '继续检查当前实现' }).hits).toEqual([]);
    expect(searchSessionHistory(lineage, {
      query: '继续检查当前实现',
      scope: 'all',
    }).hits[0]).toMatchObject({ active: true });
  });

  it('reads cited entry content in bounded chunks and rejects a stale revision', () => {
    const { lineage } = compactedFixture();
    const found = searchSessionHistory(lineage, { query: '管道重定向' });
    const entryId = found.hits[0]!.entryId;

    const first = readSessionHistoryEntry(lineage, {
      entryId,
      revision: found.revision,
      offset: 0,
      maxChars: 18,
    });
    expect(first.status).toBe('ok');
    if (first.status !== 'ok') throw new Error('expected readable history entry');
    expect(first.content.length).toBeGreaterThan(0);
    expect(first.nextOffset).toBe(18);

    const stale = readSessionHistoryEntry(lineage, {
      entryId,
      revision: 'sha256:stale',
    });
    expect(stale).toMatchObject({ status: 'stale', revision: found.revision });
  });

  it('invalidates a revision when lineage topology or source metadata changes', () => {
    const { lineage } = compactedFixture();
    const found = searchSessionHistory(lineage, { query: 'Tests 17 passed' });
    const entryId = found.hits[0]!.entryId;
    const changed = {
      ...lineage,
      entries: lineage.entries.map((entry) => entry.id === entryId
        ? { ...entry, sourceEntryId: 'entry_changed_source' }
        : entry),
    };
    const changedRevision = searchSessionHistory(changed, { query: 'Tests 17 passed' }).revision;

    expect(changedRevision).not.toBe(found.revision);
    expect(readSessionHistoryEntry(changed, {
      entryId,
      revision: found.revision,
    })).toMatchObject({ status: 'stale', revision: changedRevision });
  });

  it('does not make hidden reasoning searchable or readable through the model evidence plane', () => {
    const lineage = applySessionCompaction(
      createSessionLineage([{
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'private chain secret phrase', signature: 'sig' },
          { type: 'text', text: 'public conclusion' },
        ],
      }]),
      [{ role: 'user', content: '[对话历史摘要]\n\nDone', _synthetic: true }],
      { summary: 'Done' },
    );

    expect(searchSessionHistory(lineage, { query: 'private chain secret phrase' }).hits).toEqual([]);
    const publicHit = searchSessionHistory(lineage, { query: 'public conclusion' }).hits[0]!;
    const read = readSessionHistoryEntry(lineage, { entryId: publicHit.entryId });
    expect(read.status).toBe('ok');
    if (read.status === 'ok') {
      expect(read.content).toContain('public conclusion');
      expect(read.content).not.toContain('private chain secret phrase');
      expect(read.redactedBlockCount).toBe(1);
    }
  });

  it('excludes host instructions and old synthetic checkpoints from recovery search', () => {
    const first = applySessionCompaction(
      createSessionLineage([
        { role: 'system', content: 'host-only marker SYS-44' },
        {
          role: 'user',
          content: '[对话历史摘要]\nlegacy synthetic marker LEGACY-CHECKPOINT-44',
          _synthetic: true,
        },
        { role: 'user', content: 'genuine marker USER-44' },
      ]),
      [{
        role: 'user',
        content: '[Conversation compacted]\nsynthetic marker CHECKPOINT-44',
        _synthetic: true,
        _source: 'compaction-checkpoint',
      }],
      { summary: 'synthetic marker CHECKPOINT-44' },
    );
    const lineage = applySessionCompaction(
      first,
      [{ role: 'user', content: 'active tail' }],
      { summary: 'second summary' },
    );

    expect(searchSessionHistory(lineage, { query: 'SYS-44', scope: 'all' }).hits).toEqual([]);
    expect(searchSessionHistory(lineage, { query: 'CHECKPOINT-44', scope: 'all' }).hits).toEqual([]);
    expect(searchSessionHistory(lineage, {
      query: 'LEGACY-CHECKPOINT-44',
      scope: 'all',
    }).hits).toEqual([]);
    expect(searchSessionHistory(lineage, { query: 'USER-44' }).hits[0]).toMatchObject({ role: 'user' });

    const excludedEntries = lineage.entries.filter(
      (entry) => entry.type === 'message'
        && (entry.message.role === 'system'
          || (typeof entry.message.content === 'string'
            && entry.message.content.includes('CHECKPOINT-44'))),
    );
    expect(excludedEntries.length).toBeGreaterThan(0);
    for (const entry of excludedEntries) {
      expect(readSessionHistoryEntry(lineage, { entryId: entry.id })).toMatchObject({
        status: 'not_found',
      });
    }
  });

  it('does not score legacy placeholders through short random entry-id fragments', () => {
    const lineage = applySessionCompaction(
      createSessionLineage([{
        role: 'assistant',
        content: [{ type: 'text', text: '[compacted]' }],
      }]),
      [{ role: 'user', content: 'active tail' }],
      { summary: 'summary' },
    );
    const placeholder = lineage.entries.find(
      (entry) => entry.type === 'message'
        && Array.isArray(entry.message.content)
        && entry.message.content[0]?.type === 'text'
        && entry.message.content[0].text === '[compacted]',
    );
    expect(placeholder).toBeDefined();
    expect(searchSessionHistory(lineage, { query: '0.7.74', scope: 'all' }).hits).toEqual([]);
    expect(readSessionHistoryEntry(lineage, { entryId: placeholder!.id })).toMatchObject({
      status: 'not_found',
    });
  });

  it('cooperatively observes cancellation during history indexing and scoring', async () => {
    const lineage = createSessionLineage(Array.from(
      { length: 200 },
      (_, index): KodaXMessage => ({
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `search checkpoint ${index} ${'evidence '.repeat(100)}`,
      }),
    ));
    const cancelled = new Error('search cancelled');
    let shouldCancel = false;
    let yields = 0;
    let checkpoints = 0;
    let cancellationArmed = false;

    await expect(searchSessionHistoryCooperatively(
      lineage,
      { query: 'search checkpoint', scope: 'all' },
      {
        revision: 'test-revision',
        checkpoint() {
          checkpoints += 1;
          if (checkpoints === 100) {
            cancellationArmed = true;
            setTimeout(() => {
              shouldCancel = true;
            }, 0);
          }
          if (shouldCancel) throw cancelled;
        },
        async yieldControl() {
          yields += 1;
          await new Promise<void>((resolve) => setImmediate(resolve));
        },
      },
    )).rejects.toBe(cancelled);
    expect(cancellationArmed).toBe(true);
    expect(yields).toBeGreaterThan(1);
  });

  it('keeps cooperative search results identical to the synchronous API', async () => {
    const timestamp = '2026-07-30T01:02:03.000Z';
    const lineage = createSessionLineage([
      { role: 'user', content: 'same score search target', timestamp },
      { role: 'assistant', content: 'same score search target', timestamp },
      {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'tool-parity',
          name: 'read',
          input: { path: 'same score search target' },
        }],
        timestamp,
      },
    ]);
    const options = {
      query: 'same score search target',
      scope: 'all' as const,
      limit: 20,
    };
    const expected = searchSessionHistory(lineage, options);
    const actual = await searchSessionHistoryCooperatively(
      lineage,
      options,
      {
        revision: expected.revision,
        checkpoint() {},
        async yieldControl() {
          await new Promise<void>((resolve) => setImmediate(resolve));
        },
      },
    );

    expect(actual).toEqual(expected);
  });

  it('rejects unbounded cooperative queries without limiting large transcript entries', async () => {
    const control = {
      revision: 'test-revision',
      checkpoint() {},
      async yieldControl() {
        await new Promise<void>((resolve) => setImmediate(resolve));
      },
    };
    const lineage = createSessionLineage([{
      role: 'assistant',
      content: 'searchable',
    }]);
    await expect(searchSessionHistoryCooperatively(
      lineage,
      { query: 'x'.repeat(16 * 1024 + 1), scope: 'all' },
      control,
    )).rejects.toMatchObject({
      code: 'invalid_params',
      data: { resource: 'query' },
    });
    await expect(searchSessionHistoryCooperatively(
      lineage,
      {
        query: Array.from({ length: 129 }, (_, index) => `term${index}`).join(' '),
        scope: 'all',
      },
      control,
    )).rejects.toMatchObject({
      code: 'invalid_params',
      data: { resource: 'query_terms' },
    });

    const largeEntry = createSessionLineage([{
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: 'large-tool',
        name: 'read',
        input: { content: `${'x'.repeat(512 * 1024)} searchable-tail` },
      }],
    }]);
    await expect(searchSessionHistoryCooperatively(
      largeEntry,
      { query: 'searchable-tail', scope: 'all' },
      control,
    )).resolves.toMatchObject({
      hits: [{ entryId: largeEntry.entries[0]?.id }],
    });
  });
});
