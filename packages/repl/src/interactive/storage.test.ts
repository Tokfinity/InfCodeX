import os from 'os';
import path from 'path';
import { createHash } from 'node:crypto';
import { existsSync } from 'fs';
import fsPromises from 'fs/promises';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendMemoryClientNotice,
  appendMemoryOutcomeDigest,
  appendMemoryReviewReceipt,
  applySessionCompaction,
  createSessionLineage,
  drainPendingEpisodeReviews,
  evictOldIslandMessageContent,
  getSessionLineagePath,
  hashMemoryIdentityComponent,
  listPendingEpisodeReviews,
  persistPendingEpisodeReview,
  withKodaXFileLock,
  withPendingEpisodeReviewSessionFence,
} from '@kodax-ai/agent';
import type {
  AgentActorSnapshot,
  KodaXMemoryOutcomeDigest,
  KodaXSessionLineage,
} from '@kodax-ai/agent';

// 'C:/...' is absolute on win32 but RELATIVE on POSIX, so path.resolve() would
// prepend the cwd on Linux CI and break the per-project session-key derivation
// these tests rely on. Use a repo root that is absolute on both platforms.
const KODAX_REPO_ROOT = process.platform === 'win32'
  ? 'C:/Works/GitWorks/KodaX'
  : '/Works/GitWorks/KodaX';

