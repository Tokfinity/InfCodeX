import os from 'os';
import path from 'path';
import { existsSync } from 'fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ensureLayoutMigrated,
  isMigrated,
  needsMigration,
  planMigration,
  runMigration,
} from './session-migration.js';
import { deriveProjectKeyFromRoot } from './project-key.js';

describe('FEATURE_219 session-migration', () => {
  let root: string;
  let sessionsDir: string;
  const gitRoot = path.resolve('C:/Works/GitWorks/KodaX').replace(/\\/g, '/');
  const key = deriveProjectKeyFromRoot(gitRoot).key;

  const metaLine = (id: string): string =>
    JSON.stringify({ _type: 'meta', id, title: id, gitRoot, activeMessageCount: 1 });

  async function seedFlat(id: string): Promise<string> {
    const p = path.join(sessionsDir, `${id}.jsonl`);
    await writeFile(p, `${metaLine(id)}\n${JSON.stringify({ role: 'user', content: 'x' })}\n`, 'utf8');
    return p;
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'kodax-mig-'));
    sessionsDir = path.join(root, 'sessions');
    await mkdir(sessionsDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('plans flat sessions into per-project dirs, sidecars → islands, orphans → _unknown', async () => {
    await seedFlat('20260101_000000');
    await writeFile(path.join(sessionsDir, '20260101_000000.archive.jsonl'), 'island\n', 'utf8');
    await writeFile(path.join(sessionsDir, '20260102_000000.archive.jsonl'), 'orphan\n', 'utf8'); // no main

    const plans = await planMigration(sessionsDir);
    const byReason = Object.fromEntries(plans.map((p) => [p.reason, p.to]));

    expect(byReason[`session→${key}`]).toBe(path.join(sessionsDir, key, '20260101_000000.jsonl'));
    expect(byReason['sidecar→islands']).toBe(path.join(sessionsDir, key, '20260101_000000.islands.jsonl'));
    expect(byReason['orphan-sidecar→_unknown']).toBe(
      path.join(sessionsDir, '_unknown', 'orphan-islands', '20260102_000000.islands.jsonl'),
    );
  });

  it('runMigration moves files, writes the layout marker, and is idempotent', async () => {
    const flat = await seedFlat('20260201_000000');
    expect(await needsMigration(sessionsDir)).toBe(true);

    const result = await runMigration(sessionsDir);
    expect(result.moved).toBeGreaterThanOrEqual(1);

    const moved = path.join(sessionsDir, key, '20260201_000000.jsonl');
    expect(existsSync(moved)).toBe(true);
    expect(existsSync(flat)).toBe(false);
    expect(await isMigrated(sessionsDir)).toBe(true);
    expect(existsSync(path.join(sessionsDir, '.layout.json'))).toBe(true);
    // journal cleaned up after the marker lands
    expect(existsSync(path.join(sessionsDir, '.migration-journal.jsonl'))).toBe(false);

    // Second run is a no-op (marker present).
    const again = await runMigration(sessionsDir);
    expect(again.moved).toBe(0);
  });

  it('relocates an orphan island sidecar instead of deleting it (non-destructive)', async () => {
    await writeFile(path.join(sessionsDir, '20260301_000000.archive.jsonl'), 'orphan-data\n', 'utf8');
    await runMigration(sessionsDir);
    const relocated = path.join(sessionsDir, '_unknown', 'orphan-islands', '20260301_000000.islands.jsonl');
    expect(existsSync(relocated)).toBe(true);
    expect(await readFile(relocated, 'utf8')).toBe('orphan-data\n');
  });

  it('keeps a newer dest on a destination-exists race (never clobbers a live write)', async () => {
    await seedFlat('20260401_000000');
    // Simulate a concurrent live write already at the destination.
    const destDir = path.join(sessionsDir, key);
    await mkdir(destDir, { recursive: true });
    await writeFile(path.join(destDir, '20260401_000000.jsonl'), 'NEWER\n', 'utf8');

    await runMigration(sessionsDir);

    expect(await readFile(path.join(destDir, '20260401_000000.jsonl'), 'utf8')).toBe('NEWER\n');
    expect(existsSync(path.join(sessionsDir, '20260401_000000.jsonl'))).toBe(false); // flat superseded
  });

  it('reclaims a stale lock left by a dead process', async () => {
    await seedFlat('20260501_000000');
    // Pre-create a lock owned by a definitely-dead pid with an old heartbeat.
    const lockDir = path.join(sessionsDir, '.migration-lock');
    await mkdir(lockDir, { recursive: true });
    await writeFile(
      path.join(lockDir, 'owner.json'),
      JSON.stringify({ pid: 2147483646, startTime: 0, heartbeatAt: 0 }),
    );

    const result = await runMigration(sessionsDir);
    expect(result.moved).toBeGreaterThanOrEqual(1);
    expect(existsSync(path.join(sessionsDir, key, '20260501_000000.jsonl'))).toBe(true);
  });

  it('ensureLayoutMigrated stamps a marker on a fresh (empty) install without scanning forever', async () => {
    expect(await needsMigration(sessionsDir)).toBe(false);
    await ensureLayoutMigrated(sessionsDir);
    expect(await isMigrated(sessionsDir)).toBe(true);
  });

  it('retires an empty sessions-archive/ sibling dir after migrating its contents', async () => {
    const archiveDir = path.join(root, 'sessions-archive');
    await mkdir(archiveDir, { recursive: true });
    await writeFile(
      path.join(archiveDir, '20260601_000000.jsonl'),
      `${metaLine('20260601_000000')}\n`,
      'utf8',
    );

    await runMigration(sessionsDir);

    expect(existsSync(path.join(sessionsDir, key, '20260601_000000.jsonl'))).toBe(true);
    expect(existsSync(archiveDir)).toBe(false); // retired
  });
});
