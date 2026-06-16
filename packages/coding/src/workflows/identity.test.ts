import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { saveGeneratedWorkflow } from './discovery.js';
import { resolveWorkflowIdentity } from './identity.js';

const manifest = {
  name: 'saved-audit',
  description: 'saved audit',
  phases: ['scan'],
  readOnly: true,
  maxAgents: 1,
  maxConcurrency: 1,
  patterns: ['classify-and-act'],
} as const;

describe('resolveWorkflowIdentity', () => {
  let root = '';
  let runs = '';
  let saved = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'wf-identity-'));
    runs = join(root, 'runs');
    saved = join(root, 'saved');
    mkdirSync(runs, { recursive: true });
    mkdirSync(saved, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('resolves historical run ids and saved workflow names', async () => {
    const runDir = join(runs, 'run-1');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, 'run.json'),
      JSON.stringify({
        runId: 'run-1',
        workflow: 'generated-audit',
        status: 'completed',
        displayName: 'Generated Audit',
      }),
      'utf8',
    );
    await saveGeneratedWorkflow({
      dir: saved,
      name: 'saved-audit',
      manifest,
      source: 'export default async function run() { return "ok"; }',
    });

    await expect(resolveWorkflowIdentity({
      target: 'run-1',
      runBaseDir: runs,
      savedWorkflowDirs: { project: saved },
    })).resolves.toMatchObject({
      kind: 'run',
      runId: 'run-1',
      workflowName: 'generated-audit',
      displayName: 'Generated Audit',
    });
    await expect(resolveWorkflowIdentity({
      target: 'saved-audit',
      runBaseDir: runs,
      savedWorkflowDirs: { project: saved },
    })).resolves.toMatchObject({
      kind: 'saved',
      savedWorkflow: {
        name: 'saved-audit',
      },
    });
  });

  it('fails closed when one target matches a run id and saved workflow name', async () => {
    const runDir = join(runs, 'same-name');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, 'run.json'),
      JSON.stringify({ runId: 'same-name', workflow: 'generated', status: 'completed' }),
      'utf8',
    );
    await saveGeneratedWorkflow({
      dir: saved,
      name: 'same-name',
      manifest: { ...manifest, name: 'same-name' },
      source: 'export default async function run() { return "ok"; }',
    });

    await expect(resolveWorkflowIdentity({
      target: 'same-name',
      runBaseDir: runs,
      savedWorkflowDirs: { project: saved },
    })).resolves.toEqual({
      kind: 'ambiguous',
      target: 'same-name',
      matches: ['run', 'saved'],
    });
  });
});
