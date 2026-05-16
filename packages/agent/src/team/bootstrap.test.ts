/**
 * FEATURE_125 (v0.7.41) — bootstrap + active-team-mode hermetic tests.
 *
 * The bootstrap helper composes state-writer + instance-discovery
 * (already covered by their own hermetic suites). These tests assert
 * the COMPOSITION semantics:
 *   - Returns null when KODAX_DISABLE_MULTI_INSTANCE=1.
 *   - Reaps stale peer directories on startup.
 *   - Installs the writer in the process-level singleton.
 *   - shutdown() clears the singleton AND tears down the writer
 *     atomically and idempotently.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  bootstrapTeamMode,
  type TeamModeHandle,
} from './bootstrap.js';
import {
  getActiveTeamModeWriter,
  setActiveTeamModeWriter,
  updateActiveTeamMode,
} from './active-team-mode.js';
import type { SessionMeta } from './state-writer.js';

const baseMeta: SessionMeta = {
  cwd: '/test/cwd',
  startedAt: 1_700_000_000_000,
  gitBranch: 'main',
};

describe('bootstrapTeamMode', () => {
  let tempDir: string;
  const handles: TeamModeHandle[] = [];
  let originalEnv: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-bootstrap-'));
    originalEnv = process.env.KODAX_DISABLE_MULTI_INSTANCE;
    delete process.env.KODAX_DISABLE_MULTI_INSTANCE;
    setActiveTeamModeWriter(null);
  });

  afterEach(async () => {
    await Promise.all(handles.splice(0).map((h) => h.shutdown()));
    fs.rmSync(tempDir, { recursive: true, force: true });
    setActiveTeamModeWriter(null);
    if (originalEnv === undefined) {
      delete process.env.KODAX_DISABLE_MULTI_INSTANCE;
    } else {
      process.env.KODAX_DISABLE_MULTI_INSTANCE = originalEnv;
    }
  });

  it('creates a writer + installs it in the active-team-mode singleton', () => {
    const handle = bootstrapTeamMode({
      pid: 1111,
      meta: baseMeta,
      instancesRoot: tempDir,
    });
    expect(handle).not.toBeNull();
    handles.push(handle!);
    expect(getActiveTeamModeWriter()).toBe(handle!.writer);
    expect(fs.existsSync(path.join(tempDir, '1111', 'state.json'))).toBe(true);
  });

  it('returns null and leaves the singleton empty when KODAX_DISABLE_MULTI_INSTANCE=1', () => {
    process.env.KODAX_DISABLE_MULTI_INSTANCE = '1';
    const handle = bootstrapTeamMode({
      pid: 1111,
      meta: baseMeta,
      instancesRoot: tempDir,
    });
    expect(handle).toBeNull();
    expect(getActiveTeamModeWriter()).toBeNull();
    // No directory created.
    expect(fs.existsSync(path.join(tempDir, '1111'))).toBe(false);
  });

  it('reaps stale peer directories left by crashed processes on startup', () => {
    // Pre-seed a stale peer directory by hand (heartbeat mtime in the past).
    const stalePid = '88888';
    const staleDir = path.join(tempDir, stalePid);
    fs.mkdirSync(staleDir, { recursive: true });
    fs.writeFileSync(path.join(staleDir, 'meta.json'), JSON.stringify(baseMeta));
    fs.writeFileSync(
      path.join(staleDir, 'state.json'),
      JSON.stringify({
        version: '1',
        pid: 88888,
        updatedAt: Date.now() - 90_000,
        meta: baseMeta,
        agentPhase: 'idle',
      }),
    );
    fs.writeFileSync(path.join(staleDir, 'heartbeat'), '');
    const longAgo = (Date.now() - 90_000) / 1000;
    fs.utimesSync(path.join(staleDir, 'heartbeat'), longAgo, longAgo);

    expect(fs.existsSync(staleDir)).toBe(true);

    const handle = bootstrapTeamMode({
      pid: 1111,
      meta: baseMeta,
      instancesRoot: tempDir,
    });
    handles.push(handle!);

    // Stale peer reaped; live writer dir intact.
    expect(fs.existsSync(staleDir)).toBe(false);
    expect(fs.existsSync(path.join(tempDir, '1111'))).toBe(true);
  });

  it('skips the stale reap when reapStaleOnStart=false', () => {
    const stalePid = '77777';
    const staleDir = path.join(tempDir, stalePid);
    fs.mkdirSync(staleDir, { recursive: true });
    fs.writeFileSync(path.join(staleDir, 'heartbeat'), '');
    fs.utimesSync(
      path.join(staleDir, 'heartbeat'),
      (Date.now() - 90_000) / 1000,
      (Date.now() - 90_000) / 1000,
    );

    const handle = bootstrapTeamMode({
      pid: 1111,
      meta: baseMeta,
      instancesRoot: tempDir,
      reapStaleOnStart: false,
    });
    handles.push(handle!);

    expect(fs.existsSync(staleDir)).toBe(true);
  });

  it('discoverSiblings() returns alive peers excluding our own pid', () => {
    // Create a live peer directory (heartbeat current).
    const peerDir = path.join(tempDir, '2222');
    fs.mkdirSync(peerDir, { recursive: true });
    fs.writeFileSync(path.join(peerDir, 'meta.json'), JSON.stringify(baseMeta));
    fs.writeFileSync(
      path.join(peerDir, 'state.json'),
      JSON.stringify({
        version: '1',
        pid: 2222,
        updatedAt: Date.now(),
        meta: baseMeta,
        agentPhase: 'running_tool',
        currentIntent: 'doing things',
      }),
    );
    fs.writeFileSync(path.join(peerDir, 'heartbeat'), '');
    fs.utimesSync(
      path.join(peerDir, 'heartbeat'),
      Date.now() / 1000,
      Date.now() / 1000,
    );

    const handle = bootstrapTeamMode({
      pid: 1111,
      meta: baseMeta,
      instancesRoot: tempDir,
    });
    handles.push(handle!);

    const siblings = handle!.discoverSiblings();
    expect(siblings.map((s) => s.pid)).toEqual([2222]);
    expect(siblings[0]?.state.currentIntent).toBe('doing things');
  });

  it('shutdown() clears the singleton and removes the instance directory', async () => {
    const handle = bootstrapTeamMode({
      pid: 1111,
      meta: baseMeta,
      instancesRoot: tempDir,
    })!;

    expect(getActiveTeamModeWriter()).toBe(handle.writer);
    expect(fs.existsSync(path.join(tempDir, '1111'))).toBe(true);

    await handle.shutdown();

    expect(getActiveTeamModeWriter()).toBeNull();
    expect(fs.existsSync(path.join(tempDir, '1111'))).toBe(false);
  });

  it('shutdown() is idempotent (safe to call from multiple lifecycle hooks)', async () => {
    const handle = bootstrapTeamMode({
      pid: 1111,
      meta: baseMeta,
      instancesRoot: tempDir,
    })!;
    await handle.shutdown();
    await expect(handle.shutdown()).resolves.toBeUndefined();
  });
});

describe('active-team-mode singleton', () => {
  let tempDir: string;
  const handles: TeamModeHandle[] = [];

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-bootstrap-singleton-'));
    setActiveTeamModeWriter(null);
  });

  afterEach(async () => {
    await Promise.all(handles.splice(0).map((h) => h.shutdown()));
    fs.rmSync(tempDir, { recursive: true, force: true });
    setActiveTeamModeWriter(null);
  });

  it('updateActiveTeamMode is a no-op when no writer is set', () => {
    expect(() => updateActiveTeamMode({ currentIntent: 'unused' })).not.toThrow();
  });

  it('updateActiveTeamMode forwards the patch to the active writer', () => {
    const handle = bootstrapTeamMode({
      pid: 1111,
      meta: baseMeta,
      instancesRoot: tempDir,
    })!;
    handles.push(handle);

    updateActiveTeamMode({ currentIntent: 'editing foo.ts', activeFiles: ['/r/foo.ts'] });
    expect(handle.writer.getState().currentIntent).toBe('editing foo.ts');
    expect(handle.writer.getState().activeFiles).toEqual(['/r/foo.ts']);
  });

  it('setActiveTeamModeWriter(null) drops the registration', () => {
    const handle = bootstrapTeamMode({
      pid: 1111,
      meta: baseMeta,
      instancesRoot: tempDir,
    })!;
    handles.push(handle);

    expect(getActiveTeamModeWriter()).toBe(handle.writer);
    setActiveTeamModeWriter(null);
    expect(getActiveTeamModeWriter()).toBeNull();
  });
});
