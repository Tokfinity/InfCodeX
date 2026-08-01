import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { KodaXSessionEntry, KodaXSessionLineage } from '@kodax-ai/agent';
import { createSessionManager } from '@kodax-ai/repl';

import { createKodaXRuntime, type RuntimeConversationHistorySlice } from './sdk-runtime.js';

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

describe('Runtime conversation history', () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true })));
  });

  async function fixture(
    finalAnswer = 'third answer',
    isolation: 'inline' | 'worker' = 'inline',
    legacyAmbiguous = false,
  ) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-runtime-conversation-'));
    tempRoots.push(root);
    const sessionsDir = path.join(root, 'sessions');
    const sessionId = 'conversation-runtime-source';
    const entries: KodaXSessionEntry[] = legacyAmbiguous
      ? [
          messageEntry('u1', null, 'user', 'first request'),
          messageEntry('a1', 'u1', 'assistant', 'first answer'),
          {
            type: 'compaction',
            id: 'compact',
            parentId: null,
            timestamp,
            logicalId: 'compact',
            summary: 'summary',
          },
          messageEntry('legacy-u1-copy', 'compact', 'user', 'first request'),
          messageEntry('legacy-a1-copy', 'legacy-u1-copy', 'assistant', 'first answer'),
          messageEntry('u3', 'legacy-a1-copy', 'user', 'third request'),
        ]
      : [
          messageEntry('u1', null, 'user', 'first request'),
          messageEntry('a1', 'u1', 'assistant', 'first answer'),
          messageEntry('u2', 'a1', 'user', 'second request'),
          messageEntry('a2', 'u2', 'assistant', 'second answer'),
          {
            type: 'compaction',
            id: 'compact',
            parentId: null,
            timestamp,
            logicalId: 'compact',
            summary: 'summary',
            firstKeptEntryId: 'u2-copy',
          },
          messageEntry('u2-copy', 'compact', 'user', 'second request', {
            logicalId: 'u2',
            sourceEntryId: 'u2',
          }),
          messageEntry('a2-copy', 'u2-copy', 'assistant', 'second answer', {
            logicalId: 'a2',
            sourceEntryId: 'a2',
          }),
          messageEntry('u3', 'a2-copy', 'user', 'third request'),
          messageEntry('a3', 'u3', 'assistant', finalAnswer),
        ];
    const lineage: KodaXSessionLineage = {
      version: 2,
      activeEntryId: legacyAmbiguous ? 'u3' : 'a3',
      entries,
    };
    const manager = createSessionManager({ sessionsDir });
    await manager.storage.save(sessionId, {
      title: 'Conversation Runtime',
      gitRoot: root,
      scope: 'user',
      lineage,
      messages: legacyAmbiguous
        ? [
            { role: 'system', content: '[summary]' },
            { role: 'user', content: 'first request' },
            { role: 'assistant', content: 'first answer' },
            { role: 'user', content: 'third request' },
          ]
        : [
            { role: 'system', content: '[summary]' },
            { role: 'user', content: 'second request' },
            { role: 'assistant', content: 'second answer' },
            { role: 'user', content: 'third request' },
            { role: 'assistant', content: finalAnswer },
          ],
    });
    const runtime = await createKodaXRuntime({
      homeDir: root,
      sessionsDir,
      ...(isolation === 'worker' ? { isolation } : {}),
    });
    return { manager, root, runtime, sessionId };
  }

  it('returns the same resolved order from direct and immutable paged reads', async () => {
    const { runtime, sessionId } = await fixture();
    try {
      const direct = await runtime.sessions.conversation(sessionId);
      if (direct === null) throw new Error('conversation history missing');
      const reconstructed: RuntimeConversationHistorySlice['entries'][number][] = [];
      let cursor: string | undefined;
      do {
        const page = await runtime.sessions.conversationPage({
          sessionId,
          ...(cursor !== undefined ? { cursor } : {}),
          limit: 2,
        });
        if (page === null) throw new Error('conversation page missing');
        expect(page.revision).toBe(direct.revision);
        expect(page.sourceRevision).toBe(direct.sourceRevision);
        expect(page.status).toBe('resolved');
        reconstructed.unshift(...page.entries);
        cursor = page.nextCursor;
      } while (cursor !== undefined);

      expect(reconstructed.map((item) => item.entry)).toEqual(direct.entries);
      expect(direct.entries.map((entry) => entry.message.content)).toEqual([
        'first request',
        'first answer',
        'second request',
        'second answer',
        'third request',
        'third answer',
      ]);
    } finally {
      await runtime.close();
    }
  });

  it('forks against the exact history source revision and rejects a stale one', async () => {
    const { manager, runtime, sessionId } = await fixture();
    try {
      const history = await runtime.sessions.conversation(sessionId);
      if (history === null) throw new Error('conversation history missing');
      const first = history.entries[0];
      if (first?.boundaryId === undefined) throw new Error('boundary missing');

      const forked = await runtime.sessions.fork({
        sessionId,
        newSessionId: 'conversation-fork',
        historyBoundary: {
          entryId: first.boundaryId,
          sourceRevision: history.sourceRevision,
        },
      });
      expect(forked?.id).toBe('conversation-fork');
      await expect(runtime.sessions.fork({
        sessionId,
        newSessionId: 'stale-fork',
        historyBoundary: {
          entryId: first.boundaryId,
          sourceRevision: 'sha256:stale',
        },
      })).rejects.toMatchObject({ code: 'resync_required' });
      await expect(runtime.sessions.fork({
        sessionId,
        newSessionId: 'missing-boundary-fork',
        historyBoundary: {
          entryId: 'missing-entry',
          sourceRevision: history.sourceRevision,
        },
      })).resolves.toBeNull();
      await expect(manager.storage.load('missing-boundary-fork')).resolves.toBeNull();
    } finally {
      await runtime.close();
    }
  });

  it('retrieves an oversized projected entry from the same immutable snapshot', async () => {
    const finalAnswer = 'large answer '.repeat(40_000);
    const { runtime, sessionId } = await fixture(finalAnswer);
    try {
      const direct = await runtime.sessions.conversation(sessionId);
      if (direct === null) throw new Error('conversation history missing');
      const page = await runtime.sessions.conversationPage({
        sessionId,
        limit: 20,
      });
      if (page === null) throw new Error('conversation page missing');
      const oversized = page.entries.find((entry) => entry.oversized);
      if (oversized === undefined) throw new Error('oversized entry missing');
      expect(oversized.entry).toBeUndefined();

      const chunks: Buffer[] = [];
      let cursor: string | undefined;
      do {
        const chunk = await runtime.sessions.conversationEntryChunk({
          sessionId,
          revision: page.revision,
          entryIndex: oversized.index,
          ...(cursor !== undefined ? { cursor } : {}),
        });
        if (chunk === null) throw new Error('conversation chunk missing');
        chunks.push(Buffer.from(chunk.data, 'base64'));
        cursor = chunk.nextCursor;
      } while (cursor !== undefined);

      expect(JSON.parse(Buffer.concat(chunks).toString('utf8'))).toEqual(
        direct.entries[oversized.index],
      );
    } finally {
      await runtime.close();
    }
  });

  it('keeps the conversation contract through Worker-hosted embedded transport', async () => {
    const { runtime, sessionId } = await fixture('third answer', 'worker');
    try {
      const direct = await runtime.sessions.conversation(sessionId);
      const page = await runtime.sessions.conversationPage({
        sessionId,
        limit: 20,
      });
      expect(page?.entries.map((entry) => entry.entry)).toEqual(direct?.entries);
      expect(page).toMatchObject({
        revision: direct?.revision,
        sourceRevision: direct?.sourceRevision,
        status: 'resolved',
      });
    } finally {
      await runtime.close();
    }
  });

  it('keeps ambiguous candidates and issues identical across direct and pages', async () => {
    const { runtime, sessionId } = await fixture('unused', 'inline', true);
    try {
      const direct = await runtime.sessions.conversation(sessionId);
      const page = await runtime.sessions.conversationPage({
        sessionId,
        limit: 20,
      });
      expect(direct).toMatchObject({
        status: 'ambiguous',
        issues: [expect.objectContaining({ code: 'legacy_overlap_ambiguous' })],
      });
      expect(page).toMatchObject({
        revision: direct?.revision,
        sourceRevision: direct?.sourceRevision,
        status: direct?.status,
        issues: direct?.issues,
      });
      expect(page?.entries.map((entry) => entry.entry)).toEqual(direct?.entries);
      expect(direct?.entries.map((entry) => entry.boundaryId)).toEqual([
        'u1',
        'a1',
        'legacy-u1-copy',
        'legacy-a1-copy',
        'u3',
      ]);
    } finally {
      await runtime.close();
    }
  });

  it('does not let an embedded page caller mutate cached issue metadata', async () => {
    const { runtime, sessionId } = await fixture('unused', 'inline', true);
    try {
      const first = await runtime.sessions.conversationPage({
        sessionId,
        limit: 2,
      });
      if (first === null || first.nextCursor === undefined) {
        throw new Error('multi-page conversation missing');
      }
      const mutableIssues = first.issues as Array<{
        code: string;
        message: string;
        entryIds: string[];
      }>;
      mutableIssues[0]?.entryIds.push('caller-mutation');
      mutableIssues.push({
        code: 'caller_mutation',
        message: 'must not enter the snapshot',
        entryIds: [],
      });

      const second = await runtime.sessions.conversationPage({
        sessionId,
        cursor: first.nextCursor,
        limit: 2,
      });

      expect(second?.issues).toEqual([
        expect.objectContaining({
          code: 'legacy_overlap_ambiguous',
          entryIds: ['legacy-u1-copy', 'legacy-a1-copy'],
        }),
      ]);
    } finally {
      await runtime.close();
    }
  });
});
