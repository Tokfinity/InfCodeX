import { describe, expect, it, vi } from 'vitest';

import type {
  KodaXSessionEntry,
  KodaXSessionLineage,
} from '@kodax-ai/agent';

import {
  buildLineageUnavailableConversationHistory,
  buildSessionConversationHistory,
  forkSessionConversationLineage,
} from './conversation-history.js';

const timestamp = '2026-08-01T00:00:00.000Z';

function messageEntry(
  id: string,
  parentId: string | null,
  role: 'user' | 'assistant',
  content: string,
  identity: { logicalId?: string; sourceEntryId?: string } = {},
): KodaXSessionEntry {
  return {
    type: 'message',
    id,
    parentId,
    timestamp,
    logicalId: identity.logicalId ?? id,
    ...(identity.sourceEntryId !== undefined
      ? { sourceEntryId: identity.sourceEntryId }
      : {}),
    message: { role, content },
  };
}

function compactionEntry(
  id: string,
  firstKeptEntryId?: string,
): KodaXSessionEntry {
  return {
    type: 'compaction',
    id,
    parentId: null,
    timestamp,
    logicalId: id,
    summary: `summary for ${id}`,
    ...(firstKeptEntryId !== undefined ? { firstKeptEntryId } : {}),
  };
}

function project(entries: KodaXSessionEntry[], activeEntryId: string) {
  const lineage: KodaXSessionLineage = {
    version: 2,
    activeEntryId,
    entries,
  };
  return buildSessionConversationHistory(
    lineage,
    'sha256:test-source',
  );
}

