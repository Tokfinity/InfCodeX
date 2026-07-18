import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';

import { listCliResumeSessions } from './cli-resume.js';

describe('listCliResumeSessions', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('matches the existing bare-resume filters without loading empty, worker, or other-project sessions', async () => {
    const tempHome = await mkdtemp(path.join(os.tmpdir(), 'kodax-cli-resume-'));
    tempDirs.push(tempHome);
    const sessionsDir = path.join(tempHome, 'sessions');
    await mkdir(sessionsDir, { recursive: true });

    const writeSession = async (id: string, overrides: Record<string, unknown>): Promise<void> => {
      const meta = {
        _type: 'meta',
        id,
        title: id,
        gitRoot: 'C:/repo',
        createdAt: '2026-07-18T00:00:00.000Z',
        scope: 'user',
        activeMessageCount: 2,
        runtimeInfo: { canonicalRepoRoot: 'C:/repo', surface: 'repl' },
        ...overrides,
      };
      await writeFile(path.join(sessionsDir, `${id}.jsonl`), `${JSON.stringify(meta)}\n`, 'utf8');
    };

    await writeSession('included', { title: 'Included session' });
    await writeSession('empty', { activeMessageCount: 0 });
    await writeSession('worker', { scope: 'managed-task-worker' });
    await writeSession('other-project', {
      gitRoot: 'C:/other',
      runtimeInfo: { canonicalRepoRoot: 'C:/other', surface: 'repl' },
    });

    const sessions = await listCliResumeSessions({
      projectRoot: 'C:/repo',
      sessionsDir,
      limit: 1000,
    });

    expect(sessions).toEqual([expect.objectContaining({
      id: 'included',
      title: 'Included session',
      msgCount: 2,
      surface: 'repl',
    })]);
  });

  it('sorts newest first, honors the limit, and counts legacy message lines', async () => {
    const tempHome = await mkdtemp(path.join(os.tmpdir(), 'kodax-cli-resume-'));
    tempDirs.push(tempHome);
    const sessionsDir = path.join(tempHome, 'sessions');
    await mkdir(sessionsDir, { recursive: true });

    const olderMeta = {
      _type: 'meta',
      title: 'Older',
      gitRoot: 'C:/repo',
      createdAt: '2026-07-17T00:00:00.000Z',
      scope: 'user',
    };
    await writeFile(
      path.join(sessionsDir, 'older.jsonl'),
      `${JSON.stringify(olderMeta)}\n${JSON.stringify({ role: 'user', content: 'one' })}\n${JSON.stringify({ role: 'assistant', content: 'two' })}\n`,
      'utf8',
    );
    await writeFile(
      path.join(sessionsDir, 'newer.jsonl'),
      `${JSON.stringify({ ...olderMeta, title: 'Newer', createdAt: '2026-07-18T00:00:00.000Z', activeMessageCount: 1 })}\n`,
      'utf8',
    );

    const all = await listCliResumeSessions({ projectRoot: 'C:/repo', sessionsDir, limit: 10 });
    const limited = await listCliResumeSessions({ projectRoot: 'C:/repo', sessionsDir, limit: 1 });

    expect(all.map((item) => [item.id, item.msgCount])).toEqual([
      ['newer', 1],
      ['older', 2],
    ]);
    expect(limited.map((item) => item.id)).toEqual(['newer']);
  });

  it('keeps legacy archived files out of the active resume picker', async () => {
    const tempHome = await mkdtemp(path.join(os.tmpdir(), 'kodax-cli-resume-'));
    tempDirs.push(tempHome);
    const sessionsDir = path.join(tempHome, 'sessions');

    // Stamp the current layout first so this specifically exercises the
    // dual-layout reader rather than migration of the legacy fixture.
    await listCliResumeSessions({ projectRoot: 'C:/repo', sessionsDir });
    const meta = {
      _type: 'meta',
      title: 'Archived legacy session',
      gitRoot: 'C:/repo',
      scope: 'user',
      activeMessageCount: 2,
    };
    await writeFile(
      path.join(sessionsDir, 'archived-legacy.jsonl'),
      `${JSON.stringify(meta)}\n`,
      'utf8',
    );

    await expect(listCliResumeSessions({ projectRoot: 'C:/repo', sessionsDir }))
      .resolves.toEqual([]);
  });
});
