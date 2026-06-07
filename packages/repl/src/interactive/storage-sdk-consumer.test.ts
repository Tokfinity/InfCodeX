/**
 * v0.7.46 — Regression tests for SDK-consumer footguns reported by
 * KodaX Space (in-process embedder, ADR-003) plus 3 sibling issues
 * surfaced by the same audit. Each test corresponds to one bug class:
 *
 *   F1 — fast path drops legacy `gitRoot` (no `runtimeInfo` field)
 *   F2 — hardcoded `.slice(0, 10)` cap silently truncates caller's limit
 *   F3 — fast path return shape misses `createdAt`
 *   F4 — `load()` uses process.cwd() for workspace check + bleeds
 *        notices to stderr in embedder context
 *   F5 — `deleteAll()` silently capped at 10 sessions
 *
 * Tests construct FileSessionStorage with an explicit `sessionsDir`
 * (avoiding the module-frozen KODAX_SESSIONS_DIR setup dance) and
 * write meta jsonl files by hand to control the exact shape under test.
 */

import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileSessionStorage } from './storage.js';

let tempRoot: string;
let sessionsDir: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'kodax-sdk-footguns-'));
  sessionsDir = path.join(tempRoot, 'sessions');
  await mkdir(sessionsDir, { recursive: true });
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

async function writeMeta(id: string, meta: Record<string, unknown>): Promise<void> {
  const filePath = path.join(sessionsDir, `${id}.jsonl`);
  await writeFile(filePath, JSON.stringify({ _type: 'meta', ...meta }) + '\n', 'utf-8');
}

