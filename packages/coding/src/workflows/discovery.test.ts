/**
 * FEATURE_217 (v0.7.49) Phase E — Saved workflow discovery tests.
 */

import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  discoverSavedWorkflows,
  loadSavedWorkflow,
  normalizeWorkflowModule,
  saveGeneratedWorkflow,
  saveGeneratedWorkflowFromRun,
} from './discovery.js';

describe('discoverSavedWorkflows', () => {
  let root = '';
  let project = '';
  let personal = '';
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'wf-disc-'));
    project = join(root, 'project');
    personal = join(root, 'personal');
    mkdirSync(project, { recursive: true });
    mkdirSync(personal, { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const touch = (dir: string, file: string) => writeFileSync(join(dir, file), '// x', 'utf8');

  it('returns empty for missing dirs', async () => {
    expect(await discoverSavedWorkflows({})).toEqual([]);
    expect(await discoverSavedWorkflows({ project: join(root, 'nope') })).toEqual([]);
  });

  it('discovers .ts/.mjs/.js across project + personal', async () => {
    touch(project, 'audit.ts');
    writeFileSync(
      join(project, 'generated.workflow.json'),
      JSON.stringify({
        manifest: {
          name: 'generated',
          description: 'generated',
          phases: ['run'],
          readOnly: true,
          maxAgents: 1,
          maxConcurrency: 1,
          patterns: ['fan-out-and-synthesize'],
        },
        source: 'async function run() { return "ok"; }',
      }),
      'utf8',
    );
    touch(personal, 'triage.mjs');
    touch(personal, 'review.js');
    const refs = await discoverSavedWorkflows({ project, personal });
    expect(refs.map((r) => r.name)).toEqual(['audit', 'generated', 'review', 'triage']);
    expect(refs.find((r) => r.name === 'audit')?.source).toBe('project');
    expect(refs.find((r) => r.name === 'generated')?.execution).toBe('capability-generated');
    expect(refs.find((r) => r.name === 'triage')?.source).toBe('personal');
  });

  it('project wins on name conflict', async () => {
    touch(project, 'shared.ts');
    touch(personal, 'shared.js');
    const refs = await discoverSavedWorkflows({ project, personal });
    expect(refs).toHaveLength(1);
    expect(refs[0]!.source).toBe('project');
  });

  it('prefers .ts over .mjs over .js within a dir', async () => {
    touch(project, 'dup.js');
    touch(project, 'dup.ts');
    const refs = await discoverSavedWorkflows({ project });
    expect(refs).toHaveLength(1);
    expect(refs[0]!.path.endsWith('.ts')).toBe(true);
  });
});

describe('normalizeWorkflowModule', () => {
  const run = async () => 'ok';
  it('accepts a { meta, run } default export', () => {
    const mod = normalizeWorkflowModule({ default: { meta: { name: 'a', description: 'd' }, run } });
    expect(mod.meta.name).toBe('a');
  });
  it('accepts workflow meta + default run fn', () => {
    const mod = normalizeWorkflowModule({ workflow: { name: 'b', description: 'd' }, default: run });
    expect(mod.meta.name).toBe('b');
  });
  it('accepts meta + run named exports', () => {
    const mod = normalizeWorkflowModule({ meta: { name: 'c', description: 'd' }, run });
    expect(mod.meta.name).toBe('c');
  });
  it('throws on an invalid module', () => {
    expect(() => normalizeWorkflowModule({ default: 42 })).toThrow(/invalid workflow module/);
  });
});

describe('loadSavedWorkflow', () => {
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wf-load-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('imports + normalizes a .mjs workflow file', async () => {
    const file = join(dir, 'demo.mjs');
    writeFileSync(
      file,
      'export default { meta: { name: "demo", description: "d", readOnly: true }, run: async () => "done" };\n',
      'utf8',
    );
    const mod = await loadSavedWorkflow(file);
    expect(mod.meta.name).toBe('demo');
    expect(mod.meta.readOnly).toBe(true);
    // The run function is executable.
    expect(await mod.run({} as never, {})).toBe('done');
  });

  it('loads .workflow.json through the restricted workflow runner', async () => {
    const file = join(dir, 'generated.workflow.json');
    writeFileSync(
      file,
      JSON.stringify({
        manifest: {
          name: 'generated',
          description: 'generated',
          phases: ['run'],
          readOnly: true,
          maxAgents: 1,
          maxConcurrency: 1,
          patterns: ['fan-out-and-synthesize'],
        },
        source: 'async function run() { return process.cwd(); }',
      }),
      'utf8',
    );

    const mod = await loadSavedWorkflow(file);
    await expect(mod.run({} as never, {})).rejects.toThrow(/restricted workflow script failed/);
  });
});

describe('saveGeneratedWorkflow', () => {
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wf-save-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const manifest = {
    name: 'saved-demo',
    description: 'saved',
    phases: ['run'],
    readOnly: true,
    maxAgents: 1,
    maxConcurrency: 1,
    patterns: ['fan-out-and-synthesize' as const],
  };

  it('writes a capability-generated workflow file with a safe name', async () => {
    const ref = await saveGeneratedWorkflow({
      dir,
      name: '../unsafe demo',
      manifest,
      source: 'async function run() { return "ok"; }',
    });

    expect(ref.name).toBe('unsafe-demo');
    expect(ref.execution).toBe('capability-generated');
    expect(ref.path.endsWith('unsafe-demo.workflow.json')).toBe(true);
    expect(existsSync(ref.path)).toBe(true);
    const data = JSON.parse(readFileSync(ref.path, 'utf8'));
    expect(data.manifest.name).toBe('saved-demo');
  });

  it('saves from a completed run script snapshot and can rerun it', async () => {
    const runDir = join(dir, 'run-1');
    mkdirSync(runDir, { recursive: true });
    const scriptPath = join(runDir, 'script.js');
    const manifestPath = join(runDir, 'manifest.json');
    writeFileSync(scriptPath, 'async function run() { return "ok"; }', 'utf8');
    writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');
    writeFileSync(
      join(runDir, 'run.json'),
      JSON.stringify({
        runId: 'run-1',
        workflow: 'generated',
        scriptSnapshotPath: scriptPath,
        manifestSnapshotPath: manifestPath,
      }),
      'utf8',
    );

    const ref = await saveGeneratedWorkflowFromRun({
      runDir,
      targetDir: join(dir, 'workflows'),
      name: 'saved-demo',
    });
    const mod = await loadSavedWorkflow(ref.path);
    expect(await mod.run({} as never, {})).toBe('ok');
  });
});
