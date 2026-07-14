/**
 * FEATURE_173 Part B — Session Management Public SDK contract tests.
 *
 * 12 contract tests covering the public API surface.
 *
 * Session directory isolation: each test overrides HOME/USERPROFILE to a
 * fresh mkdtemp directory so KODAX_SESSIONS_DIR (frozen at module-load time)
 * points to a per-test temp dir. vi.resetModules() + dynamic imports are
 * required.
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Helpers —————————————————————————————————————————————————————————————————————

interface SessionApiModule {
  listSessions: (opts?: import('./public-api.js').ListSessionsOptions) => Promise<import('./public-api.js').SessionSummary[]>;
  loadSession: (id: string) => Promise<import('./public-api.js').SessionSummary | null>;
  loadFullTranscript: (id: string) => Promise<import('./public-api.js').FullTranscriptSessionData | null>;
  appendClientNotice: (
    id: string,
    opts: import('./public-api.js').AppendClientNoticeOptions,
  ) => Promise<import('./public-api.js').SessionTranscriptEntry | null>;
  forkSession: (id: string, opts?: { selector?: string; sessionId?: string; title?: string }) => Promise<{ sessionId: string; data: unknown } | null>;
  rewindSession: (id: string, opts?: { selector?: string }) => Promise<unknown | null>;
  setActiveEntry: (id: string, selector: string) => Promise<unknown | null>;
  deleteSession: (id: string) => Promise<{ ok: true } | { error: { code: string } }>;
  listRunningSessions: () => Promise<Array<{ pid: number; startedAt: number; cwd: string; sessionId: string | undefined }>>;
  watchSessions: (cb: (e: { kind: string; sessionId: string }) => void) => { close: () => void };
  createSessionManager: (opts?: { sessionsDir?: string }) => unknown;
}

/** Write a minimal valid JSONL session file (just a meta line). */
async function writeMinimalSession(
  sessionsDir: string,
  id: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  await mkdir(sessionsDir, { recursive: true });
  const meta = {
    _type: 'meta',
    id,
    title: overrides.title ?? `Title for ${id}`,
    gitRoot: '/tmp/test-repo',
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    scope: overrides.scope ?? 'user',
    activeMessageCount: overrides.activeMessageCount ?? 2,
    ...overrides,
  };
  await writeFile(
    path.join(sessionsDir, `${id}.jsonl`),
    JSON.stringify(meta) + '\n',
    'utf-8',
  );
}

// Test state ───────────────────────────────────────────────────────────────────

