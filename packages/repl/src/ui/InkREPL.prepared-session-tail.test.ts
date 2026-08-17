import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  createSessionLineage,
  getSessionMessagesFromLineage,
  type AgentActorSnapshot,
} from '@kodax-ai/agent';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createPreparedSessionTail,
  persistHostSessionPayload,
} from './InkREPL.js';
import {
  FileSessionStorage,
  type PreparedSessionAppendBaseline,
} from '../interactive/storage.js';
import type { SessionData } from './utils/session-storage.js';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

function actorSnapshot(): AgentActorSnapshot {
  const now = '2026-08-17T00:00:00.000Z';
  return {
    schemaVersion: 1,
    revision: 1,
    maxConcurrentThreads: 4,
    actors: [{
      path: '/root',
      taskName: 'root',
      kind: 'native',
      state: 'running',
      capabilities: {
        tools: ['*'],
        filesystem: 'write',
        network: true,
        providers: ['*'],
        canAskUser: true,
      },
      turnIds: [],
      mailboxCursor: 0,
      createdAt: now,
      updatedAt: now,
      revision: 1,
    }],
    turns: [],
    mailboxes: { '/root': [] },
    events: [],
  };
}

function fixture(): {
  baseline: PreparedSessionAppendBaseline;
  data: SessionData;
} {
  const messages = [{ role: 'user' as const, content: 'prepared helper base' }];
  const lineage = createSessionLineage(messages);
  return {
    baseline: {
      sessionId: 'prepared-helper-session',
      revision: 'prepared-helper-revision',
      lineageCount: lineage.entries.length,
      artifactCount: 1,
      extensionCount: 0,
      activeEntryId: lineage.activeEntryId,
    },
    data: {
      messages,
      title: 'Prepared helper',
      gitRoot: '/repo',
      lineage,
      artifactLedger: [{
        id: 'artifact-replacement',
        kind: 'file_read',
        target: 'same.ts',
        timestamp: '2026-08-02T00:00:01.000Z',
      }],
    },
  };
}

describe('createPreparedSessionTail', () => {
  it('forces the exact path for an in-place artifact replacement', () => {
    const { baseline, data } = fixture();

    expect(createPreparedSessionTail(data, baseline, true)).toBeUndefined();
  });

  it('forces the exact path for a fixed-cap artifact rollover', () => {
    const { baseline, data } = fixture();
    const artifactLedger = Array.from({ length: 256 }, (_, index) => ({
      id: `rollover-${index}`,
      kind: 'file_read',
      target: `rollover-${index}.ts`,
      timestamp: '2026-08-02T00:00:01.000Z',
    }));
    data.artifactLedger = artifactLedger;

    expect(createPreparedSessionTail(
      data,
      { ...baseline, artifactCount: artifactLedger.length },
      true,
    )).toBeUndefined();
  });

  it('forces the exact path when runtime migration changed non-tail metadata', () => {
    const { baseline, data } = fixture();
    data.runtimeInfo = {
      workspaceRoot: '/replacement-workspace',
      executionCwd: '/replacement-workspace',
    };

    expect(createPreparedSessionTail(data, baseline, true)).toBeUndefined();
  });

  it('reloads a stale prepared boundary without losing a concurrent actor snapshot', async () => {
    const sessionsDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-ink-session-race-'));
    tempRoots.push(sessionsDir);
    const sessionId = 'runtime-actor-ui-tail-race';
    const uiStorage = new FileSessionStorage({ sessionsDir, cwd: sessionsDir });
    const runtimeStorage = new FileSessionStorage({ sessionsDir, cwd: sessionsDir });
    const baseMessages = [{ role: 'user' as const, content: 'base request' }];
    const baseLineage = createSessionLineage(baseMessages);
    await uiStorage.save(sessionId, {
      messages: baseMessages,
      title: 'Runtime actor race',
      gitRoot: sessionsDir,
      lineage: baseLineage,
    });
    const uiLineage = createSessionLineage([
      ...baseMessages,
      { role: 'assistant' as const, content: 'ui tail survives' },
    ], baseLineage);
    let raced = false;
    const racingStorage = {
      save: uiStorage.save.bind(uiStorage),
      appendSessionDelta: uiStorage.appendSessionDelta.bind(uiStorage),
      appendPreparedSessionTail: uiStorage.appendPreparedSessionTail.bind(uiStorage),
      prepareSessionAppend: async (id: string) => {
        const baseline = await uiStorage.prepareSessionAppend(id);
        if (!raced) {
          raced = true;
          await runtimeStorage.save(id, {
            messages: baseMessages,
            title: 'Runtime actor race',
            gitRoot: sessionsDir,
            lineage: baseLineage,
            actorSnapshot: actorSnapshot(),
          });
        }
        return baseline;
      },
    };

    await persistHostSessionPayload(
      racingStorage,
      sessionId,
      {
        messages: getSessionMessagesFromLineage(uiLineage),
        title: 'Runtime actor race',
        gitRoot: sessionsDir,
        lineage: uiLineage,
      },
      false,
    );

    const persisted = await new FileSessionStorage({ sessionsDir, cwd: sessionsDir })
      .load(sessionId);
    expect(persisted?.messages.at(-1)?.content).toBe('ui tail survives');
    expect(persisted?.actorSnapshot?.revision).toBe(1);
  });
});
