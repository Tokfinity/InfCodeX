/**
 * FEATURE_217 (v0.7.49) Phase D — Run-graph writer tests.
 */

import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRunGraphWriter } from './run-graph.js';

describe('createRunGraphWriter', () => {
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wf-rg-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('appends events to events.jsonl in order with a timestamp', () => {
    let clock = 1000;
    const writer = createRunGraphWriter(dir, { now: () => (clock += 1) });
    writer.onEvent({ seq: 0, type: 'workflow_started', data: { runId: 'r' } });
    writer.onEvent({ seq: 1, type: 'agent_spawned', data: { taskId: 't1' } });
    const lines = readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!);
    const second = JSON.parse(lines[1]!);
    expect(first.type).toBe('workflow_started');
    expect(second.seq).toBe(1);
    expect(typeof first.ts).toBe('number');
  });

  it('writes an artifact file and returns a ref with its path', () => {
    const writer = createRunGraphWriter(dir);
    const ref = writer.writeArtifact('my report', { findings: 3 });
    expect(ref.name).toBe('my report');
    expect(ref.path).toBeDefined();
    expect(existsSync(ref.path!)).toBe(true);
    expect(JSON.parse(readFileSync(ref.path!, 'utf8'))).toEqual({ findings: 3 });
  });

  it('writes generated workflow script and manifest snapshots', () => {
    const writer = createRunGraphWriter(dir);
    const snapshot = writer.writeScriptSnapshot({
      source: 'async function run() { return "ok"; }',
      manifest: {
        name: 'generated-demo',
        description: 'demo',
        phases: ['run'],
        readOnly: true,
        maxAgents: 1,
        maxConcurrency: 1,
        patterns: ['fan-out-and-synthesize'],
      },
    });

    expect(snapshot.scriptPath.endsWith('script.js')).toBe(true);
    expect(snapshot.manifestPath?.endsWith('manifest.json')).toBe(true);
    expect(readFileSync(snapshot.scriptPath, 'utf8')).toContain('async function run');
    const manifest = JSON.parse(readFileSync(snapshot.manifestPath!, 'utf8'));
    expect(manifest.name).toBe('generated-demo');
  });

  it('writes run.json with run summary', () => {
    const writer = createRunGraphWriter(dir);
    writer.writeRunJson({
      meta: { name: 'demo', description: 'd' },
      args: { q: 'x' },
      startedAt: 1,
      endedAt: 2,
      state: {
        runId: 'run-9',
        status: 'completed',
        totalSpawned: 3,
        events: [{ seq: 0, type: 'workflow_started' }],
        artifacts: [{ name: 'report' }],
      },
      scriptSnapshot: {
        scriptPath: join(dir, 'script.js'),
        manifestPath: join(dir, 'manifest.json'),
      },
    });
    const runJson = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
    expect(runJson).toMatchObject({
      runId: 'run-9',
      workflow: 'demo',
      status: 'completed',
      totalSpawned: 3,
      artifacts: ['report'],
      eventCount: 1,
      scriptSnapshotPath: join(dir, 'script.js'),
      manifestSnapshotPath: join(dir, 'manifest.json'),
    });
  });
});