describe('Session Management Public SDK', () => {
  // Each test re-imports the whole public-api module graph after
  // `vi.resetModules()` (required so the module-load-time-frozen
  // KODAX_SESSIONS_DIR picks up the per-test HOME override — see header). That
  // cold import runs ~4s alone and slows further under full-suite (160+ file)
  // CPU contention, straddling vitest's default 5s test / 10s hook timeout and
  // surfacing as an intermittent timeout. Give the cold import ample headroom
  // so a slow-but-correct re-import can't flake; a genuinely hung test still
  // fails (just later).
  vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

  let tempHome: string;
  let sessionsDir: string;
  let previousHome: string | undefined;
  let previousUserProfile: string | undefined;
  let api: SessionApiModule;

  beforeEach(async () => {
    tempHome = await mkdtemp(path.join(os.tmpdir(), 'kodax-session-sdk-'));
    sessionsDir = path.join(tempHome, '.kodax', 'sessions');
    previousHome = process.env.HOME;
    previousUserProfile = process.env.USERPROFILE;
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;

    // Mock workspace-runtime to avoid git calls.
    vi.resetModules();
    vi.doMock('../interactive/workspace-runtime.js', async () => {
      const actual = await vi.importActual<typeof import('../interactive/workspace-runtime.js')>(
        '../interactive/workspace-runtime.js',
      );
      return {
        ...actual,
        inspectWorkspaceRuntime: vi.fn(async () => ({
          canonicalRepoRoot: '/tmp/test-repo',
          workspaceRoot: '/tmp/test-repo',
          executionCwd: '/tmp/test-repo',
          branch: 'main',
          workspaceKind: 'detected',
        })),
        isSameCanonicalRepo: vi.fn(() => true),
      };
    });

    api = await import('./public-api.js') as unknown as SessionApiModule;
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

  // ── Test 1: listSessions returns SessionSummary shape ────────────────────
  it('listSessions returns SessionSummary with id, title, msgCount fields', async () => {
    await writeMinimalSession(sessionsDir, 'sess-001', {
      title: 'My Test Session',
      activeMessageCount: 5,
    });

    const results = await api.listSessions({ scope: 'all' });
    expect(results.length).toBeGreaterThanOrEqual(1);
    const found = results.find((s) => s.id === 'sess-001');
    expect(found).toBeDefined();
    expect(found?.id).toBe('sess-001');
    expect(found?.title).toBe('My Test Session');
    expect(typeof found?.msgCount).toBe('number');
  });

  // ── Test 2: listSessions honors limit ────────────────────────────────────
  it('listSessions honors the limit option', async () => {
    for (let i = 0; i < 5; i++) {
      await writeMinimalSession(sessionsDir, `sess-limit-${i}`);
    }

    const results = await api.listSessions({ scope: 'all', limit: 3 });
    expect(results.length).toBeLessThanOrEqual(3);
  });

  // ── Test 3: listSessions honors scope=all ────────────────────────────────
  it('listSessions with scope=all returns worker sessions too', async () => {
    await writeMinimalSession(sessionsDir, 'user-sess', { scope: 'user' });
    await writeMinimalSession(sessionsDir, 'worker-sess', { scope: 'managed-task-worker' });

    const userOnly = await api.listSessions({ scope: 'user' });
    const all = await api.listSessions({ scope: 'all' });

    expect(all.length).toBeGreaterThanOrEqual(userOnly.length);
    const workerFound = all.find((s) => s.id === 'worker-sess');
    expect(workerFound).toBeDefined();
  });

  it('listSessions default fast path returns SessionSummary.tag', async () => {
    await writeMinimalSession(sessionsDir, 'partner-fast-summary', {
      title: 'Partner Fast Summary',
      tag: 'partner',
      activeMessageCount: 1,
    });

    const results = await api.listSessions({ limit: 10 });
    const found = results.find((s) => s.id === 'partner-fast-summary');

    expect(found).toBeDefined();
    expect(found?.tag).toBe('partner');
  });

  it('listSessions({ tag }) filters by exact tag before limit and excludes untagged sessions', async () => {
    await writeMinimalSession(sessionsDir, 'partner-newer', {
      title: 'Partner Newer',
      tag: 'partner',
      createdAt: '2026-06-03T12:00:00.000Z',
      activeMessageCount: 1,
    });
    await writeMinimalSession(sessionsDir, 'coder-middle', {
      title: 'Coder Middle',
      tag: 'coder',
      createdAt: '2026-06-03T11:00:00.000Z',
      activeMessageCount: 1,
    });
    await writeMinimalSession(sessionsDir, 'legacy-untagged', {
      title: 'Legacy Untagged',
      createdAt: '2026-06-03T10:00:00.000Z',
      activeMessageCount: 1,
    });

    const partner = await api.listSessions({ tag: 'partner', limit: 1 });
    const coder = await api.listSessions({ tag: 'coder', limit: 10 });
    const all = await api.listSessions({ limit: 10 });

    expect(partner.map((s) => s.id)).toEqual(['partner-newer']);
    expect(partner[0]?.tag).toBe('partner');
    expect(coder.map((s) => s.id)).toEqual(['coder-middle']);
    expect(all.map((s) => s.id)).toEqual(
      expect.arrayContaining(['partner-newer', 'coder-middle', 'legacy-untagged']),
    );
  });

  it('listSessions({ tag: "" }) treats empty string as an exact tag filter', async () => {
    await writeMinimalSession(sessionsDir, 'empty-tag-session', {
      title: 'Empty Tag',
      tag: '',
      createdAt: '2026-06-03T12:00:00.000Z',
      activeMessageCount: 1,
    });
    await writeMinimalSession(sessionsDir, 'untagged-session', {
      title: 'Untagged',
      createdAt: '2026-06-03T11:00:00.000Z',
      activeMessageCount: 1,
    });

    const emptyTagged = await api.listSessions({ tag: '', limit: 10 });

    expect(emptyTagged.map((s) => s.id)).toEqual(['empty-tag-session']);
    expect(emptyTagged[0]?.tag).toBe('');
  });

  it('listSessions({ projectRoot, tag }) keeps the tag filter scoped to the requested project root', async () => {
    await writeMinimalSession(sessionsDir, 'project-a-partner', {
      title: 'Project A Partner',
      gitRoot: '/tmp/project-a',
      tag: 'partner',
      createdAt: '2026-06-03T12:00:00.000Z',
      activeMessageCount: 1,
    });
    await writeMinimalSession(sessionsDir, 'project-b-partner', {
      title: 'Project B Partner',
      gitRoot: '/tmp/project-b',
      tag: 'partner',
      createdAt: '2026-06-03T11:00:00.000Z',
      activeMessageCount: 1,
    });

    const results = await api.listSessions({
      projectRoot: '/tmp/project-a',
      tag: 'partner',
      limit: 10,
    });

    expect(results.map((s) => s.id)).toEqual(['project-a-partner']);
    expect(results[0]?.tag).toBe('partner');
  });

  it('listSessions({ surface }) filters before applying the page limit', async () => {
    await writeMinimalSession(sessionsDir, 'acp-newer', {
      createdAt: '2026-07-11T03:00:00.000Z',
      runtimeInfo: { surface: 'acp' },
    });
    await writeMinimalSession(sessionsDir, 'repl-middle', {
      createdAt: '2026-07-11T02:00:00.000Z',
      runtimeInfo: { surface: 'repl' },
    });
    await writeMinimalSession(sessionsDir, 'acp-older', {
      createdAt: '2026-07-11T01:00:00.000Z',
      runtimeInfo: { surface: 'acp' },
    });

    const results = await api.listSessions({ surface: 'acp', limit: 2 });

    expect(results.map((session) => session.id)).toEqual(['acp-newer', 'acp-older']);
  });

  it('listSessions returns opaque cursors that continue from the last item', async () => {
    for (let index = 4; index >= 1; index -= 1) {
      await writeMinimalSession(sessionsDir, `cursor-${index}`, {
        createdAt: `2026-07-11T0${index}:00:00.000Z`,
      });
    }

    const firstPage = await api.listSessions({ scope: 'all', limit: 2 });
    const cursor = firstPage.at(-1)?.cursor;
    expect(cursor).toEqual(expect.any(String));

    const secondPage = await api.listSessions({ scope: 'all', limit: 2, cursor });

    expect(firstPage.map((session) => session.id)).toEqual(['cursor-4', 'cursor-3']);
    expect(secondPage.map((session) => session.id)).toEqual(['cursor-2', 'cursor-1']);
  });

  it('project-scoped listing does not full-read modern session transcripts', async () => {
    await api.listSessions({ limit: 1 });
    const id = 'project-head-read-only';
    const sessionPath = path.join(sessionsDir, `${id}.jsonl`);
    const meta = {
      _type: 'meta',
      id,
      title: 'Head Read Only',
      gitRoot: '/tmp/test-repo',
      createdAt: '2026-07-14T03:00:00.000Z',
      scope: 'user',
      activeMessageCount: 1,
    };
    await writeFile(
      sessionPath,
      `${JSON.stringify(meta)}\n${JSON.stringify({ role: 'user', content: 'x'.repeat(256_000) })}\n`,
      'utf-8',
    );
    const readFileSpy = vi.spyOn(fs.promises, 'readFile');

    try {
      const results = await api.listSessions({
        projectRoot: '/tmp/test-repo',
        scope: 'user',
        limit: 100,
      });

      expect(results.map((session) => session.id)).toContain(id);
      expect(readFileSpy.mock.calls.some(([file]) => String(file).endsWith(`${id}.jsonl`)))
        .toBe(false);
    } finally {
      readFileSpy.mockRestore();
    }
  });

  // ── Test 4: loadSession returns null for missing id ───────────────────────
  it('loadSession returns null for a non-existent session id', async () => {
    const result = await api.loadSession('does-not-exist-xyz');
    expect(result).toBeNull();
  });

  // ── Test 5: forkSession returns null for missing id (NEVER throws) ────────
  it('forkSession returns null for a missing session without throwing', async () => {
    let threw = false;
    let result: { sessionId: string; data: unknown } | null = null;
    try {
      result = await api.forkSession('ghost-session-id');
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(result).toBeNull();
  });

  // ── Test 6: forkSession on real session returns new sessionId ────────────
  it('forkSession on a saved session returns a new sessionId', async () => {
    // Need a real session file with lineage data — use FileSessionStorage.
    vi.resetModules();
    vi.doMock('../interactive/workspace-runtime.js', async () => {
      const actual = await vi.importActual<typeof import('../interactive/workspace-runtime.js')>(
        '../interactive/workspace-runtime.js',
      );
      return {
        ...actual,
        inspectWorkspaceRuntime: vi.fn(async () => ({
          canonicalRepoRoot: '/tmp/test-repo',
          workspaceRoot: '/tmp/test-repo',
          executionCwd: '/tmp/test-repo',
          branch: 'main',
          workspaceKind: 'detected',
        })),
        isSameCanonicalRepo: vi.fn(() => true),
      };
    });
    const storage = await import('../interactive/storage.js');
    const pubApi = await import('./public-api.js') as unknown as SessionApiModule;

    const st = new storage.FileSessionStorage();
    await st.save('fork-source', {
      messages: [{ role: 'user' as const, content: 'hello' }],
      title: 'Fork Source',
      gitRoot: '/tmp/test-repo',
    });

    const forkResult = await pubApi.forkSession('fork-source', { title: 'Forked' });
    expect(forkResult).not.toBeNull();
    expect(typeof forkResult?.sessionId).toBe('string');
    expect(forkResult?.sessionId).not.toBe('fork-source');
    expect(forkResult?.data).toBeDefined();
  });

  it('forkSession on a tagged session preserves the tag on the forked session', async () => {
    vi.resetModules();
    vi.doMock('../interactive/workspace-runtime.js', async () => {
      const actual = await vi.importActual<typeof import('../interactive/workspace-runtime.js')>(
        '../interactive/workspace-runtime.js',
      );
      return {
        ...actual,
        inspectWorkspaceRuntime: vi.fn(async () => ({
          canonicalRepoRoot: '/tmp/test-repo',
          workspaceRoot: '/tmp/test-repo',
          executionCwd: '/tmp/test-repo',
          branch: 'main',
          workspaceKind: 'detected',
        })),
        isSameCanonicalRepo: vi.fn(() => true),
      };
    });
    const storage = await import('../interactive/storage.js');
    const pubApi = await import('./public-api.js') as unknown as SessionApiModule;

    const st = new storage.FileSessionStorage();
    await st.save('fork-tag-source', {
      messages: [{ role: 'user' as const, content: 'hello' }],
      title: 'Fork Tag Source',
      gitRoot: '/tmp/test-repo',
      tag: 'partner',
    });

    const forkResult = await pubApi.forkSession('fork-tag-source', {
      sessionId: 'fork-tag-copy',
      title: 'Forked Tag',
    });
    const loadedFork = await pubApi.loadSession('fork-tag-copy');

    expect((forkResult?.data as { tag?: string } | undefined)?.tag).toBe('partner');
    expect((loadedFork as { tag?: string } | null)?.tag).toBe('partner');
  });

  // FEATURE_247 (R5): a forked session inherits runtimeInfo (previously dropped),
  // so a forked Partner session stays a Partner (surface/profileId survive).
  it('forkSession inherits runtimeInfo profile identity on the forked session', async () => {
    vi.resetModules();
    vi.doMock('../interactive/workspace-runtime.js', async () => {
      const actual = await vi.importActual<typeof import('../interactive/workspace-runtime.js')>(
        '../interactive/workspace-runtime.js',
      );
      return {
        ...actual,
        inspectWorkspaceRuntime: vi.fn(async () => ({
          canonicalRepoRoot: '/tmp/test-repo',
          workspaceRoot: '/tmp/test-repo',
          executionCwd: '/tmp/test-repo',
          branch: 'main',
          workspaceKind: 'detected',
        })),
        isSameCanonicalRepo: vi.fn(() => true),
      };
    });
    const storage = await import('../interactive/storage.js');
    const pubApi = await import('./public-api.js') as unknown as SessionApiModule;

    const st = new storage.FileSessionStorage();
    await st.save('fork-ri-source', {
      messages: [{ role: 'user' as const, content: 'hello' }],
      title: 'Fork Runtime Source',
      gitRoot: '/tmp/test-repo',
      runtimeInfo: {
        workspaceRoot: '/tmp/test-repo',
        surface: 'partner',
        profileId: 'partner/acme-v1',
        profileVersion: '1.0.0',
        provider: 'anthropic',
      },
    });

    const forkResult = await pubApi.forkSession('fork-ri-source', {
      sessionId: 'fork-ri-copy',
      title: 'Forked Runtime',
    });
    const forkedRi = (forkResult?.data as { runtimeInfo?: Record<string, string> } | undefined)?.runtimeInfo;
    expect(forkedRi?.surface).toBe('partner');
    expect(forkedRi?.profileId).toBe('partner/acme-v1');
    expect(forkedRi?.profileVersion).toBe('1.0.0');
    expect(forkedRi?.provider).toBe('anthropic');
  });

  // ── Test 7: rewindSession returns null for missing id ────────────────────
  it('rewindSession returns null for a non-existent session id', async () => {
    const result = await api.rewindSession('ghost-session-id');
    expect(result).toBeNull();
  });

  it('rewindSession on a tagged session keeps the original tag', async () => {
    vi.resetModules();
    vi.doMock('../interactive/workspace-runtime.js', async () => {
      const actual = await vi.importActual<typeof import('../interactive/workspace-runtime.js')>(
        '../interactive/workspace-runtime.js',
      );
      return {
        ...actual,
        inspectWorkspaceRuntime: vi.fn(async () => ({
          canonicalRepoRoot: '/tmp/test-repo',
          workspaceRoot: '/tmp/test-repo',
          executionCwd: '/tmp/test-repo',
          branch: 'main',
          workspaceKind: 'detected',
        })),
        isSameCanonicalRepo: vi.fn(() => true),
      };
    });
    const storage = await import('../interactive/storage.js');
    const pubApi = await import('./public-api.js') as unknown as SessionApiModule;

    const st = new storage.FileSessionStorage();
    await st.save('rewind-tag-source', {
      messages: [
        { role: 'user' as const, content: 'first' },
        { role: 'assistant' as const, content: 'reply' },
        { role: 'user' as const, content: 'second' },
        { role: 'assistant' as const, content: 'reply 2' },
      ],
      title: 'Rewind Tag Source',
      gitRoot: '/tmp/test-repo',
      tag: 'partner',
    });

    const rewound = await pubApi.rewindSession('rewind-tag-source');
    const loaded = await pubApi.loadSession('rewind-tag-source');

    expect((rewound as { tag?: string } | null)?.tag).toBe('partner');
    expect((loaded as { tag?: string } | null)?.tag).toBe('partner');
  });

  // ── Test 8: deleteSession on missing id is no-op (no throw, ok:true) ─────
  it('deleteSession returns ok:true for a non-existent session', async () => {
    const result = await api.deleteSession('no-such-session');
    expect(result).toEqual({ ok: true });
  });

  // ── Test 9: listRunningSessions returns [] when no instances dir ──────────
  it('listRunningSessions returns [] when the instances directory is missing', async () => {
    // instances dir doesn't exist in our fresh tempHome.
    const result = await api.listRunningSessions();
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(0);
  });

  // ── Test 10: listRunningSessions skips own pid ────────────────────────────
  it('listRunningSessions does not include the current process pid', async () => {
    const result = await api.listRunningSessions();
    const selfPid = process.pid;
    expect(result.every((r) => r.pid !== selfPid)).toBe(true);
  });

  // ── Test 11: watchSessions fires callback on file create ─────────────────
  it(
    'watchSessions callback fires within the platform timeout when a session file is created',
    async () => {
      await mkdir(sessionsDir, { recursive: true });
      const events: Array<{ kind: string; sessionId: string }> = [];

      const handle = api.watchSessions((e) => events.push(e));

      try {
        // Allow watcher to initialize.
        await new Promise<void>((resolve) => setTimeout(resolve, 200));

        // Create a session file.
        await writeFile(
          path.join(sessionsDir, 'watch-test.jsonl'),
          JSON.stringify({ _type: 'meta', id: 'watch-test', title: 'W' }) + '\n',
        );

        // On Windows poll is 1000ms; POSIX is 100ms debounce.
        const waitMs = process.platform === 'win32' ? 1600 : 300;
        await new Promise<void>((resolve) => setTimeout(resolve, waitMs));

        expect(events.some((e) => e.sessionId === 'watch-test')).toBe(true);
      } finally {
        handle.close();
      }
    },
    // Generous timeout to cover Windows polling.
    process.platform === 'win32' ? 5000 : 2000,
  );

  // ── FEATURE_219: SDK slow path triggers auto-migration ──
  it('listSessions (slow path, scope=all) triggers auto-migration of the flat pool', async () => {
    await writeMinimalSession(sessionsDir, '20260901_000000');
    expect(fs.existsSync(path.join(sessionsDir, '.layout.json'))).toBe(false);

    const sessions = await api.listSessions({ scope: 'all' });

    expect(sessions.map((s) => s.id)).toContain('20260901_000000');
    // The slow path must have run the migration gate (not just the fast path).
    expect(fs.existsSync(path.join(sessionsDir, '.layout.json'))).toBe(true);
    // Flat file moved into a per-project dir.
    expect(fs.existsSync(path.join(sessionsDir, '20260901_000000.jsonl'))).toBe(false);
  });

  // ── Test 12: createSessionManager returns object with all methods + storage ───
  it('createSessionManager returns an object with all expected methods and a storage field', async () => {
    const manager = api.createSessionManager() as Record<string, unknown>;
    const expectedMethods = [
      'listSessions',
      'loadSession',
      'loadFullTranscript',
      'appendClientNotice',
      'forkSession',
      'rewindSession',
      'setActiveEntry',
      'deleteSession',
      'archiveSession', // FEATURE_219
      'unarchiveSession', // FEATURE_219
      'listRunningSessions',
      'watchSessions',
    ];
    for (const method of expectedMethods) {
      expect(typeof manager[method]).toBe('function');
    }
    // v0.7.43 — storage field exposes the underlying FileSessionStorage
    // so embedders can pass it through runKodaX({ session: { id, storage } }).
    expect(manager.storage).toBeDefined();
    expect(typeof (manager.storage as { save?: unknown }).save).toBe('function');
    expect(typeof (manager.storage as { load?: unknown }).load).toBe('function');
    // sessionId field in listRunningSessions result is allowed to be undefined.
    const sessions = await (manager.listRunningSessions as () => Promise<Array<{ sessionId: string | undefined }>>)();
    expect(Array.isArray(sessions)).toBe(true);
    if (sessions.length > 0) {
      // sessionId field must exist (may be undefined).
      expect('sessionId' in sessions[0]).toBe(true);
    }
  });

  // ── Test 13: v0.7.43 — createSessionManager({sessionsDir}) honors override ──
  it('createSessionManager({sessionsDir}) routes reads + writes through the override', async () => {
    // Two isolated directories — the override must NOT see entries from the
    // default sessions dir.
    const overrideDir = path.join(tempHome, 'isolated-sessions');
    await mkdir(overrideDir, { recursive: true });
    await writeMinimalSession(overrideDir, 'iso-001', { title: 'Isolated' });
    await writeMinimalSession(sessionsDir, 'default-001', { title: 'Default' });

    const overrideMgr = api.createSessionManager({ sessionsDir: overrideDir }) as {
      listSessions: (opts?: { scope?: string }) => Promise<Array<{ id: string }>>;
    };
    const defaultMgr = api.createSessionManager() as {
      listSessions: (opts?: { scope?: string }) => Promise<Array<{ id: string }>>;
    };

    const overrideList = await overrideMgr.listSessions({ scope: 'all' });
    const defaultList = await defaultMgr.listSessions({ scope: 'all' });

    expect(overrideList.map((s) => s.id)).toContain('iso-001');
    expect(overrideList.map((s) => s.id)).not.toContain('default-001');
    expect(defaultList.map((s) => s.id)).toContain('default-001');
    expect(defaultList.map((s) => s.id)).not.toContain('iso-001');
  });

  // ── Test 13b: v0.7.43 — manager.storage.save writes into the same dir reads see ──
  it('createSessionManager.storage routes writes into the manager-owned sessionsDir', async () => {
    const overrideDir = path.join(tempHome, 'storage-rw-test');
    await mkdir(overrideDir, { recursive: true });

    const mgr = api.createSessionManager({ sessionsDir: overrideDir }) as {
      storage: { save: (id: string, data: unknown) => Promise<void> };
      listSessions: (opts?: { scope?: string }) => Promise<Array<{ id: string }>>;
      loadSession: (id: string) => Promise<unknown>;
    };

    // Use the exposed storage to persist a minimal session — this is the
    // pattern SDK embedders use: pass `mgr.storage` into
    // runKodaX({ session: { id, storage } }).
    await mgr.storage.save('sdk-wired-001', {
      messages: [{ role: 'user', content: 'hello' }],
      title: 'SDK-wired',
      gitRoot: tempHome,
      scope: 'user',
    });

    // The same manager's read side must see what the write side wrote
    // — proves storage + list/load share one underlying FileSessionStorage
    // and one sessionsDir.
    const list = await mgr.listSessions({ scope: 'all' });
    expect(list.map((s) => s.id)).toContain('sdk-wired-001');

    const loaded = await mgr.loadSession('sdk-wired-001');
    expect(loaded).not.toBeNull();
  });

  // ── Test 14: v0.7.43 — listRunningSessions surfaces sessionId from heartbeat ──
  it('loadFullTranscript returns append-order entries across disconnected lineage roots', async () => {
    const overrideDir = path.join(tempHome, 'full-transcript-test');
    await mkdir(overrideDir, { recursive: true });

    const mgr = api.createSessionManager({ sessionsDir: overrideDir }) as {
      storage: { save: (id: string, data: unknown) => Promise<void> };
      loadSession: (id: string) => Promise<{ messages: Array<{ content: unknown }> } | null>;
      loadFullTranscript: (id: string) => Promise<{
        messages: Array<{ content: unknown }>;
        activeMessages: Array<{ content: unknown }>;
        transcriptEntries: Array<{ active: boolean; type: string }>;
      } | null>;
    };

    await mgr.storage.save('full-transcript-001', {
      messages: [
        { role: 'user', content: 'first prompt' },
        { role: 'assistant', content: 'first answer' },
      ],
      title: 'Full transcript',
      gitRoot: tempHome,
      scope: 'user',
    });
    await mgr.storage.save('full-transcript-001', {
      messages: [
        { role: 'system', content: '[对话历史摘要]\n\nsummary' },
        { role: 'user', content: 'second prompt' },
      ],
      title: 'Full transcript',
      gitRoot: tempHome,
      scope: 'user',
    });

    const active = await mgr.loadSession('full-transcript-001');
    const full = await mgr.loadFullTranscript('full-transcript-001');

    expect(active?.messages.map((message) => message.content)).toEqual([
      '[对话历史摘要]\n\nsummary',
      'second prompt',
    ]);
    expect(full?.activeMessages.map((message) => message.content)).toEqual([
      '[对话历史摘要]\n\nsummary',
      'second prompt',
    ]);
    expect(full?.messages.map((message) => message.content)).toEqual([
      'first prompt',
      'first answer',
      '[对话历史摘要]\n\nsummary',
      'second prompt',
    ]);
    expect(full?.transcriptEntries.map((entry) => entry.active)).toEqual([
      false,
      false,
      true,
      true,
    ]);
  });

  it('loadFullTranscript exposes logical provenance for forked transcript entries', async () => {
    const overrideDir = path.join(tempHome, 'full-transcript-provenance-test');
    await mkdir(overrideDir, { recursive: true });

    const mgr = api.createSessionManager({ sessionsDir: overrideDir }) as {
      storage: { save: (id: string, data: unknown) => Promise<void> };
      forkSession: (
        id: string,
        opts?: { selector?: string; sessionId?: string; title?: string },
      ) => Promise<{ sessionId: string; data: unknown } | null>;
      loadFullTranscript: (id: string) => Promise<{
        transcriptEntries: Array<{
          entryId: string;
          logicalId: string;
          sourceEntryId?: string;
          message: { content: unknown };
        }>;
      } | null>;
    };

    await mgr.storage.save('provenance-source-001', {
      messages: [
        { role: 'user', content: 'original prompt' },
        { role: 'assistant', content: 'original answer' },
      ],
      title: 'Provenance source',
      gitRoot: tempHome,
      scope: 'user',
    });

    const source = await mgr.loadFullTranscript('provenance-source-001');
    const forkResult = await mgr.forkSession('provenance-source-001', {
      sessionId: 'provenance-fork-001',
      title: 'Provenance fork',
    });
    const fork = await mgr.loadFullTranscript('provenance-fork-001');

    expect(forkResult?.sessionId).toBe('provenance-fork-001');
    expect(source).not.toBeNull();
    expect(fork).not.toBeNull();
    expect(source?.transcriptEntries.map((entry) => entry.message.content)).toEqual([
      'original prompt',
      'original answer',
    ]);
    expect(fork?.transcriptEntries.map((entry) => entry.message.content)).toEqual([
      'original prompt',
      'original answer',
    ]);
    expect(fork?.transcriptEntries).toHaveLength(source?.transcriptEntries.length ?? -1);

    for (let i = 0; i < (source?.transcriptEntries.length ?? 0); i++) {
      const sourceEntry = source!.transcriptEntries[i]!;
      const forkEntry = fork!.transcriptEntries[i]!;
      expect(sourceEntry.logicalId).toBe(sourceEntry.entryId);
      expect(sourceEntry.sourceEntryId).toBeUndefined();
      expect(forkEntry.entryId).not.toBe(sourceEntry.entryId);
      expect(forkEntry.logicalId).toBe(sourceEntry.logicalId);
      expect(forkEntry.sourceEntryId).toBe(sourceEntry.entryId);
    }
  });

  it('appendClientNotice persists a client-only transcript entry without entering model context', async () => {
    const overrideDir = path.join(tempHome, 'client-notice-transcript-test');
    await mkdir(overrideDir, { recursive: true });

    const mgr = api.createSessionManager({ sessionsDir: overrideDir }) as {
      storage: {
        save: (id: string, data: unknown) => Promise<void>;
        appendSessionDelta: (id: string, data: unknown) => Promise<void>;
      };
      appendClientNotice: (
        id: string,
        options: import('./public-api.js').AppendClientNoticeOptions,
      ) => Promise<import('./public-api.js').SessionTranscriptEntry | null>;
      loadSession: (id: string) => Promise<{ messages: Array<{ content: unknown }> } | null>;
      loadFullTranscript: (id: string) => Promise<{
        messages: Array<{ content: unknown }>;
        activeMessages: Array<{ content: unknown }>;
        transcriptEntries: Array<{
          type: string;
          source?: string;
          active: boolean;
          turnId?: string;
          payload?: unknown;
        }>;
      } | null>;
    };

    await mgr.storage.save('client-notice-001', {
      messages: [
        { role: 'user', content: 'real prompt' },
        { role: 'assistant', content: 'real answer' },
      ],
      title: 'Client notice transcript',
      gitRoot: tempHome,
      scope: 'user',
    });

    const appendSessionDelta = mgr.storage.appendSessionDelta.bind(mgr.storage);
    let appendDeltaCalls = 0;
    mgr.storage.appendSessionDelta = async (id, data) => {
      appendDeltaCalls += 1;
      await appendSessionDelta(id, data);
    };

    const notice = await mgr.appendClientNotice('client-notice-001', {
      source: 'space',
      content: '/doctor ok',
      timestamp: '2026-07-05T00:00:00.000Z',
      turnId: 'turn-local',
      payload: { command: '/doctor' },
    });
    const active = await mgr.loadSession('client-notice-001');
    const full = await mgr.loadFullTranscript('client-notice-001');

    expect(appendDeltaCalls).toBe(1);
    expect(notice).toEqual(expect.objectContaining({
      type: 'client_notice',
      source: 'client',
      turnId: 'turn-local',
      active: true,
      payload: {
        source: 'space',
        content: '/doctor ok',
        entersModelContext: false,
        payload: { command: '/doctor' },
      },
    }));
    expect(active?.messages.map((message) => message.content)).toEqual([
      'real prompt',
      'real answer',
    ]);
    expect(full?.activeMessages.map((message) => message.content)).toEqual([
      'real prompt',
      'real answer',
    ]);
    expect(full?.messages.map((message) => message.content)).toEqual([
      'real prompt',
      'real answer',
      '/doctor ok',
    ]);
    expect(full?.transcriptEntries.map((entry) => entry.type)).toEqual([
      'message',
      'message',
      'client_notice',
    ]);
    expect(full?.transcriptEntries[2]).toEqual(expect.objectContaining({
      active: true,
      payload: {
        source: 'space',
        content: '/doctor ok',
        entersModelContext: false,
        payload: { command: '/doctor' },
      },
    }));
  });

  it('rewindSession skips tool_result users and exposes a rewind_marker transcript entry', async () => {
    const overrideDir = path.join(tempHome, 'rewind-marker-transcript-test');
    await mkdir(overrideDir, { recursive: true });

    const mgr = api.createSessionManager({ sessionsDir: overrideDir }) as {
      storage: { save: (id: string, data: unknown) => Promise<void> };
      rewindSession: (id: string, opts?: { selector?: string }) => Promise<unknown | null>;
      loadSession: (id: string) => Promise<{
        messages: Array<{ content: unknown }>;
        lineage?: { activeEntryId: string | null };
      } | null>;
      loadFullTranscript: (id: string) => Promise<{
        messages: Array<{ content: unknown }>;
        transcriptEntries: Array<{
          entryId: string;
          type: string;
          source?: string;
          active: boolean;
          payload?: unknown;
          message: { content: unknown };
        }>;
      } | null>;
    };

    await mgr.storage.save('rewind-marker-001', {
      messages: [
        { role: 'user', content: 'first prompt' },
        { role: 'assistant', content: 'first answer' },
        { role: 'user', content: 'second prompt' },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tool_1', name: 'read', input: {} }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tool_1', content: 'ok' }],
        },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tool_2', name: 'read', input: {} }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tool_2', content: 'ok' }],
        },
        { role: 'assistant', content: 'second answer' },
      ],
      title: 'Rewind marker transcript',
      gitRoot: tempHome,
      scope: 'user',
    });

    const before = await mgr.loadFullTranscript('rewind-marker-001');
    const firstEntryId = before?.transcriptEntries[0]?.entryId;
    if (!firstEntryId) {
      throw new Error('expected first transcript entry id');
    }

    const rewound = await mgr.rewindSession('rewind-marker-001');
    const active = await mgr.loadSession('rewind-marker-001');
    const full = await mgr.loadFullTranscript('rewind-marker-001');

    expect(rewound).not.toBeNull();
    expect(active?.lineage?.activeEntryId).toBe(firstEntryId);
    expect(active?.messages.map((message) => message.content)).toEqual(['first prompt']);
    expect(full?.messages.map((message) => message.content)).toEqual(['first prompt']);
    expect(full?.transcriptEntries.map((entry) => entry.type)).toEqual([
      'message',
      'rewind_marker',
    ]);
    expect(full?.transcriptEntries[1]).toEqual(expect.objectContaining({
      type: 'rewind_marker',
      source: 'system',
      active: true,
      payload: expect.objectContaining({
        rewindTargetId: firstEntryId,
        truncatedCount: 7,
      }),
    }));
  });

  it('loadFullTranscript projects legacy rewind compactions as rewind_marker entries', async () => {
    const overrideDir = path.join(tempHome, 'legacy-rewind-marker-test');
    await mkdir(overrideDir, { recursive: true });

    const mgr = api.createSessionManager({ sessionsDir: overrideDir }) as {
      storage: { save: (id: string, data: unknown) => Promise<void> };
      loadFullTranscript: (id: string) => Promise<{
        messages: Array<{ content: unknown }>;
        activeMessages: Array<{ content: unknown }>;
        transcriptEntries: Array<{
          entryId: string;
          type: string;
          source?: string;
          active: boolean;
          payload?: unknown;
          message: { content: unknown };
        }>;
      } | null>;
    };
    const timestamp = '2026-07-07T01:00:00.000Z';
    const firstPrompt = {
      type: 'message',
      id: 'entry_legacy_user',
      parentId: null,
      logicalId: 'entry_legacy_user',
      timestamp,
      message: { role: 'user', content: 'legacy prompt' },
    };
    const firstAnswer = {
      type: 'message',
      id: 'entry_legacy_assistant',
      parentId: firstPrompt.id,
      logicalId: 'entry_legacy_assistant',
      timestamp,
      message: { role: 'assistant', content: 'legacy answer' },
    };
    const legacyRewindId = 'entry_legacy_rewind';

    await mgr.storage.save('legacy-rewind-001', {
      messages: [firstPrompt.message],
      title: 'Legacy rewind marker',
      gitRoot: tempHome,
      scope: 'user',
      lineage: {
        version: 2,
        activeEntryId: legacyRewindId,
        entries: [
          firstPrompt,
          firstAnswer,
          {
            type: 'compaction',
            id: legacyRewindId,
            parentId: firstPrompt.id,
            logicalId: legacyRewindId,
            timestamp,
            summary: '[Rewind] Rewound to entry entry_legacy_user (truncated 1 entries)',
            firstKeptEntryId: firstPrompt.id,
            tokensBefore: 100,
            tokensAfter: 25,
            reason: 'rewind',
            details: {
              rewindTargetId: firstPrompt.id,
              truncatedCount: 1,
            },
          },
        ],
      },
    });

    const full = await mgr.loadFullTranscript('legacy-rewind-001');

    expect(full?.messages.map((message) => message.content)).toEqual([
      'legacy prompt',
      'legacy answer',
    ]);
    expect(full?.activeMessages.map((message) => message.content)).toEqual(['legacy prompt']);
    expect(full?.transcriptEntries.map((entry) => entry.type)).toEqual([
      'message',
      'message',
      'rewind_marker',
    ]);
    expect(full?.transcriptEntries[1]?.active).toBe(false);
    expect(full?.transcriptEntries[2]).toEqual(expect.objectContaining({
      entryId: 'entry_legacy_rewind',
      type: 'rewind_marker',
      source: 'system',
      active: true,
      payload: expect.objectContaining({
        reason: 'rewind',
        rewindTargetId: firstPrompt.id,
        truncatedCount: 1,
      }),
    }));
  });

  it('loadFullTranscript surfaces typed task_result entries from persisted metadata', async () => {
    const overrideDir = path.join(tempHome, 'typed-transcript-test');
    await mkdir(overrideDir, { recursive: true });

    const mgr = api.createSessionManager({ sessionsDir: overrideDir }) as {
      storage: { save: (id: string, data: unknown) => Promise<void> };
      loadFullTranscript: (id: string) => Promise<{
        transcriptEntries: Array<{
          type: string;
          source?: string;
          timestamp: string;
          payload?: unknown;
          taskResults?: readonly import('@kodax-ai/agent').KodaXTaskResultMetadata[];
          active: boolean;
        }>;
      } | null>;
    };

    await mgr.storage.save('typed-transcript-001', {
      messages: [
        {
          role: 'user',
          content: '<task-completed task_id="run-1">\nWorkflow finished.\n</task-completed>',
          _synthetic: true,
          _source: 'task-completed',
          _taskResult: {
            type: 'task_result',
            source: 'workflow',
            taskId: 'run-1',
            runId: 'run-1',
            status: 'completed',
            title: 'Review workflow',
            summary: 'Workflow finished.',
          },
          turnId: 'turn-1',
          timestamp: '2026-07-04T01:00:00.000Z',
        },
      ],
      title: 'Typed transcript',
      gitRoot: tempHome,
      scope: 'user',
    });

    const full = await mgr.loadFullTranscript('typed-transcript-001');

    expect(full?.transcriptEntries).toEqual([
      expect.objectContaining({
        type: 'task_result',
        source: 'workflow',
        turnId: 'turn-1',
        timestamp: '2026-07-04T01:00:00.000Z',
        active: true,
        payload: {
          type: 'task_result',
          source: 'workflow',
          taskId: 'run-1',
          runId: 'run-1',
          status: 'completed',
          title: 'Review workflow',
          summary: 'Workflow finished.',
        },
        taskResults: [
          {
            type: 'task_result',
            source: 'workflow',
            taskId: 'run-1',
            runId: 'run-1',
            status: 'completed',
            title: 'Review workflow',
            summary: 'Workflow finished.',
          },
        ],
      }),
    ]);
  });

  it('loadFullTranscript recovers multiple legacy task_completed banners from one synthetic message', async () => {
    const overrideDir = path.join(tempHome, 'multi-banner-transcript-test');
    await mkdir(overrideDir, { recursive: true });

    const mgr = api.createSessionManager({ sessionsDir: overrideDir }) as {
      storage: { save: (id: string, data: unknown) => Promise<void> };
      loadFullTranscript: (id: string) => Promise<{
        transcriptEntries: Array<{
          type: string;
          source?: string;
          payload?: {
            results?: Array<{ taskId: string; status: string; summary?: string }>;
          };
          taskResults?: Array<{ taskId: string; status: string; summary?: string }>;
        }>;
      } | null>;
    };

    await mgr.storage.save('multi-banner-transcript-001', {
      messages: [
        {
          role: 'user',
          content: [
            '<task-completed task_id="child-a">',
            'alpha done',
            '</task-completed>',
            '',
            '<task-completed task_id="child-b">',
            'failed: beta exploded',
            '</task-completed>',
          ].join('\n'),
          _synthetic: true,
          _source: 'task-completed',
          timestamp: '2026-07-04T02:00:00.000Z',
        },
      ],
      title: 'Multi banner transcript',
      gitRoot: tempHome,
      scope: 'user',
    });

    const full = await mgr.loadFullTranscript('multi-banner-transcript-001');

    expect(full?.transcriptEntries[0]).toEqual(expect.objectContaining({
      type: 'task_result',
      source: 'child_task',
      payload: expect.objectContaining({
        results: [
          expect.objectContaining({ taskId: 'child-a', status: 'completed', summary: 'alpha done' }),
          expect.objectContaining({ taskId: 'child-b', status: 'failed', summary: 'failed: beta exploded' }),
        ],
      }),
      taskResults: [
        expect.objectContaining({ taskId: 'child-a', status: 'completed', summary: 'alpha done' }),
        expect.objectContaining({ taskId: 'child-b', status: 'failed', summary: 'failed: beta exploded' }),
      ],
    }));
  });

  it('loadFullTranscript includes entries archived into the islands sidecar', async () => {
    const overrideDir = path.join(tempHome, 'full-transcript-sidecar-test');
    const projectDir = path.join(overrideDir, 'project-a');
    await mkdir(projectDir, { recursive: true });
    const id = 'sidecar-transcript-001';
    const mainPath = path.join(projectDir, `${id}.jsonl`);
    const sidecarPath = path.join(projectDir, `${id}.islands.jsonl`);
    const legacySidecarPath = path.join(projectDir, `${id}.archive.jsonl`);

    await writeFile(
      mainPath,
      [
        JSON.stringify({
          _type: 'meta',
          id,
          title: 'Sidecar transcript',
          gitRoot: '/tmp/test-repo',
          createdAt: '2026-06-16T00:00:00.000Z',
          scope: 'user',
          lineageVersion: 2,
          activeEntryId: 'entry_current',
          activeMessageCount: 1,
          lineageEntryCount: 3,
        }),
        JSON.stringify({
          _type: 'lineage_entry',
          entry: {
            id: 'entry_marker',
            parentId: null,
            timestamp: '2026-06-16T00:00:01.000Z',
            type: 'archive_marker',
            archiveBatchId: 'batch_old',
            archivedEntryCount: 2,
            summary: 'Old island',
          },
        }),
        JSON.stringify({
          _type: 'lineage_entry',
          entry: {
            id: 'entry_old_user',
            parentId: null,
            timestamp: '2026-06-15T00:00:00.000Z',
            type: 'message',
            message: { role: 'user', content: 'old prompt still in main' },
          },
        }),
        JSON.stringify({
          _type: 'lineage_entry',
          entry: {
            id: 'entry_current',
            parentId: null,
            timestamp: '2026-06-16T00:00:02.000Z',
            type: 'message',
            message: { role: 'user', content: 'current prompt' },
          },
        }),
      ].join('\n') + '\n',
      'utf-8',
    );
    await writeFile(
      sidecarPath,
      [
        JSON.stringify({
          _type: 'archive_batch',
          archiveBatchId: 'batch_old',
          sessionId: id,
          archivedAt: '2026-06-16T00:00:03.000Z',
          entryCount: 2,
        }),
        JSON.stringify({
          _type: 'archived_entry',
          archiveBatchId: 'batch_old',
          entry: {
            id: 'entry_old_user',
            parentId: null,
            timestamp: '2026-06-15T00:00:00.000Z',
            type: 'message',
            message: { role: 'user', content: 'old prompt' },
          },
        }),
        JSON.stringify({
          _type: 'archived_entry',
          archiveBatchId: 'batch_old',
          entry: {
            id: 'entry_old_assistant',
            parentId: 'entry_old_user',
            timestamp: '2026-06-15T00:00:01.000Z',
            type: 'message',
            message: { role: 'assistant', content: 'old answer' },
          },
        }),
      ].join('\n') + '\n',
      'utf-8',
    );
    await writeFile(
      legacySidecarPath,
      [
        JSON.stringify({
          _type: 'archived_entry',
          archiveBatchId: 'batch_old',
          entry: {
            id: 'entry_old_user',
            parentId: null,
            timestamp: '2026-06-15T00:00:00.000Z',
            type: 'message',
            message: { role: 'user', content: 'old prompt duplicate' },
          },
        }),
      ].join('\n') + '\n',
      'utf-8',
    );

    const mgr = api.createSessionManager({ sessionsDir: overrideDir }) as {
      loadSession: (sessionId: string) => Promise<{ messages: Array<{ content: unknown }> } | null>;
      loadFullTranscript: (sessionId: string) => Promise<{
        messages: Array<{ content: unknown }>;
        activeMessages: Array<{ content: unknown }>;
        transcriptEntries: Array<{
          active: boolean;
          entryId: string;
          logicalId: string;
          sourceEntryId?: string;
        }>;
      } | null>;
    };

    const active = await mgr.loadSession(id);
    const full = await mgr.loadFullTranscript(id);

    expect(active?.messages.map((message) => message.content)).toEqual([
      'current prompt',
    ]);
    expect(full?.messages.map((message) => message.content)).toEqual([
      'old prompt',
      'old answer',
      'current prompt',
    ]);
    expect(full?.activeMessages.map((message) => message.content)).toEqual([
      'current prompt',
    ]);
    expect(full?.transcriptEntries.map((entry) => entry.active)).toEqual([
      false,
      false,
      true,
    ]);
    expect(full?.transcriptEntries.map((entry) => ({
      entryId: entry.entryId,
      logicalId: entry.logicalId,
      sourceEntryId: entry.sourceEntryId,
    }))).toEqual([
      { entryId: 'entry_old_user', logicalId: 'entry_old_user', sourceEntryId: undefined },
      { entryId: 'entry_old_assistant', logicalId: 'entry_old_assistant', sourceEntryId: undefined },
      { entryId: 'entry_current', logicalId: 'entry_current', sourceEntryId: undefined },
    ]);
  });

  it('listRunningSessions().sessionId is sourced from PersistedSessionState.sessionId', async () => {
    // Plant a fake live instance directory under <agentConfigHome>/instances/<pid>/
    // with sessionId in its state.json. discoverInstances reads
    // getAgentConfigPath('instances') which resolves under HOME/.kodax.
    const peerPid = 4242;
    const instanceDir = path.join(tempHome, '.kodax', 'instances', String(peerPid));
    await mkdir(instanceDir, { recursive: true });
    const now = Date.now();
    fs.writeFileSync(path.join(instanceDir, 'heartbeat'), '');
    fs.utimesSync(path.join(instanceDir, 'heartbeat'), now / 1000, now / 1000);
    await writeFile(
      path.join(instanceDir, 'meta.json'),
      JSON.stringify({ cwd: '/tmp/peer-repo', startedAt: now - 5000 }),
    );
    await writeFile(
      path.join(instanceDir, 'state.json'),
      JSON.stringify({
        version: '1',
        pid: peerPid,
        updatedAt: now,
        meta: { cwd: '/tmp/peer-repo', startedAt: now - 5000 },
        agentPhase: 'idle',
        sessionId: '20260522_113000',
      }),
    );

    const running = await api.listRunningSessions();
    const peer = running.find((r) => r.pid === peerPid);
    expect(peer).toBeDefined();
    expect(peer?.sessionId).toBe('20260522_113000');
  });
});