describe('FileSessionStorage', () => {
  let tempHome: string;
  let previousHome: string | undefined;
  let previousUserProfile: string | undefined;
  let previousKodaXHome: string | undefined;

  beforeEach(async () => {
    tempHome = await mkdtemp(path.join(os.tmpdir(), 'kodax-storage-'));
    previousHome = process.env.HOME;
    previousUserProfile = process.env.USERPROFILE;
    previousKodaXHome = process.env.KODAX_HOME;
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    process.env.KODAX_HOME = path.join(tempHome, '.kodax');
    vi.doUnmock('./workspace-runtime.js');
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

    if (previousKodaXHome === undefined) {
      delete process.env.KODAX_HOME;
    } else {
      process.env.KODAX_HOME = previousKodaXHome;
    }

    vi.doUnmock('./workspace-runtime.js');

    vi.resetModules();
    await rm(tempHome, { recursive: true, force: true });
  });

  const testSessionsDir = (): string => path.join(tempHome, '.kodax', 'sessions');

  it('retries a transient Windows atomic-replace failure', async () => {
    const originalRename = fsPromises.rename.bind(fsPromises);
    let targetAttempts = 0;
    const rename = vi.spyOn(fsPromises, 'rename');
    rename.mockImplementation(async (oldPath, newPath) => {
      if (String(newPath).endsWith('rename-retry.jsonl')) {
        targetAttempts += 1;
        if (targetAttempts === 1) {
          throw Object.assign(new Error('file temporarily locked'), { code: 'EPERM' });
        }
      }
      await originalRename(oldPath, newPath);
    });
    try {
      const { FileSessionStorage } = await import('./storage.js');
      const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });

      await storage.save('rename-retry', {
        messages: [{ role: 'user', content: 'persist despite a transient lock' }],
        title: 'Rename retry',
        gitRoot: path.resolve(KODAX_REPO_ROOT).replace(/\\/g, '/'),
      });

      expect(targetAttempts).toBe(2);
      expect(await storage.load('rename-retry')).toMatchObject({ title: 'Rename retry' });
    } finally {
      rename.mockRestore();
    }
  });

  it('persists the Runtime-owned Actor snapshot without a private sidecar journal', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const now = '2026-07-17T00:00:00.000Z';
    const actorSnapshot = {
      schemaVersion: 1 as const,
      revision: 3,
      maxConcurrentThreads: 4,
      actors: [{
        path: '/root', taskName: 'root', kind: 'native' as const, state: 'running' as const,
        capabilities: {
          tools: ['*'], filesystem: 'write' as const, network: true,
          providers: ['*'], canAskUser: true,
        },
        turnIds: [], mailboxCursor: 0, createdAt: now, updatedAt: now, revision: 1,
      }],
      turns: [],
      mailboxes: { '/root': [] },
      events: [],
    };
    const base = {
      messages: [{ role: 'user' as const, content: 'persist actors' }],
      title: 'Actor owner',
      gitRoot: path.resolve(KODAX_REPO_ROOT).replace(/\\/g, '/'),
    };

    await storage.save('actor-session', { ...base, actorSnapshot });
    await storage.save('actor-session', { ...base, title: 'Actor owner updated' });

    const nextSnapshot = { ...actorSnapshot, revision: 4 };
    await storage.saveActorSnapshot('actor-session', nextSnapshot, 3);
    await expect(storage.saveActorSnapshot('actor-session', actorSnapshot, 3))
      .rejects.toMatchObject({
        code: 'actor_snapshot_conflict',
        expectedRevision: 3,
        currentRevision: 4,
      });

    expect(await storage.load('actor-session')).toMatchObject({
      title: 'Actor owner updated',
      actorSnapshot: nextSnapshot,
    });

    const competingStorage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const competingWrites = await Promise.allSettled([
      storage.saveActorSnapshot(
        'actor-session',
        { ...nextSnapshot, revision: 5, maxConcurrentThreads: 6 },
        4,
      ),
      competingStorage.saveActorSnapshot(
        'actor-session',
        { ...nextSnapshot, revision: 5, maxConcurrentThreads: 8 },
        4,
      ),
    ]);
    expect(competingWrites.map((result) => result.status).sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);
    const rejectedWrite = competingWrites.find((result) => result.status === 'rejected');
    expect(rejectedWrite?.reason).toMatchObject({
      code: 'actor_snapshot_conflict',
      expectedRevision: 4,
      currentRevision: 5,
    });
    expect([6, 8]).toContain(
      (await storage.load('actor-session'))?.actorSnapshot?.maxConcurrentThreads,
    );
    const wonSnapshot = (await storage.load('actor-session'))?.actorSnapshot;
    if (!wonSnapshot) throw new Error('Expected the winning Actor snapshot.');
    const staleFullSession = await storage.load('actor-session');
    if (!staleFullSession) throw new Error('Expected a stale full Session snapshot.');
    const nextWinner = { ...wonSnapshot, revision: 6 };
    await storage.saveActorSnapshot('actor-session', nextWinner, 5);
    await storage.save('actor-session', {
      ...staleFullSession,
      title: 'Stale host save must preserve Actor CAS state',
    });
    expect((await storage.peek('actor-session'))?.actorSnapshot).toEqual(nextWinner);

    await storage.archive('actor-session');
    await competingStorage.saveActorSnapshot(
      'actor-session',
      { ...nextWinner, revision: 7 },
      6,
    );
    expect((await storage.list(
      path.resolve(KODAX_REPO_ROOT).replace(/\\/g, '/'),
    )).map((session) => session.id)).not.toContain('actor-session');
    expect((await storage.list(
      path.resolve(KODAX_REPO_ROOT).replace(/\\/g, '/'),
      { includeArchived: true },
    )).filter((session) => session.id === 'actor-session')).toHaveLength(1);

    const fork = await storage.fork('actor-session', undefined, { sessionId: 'actor-fork' });
    expect(fork?.data.actorSnapshot).toBeUndefined();
  });

  it('requires the durable Actor owner for archive, unarchive, and delete', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const now = '2026-07-28T00:00:00.000Z';
    const owner = {
      ownerId: 'owner-maintenance',
      runtimeId: 'runtime-maintenance',
      pid: process.pid,
      startedAt: now,
    };
    const actorSnapshot: AgentActorSnapshot = {
      schemaVersion: 2,
      revision: 1,
      maxConcurrentThreads: 4,
      owner,
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
    const data = {
      messages: [
        { role: 'user' as const, content: 'Leave a tool call incomplete.' },
        {
          role: 'assistant' as const,
          content: [
            { type: 'tool_use' as const, id: 'call_owned', name: 'test', input: {} },
          ],
        },
      ],
      title: 'Owned maintenance',
      gitRoot: path.resolve(KODAX_REPO_ROOT).replace(/\\/g, '/'),
      scope: 'user' as const,
      actorSnapshot,
      errorMetadata: {
        lastError: 'interrupted',
        lastErrorTime: 1,
        consecutiveErrors: 1,
      },
    };
    await storage.save('owned-maintenance', data);

    await expect(storage.archive('owned-maintenance')).rejects.toMatchObject({
      code: 'actor_owner_conflict',
      ownerRuntimeId: owner.runtimeId,
    });
    await expect(storage.archiveOwned('owned-maintenance', 'wrong-owner'))
      .rejects.toMatchObject({ code: 'actor_owner_conflict' });
    await expect(storage.archiveOwned('owned-maintenance', owner.ownerId))
      .resolves.toBe(true);
    await expect(storage.unarchive('owned-maintenance')).rejects.toMatchObject({
      code: 'actor_owner_conflict',
    });
    await expect(storage.unarchiveOwned('owned-maintenance', owner.ownerId))
      .resolves.toBe(true);
    const { deriveProjectKeyFromRoot } = await import('./project-key.js');
    const mainPath = path.join(
      testSessionsDir(),
      deriveProjectKeyFromRoot(data.gitRoot).key,
      'owned-maintenance.jsonl',
    );
    const bytesBeforeOwnedLoad = await readFile(mainPath);
    await expect(storage.load('owned-maintenance')).resolves.toMatchObject({
      errorMetadata: { consecutiveErrors: 1 },
      actorSnapshot: { owner },
    });
    expect(await readFile(mainPath)).toEqual(bytesBeforeOwnedLoad);
    await expect(storage.delete('owned-maintenance')).rejects.toMatchObject({
      code: 'actor_owner_conflict',
    });
    await expect(storage.deleteOwned('owned-maintenance', owner.ownerId))
      .resolves.toBeUndefined();
    await expect(storage.load('owned-maintenance')).resolves.toBeNull();

    const unknownOwnerSnapshot: AgentActorSnapshot = {
      ...actorSnapshot,
      owner: undefined,
      revision: 2,
      turns: [{
        turnId: 'turn_root_worker_1',
        actorPath: '/root',
        sequence: 1,
        state: 'accepted',
        objective: 'Must not be removed during owner handoff.',
        forkTurns: 'none',
        createdAt: now,
        progress: [],
        revision: 1,
      }],
    };
    await storage.save('unknown-owner-maintenance', {
      ...data,
      actorSnapshot: unknownOwnerSnapshot,
    });
    await expect(storage.delete('unknown-owner-maintenance')).rejects.toMatchObject({
      code: 'actor_owner_unknown',
      currentRevision: 2,
    });
  });

  it('round-trips extension state and extension records through JSONL session storage', async () => {
    const gitRoot = path.resolve(KODAX_REPO_ROOT).replace(/\\/g, '/');
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
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
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

    // v0.7.46 — list() now surfaces `createdAt` so the fast path in
    // session/public-api.ts can populate SessionSummary.createdAt
    // instead of silently dropping it. Use objectContaining since the
    // session writer auto-stamps createdAt with `new Date().toISOString()`.
    const listed = await storage.list(gitRoot);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      id: 'session-1',
      title: 'Persisted Runtime',
      msgCount: 1,
      runtimeInfo,
    });
    expect(typeof listed[0]?.createdAt).toBe('string');
  });

  it('uses runtimeInfo.executionCwd as the project key for non-git sessions', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const { UNKNOWN_PROJECT_KEY, deriveProjectKeyFromData } = await import('./project-key.js');
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const executionCwd = process.platform === 'win32'
      ? 'C:/Users/surui/tmp'
      : '/mnt/c/Users/surui/tmp';
    const runtimeInfo = {
      executionCwd,
      workspaceKind: 'detected' as const,
    };

    await storage.save('non-git-session', {
      messages: [{ role: 'user', content: 'hello from non-git cwd' }],
      title: 'Non Git Session',
      gitRoot: '',
      runtimeInfo,
      scope: 'user',
    });

    const expectedKey = deriveProjectKeyFromData({ gitRoot: '', runtimeInfo }).key;
    expect(expectedKey).not.toBe(UNKNOWN_PROJECT_KEY);
    expect(existsSync(path.join(testSessionsDir(), expectedKey, 'non-git-session.jsonl'))).toBe(true);
    expect(existsSync(path.join(testSessionsDir(), UNKNOWN_PROJECT_KEY, 'non-git-session.jsonl'))).toBe(false);
  });

  it('does not collapse synthetic and real same-content messages during snapshot merge', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const gitRoot = path.resolve(KODAX_REPO_ROOT).replace(/\\/g, '/');
    const realMessage = { role: 'user' as const, content: 'repeat' };
    const syntheticMessage = { role: 'user' as const, content: 'repeat', _synthetic: true };

    await storage.save('synthetic-prefix', {
      messages: [realMessage],
      title: 'Synthetic Prefix',
      gitRoot,
    });
    await storage.save('synthetic-prefix', {
      messages: [syntheticMessage],
      title: 'Synthetic Prefix',
      gitRoot,
    });

    await expect(storage.load('synthetic-prefix')).resolves.toMatchObject({
      messages: [syntheticMessage],
    });
  });

  it('keeps valid uiHistory siblings when one persisted item is malformed', async () => {
    const sessionsDir = path.join(tempHome, '.kodax', 'sessions');
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(
      path.join(sessionsDir, 'malformed-ui-history.jsonl'),
      `${JSON.stringify({
        _type: 'meta',
        title: 'Malformed UI History',
        id: 'malformed-ui-history',
        gitRoot: 'C:/repo',
        createdAt: '2026-06-17T00:00:00.000Z',
        uiHistory: [
          { type: 'user', text: 'read the file' },
          {
            type: 'tool_group',
            tools: [
              {
                id: 'tool-live',
                name: 'read',
                status: 'executing',
              },
            ],
          },
          {
            type: 'tool_group',
            tools: [
              {
                id: 'tool-done',
                name: 'read',
                status: 'success',
                input: { path: 'README.md' },
                output: 'ok',
              },
            ],
          },
          { type: 'assistant', text: 'done' },
        ],
      })}\n`,
      'utf8',
    );

    const { FileSessionStorage } = await import('./storage.js');
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });

    await expect(storage.load('malformed-ui-history')).resolves.toMatchObject({
      uiHistory: [
        { type: 'user', text: 'read the file' },
        {
          type: 'tool_group',
          tools: [
            {
              id: 'tool-done',
              name: 'read',
              status: 'success',
              input: { path: 'README.md' },
              output: 'ok',
            },
          ],
        },
        { type: 'assistant', text: 'done' },
      ],
    });
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
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
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
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });

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
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const gitRoot = path.resolve(KODAX_REPO_ROOT).replace(/\\/g, '/');

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
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const gitRoot = path.resolve(KODAX_REPO_ROOT).replace(/\\/g, '/');

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
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const gitRoot = path.resolve(KODAX_REPO_ROOT).replace(/\\/g, '/');

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

    const { deriveProjectKeyFromRoot } = await import('./project-key.js');
    const sessionsDir = path.join(tempHome, '.kodax', 'sessions', deriveProjectKeyFromRoot(gitRoot).key);
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

    // v0.7.46 — list() now surfaces `createdAt` (F3 fix). Verify
    // ordering + payload via toMatchObject so we don't have to enumerate
    // exact timestamps.
    const listed = await storage.list(gitRoot);
    expect(listed).toHaveLength(2);
    expect(listed[0]).toMatchObject({
      id: 'custom-user-session',
      title: 'Newer User',
      msgCount: 1,
    });
    expect(listed[1]).toMatchObject({
      id: '20260326_100000',
      title: 'Older User',
      msgCount: 1,
    });
    // createdAt is the sort key for these two — verify both are present
    // strings so a future regression that drops it surfaces here too.
    expect(typeof listed[0]?.createdAt).toBe('string');
    expect(typeof listed[1]?.createdAt).toBe('string');
  });

  it('excludes .archive.jsonl and archived- prefixed files from the session list', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const gitRoot = path.resolve(KODAX_REPO_ROOT).replace(/\\/g, '/');

    await storage.save('20260401_120000', {
      messages: [{ role: 'user', content: 'live session' }],
      title: 'Live',
      gitRoot,
      scope: 'user',
    });

    const sessionsDir = path.join(tempHome, '.kodax', 'sessions');
    const metaLine = (title: string, createdAt: string) =>
      `${JSON.stringify({ _type: 'meta', title, gitRoot, createdAt, scope: 'user', activeMessageCount: 9 })}\n`;
    // A round archive ends in `.jsonl` too — the old listing logic read it and
    // surfaced a bogus `<id>.archive` session. It must be excluded.
    await writeFile(path.join(sessionsDir, '20260330_090000.archive.jsonl'), metaLine('RoundArchive', '2026-03-30T09:00:00.000Z'), 'utf8');
    // FEATURE_219 — the renamed island sidecar must also be excluded.
    await writeFile(path.join(sessionsDir, '20260330_091000.islands.jsonl'), metaLine('IslandSidecar', '2026-03-30T09:10:00.000Z'), 'utf8');
    // `archived-` prefixed files are the session-archive mechanism — hidden from
    // the picker/SDK fast path, consistent with the public-api slow path.
    await writeFile(path.join(sessionsDir, 'archived-20260301_080000.jsonl'), metaLine('ArchivedSession', '2026-03-01T08:00:00.000Z'), 'utf8');

    const ids = (await storage.list(gitRoot)).map((session) => session.id);
    expect(ids).toContain('20260401_120000');
    expect(ids).not.toContain('20260330_090000.archive');
    expect(ids).not.toContain('20260330_090000');
    expect(ids).not.toContain('20260330_091000.islands');
    expect(ids).not.toContain('20260330_091000');
    expect(ids).not.toContain('archived-20260301_080000');
  });

  it('reports msgCount from the meta head only — ignores appended body lines (no full-file read)', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const gitRoot = path.resolve(KODAX_REPO_ROOT).replace(/\\/g, '/');

    await storage.save('20260401_130000', {
      messages: [{ role: 'user', content: 'hi' }],
      title: 'Head',
      gitRoot,
      scope: 'user',
    });

    // Append 2000 junk lines AFTER the meta line. A whole-file line count would
    // inflate msgCount; the head-read path uses the meta's activeMessageCount and
    // never sees these lines. FEATURE_219: the file lives under the per-project dir.
    const { deriveProjectKeyFromRoot } = await import('./project-key.js');
    const projectKey = deriveProjectKeyFromRoot(gitRoot).key;
    const filePath = path.join(tempHome, '.kodax', 'sessions', projectKey, '20260401_130000.jsonl');
    const junk = `${Array.from({ length: 2000 }, (_, i) => JSON.stringify({ _type: 'noise', i })).join('\n')}\n`;
    await writeFile(filePath, `${await readFile(filePath, 'utf8')}${junk}`, 'utf8');

    const session = (await storage.list(gitRoot)).find((s) => s.id === '20260401_130000');
    expect(session?.msgCount).toBe(1);
  });

  it('cleanupOldSessions removes files (and archives) older than the retention window, keeps recent', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const gitRoot = path.resolve(KODAX_REPO_ROOT).replace(/\\/g, '/');

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

    const { deriveProjectKeyFromRoot } = await import('./project-key.js');
    const sessionsDir = path.join(tempHome, '.kodax', 'sessions', deriveProjectKeyFromRoot(gitRoot).key);
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

  it('cleanupOldSessions never removes an old Session with a durable Actor owner', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const { deriveProjectKeyFromRoot } = await import('./project-key.js');
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const gitRoot = path.resolve(KODAX_REPO_ROOT).replace(/\\/g, '/');
    const sessionId = 'retention-owned-actor';
    const now = '2026-07-28T00:00:00.000Z';
    const actorSnapshot = {
      schemaVersion: 2 as const,
      revision: 1,
      maxConcurrentThreads: 4,
      owner: {
        ownerId: 'owner-retention',
        runtimeId: 'runtime-retention',
        pid: process.pid,
        startedAt: now,
      },
      actors: [{
        path: '/root',
        taskName: 'root',
        kind: 'native' as const,
        state: 'running' as const,
        capabilities: {
          tools: ['*'],
          filesystem: 'write' as const,
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
    await storage.save(sessionId, {
      messages: [],
      title: 'Owned Actor',
      gitRoot,
      scope: 'user',
      actorSnapshot,
    });
    const mainPath = path.join(
      testSessionsDir(),
      deriveProjectKeyFromRoot(gitRoot).key,
      `${sessionId}.jsonl`,
    );
    const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    await utimes(mainPath, sixtyDaysAgo, sixtyDaysAgo);

    await expect(storage.cleanupOldSessions(30)).resolves.toBe(0);
    expect(existsSync(mainPath)).toBe(true);
    await expect(storage.load(sessionId)).resolves.toMatchObject({
      actorSnapshot: {
        owner: expect.objectContaining({ ownerId: 'owner-retention' }),
      },
    });
  });

  it('cleanupOldSessions is a no-op when retention is disabled (0 / negative / NaN)', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const gitRoot = path.resolve(KODAX_REPO_ROOT).replace(/\\/g, '/');

    await storage.save('20260101_010000', {
      messages: [{ role: 'user', content: 'old' }],
      title: 'Old',
      gitRoot,
      scope: 'user',
    });
    const { deriveProjectKeyFromRoot } = await import('./project-key.js');
    const oldPath = path.join(
      tempHome, '.kodax', 'sessions', deriveProjectKeyFromRoot(gitRoot).key, '20260101_010000.jsonl',
    );
    const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    await utimes(oldPath, sixtyDaysAgo, sixtyDaysAgo);

    await expect(storage.cleanupOldSessions(0)).resolves.toBe(0);
    await expect(storage.cleanupOldSessions(-5)).resolves.toBe(0);
    await expect(storage.cleanupOldSessions(Number.NaN)).resolves.toBe(0);
    expect(existsSync(oldPath)).toBe(true);
  });

  it('appendSessionDelta round-trips correctly: append → load → data consistent', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
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

  it('does not duplicate or lose deltas appended by separate storage instances', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const sessionsDir = testSessionsDir();
    const first = new FileSessionStorage({ sessionsDir });
    const second = new FileSessionStorage({ sessionsDir });
    const sessionId = 'session-cross-instance-append';
    const baseMessages = [{ role: 'user' as const, content: 'shared base' }];
    await first.save(sessionId, {
      messages: baseMessages,
      title: 'Cross-instance append',
      gitRoot: KODAX_REPO_ROOT,
      lineage: createSessionLineage(baseMessages),
    });
    const [firstBase, secondBase] = await Promise.all([
      first.load(sessionId),
      second.load(sessionId),
    ]);
    if (!firstBase?.lineage || !secondBase?.lineage) {
      throw new Error('expected both storage instances to load the base lineage');
    }
    const firstMessages = [
      ...baseMessages,
      { role: 'assistant' as const, content: 'delta from first runtime' },
    ];
    const secondMessages = [
      ...baseMessages,
      { role: 'assistant' as const, content: 'delta from second runtime' },
    ];

    await Promise.all([
      first.appendSessionDelta(sessionId, {
        ...firstBase,
        messages: firstMessages,
        lineage: createSessionLineage(firstMessages, firstBase.lineage),
      }),
      second.appendSessionDelta(sessionId, {
        ...secondBase,
        messages: secondMessages,
        lineage: createSessionLineage(secondMessages, secondBase.lineage),
      }),
    ]);

    const full = await new FileSessionStorage({ sessionsDir }).loadFullLineage(sessionId);
    const persistedMessages = full?.entries
      .filter((entry) => entry.type === 'message')
      .map((entry) => entry.message.content);
    expect(persistedMessages?.filter(
      (content) => content === 'delta from first runtime',
    )).toHaveLength(1);
    expect(persistedMessages?.filter(
      (content) => content === 'delta from second runtime',
    )).toHaveLength(1);
  });

  it('appends to the exact archived path after another storage instance moves the Session', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const { deriveProjectKeyFromRoot } = await import('./project-key.js');
    const sessionsDir = testSessionsDir();
    const writer = new FileSessionStorage({ sessionsDir });
    const mover = new FileSessionStorage({ sessionsDir });
    const sessionId = 'session-archived-cross-instance-append';
    const baseMessages = [{ role: 'user' as const, content: 'archive base' }];
    await writer.save(sessionId, {
      messages: baseMessages,
      title: 'Archived append',
      gitRoot: KODAX_REPO_ROOT,
      lineage: createSessionLineage(baseMessages),
    });
    const stale = await writer.load(sessionId);
    if (!stale?.lineage) throw new Error('expected stale lineage');
    await mover.archive(sessionId);
    const messages = [
      ...baseMessages,
      { role: 'assistant' as const, content: 'archived delta' },
    ];

    await writer.appendSessionDelta(sessionId, {
      ...stale,
      messages,
      lineage: createSessionLineage(messages, stale.lineage),
    });

    const projectDir = path.join(
      sessionsDir,
      deriveProjectKeyFromRoot(KODAX_REPO_ROOT).key,
    );
    expect(existsSync(path.join(projectDir, `${sessionId}.jsonl`))).toBe(false);
    expect(existsSync(path.join(projectDir, 'archived', `${sessionId}.jsonl`))).toBe(true);
    await expect(writer.load(sessionId)).resolves.toMatchObject({
      messages: expect.arrayContaining([
        expect.objectContaining({ content: 'archived delta' }),
      ]),
    });
  });

  it('merges a same-length cross-instance lineage rewrite before appending', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const sessionsDir = testSessionsDir();
    const first = new FileSessionStorage({ sessionsDir });
    const staleWriter = new FileSessionStorage({ sessionsDir });
    const sessionId = 'session-same-length-rewrite';
    const baseMessages = [{ role: 'user' as const, content: 'original base' }];
    await first.save(sessionId, {
      messages: baseMessages,
      title: 'Same length rewrite',
      gitRoot: KODAX_REPO_ROOT,
      lineage: createSessionLineage(baseMessages),
    });
    const stale = await staleWriter.load(sessionId);
    if (!stale?.lineage) throw new Error('expected stale lineage');
    const rewrittenMessages = [{ role: 'user' as const, content: 'rewritten base' }];
    await first.save(sessionId, {
      ...stale,
      messages: rewrittenMessages,
      lineage: createSessionLineage(rewrittenMessages),
    });
    const staleMessages = [
      ...baseMessages,
      { role: 'assistant' as const, content: 'stale writer delta' },
    ];

    await staleWriter.appendSessionDelta(sessionId, {
      ...stale,
      messages: staleMessages,
      lineage: createSessionLineage(staleMessages, stale.lineage),
    });

    const full = await first.loadFullLineage(sessionId);
    const ids = new Set(full?.entries.map((entry) => entry.id));
    expect(full?.entries.every(
      (entry) => entry.parentId === null || ids.has(entry.parentId),
    )).toBe(true);
    expect(full?.entries).toContainEqual(expect.objectContaining({
      type: 'message',
      message: expect.objectContaining({ content: 'rewritten base' }),
    }));
    expect(full?.entries).toContainEqual(expect.objectContaining({
      type: 'message',
      message: expect.objectContaining({ content: 'stale writer delta' }),
    }));
  });

  it('appendSessionDelta meta_update overwrites title but preserves extensionState from disk', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
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

  it('fences review jobs against the exact branch on setActiveEntry and rewind', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const configHome = path.join(tempHome, '.kodax');
    const storage = new FileSessionStorage({
      sessionsDir: testSessionsDir(),
      configHome,
    });
    const sessionId = 'session-review-fence';
    const reviewIdentity = {
      configHome,
      tenantId: 'tenant-a',
      agentId: 'agent-a',
      projectId: 'project-a',
      sessionId,
    } as const;
    const makeDigest = (
      id: string,
      reviewKey: string,
      sequence: number,
    ): KodaXMemoryOutcomeDigest => ({
      id,
      reviewKey,
      sessionId,
      branchId: sessionId,
      sequence,
      objective: 'branch fence',
      approach: 'review',
      outcome: 'succeeded',
      summary: id,
      evidenceRefs: [],
      visibility: 'prompt_safe',
      createdAt: `2026-07-27T00:00:0${sequence}.000Z`,
    });
    const digestA = makeDigest('digest-a', 'review-a', 9);
    const digestB = makeDigest('digest-b', 'review-b', 1);
    const jobA = await persistPendingEpisodeReview(reviewIdentity, digestA);
    const jobB = await persistPendingEpisodeReview(reviewIdentity, digestB);
    const lineage: KodaXSessionLineage = {
      version: 2,
      activeEntryId: 'branch-b',
      entries: [
        {
          type: 'message',
          id: 'root',
          logicalId: 'root',
          parentId: null,
          timestamp: '2026-07-27T00:00:00.000Z',
          message: { role: 'user', content: 'root' },
        },
        {
          type: 'message',
          id: 'branch-a',
          logicalId: 'branch-a',
          parentId: 'root',
          timestamp: '2026-07-27T00:00:01.000Z',
          message: { role: 'user', content: 'a' },
        },
        {
          type: 'memory_outcome_digest',
          id: 'lineage-digest-a',
          logicalId: 'lineage-digest-a',
          parentId: 'branch-a',
          timestamp: digestA.createdAt,
          jobId: jobA.entry.jobId,
          digest: digestA,
        },
        {
          type: 'message',
          id: 'branch-b',
          logicalId: 'branch-b',
          parentId: 'root',
          timestamp: '2026-07-27T00:00:02.000Z',
          message: { role: 'user', content: 'b' },
        },
        {
          type: 'memory_outcome_digest',
          id: 'lineage-digest-b',
          logicalId: 'lineage-digest-b',
          parentId: 'branch-b',
          timestamp: digestB.createdAt,
          jobId: jobB.entry.jobId,
          digest: digestB,
        },
      ],
    };
    await storage.save(sessionId, {
      messages: [
        { role: 'user', content: 'root' },
        { role: 'user', content: 'b' },
      ],
      lineage,
    });

    await storage.setActiveEntry(sessionId, 'branch-a');
    expect(await listPendingEpisodeReviews({
      configHome,
      tenantId: reviewIdentity.tenantId,
    })).toMatchObject([{ jobId: jobA.entry.jobId }]);

    await storage.rewind(sessionId, 'root');
    expect(await listPendingEpisodeReviews({
      configHome,
      tenantId: reviewIdentity.tenantId,
    })).toEqual([]);
  });

  it('atomically preserves a memory digest across a stale host snapshot save', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const storage = new FileSessionStorage({
      sessionsDir: testSessionsDir(),
      configHome: path.join(tempHome, '.kodax'),
    });
    const sessionId = 'session-memory-atomic-lineage';
    const initialMessages = [{ role: 'user' as const, content: 'before review' }];
    await storage.save(sessionId, {
      messages: initialMessages,
      title: 'atomic lineage',
      gitRoot: KODAX_REPO_ROOT,
      lineage: createSessionLineage(initialMessages),
    });
    const stale = await storage.load(sessionId);
    if (stale?.lineage === undefined) throw new Error('expected stale host lineage');
    const digest: KodaXMemoryOutcomeDigest = {
      id: 'digest-atomic-lineage',
      reviewKey: 'review-atomic-lineage',
      sessionId,
      branchId: sessionId,
      sequence: 1,
      objective: 'preserve a fenced outcome',
      approach: 'mutate latest lineage',
      outcome: 'succeeded',
      summary: 'outcome persisted',
      evidenceRefs: [],
      visibility: 'prompt_safe',
      createdAt: '2026-07-27T00:00:00.000Z',
    };

    await storage.mutateLineage(sessionId, (lineage) => {
      const withDigest = appendMemoryOutcomeDigest(lineage, digest, 'job-atomic-lineage');
      const withReceipt = appendMemoryReviewReceipt(withDigest, {
        jobId: 'job-atomic-lineage',
        reviewKey: digest.reviewKey,
        proposalIds: ['proposal-atomic-lineage'],
        completedAt: '2026-07-27T00:01:00.000Z',
      });
      return appendMemoryClientNotice(withReceipt, {
        episodeId: digest.id,
        summaries: ['durable update'],
        proposalIds: ['proposal-atomic-lineage'],
        createdAt: '2026-07-27T00:01:00.000Z',
      });
    });
    const nextMessages = [
      ...initialMessages,
      { role: 'assistant' as const, content: 'new host state' },
    ];
    await storage.save(sessionId, {
      ...stale,
      messages: nextMessages,
      lineage: createSessionLineage(nextMessages, stale.lineage),
    });

    const loaded = await storage.load(sessionId);
    expect(loaded?.messages).toEqual(nextMessages);
    expect(loaded?.lineage?.entries).toContainEqual(expect.objectContaining({
      type: 'memory_outcome_digest',
      jobId: 'job-atomic-lineage',
    }));
    expect(loaded?.lineage?.entries).toContainEqual(expect.objectContaining({
      type: 'memory_review_receipt',
      jobId: 'job-atomic-lineage',
    }));
    expect(loaded?.lineage?.entries).toContainEqual(expect.objectContaining({
      type: 'client_notice',
      payload: { episodeId: digest.id, proposalIds: ['proposal-atomic-lineage'] },
    }));
  });

  it('does not let a pre-rewind host snapshot restore the retired branch', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const storage = new FileSessionStorage({
      sessionsDir: testSessionsDir(),
      configHome: path.join(tempHome, '.kodax'),
    });
    const sessionId = 'session-stale-after-rewind';
    const messages = [
      { role: 'user' as const, content: 'first question' },
      { role: 'assistant' as const, content: 'first answer' },
      { role: 'user' as const, content: 'retired question' },
      { role: 'assistant' as const, content: 'retired answer' },
    ];
    await storage.save(sessionId, {
      messages,
      title: 'rewind topology',
      gitRoot: KODAX_REPO_ROOT,
      lineage: createSessionLineage(messages),
    });
    const stale = await storage.load(sessionId);
    const target = stale?.lineage?.entries.find((entry) => entry.type === 'message')?.id;
    if (stale === null || target === undefined) throw new Error('expected stale rewind snapshot');

    await storage.rewind(sessionId, target);
    await storage.save(sessionId, stale);

    const loaded = await storage.load(sessionId);
    expect(loaded?.messages).toEqual([{ role: 'user', content: 'first question' }]);
    expect(loaded?.lineage?.entries).toContainEqual(expect.objectContaining({
      type: 'rewind_marker',
      targetId: target,
    }));
  });

  it('does not let a pre-compaction host snapshot restore compacted context', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const storage = new FileSessionStorage({
      sessionsDir: testSessionsDir(),
      configHome: path.join(tempHome, '.kodax'),
    });
    const sessionId = 'session-stale-after-compaction';
    const messages = [
      { role: 'user' as const, content: 'old question' },
      { role: 'assistant' as const, content: 'old answer' },
    ];
    const initial = createSessionLineage(messages);
    await storage.save(sessionId, {
      messages,
      title: 'compaction topology',
      gitRoot: KODAX_REPO_ROOT,
      lineage: initial,
    });
    const stale = await storage.load(sessionId);
    if (stale === null) throw new Error('expected stale compaction snapshot');
    const keptMessages = [{ role: 'user' as const, content: 'kept context' }];
    const compacted = applySessionCompaction(initial, keptMessages, {
      summary: 'old work',
      reason: 'automatic_compaction',
    });
    await storage.save(sessionId, {
      ...stale,
      messages: keptMessages,
      lineage: compacted,
    });

    await storage.save(sessionId, stale);

    const loaded = await storage.load(sessionId);
    expect(loaded?.messages).toEqual(keptMessages);
    expect(loaded?.lineage?.entries).toContainEqual(expect.objectContaining({
      type: 'compaction',
      summary: 'old work',
    }));
  });

  it('rejects a stale compaction that did not inherit the persisted rewind', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const storage = new FileSessionStorage({
      sessionsDir: testSessionsDir(),
      configHome: path.join(tempHome, '.kodax'),
    });
    const sessionId = 'session-stale-compaction-after-rewind';
    const messages = [
      { role: 'user' as const, content: 'first question' },
      { role: 'assistant' as const, content: 'first answer' },
      { role: 'user' as const, content: 'retired question' },
      { role: 'assistant' as const, content: 'retired answer' },
    ];
    const initial = createSessionLineage(messages);
    await storage.save(sessionId, {
      messages,
      title: 'conflicting topology',
      gitRoot: KODAX_REPO_ROOT,
      lineage: initial,
    });
    const stale = await storage.load(sessionId);
    const target = stale?.lineage?.entries.find((entry) => entry.type === 'message')?.id;
    if (stale?.lineage === undefined || target === undefined) {
      throw new Error('expected stale topology snapshot');
    }
    await storage.rewind(sessionId, target);
    const staleMessages = [{ role: 'user' as const, content: 'stale compacted branch' }];
    const staleCompaction = applySessionCompaction(stale.lineage, staleMessages, {
      summary: 'stale branch',
      reason: 'automatic_compaction',
    });

    await storage.save(sessionId, {
      ...stale,
      messages: staleMessages,
      lineage: staleCompaction,
    });

    const loaded = await storage.load(sessionId);
    expect(loaded?.messages).toEqual([{ role: 'user', content: 'first question' }]);
    expect(loaded?.lineage?.entries).toContainEqual(expect.objectContaining({
      type: 'rewind_marker',
      targetId: target,
    }));
    expect(loaded?.lineage?.entries).not.toContainEqual(expect.objectContaining({
      type: 'compaction',
      summary: 'stale branch',
    }));
  });

  it('serializes full saves and lineage mutations across storage instances', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const sessionsDir = testSessionsDir();
    const host = new FileSessionStorage({ sessionsDir });
    const reviewer = new FileSessionStorage({ sessionsDir });
    const sessionId = 'session-cross-instance-mutation';
    const initialMessages = [{ role: 'user' as const, content: 'base turn' }];
    await host.save(sessionId, {
      messages: initialMessages,
      title: 'cross-instance owner',
      gitRoot: KODAX_REPO_ROOT,
      lineage: createSessionLineage(initialMessages),
    });
    const originalRename = fsPromises.rename.bind(fsPromises);
    let releaseHostRename!: () => void;
    const hostRenameReleased = new Promise<void>((resolve) => {
      releaseHostRename = resolve;
    });
    let signalHostRename!: () => void;
    const hostRenameReached = new Promise<void>((resolve) => {
      signalHostRename = resolve;
    });
    let blocked = false;
    const rename = vi.spyOn(fsPromises, 'rename');
    rename.mockImplementation(async (oldPath, newPath) => {
      if (!blocked && String(newPath).endsWith(`${sessionId}.jsonl`)) {
        blocked = true;
        signalHostRename();
        await hostRenameReleased;
      }
      await originalRename(oldPath, newPath);
    });
    try {
      const nextMessages = [
        ...initialMessages,
        { role: 'assistant' as const, content: 'new owner turn' },
      ];
      const hostSave = host.save(sessionId, {
        messages: nextMessages,
        title: 'cross-instance owner',
        gitRoot: KODAX_REPO_ROOT,
        lineage: createSessionLineage(nextMessages),
      });
      await hostRenameReached;
      const receiptMutation = reviewer.mutateLineage(sessionId, (lineage) => (
        appendMemoryReviewReceipt(lineage, {
          jobId: 'job-cross-instance',
          reviewKey: 'review-cross-instance',
          proposalIds: ['proposal-cross-instance'],
          completedAt: '2026-07-27T00:01:00.000Z',
        })
      ));
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      releaseHostRename();
      await Promise.all([hostSave, receiptMutation]);

      const loaded = await host.load(sessionId);
      expect(loaded?.messages).toEqual(nextMessages);
      expect(loaded?.lineage?.entries).toContainEqual(expect.objectContaining({
        type: 'memory_review_receipt',
        jobId: 'job-cross-instance',
      }));
    } finally {
      releaseHostRename();
      rename.mockRestore();
    }
  });

  it('waits for a live session writer held longer than the learning lock timeout', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const sessionsDir = testSessionsDir();
    const storage = new FileSessionStorage({ sessionsDir });
    const sessionId = 'session-long-cross-instance-writer';
    const lockKey = createHash('sha256').update(sessionId, 'utf8').digest('hex');
    const lockPath = path.join(sessionsDir, '.write-locks', `${lockKey}.lock`);
    let markLockHeld!: () => void;
    const lockHeld = new Promise<void>((resolve) => {
      markLockHeld = resolve;
    });
    const holder = withKodaXFileLock(lockPath, async () => {
      markLockHeld();
      await new Promise<void>((resolve) => setTimeout(resolve, 5_600));
    });
    await lockHeld;

    const messages = [{ role: 'user' as const, content: 'wait for the live writer' }];
    await expect(storage.save(sessionId, {
      messages,
      title: 'long writer',
      gitRoot: KODAX_REPO_ROOT,
      lineage: createSessionLineage(messages),
    })).resolves.toBeUndefined();
    await holder;

    expect((await storage.load(sessionId))?.messages).toEqual(messages);
  });

  it('keeps the outer review fence live while a branch mutation waits on a long session writer', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const sessionsDir = testSessionsDir();
    const configHome = path.join(tempHome, '.kodax');
    const storage = new FileSessionStorage({ sessionsDir, configHome });
    const sessionId = 'session-long-writer-branch-fence';
    const identity = {
      configHome,
      tenantId: 'tenant-long-writer-branch-fence',
      agentId: 'agent-long-writer-branch-fence',
      projectId: 'project-long-writer-branch-fence',
      sessionId,
    };
    const messages = [
      { role: 'user' as const, content: 'root turn' },
      { role: 'assistant' as const, content: 'branch turn' },
    ];
    const lineage = createSessionLineage(messages);
    const targetId = lineage.entries[0]?.id;
    if (targetId === undefined) throw new Error('expected branch target');
    await storage.save(sessionId, {
      messages,
      title: 'long writer branch fence',
      gitRoot: KODAX_REPO_ROOT,
      lineage,
    });
    await persistPendingEpisodeReview(identity, {
      id: 'digest-long-writer-branch-fence',
      reviewKey: 'review-long-writer-branch-fence',
      sessionId,
      branchId: sessionId,
      sequence: 1,
      objective: 'preserve branch authority',
      approach: 'wait through session contention',
      outcome: 'succeeded',
      summary: 'review is pending',
      evidenceRefs: [],
      visibility: 'prompt_safe',
      createdAt: '2026-07-27T00:00:00.000Z',
    });

    const sessionLockKey = createHash('sha256').update(sessionId, 'utf8').digest('hex');
    const sessionLockPath = path.join(
      sessionsDir,
      '.write-locks',
      `${sessionLockKey}.lock`,
    );
    let markSessionLockHeld!: () => void;
    const sessionLockHeld = new Promise<void>((resolve) => {
      markSessionLockHeld = resolve;
    });
    const holder = withKodaXFileLock(sessionLockPath, async () => {
      markSessionLockHeld();
      await new Promise<void>((resolve) => setTimeout(resolve, 6_500));
    });
    await sessionLockHeld;

    const branchChange = storage.setActiveEntry(sessionId, targetId);
    const branchLockPath = path.join(
      configHome,
      'memory-review-inbox',
      hashMemoryIdentityComponent('tenant', identity.tenantId),
      hashMemoryIdentityComponent('session', sessionId),
      '.branch-authority.lock',
    );
    const branchLockDeadline = Date.now() + 2_000;
    while (!existsSync(branchLockPath) && Date.now() < branchLockDeadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    expect(existsSync(branchLockPath)).toBe(true);

    const completionFence = withPendingEpisodeReviewSessionFence(
      { configHome, sessionId },
      async () => 'completed',
    );
    const results = await Promise.allSettled([branchChange, completionFence]);
    await holder;

    expect(results).toEqual([
      expect.objectContaining({ status: 'fulfilled' }),
      { status: 'fulfilled', value: 'completed' },
    ]);
  });

  it('serializes review completion before a concurrent branch change without timing out or attaching the receipt to the new branch', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const configHome = path.join(tempHome, '.kodax');
    const storage = new FileSessionStorage({
      sessionsDir: testSessionsDir(),
      configHome,
    });
    const sessionId = 'session-review-completion-race';
    const identity = {
      configHome,
      tenantId: 'tenant-review-completion-race',
      agentId: 'agent-review-completion-race',
      projectId: 'project-review-completion-race',
      sessionId,
    };
    const digest: KodaXMemoryOutcomeDigest = {
      id: 'digest-review-completion-race',
      reviewKey: 'review-completion-race',
      sessionId,
      branchId: sessionId,
      sequence: 1,
      objective: 'complete a delayed review',
      approach: 'persist its owner-session receipt',
      outcome: 'succeeded',
      summary: 'review completed',
      evidenceRefs: [],
      visibility: 'prompt_safe',
      createdAt: '2026-07-27T00:00:00.000Z',
    };
    const pending = await persistPendingEpisodeReview(identity, digest);
    const messages = [
      { role: 'user' as const, content: 'root' },
      { role: 'assistant' as const, content: 'old branch' },
    ];
    const initialLineage = createSessionLineage(messages);
    const targetEntryId = initialLineage.entries[0]?.id;
    if (targetEntryId === undefined) throw new Error('expected branch target');
    await storage.save(sessionId, {
      messages,
      title: 'completion race',
      gitRoot: KODAX_REPO_ROOT,
      lineage: appendMemoryOutcomeDigest(initialLineage, digest, pending.entry.jobId),
    });

    let markCompletionStarted!: () => void;
    const completionStarted = new Promise<void>((resolve) => {
      markCompletionStarted = resolve;
    });
    let releaseCompletion!: () => void;
    const completionRelease = new Promise<void>((resolve) => {
      releaseCompletion = resolve;
    });
    const drain = drainPendingEpisodeReviews(identity, {
      revalidate: async () => 'eligible',
      review: async () => [],
      onV2Completed: async (entry, _decision, proposalIds) => {
        markCompletionStarted();
        await completionRelease;
        const owner = await storage.load(sessionId);
        if (owner?.lineage === undefined) throw new Error('expected owner lineage');
        await storage.save(sessionId, {
          ...owner,
          lineage: appendMemoryReviewReceipt(owner.lineage, {
            jobId: entry.jobId,
            reviewKey: entry.reviewKey,
            proposalIds,
            completedAt: '2026-07-27T00:01:00.000Z',
          }),
        });
      },
    });
    await completionStarted;
    const branchChange = storage.setActiveEntry(sessionId, targetEntryId);
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    releaseCompletion();

    await expect(Promise.all([drain, branchChange])).resolves.toMatchObject([
      { reviewed: 1, failed: 0 },
      { lineage: { activeEntryId: targetEntryId } },
    ]);
    const loaded = await storage.load(sessionId);
    const receipt = loaded?.lineage?.entries.find((entry) =>
      entry.type === 'memory_review_receipt' && entry.jobId === pending.entry.jobId);
    const activePathIds = new Set(
      loaded?.lineage === undefined
        ? []
        : getSessionLineagePath(loaded.lineage).map((entry) => entry.id),
    );
    expect(receipt).toBeDefined();
    expect(receipt?.parentId === null || activePathIds.has(receipt?.parentId ?? '')).toBe(false);
  }, 10_000);

  it('archives exact pre-compaction messages before accepting an evicted snapshot', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const gitRoot = path.resolve(KODAX_REPO_ROOT).replace(/\\/g, '/');
    const originalMessages = [
      { role: 'user' as const, content: '旧需求精确值是 ALPHA-9274，不得猜测。' },
      { role: 'assistant' as const, content: '已记录 ALPHA-9274，并完成第一阶段。' },
    ];
    const initialLineage = createSessionLineage(originalMessages);

    await storage.save('durable-before-evict', {
      messages: originalMessages,
      title: 'Durable compaction',
      gitRoot,
      lineage: initialLineage,
    });

    const compacted = applySessionCompaction(
      initialLineage,
      [
        { role: 'system', content: '[对话历史摘要]\n\n已完成第一阶段。' },
        { role: 'user', content: '继续第二阶段' },
      ],
      { summary: '已完成第一阶段。', reason: 'automatic_compaction' },
    );
    const evicted = evictOldIslandMessageContent(compacted);
    await storage.save('durable-before-evict', {
      messages: [{ role: 'user', content: '继续第二阶段' }],
      title: 'Durable compaction',
      gitRoot,
      lineage: evicted,
    });

    const restarted = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const fullLineage = await restarted.loadFullLineage('durable-before-evict');
    const exactBodies = fullLineage?.entries
      .filter((entry) => entry.type === 'message')
      .map((entry) => entry.message.content);
    expect(exactBodies).toContain('旧需求精确值是 ALPHA-9274，不得猜测。');
    expect(exactBodies).toContain('已记录 ALPHA-9274，并完成第一阶段。');
  });

  it('round-trips full lineage by merging the main file and island sidecar', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const gitRoot = path.resolve(KODAX_REPO_ROOT).replace(/\\/g, '/');
    const originalMessages = [
      { role: 'user' as const, content: 'sidecar evidence USER-441' },
      { role: 'assistant' as const, content: 'sidecar evidence ASSISTANT-442' },
    ];
    const lineage = applySessionCompaction(
      createSessionLineage(originalMessages),
      [{ role: 'user', content: 'active tail' }],
      { summary: 'old work', reason: 'manual_compaction' },
    );

    await storage.save('full-lineage-merge', {
      messages: [{ role: 'user', content: 'active tail' }],
      title: 'Full lineage merge',
      gitRoot,
      lineage,
    });

    const fullLineage = await storage.loadFullLineage('full-lineage-merge');
    expect(fullLineage?.entries.filter((entry) => entry.type === 'message')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: expect.objectContaining({ content: 'sidecar evidence USER-441' }) }),
        expect.objectContaining({ message: expect.objectContaining({ content: 'sidecar evidence ASSISTANT-442' }) }),
      ]),
    );
  });

  it('merges historical island batches with stable topology instead of timestamps', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const { setKodaXDiagnosticSink } = await import('@kodax-ai/agent');
    const sessionsDir = testSessionsDir();
    const projectDir = path.join(sessionsDir, 'topology-project');
    const sessionId = 'topology-aware-full-lineage';
    const timestamp = '2026-07-30T00:00:00.000Z';
    await mkdir(projectDir, { recursive: true });

    const messageEntry = (
      id: string,
      parentId: string | null,
      content: string,
    ) => ({
      id,
      parentId,
      timestamp,
      type: 'message' as const,
      message: { role: 'user' as const, content },
    });
    const retainedParent = messageEntry('entry_parent', null, 'retained parent');
    const overlapPlaceholder = messageEntry('entry_overlap', 'entry_legacy_child', '[compacted]');
    const retainedNext = messageEntry('entry_retained_next', 'entry_parent', 'retained next');
    const current = messageEntry('entry_current', null, 'current');

    await writeFile(
      path.join(projectDir, `${sessionId}.jsonl`),
      [
        JSON.stringify({
          _type: 'meta',
          id: sessionId,
          title: 'Topology-aware recovery',
          gitRoot: '/tmp/topology-project',
          createdAt: timestamp,
          scope: 'user',
          lineageVersion: 2,
          activeEntryId: current.id,
          activeMessageCount: 1,
          lineageEntryCount: 4,
        }),
        ...[retainedParent, overlapPlaceholder, retainedNext, current].map((entry) =>
          JSON.stringify({ _type: 'lineage_entry', entry })),
      ].join('\n') + '\n',
      'utf8',
    );

    const legacyChild = messageEntry('entry_legacy_child', retainedParent.id, 'legacy child');
    const batchIndependent = messageEntry('entry_batch_independent', null, 'batch independent');
    const exactOverlap = messageEntry('entry_overlap', legacyChild.id, 'exact overlap');
    const secondBatchChild = messageEntry('entry_second_batch', exactOverlap.id, 'second batch');
    const anchoredMiddle = messageEntry('entry_anchored_middle', null, 'anchored middle');
    const legacyOnly = messageEntry('entry_legacy_only', current.id, 'legacy only');
    await writeFile(
      path.join(projectDir, `${sessionId}.islands.jsonl`),
      [
        JSON.stringify({ _type: 'archive_batch', archiveBatchId: 'batch_one' }),
        JSON.stringify({
          _type: 'archived_entry',
          archiveBatchId: 'batch_one',
          entry: legacyChild,
        }),
        JSON.stringify({
          _type: 'archived_entry',
          archiveBatchId: 'batch_one',
          entry: batchIndependent,
        }),
        JSON.stringify({
          _type: 'archived_entry',
          archiveBatchId: 'batch_one',
          entry: exactOverlap,
        }),
        JSON.stringify({ _type: 'archive_batch', archiveBatchId: 'batch_two' }),
        JSON.stringify({
          _type: 'archived_entry',
          archiveBatchId: 'batch_two',
          entry: secondBatchChild,
        }),
        JSON.stringify({ _type: 'archive_batch', archiveBatchId: 'batch_three' }),
        JSON.stringify({
          _type: 'archived_entry',
          archiveBatchId: 'batch_three',
          previousEntryId: retainedNext.id,
          nextEntryId: current.id,
          entry: anchoredMiddle,
        }),
        '{"_type":"archived_entry","archiveBatchId":"crash_tail","entry":',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      path.join(projectDir, `${sessionId}.archive.jsonl`),
      [
        JSON.stringify({
          _type: 'archived_entry',
          archiveBatchId: 'legacy_overlap',
          entry: exactOverlap,
        }),
        JSON.stringify({
          _type: 'archived_entry',
          archiveBatchId: 'legacy_only',
          previousEntryId: 42,
          entry: legacyOnly,
        }),
      ].join('\n') + '\n',
      'utf8',
    );

    const storage = new FileSessionStorage({ sessionsDir });
    const diagnostics: string[] = [];
    const restoreDiagnostics = setKodaXDiagnosticSink((diagnostic) => {
      if (diagnostic.source === 'repl:session-storage') {
        diagnostics.push(diagnostic.message);
      }
    });
    let full: Awaited<ReturnType<typeof storage.loadFullLineage>>;
    try {
      full = await storage.loadFullLineage(sessionId);
    } finally {
      restoreDiagnostics();
    }
    const messages = full?.entries
      .filter((entry) => entry.type === 'message')
      .map((entry) => ({ id: entry.id, content: entry.message.content }));

    expect(messages).toEqual([
      { id: retainedParent.id, content: 'retained parent' },
      { id: legacyChild.id, content: 'legacy child' },
      { id: batchIndependent.id, content: 'batch independent' },
      { id: exactOverlap.id, content: 'exact overlap' },
      { id: secondBatchChild.id, content: 'second batch' },
      { id: retainedNext.id, content: 'retained next' },
      { id: anchoredMiddle.id, content: 'anchored middle' },
      { id: current.id, content: 'current' },
      { id: legacyOnly.id, content: 'legacy only' },
    ]);
    expect(new Set(messages?.map((entry) => entry.id)).size).toBe(messages?.length);
    expect(diagnostics).toContain(
      `Ignored incomplete island sidecar tail ${sessionId}.islands.jsonl:9.`,
    );

    const expectedIds = messages?.map((entry) => entry.id);
    expect(await storage.archive(sessionId)).toBe(true);
    expect((await storage.loadFullLineage(sessionId))?.entries.map((entry) => entry.id))
      .toEqual(expectedIds);
    expect(await storage.unarchive(sessionId)).toBe(true);
    expect((await storage.loadFullLineage(sessionId))?.entries.map((entry) => entry.id))
      .toEqual(expectedIds);
  });

  it('keeps exact-main authority after rewind moves a conflicting overlap to the sidecar', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const sessionsDir = testSessionsDir();
    const projectDir = path.join(sessionsDir, 'overlap-authority-project');
    const sessionId = 'overlap-authority';
    const timestamp = '2026-07-30T00:00:00.000Z';
    const rootEntry = {
      id: 'entry_overlap_root',
      parentId: null,
      timestamp,
      type: 'message' as const,
      message: { role: 'user' as const, content: 'rewind target' },
    };
    const mainEntry = {
      id: 'entry_overlap_authority',
      parentId: null,
      timestamp,
      type: 'message' as const,
      message: { role: 'user' as const, content: 'authoritative main body' },
    };
    const tailEntry = {
      id: 'entry_overlap_tail',
      parentId: mainEntry.id,
      timestamp,
      type: 'message' as const,
      message: { role: 'assistant' as const, content: 'authoritative tail' },
    };
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      path.join(projectDir, `${sessionId}.jsonl`),
      [
        JSON.stringify({
          _type: 'meta',
          id: sessionId,
          title: 'Overlap authority',
          gitRoot: '/tmp/overlap-authority-project',
          createdAt: timestamp,
          scope: 'user',
          lineageVersion: 2,
          activeEntryId: tailEntry.id,
          activeMessageCount: 2,
          lineageEntryCount: 3,
        }),
        JSON.stringify({ _type: 'lineage_entry', entry: rootEntry }),
        JSON.stringify({ _type: 'lineage_entry', entry: mainEntry }),
        JSON.stringify({ _type: 'lineage_entry', entry: tailEntry }),
      ].join('\n') + '\n',
      'utf8',
    );
    await writeFile(
      path.join(projectDir, `${sessionId}.islands.jsonl`),
      JSON.stringify({
        _type: 'archived_entry',
        archiveBatchId: 'overlap',
        previousEntryId: tailEntry.id,
        nextEntryId: rootEntry.id,
        entry: {
          ...mainEntry,
          message: { role: 'user', content: 'stale sidecar body' },
        },
      }) + '\n',
      'utf8',
    );

    const storage = new FileSessionStorage({ sessionsDir });
    expect((await storage.loadFullLineage(sessionId))?.entries).toEqual([
      rootEntry,
      mainEntry,
      tailEntry,
    ]);

    expect(await storage.rewind(sessionId, rootEntry.id)).not.toBeNull();
    const full = await storage.loadFullLineage(sessionId);
    expect(full?.entries.map((entry) => entry.id)).toEqual([
      rootEntry.id,
      mainEntry.id,
      tailEntry.id,
      expect.stringMatching(/^entry_/),
    ]);
    expect(full?.entries.find((entry) => entry.id === mainEntry.id)).toEqual(mainEntry);
  });

  it('limits corrupt parent-cycle fallback to the cycle and preserves downstream topology', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const sessionsDir = testSessionsDir();
    const projectDir = path.join(sessionsDir, 'cycle-fallback-project');
    const sessionId = 'cycle-fallback';
    const timestamp = '2026-07-30T00:00:00.000Z';
    const entry = (id: string, parentId: string | null) => ({
      id,
      parentId,
      timestamp,
      type: 'message' as const,
      message: { role: 'user' as const, content: id },
    });
    const current = entry('entry_cycle_current', 'entry_cycle_y');
    const cycleA = entry('entry_cycle_a', 'entry_cycle_b');
    const cycleB = entry('entry_cycle_b', 'entry_cycle_a');
    const downstream = entry('entry_cycle_y', 'entry_cycle_b');
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      path.join(projectDir, `${sessionId}.jsonl`),
      [
        JSON.stringify({
          _type: 'meta',
          id: sessionId,
          title: 'Cycle fallback',
          gitRoot: '/tmp/cycle-fallback-project',
          createdAt: timestamp,
          scope: 'user',
          lineageVersion: 2,
          activeEntryId: current.id,
          activeMessageCount: 1,
          lineageEntryCount: 1,
        }),
        JSON.stringify({ _type: 'lineage_entry', entry: current }),
      ].join('\n') + '\n',
      'utf8',
    );
    await writeFile(
      path.join(projectDir, `${sessionId}.islands.jsonl`),
      [current, cycleA, cycleB, downstream].map((archived) => JSON.stringify({
        _type: 'archived_entry',
        archiveBatchId: 'corrupt_cycle',
        entry: archived,
      })).join('\n') + '\n',
      'utf8',
    );

    const full = await new FileSessionStorage({ sessionsDir }).loadFullLineage(sessionId);
    const ids = full?.entries.map((candidate) => candidate.id) ?? [];
    expect(new Set(ids)).toEqual(new Set([current.id, cycleA.id, cycleB.id, downstream.id]));
    expect(ids.indexOf(cycleB.id)).toBeLessThan(ids.indexOf(downstream.id));
    expect(ids.indexOf(downstream.id)).toBeLessThan(ids.indexOf(current.id));
  });

  it('reads the main transcript and sidecars under the Session write lock', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const sessionsDir = testSessionsDir();
    const sessionId = 'locked-full-lineage-read';
    const storage = new FileSessionStorage({ sessionsDir });
    await storage.save(sessionId, {
      messages: [{ role: 'user', content: 'consistent snapshot' }],
      title: 'Locked full lineage read',
      gitRoot: path.resolve(KODAX_REPO_ROOT).replace(/\\/g, '/'),
      lineage: createSessionLineage([{ role: 'user', content: 'consistent snapshot' }]),
    });
    const lockKey = createHash('sha256').update(sessionId, 'utf8').digest('hex');
    const lockPath = path.join(sessionsDir, '.write-locks', `${lockKey}.lock`);
    const reads: Array<ReturnType<typeof storage.loadFullLineage>> = [];
    let settled = false;

    await withKodaXFileLock(lockPath, async () => {
      reads.push(storage.loadFullLineage(sessionId).finally(() => {
        settled = true;
      }));
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      expect(settled).toBe(false);
    });

    const read = reads[0];
    if (!read) throw new Error('Expected a pending full-lineage read.');
    expect(await read).not.toBeNull();
  });

  it('fails strict reads without creating lock artifacts while a writer is active', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const sessionsDir = testSessionsDir();
    const sessionId = 'strict-active-writer';
    const storage = new FileSessionStorage({ sessionsDir });
    await storage.save(sessionId, {
      messages: [{ role: 'user', content: 'consistent snapshot' }],
      title: 'Strict active writer',
      gitRoot: path.resolve(KODAX_REPO_ROOT).replace(/\\/g, '/'),
      lineage: createSessionLineage([{ role: 'user', content: 'consistent snapshot' }]),
    });
    const lockKey = createHash('sha256').update(sessionId, 'utf8').digest('hex');
    const lockPath = path.join(sessionsDir, '.write-locks', `${lockKey}.lock`);

    await withKodaXFileLock(lockPath, async () => {
      await expect(storage.readFullSnapshot(sessionId)).rejects.toMatchObject({
        code: 'data_changed',
      });
    });

    const lockQueue = `${lockPath}.queue`;
    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(lockQueue)).toBe(true);
    expect(await fsPromises.readdir(lockQueue)).toEqual([]);
  });

  it('fails strict reads closed during an in-progress layout migration', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const sessionsDir = testSessionsDir();
    const sessionId = 'strict-mid-migration';
    const projectDir = path.join(sessionsDir, 'migration-target');
    const mainPath = path.join(projectDir, `${sessionId}.jsonl`);
    const strandedSidecarPath = path.join(sessionsDir, `${sessionId}.islands.jsonl`);
    const timestamp = '2026-07-30T00:00:00.000Z';
    const parent = {
      id: 'entry_migration_parent',
      parentId: null,
      timestamp,
      type: 'message' as const,
      message: { role: 'user' as const, content: 'parent' },
    };
    const child = {
      id: 'entry_migration_child',
      parentId: parent.id,
      timestamp,
      type: 'message' as const,
      message: { role: 'assistant' as const, content: 'archived child' },
    };
    await mkdir(projectDir, { recursive: true });
    await writeFile(mainPath, [
      JSON.stringify({
        _type: 'meta',
        id: sessionId,
        title: 'Mid migration',
        gitRoot: '/tmp/test-repo',
        createdAt: timestamp,
        lineageVersion: 2,
        activeEntryId: parent.id,
        activeMessageCount: 1,
      }),
      JSON.stringify({ _type: 'lineage_entry', entry: parent }),
    ].join('\n') + '\n', 'utf8');
    await writeFile(strandedSidecarPath, JSON.stringify({
      _type: 'archived_entry',
      archiveBatchId: 'migration-batch',
      entry: child,
    }) + '\n', 'utf8');
    await mkdir(path.join(sessionsDir, '.migration-lock'));

    await expect(
      new FileSessionStorage({ sessionsDir }).readFullSnapshot(sessionId),
    ).rejects.toMatchObject({ code: 'data_changed' });

    expect(await readFile(mainPath, 'utf8')).toContain(parent.id);
    expect(await readFile(strandedSidecarPath, 'utf8')).toContain(child.id);
    expect(existsSync(path.join(sessionsDir, '.write-locks'))).toBe(false);
  });

  it('reports a malformed sidecar tail as data_corrupt in strict mode', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const sessionsDir = testSessionsDir();
    const sessionId = 'strict-corrupt-sidecar-tail';
    const mainPath = path.join(sessionsDir, `${sessionId}.jsonl`);
    const timestamp = '2026-07-30T00:00:00.000Z';
    const entry = {
      id: 'entry_strict_tail',
      parentId: null,
      timestamp,
      type: 'message' as const,
      message: { role: 'user' as const, content: 'retained' },
    };
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(mainPath, [
      JSON.stringify({
        _type: 'meta',
        id: sessionId,
        title: 'Strict corrupt tail',
        gitRoot: '/tmp/test-repo',
        createdAt: timestamp,
        lineageVersion: 2,
        activeEntryId: entry.id,
        activeMessageCount: 1,
      }),
      JSON.stringify({ _type: 'lineage_entry', entry }),
    ].join('\n') + '\n', 'utf8');
    await writeFile(
      path.join(sessionsDir, `${sessionId}.islands.jsonl`),
      '{"_type":"archived_entry","archiveBatchId":"partial","entry":',
      'utf8',
    );

    await expect(
      new FileSessionStorage({ sessionsDir }).readFullSnapshot(sessionId),
    ).rejects.toMatchObject({ code: 'data_corrupt' });
  });

  it('persists private lineage adjacency anchors for newly archived entries', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const { deriveProjectKeyFromRoot } = await import('./project-key.js');
    const sessionsDir = testSessionsDir();
    const sessionId = 'sidecar-adjacency-anchors';
    const gitRoot = path.resolve(KODAX_REPO_ROOT).replace(/\\/g, '/');
    const initial = createSessionLineage([
      { role: 'user', content: 'retained parent' },
      { role: 'assistant', content: 'archived child one' },
      { role: 'assistant', content: 'archived child two' },
    ]);
    const retainedParent = initial.entries[0]!;
    const archivedChildOne = initial.entries[1]!;
    const archivedChildTwo = initial.entries[2]!;
    const label = {
      type: 'label' as const,
      id: 'label_retained_parent',
      parentId: null,
      logicalId: 'label_retained_parent',
      timestamp: '2026-07-30T00:00:00.000Z',
      targetId: retainedParent.id,
      label: 'retain-parent',
    };
    const labeled: KodaXSessionLineage = {
      ...initial,
      entries: [...initial.entries, label],
    };
    const compacted = applySessionCompaction(
      labeled,
      [{ role: 'user', content: 'current island' }],
      { summary: 'old island' },
    );

    await new FileSessionStorage({ sessionsDir }).save(sessionId, {
      messages: [{ role: 'user', content: 'current island' }],
      title: 'Sidecar adjacency anchors',
      gitRoot,
      lineage: compacted,
    });

    const sidecarPath = path.join(
      sessionsDir,
      deriveProjectKeyFromRoot(gitRoot).key,
      `${sessionId}.islands.jsonl`,
    );
    const archived = (await readFile(sidecarPath, 'utf8'))
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as {
        _type?: string;
        previousEntryId?: string | null;
        nextEntryId?: string | null;
        entry?: { id?: string };
      })
      .filter((line) => line._type === 'archived_entry');
    const byId = new Map(archived.map((line) => [line.entry?.id, line]));

    expect(byId.get(archivedChildOne.id)).toMatchObject({
      previousEntryId: retainedParent.id,
      nextEntryId: archivedChildTwo.id,
    });
    expect(byId.get(archivedChildTwo.id)).toMatchObject({
      previousEntryId: archivedChildOne.id,
      nextEntryId: label.id,
    });
  });

  it('does not replace the exact main file when the island sidecar flush fails', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const gitRoot = path.resolve(KODAX_REPO_ROOT).replace(/\\/g, '/');
    const initialMessages = [{ role: 'user' as const, content: 'sidecar failure exact FOXTROT-661' }];
    const initialLineage = createSessionLineage(initialMessages);
    await storage.save('sidecar-flush-failure', {
      messages: initialMessages,
      title: 'Sidecar failure ordering',
      gitRoot,
      lineage: initialLineage,
    });

    const compacted = applySessionCompaction(
      initialLineage,
      [{ role: 'user', content: 'active after rejected compact' }],
      { summary: 'old exact value exists' },
    );
    const originalOpen = fsPromises.open.bind(fsPromises);
    const open = vi.spyOn(fsPromises, 'open');
    open.mockImplementation(async (filePath, flags, mode) => {
      if (String(filePath).endsWith('.islands.jsonl')) {
        throw Object.assign(new Error('simulated sidecar flush failure'), { code: 'EIO' });
      }
      return originalOpen(filePath, flags, mode);
    });
    try {
      await expect(storage.save('sidecar-flush-failure', {
        messages: [{ role: 'user', content: 'active after rejected compact' }],
        title: 'Sidecar failure ordering',
        gitRoot,
        lineage: compacted,
      })).rejects.toThrow('simulated sidecar flush failure');
    } finally {
      open.mockRestore();
    }

    const restarted = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    expect((await restarted.load('sidecar-flush-failure'))?.messages).toEqual(initialMessages);
    expect((await restarted.loadFullLineage('sidecar-flush-failure'))?.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'message',
          message: expect.objectContaining({ content: 'sidecar failure exact FOXTROT-661' }),
        }),
      ]),
    );
  });

  it('keeps the prior main file authoritative when the post-archive replace fails', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const gitRoot = path.resolve(KODAX_REPO_ROOT).replace(/\\/g, '/');
    const initialMessages = [{ role: 'user' as const, content: 'failure-safe exact ECHO-551' }];
    const initialLineage = createSessionLineage(initialMessages);
    await storage.save('archive-before-replace', {
      messages: initialMessages,
      title: 'Failure ordering',
      gitRoot,
      lineage: initialLineage,
    });

    const compacted = applySessionCompaction(
      initialLineage,
      [{ role: 'user', content: 'active after failed compact' }],
      { summary: 'old exact value exists' },
    );
    const originalRename = fsPromises.rename.bind(fsPromises);
    const rename = vi.spyOn(fsPromises, 'rename');
    rename.mockImplementation(async (oldPath, newPath) => {
      if (String(newPath).endsWith('archive-before-replace.jsonl')) {
        throw Object.assign(new Error('simulated durable replace failure'), { code: 'EIO' });
      }
      await originalRename(oldPath, newPath);
    });
    try {
      await expect(storage.save('archive-before-replace', {
        messages: [{ role: 'user', content: 'active after failed compact' }],
        title: 'Failure ordering',
        gitRoot,
        lineage: compacted,
      })).rejects.toThrow('simulated durable replace failure');
    } finally {
      rename.mockRestore();
    }

    const restarted = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    expect((await restarted.load('archive-before-replace'))?.messages).toEqual(initialMessages);
    const full = await restarted.loadFullLineage('archive-before-replace');
    expect(full?.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'message',
        message: expect.objectContaining({ content: 'failure-safe exact ECHO-551' }),
      }),
    ]));
  });

  it('preserves the unslimmed append watermark across archive maintenance', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const gitRoot = path.resolve(KODAX_REPO_ROOT).replace(/\\/g, '/');
    const oldMessages = Array.from({ length: 501 }, (_, index) => ({
      role: 'user' as const,
      content: `old branch ${index}`,
    }));
    const oldLineage = createSessionLineage(oldMessages);
    await storage.save('maintenance-watermark', {
      messages: oldMessages,
      title: 'Maintenance watermark',
      gitRoot,
      lineage: oldLineage,
    });

    const switched = createSessionLineage([{ role: 'user', content: 'new root' }], oldLineage);
    await storage.appendSessionDelta('maintenance-watermark', {
      messages: [{ role: 'user', content: 'new root' }],
      title: 'Maintenance watermark',
      gitRoot,
      lineage: switched,
    });
    const extended = createSessionLineage([
      { role: 'user', content: 'new root' },
      { role: 'assistant', content: 'new root reply' },
    ], switched);
    await storage.appendSessionDelta('maintenance-watermark', {
      messages: [
        { role: 'user', content: 'new root' },
        { role: 'assistant', content: 'new root reply' },
      ],
      title: 'Maintenance watermark',
      gitRoot,
      lineage: extended,
    });
    // archive/unarchive are serialized behind both queued maintenance runs.
    await storage.archive('maintenance-watermark');
    await storage.unarchive('maintenance-watermark');

    const { deriveProjectKeyFromRoot } = await import('./project-key.js');
    const sidecarPath = path.join(
      testSessionsDir(),
      deriveProjectKeyFromRoot(gitRoot).key,
      'maintenance-watermark.islands.jsonl',
    );
    const archivedIds = (await readFile(sidecarPath, 'utf8'))
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { _type?: string; entry?: { id?: string } })
      .filter((line) => line._type === 'archived_entry')
      .map((line) => line.entry?.id)
      .filter((id): id is string => typeof id === 'string');
    expect(new Set(archivedIds).size).toBe(archivedIds.length);
    expect((await storage.load('maintenance-watermark'))?.messages).toEqual([
      { role: 'user', content: 'new root' },
      { role: 'assistant', content: 'new root reply' },
    ]);
  });

  it('appendSessionDelta full-merges when caller provides updated extensionState', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const gitRoot = tempHome.replace(/\\/g, '/');

    await storage.save('session-extension-state-update', {
      messages: [{ role: 'user', content: 'test' }],
      title: 'Original Title',
      gitRoot,
      extensionState: { 'ext:sample': { visits: 1 } },
    });

    const loaded1 = await storage.load('session-extension-state-update');
    expect(loaded1?.extensionState).toEqual({ 'ext:sample': { visits: 1 } });

    const messages = [
      { role: 'user' as const, content: 'test' },
      { role: 'assistant' as const, content: 'reply' },
    ];
    await storage.appendSessionDelta('session-extension-state-update', {
      messages,
      title: 'Updated Title',
      gitRoot,
      lineage: createSessionLineage(messages, loaded1!.lineage),
      extensionState: { 'ext:sample': { visits: 2 } },
    });

    const loaded2 = await storage.load('session-extension-state-update');
    expect(loaded2?.title).toBe('Updated Title');
    expect(loaded2?.extensionState).toEqual({ 'ext:sample': { visits: 2 } });
  });

  it('appendSessionDelta full-merges when caller clears extensionRecords', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const gitRoot = tempHome.replace(/\\/g, '/');
    const initialMessages = [{ role: 'user' as const, content: 'test' }];

    await storage.save('session-extension-records-clear', {
      messages: initialMessages,
      title: 'Original Title',
      gitRoot,
      lineage: createSessionLineage(initialMessages),
      extensionRecords: [
        {
          id: 'record-1',
          extensionId: 'ext:sample',
          type: 'turn',
          ts: 1,
        },
      ],
    });

    const loaded1 = await storage.load('session-extension-records-clear');
    expect(loaded1?.extensionRecords).toHaveLength(1);

    const messages = [
      ...initialMessages,
      { role: 'assistant' as const, content: 'reply' },
    ];
    await storage.appendSessionDelta('session-extension-records-clear', {
      messages,
      title: 'Updated Title',
      gitRoot,
      lineage: createSessionLineage(messages, loaded1!.lineage),
      extensionRecords: [],
    });

    const loaded2 = await storage.load('session-extension-records-clear');
    expect(loaded2?.title).toBe('Updated Title');
    expect(loaded2?.extensionRecords).toEqual([]);
  });

  it('appendSessionDelta fallback preserves runtimeInfo and errorMetadata', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
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

  it('clears errorMetadata when a full save explicitly supplies undefined', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const gitRoot = tempHome.replace(/\\/g, '/');
    const messages = [{ role: 'user' as const, content: 'request' }];

    await storage.save('session-error-clear', {
      messages,
      title: 'Error Clear',
      gitRoot,
      errorMetadata: {
        lastError: 'runtime run aborted',
        lastErrorTime: 1,
        consecutiveErrors: 1,
      },
    });
    await storage.save('session-error-clear', {
      messages,
      title: 'Successful Turn',
      gitRoot,
      errorMetadata: undefined,
    });

    expect((await storage.load('session-error-clear'))?.errorMetadata)
      .toBeUndefined();
  });

  it('preserves errorMetadata when a partial full save omits the field', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const gitRoot = tempHome.replace(/\\/g, '/');
    const messages = [{ role: 'user' as const, content: 'request' }];

    await storage.save('session-error-preserve', {
      messages,
      title: 'Error Preserve',
      gitRoot,
      errorMetadata: {
        lastError: 'runtime run aborted',
        lastErrorTime: 1,
        consecutiveErrors: 1,
      },
    });
    await storage.save('session-error-preserve', {
      messages,
      title: 'Partial Update',
      gitRoot,
    });

    expect((await storage.load('session-error-preserve'))?.errorMetadata)
      .toMatchObject({
        lastError: 'runtime run aborted',
        consecutiveErrors: 1,
      });
  });

  it('clears errorMetadata through appendSessionDelta when explicitly undefined', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const gitRoot = tempHome.replace(/\\/g, '/');
    const firstMessages = [{ role: 'user' as const, content: 'request' }];
    const firstLineage = createSessionLineage(firstMessages);

    await storage.save('session-error-append-clear', {
      messages: firstMessages,
      title: 'Append Error Clear',
      gitRoot,
      lineage: firstLineage,
      errorMetadata: {
        lastError: 'runtime run aborted',
        lastErrorTime: 1,
        consecutiveErrors: 1,
      },
    });
    const messages = [
      ...firstMessages,
      { role: 'assistant' as const, content: 'successful answer' },
    ];
    await storage.appendSessionDelta('session-error-append-clear', {
      messages,
      title: 'Append Error Clear',
      gitRoot,
      lineage: createSessionLineage(messages, firstLineage),
      errorMetadata: undefined,
    });

    expect((await storage.load('session-error-append-clear'))?.errorMetadata)
      .toBeUndefined();
  });

  it('preserves errorMetadata through appendSessionDelta when omitted', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const gitRoot = tempHome.replace(/\\/g, '/');
    const firstMessages = [{ role: 'user' as const, content: 'request' }];
    const firstLineage = createSessionLineage(firstMessages);

    await storage.save('session-error-append-preserve', {
      messages: firstMessages,
      title: 'Append Error Preserve',
      gitRoot,
      lineage: firstLineage,
      errorMetadata: {
        lastError: 'runtime run aborted',
        lastErrorTime: 1,
        consecutiveErrors: 1,
      },
    });
    const messages = [
      ...firstMessages,
      { role: 'assistant' as const, content: 'partial host update' },
    ];
    await storage.appendSessionDelta('session-error-append-preserve', {
      messages,
      title: 'Append Error Preserve',
      gitRoot,
      lineage: createSessionLineage(messages, firstLineage),
    });

    expect((await storage.load('session-error-append-preserve'))?.errorMetadata)
      .toMatchObject({
        lastError: 'runtime run aborted',
        consecutiveErrors: 1,
      });
  });

  it('appendSessionDelta fallback persists session tag into the initial meta line', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const { deriveProjectKeyFromRoot } = await import('./project-key.js');
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const gitRoot = tempHome.replace(/\\/g, '/');

    await storage.appendSessionDelta('session-host-tag', {
      messages: [{ role: 'user', content: 'partner request' }],
      title: 'Host Owned Partner',
      gitRoot,
      scope: 'user',
      tag: 'partner',
    });

    const loaded = await storage.load('session-host-tag');
    expect(loaded?.tag).toBe('partner');

    const sessionPath = path.join(
      tempHome,
      '.kodax',
      'sessions',
      deriveProjectKeyFromRoot(gitRoot).key,
      'session-host-tag.jsonl',
    );
    const firstLine = (await readFile(sessionPath, 'utf-8')).split('\n')[0]!;
    expect(JSON.parse(firstLine).tag).toBe('partner');
  });

  it('appendSessionDelta hot path preserves an existing tag when the partial payload omits it', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const gitRoot = tempHome.replace(/\\/g, '/');

    const lineage1 = createSessionLineage([
      { role: 'user', content: 'hello' },
    ]);
    await storage.save('session-tag-preserve', {
      messages: [{ role: 'user', content: 'hello' }],
      title: 'Tagged Session',
      gitRoot,
      scope: 'user',
      lineage: lineage1,
      tag: 'partner',
    });

    const loaded1 = await storage.load('session-tag-preserve');
    const lineage2 = createSessionLineage([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'reply' },
    ], loaded1!.lineage);

    await storage.appendSessionDelta('session-tag-preserve', {
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'reply' },
      ],
      title: 'Tagged Session Updated',
      gitRoot,
      lineage: lineage2,
    });

    const loaded2 = await storage.load('session-tag-preserve');
    expect(loaded2?.title).toBe('Tagged Session Updated');
    expect(loaded2?.tag).toBe('partner');
  });

  it('appendSessionDelta makes a newly provided tag visible to list by rewriting the initial meta line', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const { deriveProjectKeyFromRoot } = await import('./project-key.js');
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const gitRoot = tempHome.replace(/\\/g, '/');

    const lineage1 = createSessionLineage([
      { role: 'user', content: 'hello' },
    ]);
    await storage.save('session-tag-late', {
      messages: [{ role: 'user', content: 'hello' }],
      title: 'Late Tag Session',
      gitRoot,
      scope: 'user',
      lineage: lineage1,
    });

    const loaded1 = await storage.load('session-tag-late');
    const lineage2 = createSessionLineage([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'reply' },
    ], loaded1!.lineage);
    await storage.appendSessionDelta('session-tag-late', {
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'reply' },
      ],
      title: 'Late Tag Session Updated',
      gitRoot,
      lineage: lineage2,
      tag: 'partner',
    });

    const sessionPath = path.join(
      tempHome,
      '.kodax',
      'sessions',
      deriveProjectKeyFromRoot(gitRoot).key,
      'session-tag-late.jsonl',
    );
    const firstLine = (await readFile(sessionPath, 'utf-8')).split('\n')[0]!;
    const listed = await storage.list(gitRoot, { limit: 10 });

    expect(JSON.parse(firstLine).tag).toBe('partner');
    expect(listed.find((session) => session.id === 'session-tag-late')?.tag).toBe('partner');
  });

  it('mixed path: append → rewind (cold save) → append → load consistent', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
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

  // ── FEATURE_219: per-project layout + id-only locator ──

  it('FEATURE_219: writes sessions under a per-project directory (not flat) + project.json', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const { deriveProjectKeyFromRoot } = await import('./project-key.js');
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const gitRoot = path.resolve(KODAX_REPO_ROOT).replace(/\\/g, '/');

    await storage.save('20260601_120000', {
      messages: [{ role: 'user', content: 'hi' }],
      title: 'In Project Dir',
      gitRoot,
      scope: 'user',
    });

    const projectDir = path.join(
      tempHome, '.kodax', 'sessions', deriveProjectKeyFromRoot(gitRoot).key,
    );
    expect(existsSync(path.join(projectDir, '20260601_120000.jsonl'))).toBe(true);
    expect(existsSync(path.join(projectDir, 'project.json'))).toBe(true);
    // The legacy flat path must NOT be used.
    expect(existsSync(path.join(tempHome, '.kodax', 'sessions', '20260601_120000.jsonl'))).toBe(false);
  });

  it('FEATURE_219: id-only locator resolves a project-dir session from a cold storage instance', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const gitRoot = path.resolve(KODAX_REPO_ROOT).replace(/\\/g, '/');

    await new FileSessionStorage({ sessionsDir: testSessionsDir() }).save('20260601_130000', {
      messages: [{ role: 'user', content: 'persisted' }],
      title: 'Cold Load',
      gitRoot,
      scope: 'user',
    });

    // Fresh instance → empty sessionDirCache → must locate by bounded scan.
    const cold = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const loaded = await cold.load('20260601_130000');
    expect(loaded?.title).toBe('Cold Load');
    expect(loaded?.messages[0]).toEqual({ role: 'user', content: 'persisted' });
  });

  it('FEATURE_219: load(id) still reads a legacy flat-pool session (compat)', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const sessionsDir = path.join(tempHome, '.kodax', 'sessions');
    const { mkdir } = await import('fs/promises');
    await mkdir(sessionsDir, { recursive: true });
    const meta = JSON.stringify({
      _type: 'meta',
      id: '20260101_999999',
      title: 'Legacy Flat',
      gitRoot: '/legacy/repo',
      createdAt: '2026-01-01T00:00:00.000Z',
      activeMessageCount: 1,
    });
    const msg = JSON.stringify({ role: 'user', content: 'old flat session' });
    await writeFile(path.join(sessionsDir, '20260101_999999.jsonl'), `${meta}\n${msg}\n`, 'utf8');

    const loaded = await new FileSessionStorage({ sessionsDir: testSessionsDir() }).load('20260101_999999');
    expect(loaded?.title).toBe('Legacy Flat');
  });

  it('FEATURE_219: saving a legacy flat session migrates it into the project dir + removes the flat copy', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const { deriveProjectKeyFromRoot } = await import('./project-key.js');
    const gitRoot = path.resolve(KODAX_REPO_ROOT).replace(/\\/g, '/');
    const sessionsDir = path.join(tempHome, '.kodax', 'sessions');
    const { mkdir } = await import('fs/promises');
    await mkdir(sessionsDir, { recursive: true });
    const flatPath = path.join(sessionsDir, '20260101_888888.jsonl');
    const meta = JSON.stringify({
      _type: 'meta', id: '20260101_888888', title: 'Pre-migration', gitRoot, activeMessageCount: 1,
    });
    await writeFile(flatPath, `${meta}\n${JSON.stringify({ role: 'user', content: 'x' })}\n`, 'utf8');

    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const loaded = await storage.load('20260101_888888');
    await storage.save('20260101_888888', { ...loaded!, title: 'Migrated', gitRoot });

    const projectPath = path.join(
      sessionsDir, deriveProjectKeyFromRoot(gitRoot).key, '20260101_888888.jsonl',
    );
    expect(existsSync(projectPath)).toBe(true);
    expect(existsSync(flatPath)).toBe(false); // flat copy superseded
    expect((await storage.load('20260101_888888'))?.title).toBe('Migrated');
  });

  it('FEATURE_219: first list() auto-migrates the flat pool into per-project dirs + stamps marker', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const { deriveProjectKeyFromRoot } = await import('./project-key.js');
    const gitRoot = path.resolve(KODAX_REPO_ROOT).replace(/\\/g, '/');
    const sessionsDir = path.join(tempHome, '.kodax', 'sessions');
    const { mkdir } = await import('fs/promises');
    await mkdir(sessionsDir, { recursive: true });
    // Seed two legacy flat sessions directly.
    for (const id of ['20260701_000000', '20260701_000001']) {
      const meta = JSON.stringify({ _type: 'meta', id, title: id, gitRoot, activeMessageCount: 1 });
      await writeFile(path.join(sessionsDir, `${id}.jsonl`), `${meta}\n${JSON.stringify({ role: 'user', content: 'x' })}\n`, 'utf8');
    }

    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const listed = await storage.list(gitRoot); // first entry point → triggers migration

    const projectDir = path.join(sessionsDir, deriveProjectKeyFromRoot(gitRoot).key);
    expect(existsSync(path.join(sessionsDir, '.layout.json'))).toBe(true);
    expect(existsSync(path.join(projectDir, '20260701_000000.jsonl'))).toBe(true);
    expect(existsSync(path.join(sessionsDir, '20260701_000000.jsonl'))).toBe(false); // moved out of flat
    expect(listed.map((s) => s.id).sort()).toEqual(['20260701_000000', '20260701_000001']);
  });

  it('FEATURE_219: archive() hides a session from the default list; includeArchived + unarchive restore it', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const { deriveProjectKeyFromRoot } = await import('./project-key.js');
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const gitRoot = path.resolve(KODAX_REPO_ROOT).replace(/\\/g, '/');

    await storage.save('20260801_000000', {
      messages: [
        { role: 'user', content: 'to archive' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'call_archived', name: 'test', input: {} },
          ],
        },
      ],
      title: 'Archive Me',
      gitRoot,
      scope: 'user',
      errorMetadata: {
        lastError: 'interrupted',
        lastErrorTime: 1,
        consecutiveErrors: 1,
      },
    });

    expect(await storage.archive('20260801_000000')).toBe(true);

    const projectDir = path.join(
      tempHome, '.kodax', 'sessions', deriveProjectKeyFromRoot(gitRoot).key,
    );
    expect(existsSync(path.join(projectDir, 'archived', '20260801_000000.jsonl'))).toBe(true);
    expect(existsSync(path.join(projectDir, '20260801_000000.jsonl'))).toBe(false);

    // Hidden from default list, visible with includeArchived, still loadable by id.
    expect((await storage.list(gitRoot)).map((s) => s.id)).not.toContain('20260801_000000');
    const withArchived = await storage.list(gitRoot, { includeArchived: true });
    const archivedEntry = withArchived.find((s) => s.id === '20260801_000000');
    expect(archivedEntry?.archived).toBe(true);
    const recoveredArchived = await storage.load('20260801_000000');
    expect(recoveredArchived).toMatchObject({
      title: 'Archive Me',
      messages: [{ role: 'user', content: 'to archive' }],
      errorMetadata: { consecutiveErrors: 0 },
    });
    if (!recoveredArchived) throw new Error('Expected archived recovery data.');
    await storage.save('20260801_000000', {
      ...recoveredArchived,
      title: 'Archive Me In Place',
    });
    expect(existsSync(path.join(projectDir, 'archived', '20260801_000000.jsonl'))).toBe(true);
    expect(existsSync(path.join(projectDir, '20260801_000000.jsonl'))).toBe(false);
    expect((await storage.load('20260801_000000'))?.title).toBe('Archive Me In Place');

    // Unarchive restores it to the default list.
    expect(await storage.unarchive('20260801_000000')).toBe(true);
    expect(existsSync(path.join(projectDir, '20260801_000000.jsonl'))).toBe(true);
    expect((await storage.list(gitRoot)).map((s) => s.id)).toContain('20260801_000000');
  });

  it('keeps raw lineage mutators on the exact archived Session path', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const { deriveProjectKeyFromRoot } = await import('./project-key.js');
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const gitRoot = path.resolve(KODAX_REPO_ROOT).replace(/\\/g, '/');
    const sessionId = 'archived-lineage-mutators';
    const messages = [
      { role: 'user' as const, content: 'first question' },
      { role: 'assistant' as const, content: 'first answer' },
      { role: 'user' as const, content: 'second question' },
      { role: 'assistant' as const, content: 'second answer' },
    ];
    const lineage = createSessionLineage(messages);
    const messageEntries = lineage.entries.filter((entry) => entry.type === 'message');
    const firstId = messageEntries[0]?.id;
    const lastId = messageEntries.at(-1)?.id;
    if (!firstId || !lastId) throw new Error('expected lineage selectors');
    await storage.save(sessionId, {
      messages,
      title: 'Archived lineage mutators',
      gitRoot,
      lineage,
    });
    await storage.archive(sessionId);
    const projectDir = path.join(
      testSessionsDir(),
      deriveProjectKeyFromRoot(gitRoot).key,
    );
    const activePath = path.join(projectDir, `${sessionId}.jsonl`);
    const archivedPath = path.join(projectDir, 'archived', `${sessionId}.jsonl`);

    await expect(storage.setLabel(sessionId, lastId, 'archived-label'))
      .resolves.not.toBeNull();
    await expect(storage.setActiveEntry(sessionId, firstId)).resolves.not.toBeNull();
    await expect(storage.setActiveEntry(sessionId, lastId)).resolves.not.toBeNull();
    await expect(storage.rewind(sessionId, firstId)).resolves.not.toBeNull();

    expect(existsSync(activePath)).toBe(false);
    expect(existsSync(archivedPath)).toBe(true);
  });

  it('rolls the main Session file back when its sidecar cannot be archived', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const { deriveProjectKeyFromRoot } = await import('./project-key.js');
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const gitRoot = path.resolve(KODAX_REPO_ROOT).replace(/\\/g, '/');
    const sessionId = 'archive-sidecar-rollback';
    await storage.save(sessionId, {
      messages: [{ role: 'user', content: 'archive atomically' }],
      title: 'Archive Rollback',
      gitRoot,
      scope: 'user',
    });
    const projectDir = path.join(
      testSessionsDir(),
      deriveProjectKeyFromRoot(gitRoot).key,
    );
    const mainPath = path.join(projectDir, `${sessionId}.jsonl`);
    const sidecarPath = path.join(projectDir, `${sessionId}.islands.jsonl`);
    const archivedDir = path.join(projectDir, 'archived');
    await writeFile(sidecarPath, '{"_type":"archive_meta"}\n', 'utf-8');
    const renameOriginal = fsPromises.rename.bind(fsPromises);
    const rename = vi.spyOn(fsPromises, 'rename').mockImplementation(
      async (from, to) => {
        if (
          path.resolve(String(from)) === path.resolve(sidecarPath)
          && path.dirname(path.resolve(String(to))) === path.resolve(archivedDir)
        ) {
          throw Object.assign(new Error('sidecar move denied'), { code: 'EACCES' });
        }
        await renameOriginal(from, to);
      },
    );

    try {
      await expect(storage.archive(sessionId)).rejects.toMatchObject({
        code: 'EACCES',
      });
    } finally {
      rename.mockRestore();
    }

    expect(existsSync(mainPath)).toBe(true);
    expect(existsSync(sidecarPath)).toBe(true);
    expect(existsSync(path.join(archivedDir, `${sessionId}.jsonl`))).toBe(false);
    expect(existsSync(path.join(archivedDir, `${sessionId}.islands.jsonl`))).toBe(false);
  });

  it.each([
    ['archive', 'islands'],
    ['archive', 'archive'],
    ['unarchive', 'islands'],
    ['unarchive', 'archive'],
  ] as const)('fails closed for an orphaned %s destination %s sidecar', async (
    operation,
    sidecarKind,
  ) => {
    const { FileSessionStorage } = await import('./storage.js');
    const { deriveProjectKeyFromRoot } = await import('./project-key.js');
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const gitRoot = path.resolve(KODAX_REPO_ROOT).replace(/\\/g, '/');
    const sessionId = `${operation}-${sidecarKind}-destination-collision`;
    await storage.save(sessionId, {
      messages: [{ role: 'user', content: 'preserve both sides' }],
      title: 'Archive destination collision',
      gitRoot,
      lineage: createSessionLineage([{ role: 'user', content: 'preserve both sides' }]),
    });
    const projectDir = path.join(
      testSessionsDir(),
      deriveProjectKeyFromRoot(gitRoot).key,
    );
    const archivedDir = path.join(projectDir, 'archived');
    if (operation === 'unarchive') {
      expect(await storage.archive(sessionId)).toBe(true);
    }
    const sourceDir = operation === 'archive' ? projectDir : archivedDir;
    const destinationDir = operation === 'archive' ? archivedDir : projectDir;
    const destinationSidecar = path.join(
      destinationDir,
      `${sessionId}.${sidecarKind}.jsonl`,
    );
    const destinationBytes = 'orphaned destination history\n';
    await mkdir(destinationDir, { recursive: true });
    await writeFile(destinationSidecar, destinationBytes, 'utf8');
    const fileSet = [sourceDir, destinationDir].flatMap((dir) => [
      path.join(dir, `${sessionId}.jsonl`),
      path.join(dir, `${sessionId}.islands.jsonl`),
      path.join(dir, `${sessionId}.archive.jsonl`),
    ]);
    const snapshot = async (): Promise<Record<string, string | null>> =>
      Object.fromEntries(await Promise.all(fileSet.map(async (filePath) => [
        filePath,
        existsSync(filePath) ? await readFile(filePath, 'utf8') : null,
      ] as const)));
    const before = await snapshot();

    await expect(storage[operation](sessionId)).rejects.toThrow(
      'Refusing to overwrite existing Session archive file',
    );

    expect(await snapshot()).toEqual(before);
    expect(before[path.join(sourceDir, `${sessionId}.jsonl`)]).not.toBeNull();
    expect(before[path.join(sourceDir, `${sessionId}.${sidecarKind}.jsonl`)]).toBeNull();
    expect(before[destinationSidecar]).toBe(destinationBytes);
  });

  it('surfaces both the move and rollback errors when paired archive recovery fails', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const { deriveProjectKeyFromRoot } = await import('./project-key.js');
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const gitRoot = path.resolve(KODAX_REPO_ROOT).replace(/\\/g, '/');
    const sessionId = 'archive-incomplete-rollback';
    await storage.save(sessionId, {
      messages: [{ role: 'user', content: 'report incomplete rollback' }],
      title: 'Archive Incomplete Rollback',
      gitRoot,
      scope: 'user',
    });
    const projectDir = path.join(
      testSessionsDir(),
      deriveProjectKeyFromRoot(gitRoot).key,
    );
    const mainPath = path.join(projectDir, `${sessionId}.jsonl`);
    const sidecarPath = path.join(projectDir, `${sessionId}.islands.jsonl`);
    const archivedDir = path.join(projectDir, 'archived');
    const archivedMainPath = path.join(archivedDir, `${sessionId}.jsonl`);
    await writeFile(sidecarPath, '{"_type":"archive_meta"}\n', 'utf-8');
    const renameOriginal = fsPromises.rename.bind(fsPromises);
    const rename = vi.spyOn(fsPromises, 'rename').mockImplementation(
      async (from, to) => {
        const resolvedFrom = path.resolve(String(from));
        const resolvedTo = path.resolve(String(to));
        if (
          resolvedFrom === path.resolve(sidecarPath)
          && path.dirname(resolvedTo) === path.resolve(archivedDir)
        ) {
          throw Object.assign(new Error('sidecar move denied'), { code: 'EACCES' });
        }
        if (
          resolvedFrom === path.resolve(archivedMainPath)
          && resolvedTo === path.resolve(mainPath)
        ) {
          throw Object.assign(new Error('main rollback denied'), { code: 'EPERM' });
        }
        await renameOriginal(from, to);
      },
    );

    let failure: unknown;
    try {
      await storage.archive(sessionId);
    } catch (error: unknown) {
      failure = error;
    } finally {
      rename.mockRestore();
    }

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toHaveLength(2);
    expect(existsSync(archivedMainPath)).toBe(true);
    expect(existsSync(sidecarPath)).toBe(true);
  });

  it('keeps the authoritative Session snapshot when strict deletion fails', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const { deriveProjectKeyFromRoot } = await import('./project-key.js');
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const gitRoot = path.resolve(KODAX_REPO_ROOT).replace(/\\/g, '/');
    const sessionId = 'delete-failure-owner-retry';
    await storage.save(sessionId, {
      messages: [{ role: 'user', content: 'retain on failure' }],
      title: 'Delete Failure',
      gitRoot,
      scope: 'user',
    });
    const projectDir = path.join(
      testSessionsDir(),
      deriveProjectKeyFromRoot(gitRoot).key,
    );
    const mainPath = path.join(projectDir, `${sessionId}.jsonl`);
    const sidecarPath = path.join(projectDir, `${sessionId}.islands.jsonl`);
    await writeFile(sidecarPath, '{"_type":"archive_meta"}\n', 'utf-8');
    const renameOriginal = fsPromises.rename;
    const rename = vi.spyOn(fsPromises, 'rename').mockImplementation(
      async (source, target) => {
        if (path.resolve(String(source)) === path.resolve(mainPath)) {
          throw Object.assign(new Error('delete denied'), { code: 'EACCES' });
        }
        return renameOriginal(source, target);
      },
    );

    try {
      await expect(storage.delete(sessionId)).rejects.toMatchObject({
        code: 'EACCES',
      });
    } finally {
      rename.mockRestore();
    }

    expect(existsSync(mainPath)).toBe(true);
    expect(existsSync(sidecarPath)).toBe(true);
    await expect(storage.load(sessionId)).resolves.toMatchObject({
      title: 'Delete Failure',
    });
  });
});
