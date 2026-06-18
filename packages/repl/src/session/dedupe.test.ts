import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { dedupeSessions } from './dedupe.js';

let tempRoot: string;
let sessionsDir: string;

async function writeSession(
  relativePath: string,
  meta: Record<string, unknown>,
): Promise<string> {
  const filePath = path.join(sessionsDir, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(meta)}\n`, 'utf8');
  return filePath;
}

function meta(
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    _type: 'meta',
    id,
    title: 'Same task',
    gitRoot: '/repo/demo',
    runtimeInfo: {
      canonicalRepoRoot: '/repo/demo',
      workspaceRoot: '/repo/demo',
    },
    createdAt: '2026-06-18T12:00:00.000Z',
    scope: 'user',
    activeMessageCount: 4,
    ...overrides,
  };
}

describe('dedupeSessions', () => {
  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'kodax-session-dedupe-'));
    sessionsDir = path.join(tempRoot, 'sessions');
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('does not create or migrate the sessions directory during dry-run', async () => {
    const report = await dedupeSessions({ sessionsDir });

    expect(report).toMatchObject({
      scanned: 0,
      runnerCandidates: 0,
      matches: [],
      moved: [],
      skipped: [],
    });
    expect(fs.existsSync(sessionsDir)).toBe(false);
  });

  it('dry-runs a unique runner ghost match without moving files', async () => {
    const canonicalPath = await writeSession('project-a/20260618_120000.jsonl', meta('20260618_120000', {
      lineageVersion: 2,
      activeEntryId: 'entry-4',
      uiHistory: [{ type: 'assistant', text: 'done' }],
    }));
    const runnerPath = await writeSession('project-a/runner-123.jsonl', meta('runner-123'));

    const report = await dedupeSessions({ sessionsDir });

    expect(report.scanned).toBe(2);
    expect(report.runnerCandidates).toBe(1);
    expect(report.matches).toEqual([
      expect.objectContaining({
        runnerId: 'runner-123',
        canonicalId: '20260618_120000',
      }),
    ]);
    expect(report.moved).toEqual([]);
    expect(fs.existsSync(canonicalPath)).toBe(true);
    expect(fs.existsSync(runnerPath)).toBe(true);
  });

  it('moves a unique runner ghost to a hidden dedupe archive when apply is true', async () => {
    const canonicalPath = await writeSession('project-a/20260618_120000.jsonl', meta('20260618_120000', {
      lineageVersion: 2,
      activeEntryId: 'entry-4',
      uiHistory: [{ type: 'assistant', text: 'done' }],
    }));
    const runnerPath = await writeSession('project-a/runner-123.jsonl', meta('runner-123'));

    const report = await dedupeSessions({
      sessionsDir,
      apply: true,
      now: new Date('2026-06-18T12:34:56.000Z'),
    });

    const archivedRunner = path.join(
      sessionsDir,
      '.dedupe-archive',
      '20260618-123456',
      'project-a',
      'runner-123.jsonl',
    );

    expect(report.moved).toEqual([
      expect.objectContaining({
        runnerId: 'runner-123',
        from: runnerPath,
        to: archivedRunner,
      }),
    ]);
    expect(fs.existsSync(canonicalPath)).toBe(true);
    expect(fs.existsSync(runnerPath)).toBe(false);
    expect(fs.existsSync(archivedRunner)).toBe(true);
  });

  it('skips ambiguous runner ghost matches', async () => {
    await writeSession('project-a/20260618_120000.jsonl', meta('20260618_120000', {
      lineageVersion: 2,
      activeEntryId: 'entry-4',
      uiHistory: [{ type: 'assistant', text: 'done' }],
    }));
    await writeSession('project-a/20260618_120100.jsonl', meta('20260618_120100', {
      createdAt: '2026-06-18T12:01:00.000Z',
      lineageVersion: 2,
      activeEntryId: 'entry-4',
      uiHistory: [{ type: 'assistant', text: 'done' }],
    }));
    const runnerPath = await writeSession('project-a/runner-123.jsonl', meta('runner-123'));

    const report = await dedupeSessions({ sessionsDir, apply: true });

    expect(report.matches).toEqual([]);
    expect(report.moved).toEqual([]);
    expect(report.skipped).toEqual([
      expect.objectContaining({
        runnerId: 'runner-123',
        reason: 'ambiguous-match',
      }),
    ]);
    expect(fs.existsSync(runnerPath)).toBe(true);
  });

  it('skips managed-task-worker runner sessions', async () => {
    const runnerPath = await writeSession('project-a/runner-worker.jsonl', meta('runner-worker', {
      scope: 'managed-task-worker',
    }));

    const report = await dedupeSessions({ sessionsDir, apply: true });

    expect(report.runnerCandidates).toBe(0);
    expect(report.moved).toEqual([]);
    expect(report.skipped).toEqual([
      expect.objectContaining({
        runnerId: 'runner-worker',
        reason: 'managed-task-worker',
      }),
    ]);
    expect(fs.existsSync(runnerPath)).toBe(true);
  });
});
