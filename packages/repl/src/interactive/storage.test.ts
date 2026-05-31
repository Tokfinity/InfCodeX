import os from 'os';
import path from 'path';
import { existsSync } from 'fs';
import { mkdtemp, readFile, rm, utimes, writeFile } from 'fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applySessionCompaction, createSessionLineage } from '@kodax-ai/coding';

describe('FileSessionStorage', () => {
  let tempHome: string;
  let previousHome: string | undefined;
  let previousUserProfile: string | undefined;

  beforeEach(async () => {
    tempHome = await mkdtemp(path.join(os.tmpdir(), 'kodax-storage-'));
    previousHome = process.env.HOME;
    previousUserProfile = process.env.USERPROFILE;
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    vi.resetModules();
  });

  afterEach(async () => {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }

    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserProfile;
    }

    vi.resetModules();
    await rm(tempHome, { recursive: true, force: true });
  });

  it('round-trips extension state and extension records through JSONL session storage', async () => {
    const gitRoot = path.resolve('C:/Works/GitWorks/KodaX').replace(/\\/g, '/');
    vi.doMock('./workspace-runtime.js', async () => {
      const actual = await vi.importActual<typeof import('./workspace-runtime.js')>('./workspace-runtime.js');
      return {
        ...actual,
        inspectWorkspaceRuntime: vi.fn(async () => ({
          canonicalRepoRoot: gitRoot,
          workspaceRoot: gitRoot,
          executionCwd: `${gitRoot}/packages/repl`,
          branch: 'feature/runtime-truth',
          workspaceKind: 'detected',
        })),
      };
    });

    const { FileSessionStorage } = await import('./storage.js');
    const storage = new FileSessionStorage();
    const runtimeInfo = {
      canonicalRepoRoot: gitRoot,
      workspaceRoot: gitRoot,
      executionCwd: `${gitRoot}/packages/repl`,
      branch: 'feature/runtime-truth',
      workspaceKind: 'detected' as const,
    };

    await storage.save('session-1', {
      messages: [{ role: 'user', content: 'hello persisted runtime' }],
      title: 'Persisted Runtime',
      gitRoot,
      runtimeInfo,
      uiHistory: [
        { type: 'user', text: 'hello persisted runtime' },
        { type: 'assistant', text: 'managed transcript survives resume' },
      ],
      extensionState: {
        'api:extension:C:/repo/extensions/sample.mjs': {
          phase: 'collecting',
          visits: 2,
        },
      },
      extensionRecords: [
        {
          id: 'record-1',
          extensionId: 'api:extension:C:/repo/extensions/sample.mjs',
          type: 'hydrate',
          ts: 1,
          data: { visits: 2 },
          dedupeKey: 'latest',
        },
      ],
      artifactLedger: [
        {
          id: 'artifact-1',
          kind: 'file_read',
          sourceTool: 'read',
          action: 'read',
          target: 'src/app.ts',
          displayTarget: 'src/app.ts',
          summary: 'Read src/app.ts',
          timestamp: '2026-04-03T00:00:00.000Z',
          metadata: { reason: 'resume' },
        },
      ],
    });

    await expect(storage.load('session-1')).resolves.toEqual({
      messages: [{ role: 'user', content: 'hello persisted runtime' }],
      title: 'Persisted Runtime',
      gitRoot,
      runtimeInfo,
      scope: 'user',
      uiHistory: [
        { type: 'user', text: 'hello persisted runtime' },
        { type: 'assistant', text: 'managed transcript survives resume' },
      ],
      errorMetadata: undefined,
      artifactLedger: [
        {
          id: 'artifact-1',
          kind: 'file_read',
          sourceTool: 'read',
          action: 'read',
          target: 'src/app.ts',
          displayTarget: 'src/app.ts',
          summary: 'Read src/app.ts',
          timestamp: '2026-04-03T00:00:00.000Z',
          metadata: { reason: 'resume' },
        },
      ],
      extensionState: {
        'api:extension:C:/repo/extensions/sample.mjs': {
          phase: 'collecting',
          visits: 2,
        },
      },
      extensionRecords: [
        {
          id: 'record-1',
          extensionId: 'api:extension:C:/repo/extensions/sample.mjs',
          type: 'hydrate',
          ts: 1,
          data: { visits: 2 },
          dedupeKey: 'latest',
        },
      ],
      lineage: expect.objectContaining({
        version: 2,
        entries: [
          expect.objectContaining({
            type: 'message',
            parentId: null,
            message: { role: 'user', content: 'hello persisted runtime' },
          }),
        ],
      }),
    });

    await expect(storage.list(gitRoot)).resolves.toEqual([
      {
        id: 'session-1',
        title: 'Persisted Runtime',
        msgCount: 1,
        runtimeInfo,
      },
    ]);
  });

  it('lists sibling workspace sessions when canonical repo identity matches', async () => {
    vi.doMock('./workspace-runtime.js', async () => {
      const actual = await vi.importActual<typeof import('./workspace-runtime.js')>('./workspace-runtime.js');
      return {
        ...actual,
        inspectWorkspaceRuntime: vi.fn(async () => ({
          canonicalRepoRoot: 'C:/repo',
          workspaceRoot: 'C:/repo/worktrees/main',
          executionCwd: 'C:/repo/worktrees/main',
          branch: 'main',
          workspaceKind: 'detected',
        })),
      };
    });

    const { FileSessionStorage } = await import('./storage.js');
    const storage = new FileSessionStorage();
    const canonicalRepoRoot = 'C:/repo';
    const mainWorkspace = 'C:/repo/worktrees/main';
    const siblingWorkspace = 'C:/repo/worktrees/feature-runtime';

    await storage.save('session-main', {
      messages: [{ role: 'user', content: 'main workspace session' }],
      title: 'Main Workspace',
      gitRoot: mainWorkspace,
      runtimeInfo: {
        canonicalRepoRoot,
        workspaceRoot: mainWorkspace,
        executionCwd: mainWorkspace,
        branch: 'main',
        workspaceKind: 'detected',
      },
      scope: 'user',
    });

    await storage.save('session-sibling', {
      messages: [{ role: 'user', content: 'sibling workspace session' }],
      title: 'Sibling Workspace',
      gitRoot: siblingWorkspace,
      runtimeInfo: {
        canonicalRepoRoot,
        workspaceRoot: siblingWorkspace,
        executionCwd: `${siblingWorkspace}/packages/repl`,
        branch: 'feature/runtime-truth',
        workspaceKind: 'managed',
      },
      scope: 'user',
    });

    await storage.save('session-other-repo', {
      messages: [{ role: 'user', content: 'other repo session' }],
      title: 'Other Repo',
      gitRoot: 'C:/other/workspace',
      runtimeInfo: {
        canonicalRepoRoot: 'C:/other',
        workspaceRoot: 'C:/other/workspace',
        executionCwd: 'C:/other/workspace',
        branch: 'main',
        workspaceKind: 'detected',
      },
      scope: 'user',
    });

    const sessions = await storage.list(mainWorkspace);
    expect(sessions).toHaveLength(2);
    expect(sessions.map((session) => session.id)).toEqual(
      expect.arrayContaining(['session-main', 'session-sibling']),
    );
    expect(sessions.map((session) => session.id)).not.toContain('session-other-repo');
    expect(sessions.find((session) => session.id === 'session-sibling')).toMatchObject({
      runtimeInfo: {
        canonicalRepoRoot,
        workspaceRoot: siblingWorkspace,
        branch: 'feature/runtime-truth',
        workspaceKind: 'managed',
      },
    });
  });

  // v0.7.38 FEATURE_157 — Windows-aware path equality in session-list
  // gating. Production reproduction (user report 2026-05-11): session
  // saved with `gitRoot: 'C:/Works/.../KodaX'`; a subsequent shell where
  // `getGitRoot()` returns lowercase drive letter `c:/Works/.../KodaX`
  // hit the literal `===` comparison and excluded every prior
  // same-repo session, leaving `kodax -c` / `kodax -r` to start fresh
  // with no resume context (the user's "previous conversation lost"
  // symptom). Two arms cover: (a) the workspaceRoot branch when
  // sessionRuntime carries it, (b) the gitRoot fallback when it
  // doesn't (older sessions without runtimeInfo are exactly this
  // shape — every session in the user's reproduction lacked the
  // runtimeInfo field).
  it('FEATURE_157: lists same-repo sessions across drive-letter case differences (Windows / darwin parity)', async () => {
    // The bug only manifests on case-insensitive filesystems (win32 +
    // darwin). On strict-case POSIX (most Linux) the pre-fix literal
    // equality is correct, so the case-insensitive branch should not
    // fire — skip the test there so we don't pin behaviour we don't
    // want.
    if (process.platform !== 'win32' && process.platform !== 'darwin') {
      return;
    }
    // The session was saved with uppercase drive letter (typical when
    // launched from a fresh PowerShell where node returns the literal
    // user-typed path).
    const savedGitRoot = 'C:/Works/GitWorks/KodaX-author/KodaX';
    // The session is being listed from a shell where the runtime
    // returns a different case (typical from a VS Code-spawned shell
    // or from a path that went through `process.cwd()` normalisation
    // on some Windows configurations).
    const lookupGitRoot = 'c:/Works/GitWorks/KodaX-author/KodaX';

    vi.doMock('./workspace-runtime.js', async () => {
      const actual = await vi.importActual<typeof import('./workspace-runtime.js')>('./workspace-runtime.js');
      return {
        ...actual,
        // Mock returns the lowercase variant — what the resume-time
        // shell perceives. The session on disk has the uppercase
        // variant. Pre-FEATURE_157 the literal `===` would fail and
        // exclude the session; post-FEATURE_157 `pathsEqual` folds
        // case on win32/darwin and the session is included.
        inspectWorkspaceRuntime: vi.fn(async () => ({
          canonicalRepoRoot: undefined,
          workspaceRoot: undefined,
          executionCwd: lookupGitRoot,
          branch: undefined,
          workspaceKind: 'detected',
        })),
      };
    });

    const { FileSessionStorage } = await import('./storage.js');
    const storage = new FileSessionStorage();

    // Save a session as it appears on disk in the production
    // reproduction — no runtimeInfo (legacy sessions don't have it).
    await storage.save('session-uppercase', {
      messages: [{ role: 'user', content: 'session saved with uppercase C:' }],
      title: 'Pre-existing Conversation',
      gitRoot: savedGitRoot,
      scope: 'user',
    });

    // Listing with the lowercase variant MUST surface the session.
    const sessions = await storage.list(lookupGitRoot);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe('session-uppercase');
  });

  it('supports branch switching, checkpoint labels, and forking without losing prior history', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const storage = new FileSessionStorage();
    const gitRoot = path.resolve('C:/Works/GitWorks/KodaX').replace(/\\/g, '/');

    await storage.save('session-tree', {
      messages: [
        { role: 'user', content: 'root task' },
        { role: 'assistant', content: 'first pass' },
      ],
      title: 'Tree Session',
      gitRoot,
    });

    const initial = await storage.getLineage?.('session-tree');
    expect(initial?.entries).toHaveLength(2);
    const rootId = initial?.entries[0]?.id;
    expect(rootId).toBeTruthy();

    const rewound = await storage.setActiveEntry?.(
      'session-tree',
      rootId!,
      { summarizeCurrentBranch: true },
    );
    expect(rewound).toMatchObject({
      messages: [
        { role: 'user', content: 'root task' },
        expect.objectContaining({
          role: 'user',
          content: expect.stringContaining('The following is a summary of a branch'),
        }),
      ],
    });

    await storage.save('session-tree', {
      messages: [
        ...(rewound?.messages ?? []),
        { role: 'user', content: 'root task follow-up' },
        { role: 'assistant', content: 'second pass' },
      ],
      title: 'Tree Session',
      gitRoot,
    });

    await storage.setLabel?.('session-tree', rootId!, 'checkpoint-a');

    const branched = await storage.getLineage?.('session-tree');
    expect(branched?.entries.filter((entry: { type: string }) => entry.type === 'label')).toHaveLength(1);
    expect(branched?.entries.filter((entry: { type: string }) => entry.type === 'branch_summary')).toHaveLength(1);
    expect(branched?.entries.filter((entry: { type: string }) => entry.type === 'message')).toHaveLength(4);

    const forked = await storage.fork?.('session-tree', 'checkpoint-a', { sessionId: 'forked-tree' });
    expect(forked?.sessionId).toBe('forked-tree');
    expect(forked?.data.messages).toEqual([
      { role: 'user', content: 'root task' },
    ]);

    await expect(storage.load('session-tree')).resolves.toMatchObject({
      messages: [
        { role: 'user', content: 'root task' },
        expect.objectContaining({
          role: 'user',
          content: expect.stringContaining('The following is a summary of a branch'),
        }),
        { role: 'user', content: 'root task follow-up' },
        { role: 'assistant', content: 'second pass' },
      ],
    });
  });

  it('persists compaction anchors and artifact ledgers through JSONL round-trips', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const storage = new FileSessionStorage();
    const gitRoot = path.resolve('C:/Works/GitWorks/KodaX').replace(/\\/g, '/');

    const baseLineage = createSessionLineage([
      { role: 'user', content: 'root task' },
      { role: 'assistant', content: 'initial implementation' },
    ]);
    const lineage = applySessionCompaction(
      baseLineage,
      [
        { role: 'system', content: '[对话历史摘要]\n\nCompacted summary' },
        { role: 'assistant', content: 'continue from summary' },
      ],
      {
        summary: 'Compacted summary',
        tokensBefore: 1000,
        tokensAfter: 250,
        artifactLedgerId: 'ledger_abc123',
        reason: 'automatic_compaction',
        details: {
          readFiles: ['src/app.ts'],
          modifiedFiles: ['src/feature.ts'],
        },
        memorySeed: {
          objective: 'Continue from summary',
          constraints: ['Keep scope tight'],
          progress: {
            completed: ['Compacted old context'],
            inProgress: ['Resume latest implementation'],
            blockers: [],
          },
          keyDecisions: ['Keep the summary durable'],
          nextSteps: ['Continue the feature'],
          keyContext: ['src/app.ts'],
          importantTargets: ['src/feature.ts'],
          tombstones: [],
        },
      },
    );

    await storage.save('session-compacted', {
      messages: [
        { role: 'system', content: '[对话历史摘要]\n\nCompacted summary' },
        { role: 'assistant', content: 'continue from summary' },
      ],
      title: 'Compacted Session',
      gitRoot,
      lineage,
      artifactLedger: [
        {
          id: 'artifact-1',
          kind: 'file_modified',
          sourceTool: 'edit',
          action: 'edit',
          target: 'src/feature.ts',
          displayTarget: 'src/feature.ts',
          summary: 'Edited src/feature.ts',
          timestamp: '2026-04-03T00:00:00.000Z',
        },
      ],
    });

    await expect(storage.load('session-compacted')).resolves.toEqual(
      expect.objectContaining({
        title: 'Compacted Session',
        artifactLedger: [
          expect.objectContaining({
            id: 'artifact-1',
            kind: 'file_modified',
            target: 'src/feature.ts',
          }),
        ],
        lineage: expect.objectContaining({
          entries: expect.arrayContaining([
            expect.objectContaining({
              type: 'compaction',
              summary: 'Compacted summary',
              artifactLedgerId: 'ledger_abc123',
              firstKeptEntryId: expect.any(String),
              memorySeed: expect.objectContaining({
                objective: 'Continue from summary',
              }),
            }),
          ]),
        }),
      }),
    );
  });

  it('hides managed-task worker sessions from default session listing and sorts by createdAt', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const storage = new FileSessionStorage();
    const gitRoot = path.resolve('C:/Works/GitWorks/KodaX').replace(/\\/g, '/');

    await storage.save('20260326_100000', {
      messages: [{ role: 'user', content: 'older user session' }],
      title: 'Older User',
      gitRoot,
      scope: 'user',
    });
    await storage.save('managed-task-worker-task-abc-sidecar', {
      messages: [{ role: 'assistant', content: 'internal sidecar session' }],
      title: 'Internal Worker',
      gitRoot,
      scope: 'managed-task-worker',
    });
    await storage.save('custom-user-session', {
      messages: [{ role: 'user', content: 'newer user session' }],
      title: 'Newer User',
      gitRoot,
      scope: 'user',
    });

    const sessionsDir = path.join(tempHome, '.kodax', 'sessions');
    const olderPath = path.join(sessionsDir, '20260326_100000.jsonl');
    const newerPath = path.join(sessionsDir, 'custom-user-session.jsonl');
    const olderContent = await readFile(olderPath, 'utf8');
    const newerContent = await readFile(newerPath, 'utf8');
    const newerCreatedAt = '2026-03-26T11:00:00.000Z';
    const olderCreatedAt = '2026-03-26T10:00:00.000Z';

    await Promise.all([
      writeFile(
        olderPath,
        olderContent.replace(/\"createdAt\":\"[^\"]+\"/, `"createdAt":"${olderCreatedAt}"`),
        'utf8',
      ),
      writeFile(
        newerPath,
        newerContent.replace(/\"createdAt\":\"[^\"]+\"/, `"createdAt":"${newerCreatedAt}"`),
        'utf8',
      ),
    ]);

    await expect(storage.list(gitRoot)).resolves.toEqual([
      {
        id: 'custom-user-session',
        title: 'Newer User',
        msgCount: 1,
      },
      {
        id: '20260326_100000',
        title: 'Older User',
        msgCount: 1,
      },
    ]);
  });

  it('excludes .archive.jsonl files from the session list', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const storage = new FileSessionStorage();
    const gitRoot = path.resolve('C:/Works/GitWorks/KodaX').replace(/\\/g, '/');

    await storage.save('20260401_120000', {
      messages: [{ role: 'user', content: 'live session' }],
      title: 'Live',
      gitRoot,
      scope: 'user',
    });

    // An archive file ends in `.jsonl` too — the old listing logic read it and
    // surfaced a bogus `<id>.archive` session. It must be excluded entirely.
    const sessionsDir = path.join(tempHome, '.kodax', 'sessions');
    await writeFile(
      path.join(sessionsDir, '20260330_090000.archive.jsonl'),
      `${JSON.stringify({
        _type: 'meta',
        title: 'Archived',
        gitRoot,
        createdAt: '2026-03-30T09:00:00.000Z',
        scope: 'user',
        activeMessageCount: 9,
      })}\n`,
      'utf8',
    );

    const ids = (await storage.list(gitRoot)).map((session) => session.id);
    expect(ids).toContain('20260401_120000');
    expect(ids).not.toContain('20260330_090000.archive');
    expect(ids).not.toContain('20260330_090000');
  });

  it('reports msgCount from the meta head only — ignores appended body lines (no full-file read)', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const storage = new FileSessionStorage();
    const gitRoot = path.resolve('C:/Works/GitWorks/KodaX').replace(/\\/g, '/');

    await storage.save('20260401_130000', {
      messages: [{ role: 'user', content: 'hi' }],
      title: 'Head',
      gitRoot,
      scope: 'user',
    });

    // Append 2000 junk lines AFTER the meta line. A whole-file line count would
    // inflate msgCount; the head-read path uses the meta's activeMessageCount and
    // never sees these lines.
    const filePath = path.join(tempHome, '.kodax', 'sessions', '20260401_130000.jsonl');
    const junk = `${Array.from({ length: 2000 }, (_, i) => JSON.stringify({ _type: 'noise', i })).join('\n')}\n`;
    await writeFile(filePath, `${await readFile(filePath, 'utf8')}${junk}`, 'utf8');

    const session = (await storage.list(gitRoot)).find((s) => s.id === '20260401_130000');
    expect(session?.msgCount).toBe(1);
  });

  it('cleanupOldSessions removes files (and archives) older than the retention window, keeps recent', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const storage = new FileSessionStorage();
    const gitRoot = path.resolve('C:/Works/GitWorks/KodaX').replace(/\\/g, '/');

    await storage.save('20260101_000000', {
      messages: [{ role: 'user', content: 'old' }],
      title: 'Old',
      gitRoot,
      scope: 'user',
    });
    await storage.save('20260401_000000', {
      messages: [{ role: 'user', content: 'recent' }],
      title: 'Recent',
      gitRoot,
      scope: 'user',
    });

    const sessionsDir = path.join(tempHome, '.kodax', 'sessions');
    const oldPath = path.join(sessionsDir, '20260101_000000.jsonl');
    const oldArchivePath = path.join(sessionsDir, '20260101_000000.archive.jsonl');
    const recentPath = path.join(sessionsDir, '20260401_000000.jsonl');
    await writeFile(oldArchivePath, 'archived\n', 'utf8');

    const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    await utimes(oldPath, sixtyDaysAgo, sixtyDaysAgo);
    await utimes(oldArchivePath, sixtyDaysAgo, sixtyDaysAgo);

    const removed = await storage.cleanupOldSessions(30);
    expect(removed).toBe(2);
    expect(existsSync(oldPath)).toBe(false);
    expect(existsSync(oldArchivePath)).toBe(false);
    expect(existsSync(recentPath)).toBe(true);
  });

  it('cleanupOldSessions is a no-op when retention is disabled (0 / negative / NaN)', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const storage = new FileSessionStorage();
    const gitRoot = path.resolve('C:/Works/GitWorks/KodaX').replace(/\\/g, '/');

    await storage.save('20260101_010000', {
      messages: [{ role: 'user', content: 'old' }],
      title: 'Old',
      gitRoot,
      scope: 'user',
    });
    const oldPath = path.join(tempHome, '.kodax', 'sessions', '20260101_010000.jsonl');
    const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    await utimes(oldPath, sixtyDaysAgo, sixtyDaysAgo);

    await expect(storage.cleanupOldSessions(0)).resolves.toBe(0);
    await expect(storage.cleanupOldSessions(-5)).resolves.toBe(0);
    await expect(storage.cleanupOldSessions(Number.NaN)).resolves.toBe(0);
    expect(existsSync(oldPath)).toBe(true);
  });

  it('appendSessionDelta round-trips correctly: append → load → data consistent', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const storage = new FileSessionStorage();
    const gitRoot = tempHome.replace(/\\/g, '/');

    // First save to seed the file
    const lineage1 = createSessionLineage([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ]);
    await storage.save('session-append', {
      messages: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'world' }],
      title: 'Append Test',
      gitRoot,
      lineage: lineage1,
    });

    // Load to initialize watermark
    const loaded1 = await storage.load('session-append');
    expect(loaded1).toBeTruthy();

    // Append new messages
    const lineage2 = createSessionLineage([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
      { role: 'user', content: 'follow-up' },
      { role: 'assistant', content: 'follow-up reply' },
    ], loaded1!.lineage);
    await storage.appendSessionDelta('session-append', {
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'world' },
        { role: 'user', content: 'follow-up' },
        { role: 'assistant', content: 'follow-up reply' },
      ],
      title: 'Append Test Updated',
      gitRoot,
      lineage: lineage2,
    });

    // Reload and verify
    const loaded2 = await storage.load('session-append');
    expect(loaded2?.title).toBe('Append Test Updated');
    expect(loaded2?.messages).toHaveLength(4);
    expect(loaded2?.messages[2]).toEqual({ role: 'user', content: 'follow-up' });
    expect(loaded2?.lineage?.entries.length).toBe(lineage2.entries.length);
  });

  it('appendSessionDelta meta_update overwrites title but preserves extensionState from disk', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const storage = new FileSessionStorage();
    const gitRoot = tempHome.replace(/\\/g, '/');

    // Save with extensionState
    await storage.save('session-meta-update', {
      messages: [{ role: 'user', content: 'test' }],
      title: 'Original Title',
      gitRoot,
      extensionState: { 'ext:sample': { phase: 'active', visits: 5 } },
    });

    // Load to init watermark
    const loaded1 = await storage.load('session-meta-update');
    expect(loaded1?.extensionState).toEqual({ 'ext:sample': { phase: 'active', visits: 5 } });

    // Append — caller doesn't provide extensionState (like InkREPL.persistContextState)
    await storage.appendSessionDelta('session-meta-update', {
      messages: [{ role: 'user', content: 'test' }, { role: 'assistant', content: 'reply' }],
      title: 'Updated Title',
      gitRoot,
      lineage: createSessionLineage([
        { role: 'user', content: 'test' },
        { role: 'assistant', content: 'reply' },
      ], loaded1!.lineage),
    });

    // Load — title should be updated, extensionState preserved from disk
    const loaded2 = await storage.load('session-meta-update');
    expect(loaded2?.title).toBe('Updated Title');
    // extensionState is in the meta line (first save), meta_update doesn't overwrite it
    expect(loaded2?.extensionState).toEqual({ 'ext:sample': { phase: 'active', visits: 5 } });
  });

  it('appendSessionDelta fallback preserves runtimeInfo and errorMetadata', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const storage = new FileSessionStorage();
    const gitRoot = tempHome.replace(/\\/g, '/');

    // Save with runtimeInfo and errorMetadata
    await storage.save('session-fallback', {
      messages: [{ role: 'user', content: 'test' }],
      title: 'Fallback Test',
      gitRoot,
      runtimeInfo: {
        canonicalRepoRoot: gitRoot,
        workspaceRoot: gitRoot,
        executionCwd: gitRoot,
        branch: 'main',
        workspaceKind: 'detected' as const,
      },
      errorMetadata: { lastError: 'test error', lastErrorTime: 12345, consecutiveErrors: 0 },
    });

    // appendSessionDelta WITHOUT lineage → triggers fallback mergeAndWriteInternal
    await storage.appendSessionDelta('session-fallback', {
      messages: [{ role: 'user', content: 'test' }, { role: 'assistant', content: 'reply' }],
      title: 'Fallback Updated',
      gitRoot,
      // No lineage → fallback
    });

    // Verify runtimeInfo and errorMetadata are preserved
    const loaded = await storage.load('session-fallback');
    expect(loaded?.runtimeInfo).toEqual(expect.objectContaining({
      canonicalRepoRoot: gitRoot,
      branch: 'main',
    }));
    expect(loaded?.errorMetadata).toEqual(expect.objectContaining({
      lastError: 'test error',
    }));
    expect(loaded?.title).toBe('Fallback Updated');
  });

  it('mixed path: append → rewind (cold save) → append → load consistent', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const storage = new FileSessionStorage();
    const gitRoot = tempHome.replace(/\\/g, '/');

    // Seed
    await storage.save('session-mixed', {
      messages: [
        { role: 'user', content: 'step 1' },
        { role: 'assistant', content: 'reply 1' },
      ],
      title: 'Mixed Path',
      gitRoot,
    });
    const loaded1 = await storage.load('session-mixed');

    // Append
    const lineage2 = createSessionLineage([
      { role: 'user', content: 'step 1' },
      { role: 'assistant', content: 'reply 1' },
      { role: 'user', content: 'step 2' },
      { role: 'assistant', content: 'reply 2' },
    ], loaded1!.lineage);
    await storage.appendSessionDelta('session-mixed', {
      messages: [
        { role: 'user', content: 'step 1' },
        { role: 'assistant', content: 'reply 1' },
        { role: 'user', content: 'step 2' },
        { role: 'assistant', content: 'reply 2' },
      ],
      title: 'Mixed Path',
      gitRoot,
      lineage: lineage2,
    });

    // Rewind (cold path — triggers full save via writeSessionInternal)
    // rewind goes back one user entry: from step2 back to step1 (the previous user entry)
    const rewound = await storage.rewind?.('session-mixed');
    expect(rewound).toBeTruthy();
    expect(rewound!.messages[0]).toEqual({ role: 'user', content: 'step 1' });

    // Append again after rewind
    const loaded3 = await storage.load('session-mixed');
    const lineage4 = createSessionLineage([
      ...loaded3!.messages,
      { role: 'user', content: 'step 3' },
      { role: 'assistant', content: 'reply 3' },
    ], loaded3!.lineage);
    await storage.appendSessionDelta('session-mixed', {
      messages: [
        ...loaded3!.messages,
        { role: 'user', content: 'step 3' },
        { role: 'assistant', content: 'reply 3' },
      ],
      title: 'Mixed Path Final',
      gitRoot,
      lineage: lineage4,
    });

    // Final load — everything consistent
    const final = await storage.load('session-mixed');
    expect(final?.title).toBe('Mixed Path Final');
    expect(final?.messages[final.messages.length - 1]).toEqual({ role: 'assistant', content: 'reply 3' });
  });
});
