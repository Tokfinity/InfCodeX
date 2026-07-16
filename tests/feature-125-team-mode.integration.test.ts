/**
 * FEATURE_125 (v0.7.41) — Team Mode end-to-end integration.
 *
 * Drives all 5 layers with the REAL fs against a temp directory.
 * Lives in the root `tests/` directory so it can import freely from
 * both `@kodax-ai/agent` (layers 1–3) and `@kodax-ai/coding` (layers
 * 4–5). The hermetic per-module tests live alongside each source
 * file; this file is the composition proof.
 *
 * Layers exercised:
 *   1. state-writer
 *   2. instance-discovery
 *   3. system-prompt-injection (buildOtherInstancesPromptBlock)
 *   4. content-hash-cache (cross-process stale-write detection)
 *   5. active-file-warning (sibling overlap detection)
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildOtherInstancesPromptBlock,
  createStateWriter,
  discoverInstances,
} from '@kodax-ai/agent';
import type {
  SessionMeta,
  SessionStateSnapshot,
  StateWriter,
} from '@kodax-ai/agent';

// Coding-layer modules consumed via relative path; cross-package
// integration belongs in this root tests directory per project
// convention.
import { createContentHashCache } from '../packages/coding/src/multi-instance/content-hash-cache.js';
import { formatActiveFileWarning } from '../packages/coding/src/multi-instance/active-file-warning.js';

const baseMeta: SessionMeta = {
  cwd: process.cwd(),
  startedAt: Date.now(),
  gitBranch: 'main',
};

describe('FEATURE_125 — Team Mode multi-layer integration (real fs)', () => {
  let tempDir: string;
  const writers: StateWriter[] = [];

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-team-test-'));
  });

  afterEach(async () => {
    await Promise.all(writers.splice(0).map((w) => w.shutdown()));
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function makeWriter(pid: number, state: SessionStateSnapshot): StateWriter {
    const writer = createStateWriter({
      pid,
      meta: baseMeta,
      initialState: state,
      instancesRoot: tempDir,
      heartbeatIntervalMs: 60_000,
    });
    writers.push(writer);
    return writer;
  }

  it('a single session sees zero siblings (no regression on solo workflow)', () => {
    const writer = makeWriter(1111, {
      agentPhase: 'idle',
      currentIntent: 'starting up',
    });
    const result = discoverInstances({
      instancesRoot: tempDir,
      excludePid: 1111,
    });
    expect(result).toEqual([]);
    void writer;
  });

  it('two live sessions see each other; the freshest peer comes first', async () => {
    const a = makeWriter(1001, {
      agentPhase: 'running_tool',
      currentIntent: 'reviewing packages/ui',
      activeFiles: [path.join('packages', 'ui', 'Button.tsx')],
    });
    await new Promise((r) => setTimeout(r, 15));
    const b = makeWriter(1002, {
      agentPhase: 'awaiting_llm',
      currentIntent: 'auth refactor',
      activeFiles: [path.join('packages', 'api', 'auth.ts')],
    });
    void a;
    void b;

    const fromA = discoverInstances({ instancesRoot: tempDir, excludePid: 1001 });
    expect(fromA.map((i) => i.pid)).toEqual([1002]);

    const fromB = discoverInstances({ instancesRoot: tempDir, excludePid: 1002 });
    expect(fromB.map((i) => i.pid)).toEqual([1001]);

    const fromThird = discoverInstances({ instancesRoot: tempDir, excludePid: 9999 });
    expect(fromThird.map((i) => i.pid)).toEqual([1002, 1001]);
  });

  it('the rendered prompt block reflects peer state and updates after the peer updates', () => {
    const a = makeWriter(1001, {
      agentPhase: 'running_tool',
      currentIntent: 'first task',
      activeFiles: ['packages/ui/Button.tsx'],
    });
    const b = makeWriter(1002, {
      agentPhase: 'running_tool',
      currentIntent: 'second task',
      activeFiles: ['packages/api/auth.ts'],
    });

    let siblings = discoverInstances({ instancesRoot: tempDir, excludePid: 1001 });
    let block = buildOtherInstancesPromptBlock(siblings);
    expect(block).toContain('=== Other active KodaX sessions ===');
    expect(block).toContain('pid 1002');
    expect(block).toContain('second task');
    expect(block).toContain('packages/api/auth.ts');

    b.update({ activeFiles: ['packages/api/session.ts'] });
    siblings = discoverInstances({ instancesRoot: tempDir, excludePid: 1001 });
    block = buildOtherInstancesPromptBlock(siblings);
    expect(block).toContain('packages/api/session.ts');
    expect(block).not.toContain('auth.ts');
    void a;
  });

  it('a session that calls shutdown() drops out of the sibling list immediately', async () => {
    const a = makeWriter(1001, { agentPhase: 'idle' });
    const b = makeWriter(1002, { agentPhase: 'idle' });

    let visible = discoverInstances({ instancesRoot: tempDir, excludePid: 1001 });
    expect(visible.map((i) => i.pid)).toEqual([1002]);

    await b.shutdown();
    const idx = writers.indexOf(b);
    if (idx >= 0) writers.splice(idx, 1);

    visible = discoverInstances({ instancesRoot: tempDir, excludePid: 1001 });
    expect(visible).toEqual([]);
    void a;
  });

  it('the active-file-warning detects overlap and the content-hash cache blocks stale writes', () => {
    const filePath = path.join(tempDir, 'shared.ts');
    fs.writeFileSync(filePath, 'export const v = 1;\n');

    const a = makeWriter(1001, {
      agentPhase: 'running_tool',
      currentIntent: 'editing shared.ts',
      activeFiles: [filePath],
    });

    // Session B reads the file and records its hash.
    const cacheB = createContentHashCache();
    cacheB.recordRead(filePath, fs.readFileSync(filePath, 'utf8'));

    // From B's perspective, A is editing the file → soft warning fires.
    const siblings = discoverInstances({ instancesRoot: tempDir, excludePid: 1002 });
    const warning = formatActiveFileWarning(filePath, siblings);
    expect(warning).not.toBeNull();
    expect(warning).toContain('pid 1001 is editing');
    expect(warning).toContain('editing shared.ts');

    // A modifies the file underneath B.
    fs.writeFileSync(filePath, 'export const v = 2;\n');

    // B's stale check fires → the safety net catches the race.
    const stale = cacheB.checkStale(filePath);
    expect(stale.kind).toBe('stale');
    expect(stale.stale).toBe(true);
    void a;
  });

  it('discoverInstances({reapStale:true}) reaps a stale directory left by a crashed process', () => {
    const crashedDir = path.join(tempDir, '99999');
    fs.mkdirSync(crashedDir, { recursive: true });
    fs.writeFileSync(path.join(crashedDir, 'meta.json'), JSON.stringify(baseMeta));
    fs.writeFileSync(
      path.join(crashedDir, 'state.json'),
      JSON.stringify({
        version: '1',
        pid: 99999,
        updatedAt: Date.now() - 60_000,
        meta: baseMeta,
        agentPhase: 'idle',
      }),
    );
    fs.writeFileSync(path.join(crashedDir, 'heartbeat'), '');
    const longAgo = (Date.now() - 60_000) / 1000;
    fs.utimesSync(path.join(crashedDir, 'heartbeat'), longAgo, longAgo);

    expect(fs.existsSync(crashedDir)).toBe(true);

    discoverInstances({
      instancesRoot: tempDir,
      excludePid: 1001,
      reapStale: true,
    });

    expect(fs.existsSync(crashedDir)).toBe(false);
  });

  it('non-overlapping active_files produce no warning (parallel work scenario A in design doc)', () => {
    const a = makeWriter(1001, {
      agentPhase: 'running_tool',
      currentIntent: 'frontend',
      activeFiles: ['packages/ui/Button.tsx'],
    });
    const b = makeWriter(1002, {
      agentPhase: 'running_tool',
      currentIntent: 'backend',
      activeFiles: ['packages/api/auth.ts'],
    });
    const cacheA = createContentHashCache();
    // A reads its own active file. Hash unchanged → fresh.
    const filePathA = path.join(tempDir, 'a-file.ts');
    fs.writeFileSync(filePathA, 'A content');
    cacheA.recordRead(filePathA, fs.readFileSync(filePathA, 'utf8'));

    const siblings = discoverInstances({ instancesRoot: tempDir, excludePid: 1001 });
    const warning = formatActiveFileWarning(filePathA, siblings);
    expect(warning).toBeNull(); // disjoint files → no warning
    expect(cacheA.checkStale(filePathA).kind).toBe('fresh');
    void a;
    void b;
  });
});