describe('buildSessionConversationHistory', () => {
  it('treats an absent lineage as complete when no conversation record exists', () => {
    expect(buildLineageUnavailableConversationHistory([], 'sha256:empty')).toEqual({
      sourceRevision: 'sha256:empty',
      status: 'resolved',
      entries: [],
      issues: [],
    });
  });

  it('folds modern compaction copies by persisted provenance', () => {
    const entries = [
      messageEntry('u1', null, 'user', 'first request'),
      messageEntry('a1', 'u1', 'assistant', 'first answer'),
      messageEntry('u2', 'a1', 'user', 'second request'),
      messageEntry('a2', 'u2', 'assistant', 'second answer'),
      compactionEntry('compact', 'u2-copy'),
      messageEntry('u2-copy', 'compact', 'user', 'second request', {
        logicalId: 'u2',
        sourceEntryId: 'u2',
      }),
      messageEntry('a2-copy', 'u2-copy', 'assistant', 'second answer', {
        logicalId: 'a2',
        sourceEntryId: 'a2',
      }),
      messageEntry('u3', 'a2-copy', 'user', 'third request'),
      messageEntry('a3', 'u3', 'assistant', 'third answer'),
    ];

    const history = project(entries, 'a3');

    expect(history.status).toBe('resolved');
    expect(history.issues).toEqual([]);
    expect(history.entries.map((entry) => entry.message.content)).toEqual([
      'first request',
      'first answer',
      'second request',
      'second answer',
      'third request',
      'third answer',
    ]);
    expect(history.entries[2]).toMatchObject({
      boundaryId: 'u2',
      auditEntryIds: ['u2', 'u2-copy'],
    });
  });

  it('retains an archived source entry id in the compacted copy audit references', () => {
    const history = project([
      compactionEntry('compact', 'u2-copy'),
      messageEntry('u2-copy', 'compact', 'user', 'retained request', {
        logicalId: 'u2',
        sourceEntryId: 'u2',
      }),
    ], 'u2-copy');

    expect(history.entries).toEqual([
      expect.objectContaining({
        boundaryId: 'u2-copy',
        auditEntryIds: ['u2', 'u2-copy'],
      }),
    ]);
  });

  it('uses firstKeptEntryId plus a unique suffix match for legacy compaction copies', () => {
    const entries = [
      messageEntry('u1', null, 'user', 'first request'),
      messageEntry('a1', 'u1', 'assistant', 'first answer'),
      messageEntry('u2', 'a1', 'user', 'retained request'),
      messageEntry('a2', 'u2', 'assistant', 'retained answer'),
      compactionEntry('compact', 'legacy-u2-copy'),
      messageEntry('legacy-u2-copy', 'compact', 'user', 'retained request'),
      messageEntry('legacy-a2-copy', 'legacy-u2-copy', 'assistant', 'retained answer'),
      messageEntry('u3', 'legacy-a2-copy', 'user', 'new request'),
    ];

    const history = project(entries, 'u3');

    expect(history.status).toBe('resolved');
    expect(history.entries.map((entry) => entry.boundaryId)).toEqual([
      'u1',
      'a1',
      'u2',
      'a2',
      'u3',
    ]);
    expect(history.entries[2]?.auditEntryIds).toEqual(['u2', 'legacy-u2-copy']);
    expect(history.entries[3]?.auditEntryIds).toEqual(['a2', 'legacy-a2-copy']);
  });

  it('reconstructs and folds multiple compaction epochs in append order', () => {
    const entries = [
      messageEntry('u1', null, 'user', 'first request'),
      messageEntry('a1', 'u1', 'assistant', 'first answer'),
      messageEntry('u2', 'a1', 'user', 'second request'),
      messageEntry('a2', 'u2', 'assistant', 'second answer'),
      compactionEntry('compact-1', 'u2-copy-1'),
      messageEntry('u2-copy-1', 'compact-1', 'user', 'second request'),
      messageEntry('a2-copy-1', 'u2-copy-1', 'assistant', 'second answer'),
      messageEntry('u3', 'a2-copy-1', 'user', 'third request'),
      messageEntry('a3', 'u3', 'assistant', 'third answer'),
      compactionEntry('compact-2', 'u3-copy-2'),
      messageEntry('u3-copy-2', 'compact-2', 'user', 'third request', {
        logicalId: 'u3',
        sourceEntryId: 'u3',
      }),
      messageEntry('a3-copy-2', 'u3-copy-2', 'assistant', 'third answer', {
        logicalId: 'a3',
        sourceEntryId: 'a3',
      }),
      messageEntry('u4', 'a3-copy-2', 'user', 'fourth request'),
    ];

    const history = project(entries, 'u4');

    expect(history.status).toBe('resolved');
    expect(history.entries.map((entry) => entry.message.content)).toEqual([
      'first request',
      'first answer',
      'second request',
      'second answer',
      'third request',
      'third answer',
      'fourth request',
    ]);
    expect(history.entries[2]?.auditEntryIds).toEqual(['u2', 'u2-copy-1']);
    expect(history.entries[4]?.auditEntryIds).toEqual(['u3', 'u3-copy-2']);
  });

  it('uses sourceEntryId as explicit provenance when a legacy logicalId changed', () => {
    const entries = [
      messageEntry('u1', null, 'user', 'request'),
      compactionEntry('compact', 'u1-copy'),
      messageEntry('u1-copy', 'compact', 'user', 'request', {
        logicalId: 'u1-copy',
        sourceEntryId: 'u1',
      }),
    ];

    const history = project(entries, 'u1-copy');

    expect(history.status).toBe('resolved');
    expect(history.entries).toHaveLength(1);
    expect(history.entries[0]?.auditEntryIds).toEqual(['u1', 'u1-copy']);
  });

  it('uses an explicit first copy to topology-fold a later legacy copy', () => {
    const entries = [
      messageEntry('u1', null, 'user', 'request'),
      messageEntry('a1', 'u1', 'assistant', 'answer'),
      compactionEntry('compact', 'u1-copy'),
      messageEntry('u1-copy', 'compact', 'user', 'request', {
        logicalId: 'u1',
        sourceEntryId: 'u1',
      }),
      messageEntry('legacy-a1-copy', 'u1-copy', 'assistant', 'answer'),
      messageEntry('u2', 'legacy-a1-copy', 'user', 'next request'),
    ];

    const history = project(entries, 'u2');

    expect(history.status).toBe('resolved');
    expect(history.entries.map((entry) => entry.boundaryId)).toEqual([
      'u1',
      'a1',
      'u2',
    ]);
    expect(history.entries[1]?.auditEntryIds).toEqual(['a1', 'legacy-a1-copy']);
  });

  it('uses the retained suffix topology instead of the last appended inactive branch', () => {
    const entries = [
      messageEntry('u1', null, 'user', 'request'),
      messageEntry('a1', 'u1', 'assistant', 'active answer'),
      messageEntry('inactive-a1', 'u1', 'assistant', 'abandoned answer'),
      compactionEntry('compact', 'u1-copy'),
      messageEntry('u1-copy', 'compact', 'user', 'request'),
      messageEntry('a1-copy', 'u1-copy', 'assistant', 'active answer'),
    ];

    const history = project(entries, 'a1-copy');

    expect(history.status).toBe('resolved');
    expect(history.entries.map((entry) => entry.message.content)).toEqual([
      'request',
      'active answer',
    ]);
  });

  it('follows explicit provenance across an inactive compaction epoch', () => {
    const entries = [
      messageEntry('u0', null, 'user', 'base'),
      compactionEntry('compact-a', 'copy-a'),
      messageEntry('copy-a', 'compact-a', 'user', 'base', {
        logicalId: 'u0',
        sourceEntryId: 'u0',
      }),
      messageEntry('branch-a', 'copy-a', 'assistant', 'branch A'),
      compactionEntry('compact-b', 'copy-b'),
      messageEntry('copy-b', 'compact-b', 'user', 'base', {
        logicalId: 'u0',
        sourceEntryId: 'u0',
      }),
      messageEntry('branch-b', 'copy-b', 'assistant', 'branch B'),
      compactionEntry('compact-c', 'copy-c'),
      messageEntry('copy-c', 'compact-c', 'assistant', 'branch A', {
        logicalId: 'branch-a',
        sourceEntryId: 'branch-a',
      }),
      messageEntry('current', 'copy-c', 'assistant', 'current'),
    ];

    const history = project(entries, 'current');

    expect(history.status).toBe('resolved');
    expect(history.issues).toEqual([]);
    expect(history.entries.map((entry) => entry.message.content)).toEqual([
      'base',
      'branch A',
      'current',
    ]);
    expect(history.entries.map((entry) => entry.auditEntryIds)).toEqual([
      ['u0', 'copy-a'],
      ['branch-a', 'copy-c'],
      ['current'],
    ]);
  });

  it('uses an explicitly proven predecessor even when it has an abandoned child', () => {
    const entries = [
      messageEntry('u0', null, 'user', 'base'),
      messageEntry('branch-a', 'u0', 'assistant', 'branch A'),
      messageEntry('abandoned', 'branch-a', 'assistant', 'abandoned child'),
      compactionEntry('compact', 'copy-u0'),
      messageEntry('copy-u0', 'compact', 'user', 'base', {
        logicalId: 'u0',
        sourceEntryId: 'u0',
      }),
      messageEntry('copy-a', 'copy-u0', 'assistant', 'branch A', {
        logicalId: 'branch-a',
        sourceEntryId: 'branch-a',
      }),
      messageEntry('current', 'copy-a', 'assistant', 'current'),
    ];

    const history = project(entries, 'current');

    expect(history.status).toBe('resolved');
    expect(history.issues).toEqual([]);
    expect(history.entries.map((entry) => entry.message.content)).toEqual([
      'base',
      'branch A',
      'current',
    ]);
    expect(history.entries.map((entry) => entry.auditEntryIds)).toEqual([
      ['u0', 'copy-u0'],
      ['branch-a', 'copy-a'],
      ['current'],
    ]);
  });

  it('rejects a provenance path that reaches forward past its compaction', () => {
    const entries = [
      messageEntry('branch-a', 'future', 'assistant', 'branch A'),
      compactionEntry('compact', 'copy-future'),
      messageEntry('copy-future', 'compact', 'user', 'future base', {
        logicalId: 'future',
        sourceEntryId: 'future',
      }),
      messageEntry('copy-a', 'copy-future', 'assistant', 'branch A', {
        logicalId: 'branch-a',
        sourceEntryId: 'branch-a',
      }),
      messageEntry('current', 'copy-a', 'assistant', 'current'),
      messageEntry('future', null, 'user', 'future base'),
    ];

    const history = project(entries, 'current');

    expect(history.status).toBe('partial');
    expect(history.entries.map((entry) => entry.boundaryId)).toEqual([
      'branch-a',
      'copy-future',
      'copy-a',
      'current',
      'future',
    ]);
    expect(history.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'compaction_predecessor_missing' }),
    ]));
  });

  it('rejects a predecessor whose parent was appended after its child', () => {
    const entries = [
      messageEntry('branch-a', 'future-parent', 'assistant', 'branch A'),
      messageEntry('future-parent', null, 'user', 'future base'),
      compactionEntry('compact', 'copy-future'),
      messageEntry('copy-future', 'compact', 'user', 'future base', {
        logicalId: 'future-parent',
        sourceEntryId: 'future-parent',
      }),
      messageEntry('copy-a', 'copy-future', 'assistant', 'branch A', {
        logicalId: 'branch-a',
        sourceEntryId: 'branch-a',
      }),
      messageEntry('current', 'copy-a', 'assistant', 'current'),
    ];

    const history = project(entries, 'current');

    expect(history.status).toBe('partial');
    expect(history.entries.map((entry) => entry.boundaryId)).toEqual([
      'branch-a',
      'future-parent',
      'copy-future',
      'copy-a',
      'current',
    ]);
    expect(history.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'lineage_path_incomplete' }),
      expect.objectContaining({ code: 'compaction_predecessor_missing' }),
    ]));
  });

  it('preserves all candidates when two predecessor branches are indistinguishable', () => {
    const entries = [
      messageEntry('u1', null, 'user', 'request'),
      messageEntry('a1', 'u1', 'assistant', 'same answer'),
      messageEntry('a1-other', 'u1', 'assistant', 'same answer'),
      compactionEntry('compact', 'u1-copy'),
      messageEntry('u1-copy', 'compact', 'user', 'request'),
      messageEntry('a1-copy', 'u1-copy', 'assistant', 'same answer'),
    ];

    const history = project(entries, 'a1-copy');

    expect(history.status).toBe('ambiguous');
    expect(history.entries.map((entry) => entry.boundaryId)).toEqual([
      'u1',
      'a1',
      'a1-other',
      'u1-copy',
      'a1-copy',
    ]);
    expect(history.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'compaction_predecessor_ambiguous' }),
    ]));
  });

  it('preserves and reports an unproven legacy overlap instead of guessing', () => {
    const entries = [
      messageEntry('u1', null, 'user', 'request'),
      messageEntry('a1', 'u1', 'assistant', 'answer'),
      compactionEntry('compact'),
      messageEntry('legacy-u1-copy', 'compact', 'user', 'request'),
      messageEntry('legacy-a1-copy', 'legacy-u1-copy', 'assistant', 'answer'),
      messageEntry('u2', 'legacy-a1-copy', 'user', 'next request'),
    ];

    const history = project(entries, 'u2');

    expect(history.status).toBe('ambiguous');
    expect(history.entries.map((entry) => entry.boundaryId)).toEqual([
      'u1',
      'a1',
      'legacy-u1-copy',
      'legacy-a1-copy',
      'u2',
    ]);
    expect(history.issues).toEqual([
      expect.objectContaining({
        code: 'legacy_overlap_ambiguous',
        entryIds: ['legacy-u1-copy', 'legacy-a1-copy'],
      }),
    ]);
  });

  it('does not collapse a genuine repeated interaction on one active path', () => {
    const entries = [
      messageEntry('u1', null, 'user', 'repeat me'),
      messageEntry('a1', 'u1', 'assistant', 'same answer'),
      messageEntry('u2', 'a1', 'user', 'repeat me'),
      messageEntry('a2', 'u2', 'assistant', 'same answer'),
    ];

    const history = project(entries, 'a2');

    expect(history.status).toBe('resolved');
    expect(history.entries.map((entry) => entry.boundaryId)).toEqual([
      'u1',
      'a1',
      'u2',
      'a2',
    ]);
  });

  it('reports conflicting copies with one logical identity and preserves both', () => {
    const entries = [
      messageEntry('u1', null, 'user', 'original'),
      compactionEntry('compact', 'u1-copy'),
      messageEntry('u1-copy', 'compact', 'user', 'changed', {
        logicalId: 'u1',
        sourceEntryId: 'u1',
      }),
    ];

    const history = project(entries, 'u1-copy');

    expect(history.status).toBe('ambiguous');
    expect(history.entries.map((entry) => entry.boundaryId)).toEqual(['u1', 'u1-copy']);
    expect(history.entries.map((entry) => entry.auditEntryIds)).toEqual([
      ['u1'],
      ['u1-copy'],
    ]);
    expect(history.issues).toEqual([
      expect.objectContaining({
        code: 'logical_identity_conflict',
        entryIds: ['u1', 'u1-copy'],
      }),
    ]);
  });

  it('fails closed when one copy names two different provenance groups', () => {
    const entries = [
      messageEntry('u1', null, 'user', 'request'),
      messageEntry('a1', 'u1', 'assistant', 'answer'),
      compactionEntry('compact', 'u1-copy'),
      messageEntry('u1-copy', 'compact', 'user', 'request', {
        logicalId: 'u1',
        sourceEntryId: 'a1',
      }),
      messageEntry('a1-copy', 'u1-copy', 'assistant', 'answer', {
        logicalId: 'a1',
        sourceEntryId: 'a1',
      }),
    ];

    const history = project(entries, 'a1-copy');

    expect(history.status).toBe('ambiguous');
    expect(history.entries.map((entry) => entry.boundaryId)).toEqual([
      'u1',
      'a1',
      'u1-copy',
      'a1-copy',
    ]);
    expect(history.entries.flatMap((entry) => entry.auditEntryIds)
      .filter((entryId) => entryId === 'a1')).toHaveLength(1);
    expect(history.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'compaction_boundary_invalid' }),
    ]));
  });

  it('does not ignore a dangling provenance key beside a valid one', () => {
    const entries = [
      messageEntry('u1', null, 'user', 'request'),
      compactionEntry('compact', 'u1-copy'),
      messageEntry('u1-copy', 'compact', 'user', 'request', {
        logicalId: 'u1',
        sourceEntryId: 'missing-source',
      }),
    ];

    const history = project(entries, 'u1-copy');

    expect(history.status).toBe('ambiguous');
    expect(history.entries.map((entry) => entry.boundaryId)).toEqual([
      'u1',
      'u1-copy',
    ]);
    expect(history.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'compaction_boundary_invalid' }),
    ]));
  });

  it('fails closed when mixed provenance excludes every predecessor branch', () => {
    const entries = [
      messageEntry('u-a', null, 'user', 'request A'),
      messageEntry('a-a', 'u-a', 'assistant', 'answer'),
      messageEntry('u-b', null, 'user', 'request B'),
      messageEntry('a-b', 'u-b', 'assistant', 'answer'),
      compactionEntry('compact', 'u-copy'),
      messageEntry('u-copy', 'compact', 'user', 'request B'),
      messageEntry('a-copy', 'u-copy', 'assistant', 'answer', {
        logicalId: 'a-a',
        sourceEntryId: 'a-a',
      }),
    ];

    const history = project(entries, 'a-copy');

    expect(history.status).toBe('ambiguous');
    expect(history.entries.map((entry) => entry.boundaryId)).toEqual([
      'u-a',
      'a-a',
      'u-b',
      'a-b',
      'u-copy',
      'a-copy',
    ]);
    expect(history.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'compaction_boundary_invalid' }),
    ]));
  });

  it('keeps every physical message when the active topology is incomplete', () => {
    const entries = [
      messageEntry('orphan', 'missing-parent', 'assistant', 'orphaned answer'),
      messageEntry('other-root', null, 'user', 'other retained record'),
    ];

    const history = project(entries, 'orphan');

    expect(history.status).toBe('partial');
    expect(history.entries.map((entry) => entry.boundaryId)).toEqual([
      'orphan',
      'other-root',
    ]);
    expect(history.issues).toEqual([
      expect.objectContaining({ code: 'lineage_path_incomplete' }),
    ]);
  });

  it('keeps every physical message when no active entry was persisted', () => {
    const entries = [
      messageEntry('u1', null, 'user', 'first candidate'),
      messageEntry('u2', null, 'user', 'second candidate'),
    ];
    const lineage: KodaXSessionLineage = {
      version: 2,
      activeEntryId: null,
      entries,
    };

    const history = buildSessionConversationHistory(
      lineage,
      'sha256:test-source',
    );

    expect(history.status).toBe('partial');
    expect(history.entries.map((entry) => entry.boundaryId)).toEqual(['u1', 'u2']);
    expect(history.issues).toEqual([
      expect.objectContaining({
        code: 'active_entry_missing',
        occurrenceCount: 1,
        entryCount: 2,
      }),
    ]);
  });

  it('bounds diagnostic evidence without dropping conversation records', () => {
    const entries = Array.from({ length: 100 }, (_, index) =>
      messageEntry(`u-${index}`, null, 'user', `request ${index}`));
    const lineage: KodaXSessionLineage = {
      version: 2,
      activeEntryId: null,
      entries,
    };

    const history = buildSessionConversationHistory(lineage, 'sha256:large');

    expect(history.entries).toHaveLength(100);
    expect(history.issues).toEqual([
      expect.objectContaining({
        code: 'active_entry_missing',
        occurrenceCount: 1,
        entryCount: 100,
      }),
    ]);
    expect(history.issues[0]?.entryIds).toHaveLength(16);
  });

  it('does not copy an oversized corrupt entry id into issue metadata', () => {
    const oversizedId = 'x'.repeat(8 * 1024);
    const lineage: KodaXSessionLineage = {
      version: 2,
      activeEntryId: null,
      entries: [messageEntry(oversizedId, null, 'user', 'preserved request')],
    };

    const history = buildSessionConversationHistory(lineage, 'sha256:oversized-id');

    expect(history.entries[0]?.boundaryId).toBe(oversizedId);
    expect(history.issues[0]).toMatchObject({
      code: 'active_entry_missing',
      entryCount: 1,
      entryIds: [],
    });
    expect(JSON.stringify(history.issues).length).toBeLessThan(1_024);
  });

  it('resolves large repeated legacy suffix candidates without quadratic scanning', () => {
    const entries: KodaXSessionEntry[] = [];
    let parentId: string | null = null;
    for (let index = 0; index < 5_000; index += 1) {
      const id = `prior-${index}`;
      entries.push(messageEntry(id, parentId, 'user', 'same payload'));
      parentId = id;
    }
    entries.push(compactionEntry('compact-large', 'copy-0'));
    parentId = 'compact-large';
    for (let index = 0; index < 5_000; index += 1) {
      const id = `copy-${index}`;
      entries.push(messageEntry(id, parentId, 'user', 'same payload'));
      parentId = id;
    }

    const history = project(entries, parentId);

    expect(history.status).toBe('ambiguous');
    expect(history.entries).toHaveLength(10_000);
    expect(history.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'compaction_boundary_invalid' }),
    ]));
  }, 1_500);

  it('reconstructs thousands of compaction epochs without rescanning all history', () => {
    const entries: KodaXSessionEntry[] = [
      messageEntry('message-0', null, 'user', 'request 0'),
    ];
    let retainedId = 'message-0';
    for (let index = 1; index <= 2_000; index += 1) {
      const compactionId = `compact-${index}`;
      const copyId = `copy-${index}`;
      const messageId = `message-${index}`;
      entries.push(compactionEntry(compactionId, copyId));
      entries.push(messageEntry(
        copyId,
        compactionId,
        'user',
        `request ${index - 1}`,
        { logicalId: retainedId, sourceEntryId: retainedId },
      ));
      entries.push(messageEntry(
        messageId,
        copyId,
        'user',
        `request ${index}`,
      ));
      retainedId = messageId;
    }

    const history = project(entries, retainedId);

    expect(history.status).toBe('resolved');
    expect(history.entries).toHaveLength(2_001);
  }, 1_500);

  it('propagates projection checkpoints through conversation-boundary forks', () => {
    const entries = [
      messageEntry('u1', null, 'user', 'first request'),
      messageEntry('a1', 'u1', 'assistant', 'first answer'),
      compactionEntry('compact', 'u1-copy'),
      messageEntry('u1-copy', 'compact', 'user', 'first request', {
        logicalId: 'u1',
        sourceEntryId: 'u1',
      }),
      messageEntry('a1-copy', 'u1-copy', 'assistant', 'first answer', {
        logicalId: 'a1',
        sourceEntryId: 'a1',
      }),
      messageEntry('u2', 'a1-copy', 'user', 'second request'),
    ];
    const checkpoint = vi.fn();

    const forked = forkSessionConversationLineage({
      version: 2,
      activeEntryId: 'u2',
      entries,
    }, 'u2', 'sha256:test-source', checkpoint);

    expect(forked).not.toBeNull();
    expect(checkpoint).toHaveBeenCalled();
  });

  it('checks the budget while scanning a large inactive lineage', () => {
    const entries: KodaXSessionEntry[] = [
      messageEntry('active', null, 'user', 'active request'),
    ];
    for (let index = 0; index < 1_000; index += 1) {
      entries.push(messageEntry(`inactive-${index}`, null, 'user', `inactive ${index}`));
    }
    let checks = 0;

    expect(() => forkSessionConversationLineage({
      version: 2,
      activeEntryId: 'active',
      entries,
    }, 'active', 'sha256:test-source', () => {
      checks += 1;
      if (checks === 2) throw new Error('projection budget exhausted');
    })).toThrow('projection budget exhausted');
  });

  it('checkpoints during conversation epoch preprocessing', () => {
    let checks = 0;
    const entries: KodaXSessionEntry[] = [
      messageEntry('active', null, 'user', 'active request'),
    ];
    for (let index = 0; index < 1_000; index += 1) {
      const entry = messageEntry(`inactive-${index}`, null, 'user', `inactive ${index}`);
      if (index === 300) {
        Object.defineProperty(entry, 'type', {
          configurable: true,
          enumerable: true,
          get: () => {
            if (checks < 2) throw new Error('epoch scan passed its checkpoint budget');
            return 'message';
          },
        });
      }
      entries.push(entry);
    }

    expect(() => buildSessionConversationHistory({
      version: 2,
      activeEntryId: 'active',
      entries,
    }, 'sha256:test-source', () => { checks += 1; })).not.toThrow();
  });

  it('checkpoints inside a large explicit provenance overlap', () => {
    const entries: KodaXSessionEntry[] = [];
    let priorParentId: string | null = null;
    for (let index = 0; index < 600; index += 1) {
      const id = `prior-${index}`;
      entries.push(messageEntry(id, priorParentId, 'user', `message ${index}`));
      priorParentId = id;
    }
    entries.push(compactionEntry('compact', 'copy-0'));
    let copyParentId = 'compact';
    let comparisonStarted = false;
    let comparisonCheckpoints = 0;
    for (let index = 0; index < 600; index += 1) {
      const entry = messageEntry(`copy-${index}`, copyParentId, 'user', `message ${index}`, {
        logicalId: `prior-${index}`,
        sourceEntryId: `prior-${index}`,
      });
      if (index === 0 || index === 300) {
        let reads = 0;
        Object.defineProperty(entry, 'logicalId', {
          configurable: true,
          enumerable: true,
          get: () => {
            reads += 1;
            if (index === 0 && reads === 4) comparisonStarted = true;
            if (index === 300 && reads === 2 && comparisonCheckpoints === 0) {
              throw new Error('overlap comparison passed its checkpoint budget');
            }
            return `prior-${index}`;
          },
        });
      }
      entries.push(entry);
      copyParentId = `copy-${index}`;
    }

    expect(() => buildSessionConversationHistory({
      version: 2,
      activeEntryId: 'copy-599',
      entries,
    }, 'sha256:test-source', () => {
      if (comparisonStarted) comparisonCheckpoints += 1;
    })).not.toThrow();
  });
});
