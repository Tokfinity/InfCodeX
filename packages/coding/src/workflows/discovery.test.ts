/**
 * FEATURE_217 (v0.7.49) Phase E — Saved workflow discovery tests.
 */

import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  discoverSavedWorkflows,
  loadGeneratedWorkflowFromRun,
  loadSavedWorkflow,
  loadSavedWorkflowCapsule,
  normalizeWorkflowModule,
  preflightWorkflowCapsule,
  renameSavedWorkflow,
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

  it('rejects .workflow.json files with an unsupported explicit format', async () => {
    const file = join(dir, 'future.workflow.json');
    writeFileSync(
      file,
      JSON.stringify({
        format: 'kodax.workflow.v2',
        manifest: {
          name: 'future',
          description: 'future',
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

    await expect(loadSavedWorkflow(file)).rejects.toThrow(/unsupported workflow capsule format/);
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
    const data = JSON.parse(readFileSync(ref.path, 'utf8')) as Record<string, unknown>;
    expect(data.format).toBe('kodax.workflow');
    expect(data.version).toBe(1);
    expect(data.source).toBe('async function run() { return "ok"; }');
    expect((data.manifest as { readonly name?: string }).name).toBe('saved-demo');
  });

  it('saves from a completed run script snapshot as a reusable capsule', async () => {
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
        args: { request: '请审计 packages/agent' },
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
    const data = JSON.parse(readFileSync(ref.path, 'utf8')) as Record<string, unknown>;
    const provenance = data.provenance as { readonly fromRunId?: string } | undefined;
    const inputs = data.inputs as { readonly examples?: readonly unknown[] } | undefined;
    expect(data.format).toBe('kodax.workflow');
    expect(provenance?.fromRunId).toBe('run-1');
    expect(inputs?.examples).toEqual([{ request: '请审计 packages/agent' }]);

    const mod = await loadSavedWorkflow(ref.path);
    expect(await mod.run({} as never, {})).toBe('ok');
  });

  it('loads a generated workflow directly from run history without saving it', async () => {
    const runDir = join(dir, 'run-2');
    mkdirSync(runDir, { recursive: true });
    const scriptPath = join(runDir, 'script.js');
    const manifestPath = join(runDir, 'manifest.json');
    writeFileSync(scriptPath, 'async function run() { return "rerun-ok"; }', 'utf8');
    writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');
    writeFileSync(
      join(runDir, 'run.json'),
      JSON.stringify({
        runId: 'run-2',
        workflow: 'generated',
        args: { request: '请检查旧目标' },
        scriptSnapshotPath: scriptPath,
        manifestSnapshotPath: manifestPath,
      }),
      'utf8',
    );

    const loaded = await loadGeneratedWorkflowFromRun({ runDir });
    expect(loaded.capsule.provenance?.fromRunId).toBe('run-2');
    expect(await loaded.module.run({} as never, {})).toBe('rerun-ok');
  });

  it('renames generated workflow capsules and updates manifest identity', async () => {
    const ref = await saveGeneratedWorkflow({
      dir,
      name: 'old-name',
      manifest: { ...manifest, name: 'old-name' },
      source: 'async function run() { return "ok"; }',
    });

    const renamed = await renameSavedWorkflow({
      dirs: { project: dir },
      name: 'old-name',
      newName: 'new name',
    });

    expect(renamed.name).toBe('new-name');
    expect(existsSync(ref.path)).toBe(false);
    expect(existsSync(renamed.path)).toBe(true);
    const capsule = await loadSavedWorkflowCapsule(renamed.path);
    expect(capsule.manifest.name).toBe('new-name');
  });

  it('preflights lightweight capsule requirements against the current environment', async () => {
    const ref = await saveGeneratedWorkflow({
      dir,
      name: 'needs-worktree',
      manifest: { ...manifest, mayUseWorktree: true },
      source: 'async function run() { return "ok"; }',
      requires: {
        environment: ['git-repo', 'worktree-capable'],
        skills: ['feature-list-tracker'],
      },
    });
    const loaded = await loadGeneratedWorkflowFromRun({
      runDir: (() => {
        const runDir = join(dir, 'run-preflight');
        mkdirSync(runDir, { recursive: true });
        writeFileSync(join(runDir, 'script.js'), 'async function run() { return "ok"; }', 'utf8');
        writeFileSync(join(runDir, 'manifest.json'), JSON.stringify(manifest), 'utf8');
        writeFileSync(
          join(runDir, 'run.json'),
          JSON.stringify({
            runId: 'run-preflight',
            workflow: 'generated',
            scriptSnapshotPath: join(runDir, 'script.js'),
            manifestSnapshotPath: join(runDir, 'manifest.json'),
          }),
          'utf8',
        );
        return runDir;
      })(),
    });

    const fileData = JSON.parse(readFileSync(ref.path, 'utf8')) as Record<string, unknown>;
    const result = preflightWorkflowCapsule(
      {
        ...loaded.capsule,
        requires: fileData.requires as typeof loaded.capsule.requires,
      },
      {
        isGitRepo: false,
        worktreeCapable: false,
        availableSkills: [],
      },
    );
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.requirement)).toEqual([
      'environment:git-repo',
      'environment:worktree-capable',
      'skills:feature-list-tracker',
    ]);
  });

  it('rejects capsules that require a newer KodaX version', async () => {
    const ref = await saveGeneratedWorkflow({
      dir,
      name: 'future-version',
      manifest,
      source: 'async function run() { return "ok"; }',
      minKodaxVersion: '99.0.0',
    });
    const capsule = await loadSavedWorkflowCapsule(ref.path);

    const result = preflightWorkflowCapsule(capsule, { kodaxVersion: '0.7.49' });

    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual({
      severity: 'error',
      requirement: 'kodax:min-version',
      message: 'workflow requires KodaX >= 99.0.0, current version is 0.7.49',
    });
  });

  it('warns when dependency inventories are unavailable instead of silently skipping them', async () => {
    const ref = await saveGeneratedWorkflow({
      dir,
      name: 'needs-inventory',
      manifest,
      source: 'async function run() { return "ok"; }',
      requires: {
        tools: ['bash'],
        mcp: ['github'],
        skills: ['feature-list-tracker'],
      },
    });
    const capsule = await loadSavedWorkflowCapsule(ref.path);

    const result = preflightWorkflowCapsule(capsule, {
      isGitRepo: true,
      worktreeCapable: true,
    });

    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([
      {
        severity: 'warning',
        requirement: 'tools:bash',
        message: 'workflow requires tools:bash, but no tools inventory was provided',
      },
      {
        severity: 'warning',
        requirement: 'mcp:github',
        message: 'workflow requires mcp:github, but no mcp inventory was provided',
      },
      {
        severity: 'warning',
        requirement: 'skills:feature-list-tracker',
        message: 'workflow requires skills:feature-list-tracker, but no skills inventory was provided',
      },
    ]);
  });
});
