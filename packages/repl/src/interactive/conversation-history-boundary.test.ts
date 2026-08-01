import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FileSessionStorage, SessionReadError } from './storage.js';
import { buildSessionConversationHistory } from '../session/conversation-history.js';

describe('conversation history mutation boundaries', () => {
  let root: string;
  let sessionsDir: string;
  let storage: FileSessionStorage;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'kodax-conversation-boundary-'));
    sessionsDir = path.join(root, 'sessions');
    storage = new FileSessionStorage({
      sessionsDir,
      configHome: path.join(root, 'config'),
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function writeCompactedFixture(
    sessionId: string,
    options: { brokenActiveParent?: boolean } = {},
  ): Promise<{
    mainPath: string;
    sidecarPath: string;
  }> {
    const projectDir = path.join(sessionsDir, 'project');
    const mainPath = path.join(projectDir, `${sessionId}.jsonl`);
    const sidecarPath = path.join(projectDir, `${sessionId}.islands.jsonl`);
    const timestamp = '2026-08-01T00:00:00.000Z';
    const mainEntries = [
      {
        type: 'compaction',
        id: 'compact',
        parentId: null,
        timestamp,
        logicalId: 'compact',
        summary: 'summary',
        firstKeptEntryId: 'u2-copy',
      },
      {
        type: 'message',
        id: 'u2-copy',
        parentId: 'compact',
        timestamp,
        logicalId: 'u2',
        sourceEntryId: 'u2',
        message: { role: 'user', content: 'second request' },
      },
      {
        type: 'message',
        id: 'a2-copy',
        parentId: 'u2-copy',
        timestamp,
        logicalId: 'a2',
        sourceEntryId: 'a2',
        message: { role: 'assistant', content: 'second answer' },
      },
      {
        type: 'message',
        id: 'u3',
        parentId: options.brokenActiveParent === true ? 'missing-parent' : 'a2-copy',
        timestamp,
        logicalId: 'u3',
        message: { role: 'user', content: 'third request' },
      },
    ];
    const archivedEntries = [
      { id: 'u1', parentId: null, logicalId: 'u1', role: 'user', content: 'first request' },
      { id: 'a1', parentId: 'u1', logicalId: 'a1', role: 'assistant', content: 'first answer' },
      { id: 'u2', parentId: 'a1', logicalId: 'u2', role: 'user', content: 'second request' },
      { id: 'a2', parentId: 'u2', logicalId: 'a2', role: 'assistant', content: 'second answer' },
    ];
    await mkdir(projectDir, { recursive: true });
    await writeFile(mainPath, [
      JSON.stringify({
        _type: 'meta',
        id: sessionId,
        title: 'Boundary fixture',
        gitRoot: root,
        createdAt: timestamp,
        scope: 'user',
        lineageVersion: 2,
        activeEntryId: 'u3',
        activeMessageCount: 4,
        lineageEntryCount: mainEntries.length,
      }),
      ...mainEntries.map((entry) => JSON.stringify({ _type: 'lineage_entry', entry })),
    ].join('\n') + '\n', { encoding: 'utf8', flag: 'wx' });
    await writeFile(sidecarPath, [
      JSON.stringify({
        _type: 'archive_batch',
        archiveBatchId: 'batch_old',
        sessionId,
        archivedAt: timestamp,
        entryCount: archivedEntries.length,
      }),
      ...archivedEntries.map((entry, index) => JSON.stringify({
        _type: 'archived_entry',
        archiveBatchId: 'batch_old',
        previousEntryId: index === 0 ? undefined : archivedEntries[index - 1]?.id,
        nextEntryId: index === archivedEntries.length - 1
          ? 'compact'
          : archivedEntries[index + 1]?.id,
        entry: {
          type: 'message',
          id: entry.id,
          parentId: entry.parentId,
          timestamp,
          logicalId: entry.logicalId,
          message: { role: entry.role, content: entry.content },
        },
      })),
    ].join('\n') + '\n', { encoding: 'utf8', flag: 'wx' });
    return { mainPath, sidecarPath };
  }

  it('forks from an archived conversation boundary at the captured revision', async () => {
    await writeCompactedFixture('fork-source');
    const snapshot = await storage.readFullSnapshot('fork-source');
    if (snapshot === null) throw new Error('fixture did not load');

    const result = await storage.fork('fork-source', 'u1', {
      sessionId: 'fork-target',
      historyBoundary: { sourceRevision: snapshot.sourceRevision },
    });

    expect(result?.data.messages).toEqual([
      expect.objectContaining({ role: 'user', content: 'first request' }),
    ]);
    expect(result?.data.lineage?.entries).toEqual([
      expect.objectContaining({ logicalId: 'u1', sourceEntryId: 'u1' }),
    ]);
  });

  it('rewinds to an archived conversation boundary without losing the audit tail', async () => {
    await writeCompactedFixture('rewind-source');
    const snapshot = await storage.readFullSnapshot('rewind-source');
    if (snapshot === null) throw new Error('fixture did not load');

    const result = await storage.rewind('rewind-source', 'u1', {
      historyBoundary: { sourceRevision: snapshot.sourceRevision },
    });
    const audit = await storage.readFullSnapshot('rewind-source');

    expect(result?.messages).toEqual([
      expect.objectContaining({ role: 'user', content: 'first request' }),
    ]);
    expect(audit?.lineage?.entries.map((entry) => entry.id)).toEqual(expect.arrayContaining([
      'u1',
      'compact',
      'u2-copy',
      'a2-copy',
      'u3',
    ]));
    expect(audit?.lineage?.entries.at(-1)).toMatchObject({
      type: 'rewind_marker',
      targetId: 'u1',
      fromId: 'u3',
      truncatedCount: 7,
    });
  });

  it('forks a post-compaction boundary with the same resolved conversation prefix', async () => {
    await writeCompactedFixture('post-compaction-source');
    const snapshot = await storage.readFullSnapshot('post-compaction-source');
    if (snapshot === null) throw new Error('fixture did not load');
    if (snapshot.lineage === null) throw new Error('source lineage missing');
    const sourceHistory = buildSessionConversationHistory(
      snapshot.lineage,
      snapshot.sourceRevision,
    );

    const result = await storage.fork('post-compaction-source', 'u3', {
      sessionId: 'post-compaction-fork',
      historyBoundary: { sourceRevision: snapshot.sourceRevision },
    });
    const forkSnapshot = await storage.readFullSnapshot('post-compaction-fork');
    if (forkSnapshot?.lineage === null || forkSnapshot === null) {
      throw new Error('fork history missing');
    }
    const forkHistory = buildSessionConversationHistory(
      forkSnapshot.lineage,
      forkSnapshot.sourceRevision,
    );

    expect(result).not.toBeNull();
    expect(forkHistory.status).toBe('resolved');
    expect(forkHistory.entries.map((entry) => entry.message.content)).toEqual(
      sourceHistory.entries.map((entry) => entry.message.content),
    );
    const compact = result?.data.lineage?.entries.find(
      (entry) => entry.type === 'compaction',
    );
    expect(compact).toMatchObject({
      type: 'compaction',
      firstKeptEntryId: expect.any(String),
    });
    expect(result?.data.lineage?.entries.some(
      (entry) => entry.id === (compact?.type === 'compaction'
        ? compact.firstKeptEntryId
        : undefined),
    )).toBe(true);
  });

  it('fails closed when a conversation boundary revision is stale', async () => {
    const { mainPath, sidecarPath } = await writeCompactedFixture('stale-source');
    const before = await Promise.all([
      readFile(mainPath),
      readFile(sidecarPath),
    ]);

    await expect(storage.rewind('stale-source', 'u1', {
      historyBoundary: { sourceRevision: 'sha256:stale' },
    })).rejects.toBeInstanceOf(SessionReadError);
    await expect(Promise.all([
      readFile(mainPath),
      readFile(sidecarPath),
    ])).resolves.toEqual(before);
  });

  it('rejects a revision-matched boundary whose parent path is incomplete', async () => {
    const { mainPath, sidecarPath } = await writeCompactedFixture(
      'incomplete-source',
      { brokenActiveParent: true },
    );
    const snapshot = await storage.readFullSnapshot('incomplete-source');
    if (snapshot === null) throw new Error('fixture did not load');
    const before = await Promise.all([readFile(mainPath), readFile(sidecarPath)]);

    await expect(storage.fork('incomplete-source', 'u3', {
      sessionId: 'incomplete-fork',
      historyBoundary: { sourceRevision: snapshot.sourceRevision },
    })).resolves.toBeNull();
    await expect(storage.rewind('incomplete-source', 'u3', {
      historyBoundary: { sourceRevision: snapshot.sourceRevision },
    })).resolves.toBeNull();
    await expect(Promise.all([
      readFile(mainPath),
      readFile(sidecarPath),
    ])).resolves.toEqual(before);
  });
});