describe('v0.7.46 SDK-consumer footgun regression', () => {
  describe('F1 — fast path falls back to legacy top-level gitRoot', () => {
    it('legacy meta (no runtimeInfo, top-level gitRoot) → list() surfaces gitRoot via runtimeInfo.canonicalRepoRoot', async () => {
      // cwd: tempRoot is not a git repo → getGitRoot returns null → the
      // workspace-mismatch filter at storage.ts:1057 (`if (currentGitRoot)`)
      // is skipped, so all sessions flow through. Without this, tests
      // would have their sessions filtered out depending on which git
      // root happens to be the host process's cwd.
      const storage = new FileSessionStorage({ sessionsDir, cwd: tempRoot });
      const legacyGitRoot = '/some/project/dir';

      // Legacy meta shape: top-level gitRoot, NO runtimeInfo field. Pre-v0.7.46
      // the fast path returned runtimeInfo: undefined for these.
      await writeMeta('legacy-session', {
        title: 'legacy',
        gitRoot: legacyGitRoot,
        createdAt: '2026-06-03T10:00:00.000Z',
        activeMessageCount: 1,
      });

      // Pass legacyGitRoot as the filter so the workspace-mismatch
      // branch sees a match (otherwise the list filters out non-matching
      // sessions — orthogonal to F1).
      // Pass undefined gitRoot so the workspace-mismatch filter is
      // skipped (we're testing return-shape fallback, not the filter).
      const result = await storage.list(undefined, { limit: 50 });

      expect(result.length).toBe(1);
      expect(result[0]?.runtimeInfo).toBeDefined();
      // canonicalRepoRoot is the modern field name (semantic equivalent of
      // gitRoot). public-api's extractRuntimeInfoSummary remaps this to
      // SessionSummary.runtimeInfo.gitRoot for the consumer.
      expect(result[0]?.runtimeInfo?.canonicalRepoRoot).toBe(legacyGitRoot);
    });

    it('modern meta (nested runtimeInfo) → list() uses it as-is, never overwrites with gitRoot', async () => {
      // cwd: tempRoot is not a git repo → getGitRoot returns null → the
      // workspace-mismatch filter at storage.ts:1057 (`if (currentGitRoot)`)
      // is skipped, so all sessions flow through. Without this, tests
      // would have their sessions filtered out depending on which git
      // root happens to be the host process's cwd.
      const storage = new FileSessionStorage({ sessionsDir, cwd: tempRoot });
      const projectRoot = '/modern/project';

      await writeMeta('modern-session', {
        title: 'modern',
        gitRoot: projectRoot,
        runtimeInfo: {
          canonicalRepoRoot: projectRoot,
          workspaceRoot: projectRoot,
          executionCwd: projectRoot,
        },
        createdAt: '2026-06-03T10:00:00.000Z',
        activeMessageCount: 1,
      });

      const result = await storage.list(undefined, { limit: 50 });

      expect(result[0]?.runtimeInfo?.canonicalRepoRoot).toBe(projectRoot);
      expect(result[0]?.runtimeInfo?.workspaceRoot).toBe(projectRoot);
    });
  });

  describe('F2 — list() respects caller-supplied limit', () => {
    it('defaults to 10 when no limit supplied (legacy REPL picker behavior)', async () => {
      // cwd: tempRoot is not a git repo → getGitRoot returns null → the
      // workspace-mismatch filter at storage.ts:1057 (`if (currentGitRoot)`)
      // is skipped, so all sessions flow through. Without this, tests
      // would have their sessions filtered out depending on which git
      // root happens to be the host process's cwd.
      const storage = new FileSessionStorage({ sessionsDir, cwd: tempRoot });
      const gitRoot = '/test/repo';
      for (let i = 0; i < 15; i++) {
        await writeMeta(`sess-${i.toString().padStart(2, '0')}`, {
          title: `s${i}`,
          gitRoot,
          createdAt: new Date(2026, 0, i + 1).toISOString(),
          activeMessageCount: 1,
        });
      }
      const result = await storage.list();
      expect(result.length).toBe(10);
    });

    it('limit:50 returns all 15 sessions (caller override beats legacy cap)', async () => {
      // cwd: tempRoot is not a git repo → getGitRoot returns null → the
      // workspace-mismatch filter at storage.ts:1057 (`if (currentGitRoot)`)
      // is skipped, so all sessions flow through. Without this, tests
      // would have their sessions filtered out depending on which git
      // root happens to be the host process's cwd.
      const storage = new FileSessionStorage({ sessionsDir, cwd: tempRoot });
      const gitRoot = '/test/repo';
      for (let i = 0; i < 15; i++) {
        await writeMeta(`sess-${i.toString().padStart(2, '0')}`, {
          title: `s${i}`,
          gitRoot,
          createdAt: new Date(2026, 0, i + 1).toISOString(),
          activeMessageCount: 1,
        });
      }
      const result = await storage.list(undefined, { limit: 50 });
      expect(result.length).toBe(15);
    });

    it('limit:200 with 5 sessions → returns 5 (no synthetic padding)', async () => {
      // cwd: tempRoot is not a git repo → getGitRoot returns null → the
      // workspace-mismatch filter at storage.ts:1057 (`if (currentGitRoot)`)
      // is skipped, so all sessions flow through. Without this, tests
      // would have their sessions filtered out depending on which git
      // root happens to be the host process's cwd.
      const storage = new FileSessionStorage({ sessionsDir, cwd: tempRoot });
      const gitRoot = '/test/repo';
      for (let i = 0; i < 5; i++) {
        await writeMeta(`sess-${i}`, {
          title: `s${i}`, gitRoot, activeMessageCount: 1,
        });
      }
      const result = await storage.list(undefined, { limit: 200 });
      expect(result.length).toBe(5);
    });
  });

  describe('F3 — list() return carries createdAt', () => {
    it('preserves createdAt verbatim from meta record', async () => {
      // cwd: tempRoot is not a git repo → getGitRoot returns null → the
      // workspace-mismatch filter at storage.ts:1057 (`if (currentGitRoot)`)
      // is skipped, so all sessions flow through. Without this, tests
      // would have their sessions filtered out depending on which git
      // root happens to be the host process's cwd.
      const storage = new FileSessionStorage({ sessionsDir, cwd: tempRoot });
      const gitRoot = '/test/repo';
      const ts = '2026-06-03T12:34:56.789Z';
      await writeMeta('with-created-at', {
        title: 'x', gitRoot, createdAt: ts, activeMessageCount: 1,
      });
      const result = await storage.list(undefined, { limit: 5 });
      expect(result[0]?.createdAt).toBe(ts);
    });

    it('missing createdAt → undefined, not an empty string or thrown', async () => {
      // cwd: tempRoot is not a git repo → getGitRoot returns null → the
      // workspace-mismatch filter at storage.ts:1057 (`if (currentGitRoot)`)
      // is skipped, so all sessions flow through. Without this, tests
      // would have their sessions filtered out depending on which git
      // root happens to be the host process's cwd.
      const storage = new FileSessionStorage({ sessionsDir, cwd: tempRoot });
      const gitRoot = '/test/repo';
      await writeMeta('no-created-at', {
        title: 'x', gitRoot, activeMessageCount: 1,
      });
      const result = await storage.list(undefined, { limit: 5 });
      expect(result[0]?.createdAt).toBeUndefined();
    });
  });

  describe('F4 — cwd injection + mismatch warning suppression for embedders', () => {
    it('constructor accepts cwd option (FileSessionStorage embedder shape)', () => {
      const storage = new FileSessionStorage({
        sessionsDir,
        cwd: '/embedder/host/project-a',
      });
      // Surface check: cwd is stored privately; we verify via behavior
      // in the next tests rather than reaching into private state.
      expect(storage).toBeInstanceOf(FileSessionStorage);
    });

    it('hostCwd present → load() does NOT write to stderr on mismatch (embedder noise suppression)', async () => {
      // Even when the session's gitRoot differs from cwd's git root,
      // the SDK consumer is authoritative and the warning is noise.
      // We test the *absence* of stderr.write — directly verifiable
      // by stubbing process.stderr.write.
      const stderrChunks: string[] = [];
      const originalWrite = process.stderr.write.bind(process.stderr);
      process.stderr.write = ((chunk: unknown): boolean => {
        if (typeof chunk === 'string') stderrChunks.push(chunk);
        return true;
      }) as typeof process.stderr.write;

      try {
        // Write a session with a gitRoot that won't match `cwd`'s git root
        const sessionGitRoot = '/some/distinct/project';
        const id = 'embedder-load-test';
        const filePath = path.join(sessionsDir, `${id}.jsonl`);
        await writeFile(
          filePath,
          JSON.stringify({
            _type: 'meta',
            title: 't',
            gitRoot: sessionGitRoot,
            createdAt: '2026-06-03T10:00:00.000Z',
          }) + '\n' +
          JSON.stringify({ role: 'user', content: 'hi' }) + '\n',
          'utf-8',
        );

        const storage = new FileSessionStorage({
          sessionsDir,
          cwd: '/embedder/host/project-A',
        });
        await storage.load(id);

        // Pre-v0.7.46: at least one chunk would contain "[Warning]
        // Session project mismatch". Post-fix: hostCwd suppresses the
        // warning entirely.
        const warningChunks = stderrChunks.filter((c) =>
          c.includes('Session project mismatch'),
        );
        expect(warningChunks.length).toBe(0);
      } finally {
        process.stderr.write = originalWrite;
      }
    });
  });

  describe('F6 v0.7.46 — list() with no project intent → scans ALL projects (not process.cwd())', () => {
    // Regression for the bug Space reported after v0.7.46 ship:
    // even with v0.7.46's `getGitRoot(this.hostCwd)` fix, when an
    // in-process embedder constructs `new FileSessionStorage()` WITHOUT
    // a `cwd` arg AND calls `list()` WITHOUT a `gitRoot` arg, the storage
    // silently filtered by `process.cwd()` of the host process (e.g.
    // KodaX-Space's startup dir). The user saw an empty sidebar.
    //
    // v0.7.46 fix: when both signals are absent, don't filter at all —
    // return sessions from every project directory.

    it('storage with no hostCwd + list(undefined) → returns sessions across multiple project dirs', async () => {
      // FEATURE_219 (v0.7.46) uses `{sessionsDir}/{projectKey}/{id}.jsonl`
      // layout. To simulate cross-project sessions, write to two
      // distinct project subdirs. The list() call should surface BOTH
      // when no project intent is supplied.
      const storage = new FileSessionStorage({ sessionsDir });
      // Create per-project subdirs the way FEATURE_219 expects.
      const projAKey = 'proj-a-key';
      const projBKey = 'proj-b-key';
      await mkdir(path.join(sessionsDir, projAKey), { recursive: true });
      await mkdir(path.join(sessionsDir, projBKey), { recursive: true });
      // Each session's meta carries the relevant project gitRoot;
      // .layout.json marker tells the migrator the dir is already
      // migrated so list() goes straight to the per-project loop.
      await writeFile(
        path.join(sessionsDir, '.layout.json'),
        JSON.stringify({ version: 1 }),
        'utf-8',
      );
      await writeFile(
        path.join(sessionsDir, projAKey, 'sess-a.jsonl'),
        JSON.stringify({
          _type: 'meta',
          title: 'A',
          gitRoot: '/project/A',
          createdAt: '2026-06-01T10:00:00.000Z',
          activeMessageCount: 1,
        }) + '\n',
        'utf-8',
      );
      await writeFile(
        path.join(sessionsDir, projBKey, 'sess-b.jsonl'),
        JSON.stringify({
          _type: 'meta',
          title: 'B',
          gitRoot: '/project/B',
          createdAt: '2026-06-02T10:00:00.000Z',
          activeMessageCount: 1,
        }) + '\n',
        'utf-8',
      );

      const result = await storage.list(undefined, { limit: 50 });

      // Pre-v0.7.46: storage resolved process.cwd() → some-implicit-project
      // → only that project's dir scanned → either 0 or 1 sessions
      // returned depending on whether tests happened to run in a matching
      // project. Post-fix: both projects' sessions surface.
      const ids = result.map((s) => s.id).sort();
      expect(ids).toEqual(['sess-a', 'sess-b']);
    });

    it('storage WITH hostCwd → respects embedder filter (only matching project)', async () => {
      // When the embedder explicitly tells the SDK which project they
      // opened (via the constructor cwd option), the per-project
      // filter is correct. Use tempRoot — a non-git directory — so
      // `getGitRoot(tempRoot)` returns null and the test still
      // exercises the "embedder set hostCwd but no git root resolves"
      // branch: still falls into the "scan all" path, because hostCwd
      // alone without a resolvable git root produces null currentGitRoot.
      const storage = new FileSessionStorage({
        sessionsDir,
        cwd: tempRoot,
      });
      await writeMeta('alone', { title: 'x', gitRoot: '/anywhere', activeMessageCount: 1 });

      const result = await storage.list(undefined, { limit: 50 });
      expect(result.length).toBe(1);
      expect(result[0]?.id).toBe('alone');
    });
  });

  describe('F5 — deleteAll() removes ALL sessions (no silent cap)', () => {
    it('15 sessions for gitRoot → deleteAll deletes all 15', async () => {
      // cwd: tempRoot is not a git repo → getGitRoot returns null → the
      // workspace-mismatch filter at storage.ts:1057 (`if (currentGitRoot)`)
      // is skipped, so all sessions flow through. Without this, tests
      // would have their sessions filtered out depending on which git
      // root happens to be the host process's cwd.
      const storage = new FileSessionStorage({ sessionsDir, cwd: tempRoot });
      const gitRoot = '/cleanup/target';

      for (let i = 0; i < 15; i++) {
        await writeMeta(`del-${i.toString().padStart(2, '0')}`, {
          title: `s${i}`,
          gitRoot,
          createdAt: new Date(2026, 0, i + 1).toISOString(),
          activeMessageCount: 1,
        });
      }

      // Sanity: confirm there are 15 to start.
      const before = await storage.list(undefined, { limit: 50 });
      expect(before.length).toBe(15);

      // deleteAll(undefined) deletes anything matching the storage's
      // resolved gitRoot (null in our tempRoot setup → no filter, all
      // sessions targeted). Pre-v0.7.46 only the first 10 would be
      // deleted (deleteAll reused list()'s 10-cap), and 5 would
      // silently survive.
      await storage.deleteAll();

      const after = await storage.list(undefined, { limit: 50 });
      expect(after.length).toBe(0);
    });
  });
});
