import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { WorkflowAgentBackend, WorkflowModule } from '@kodax-ai/agent';
import { createWorkflowCapsule } from '@kodax-ai/agent';

import { createWorkflowLifecycleController } from './lifecycle-controller.js';
import { createWorkflowRunManager } from './run-manager.js';
import { loadSavedWorkflowCapsule, saveGeneratedWorkflow } from './discovery.js';

function fakeBackend(): WorkflowAgentBackend {
  let counter = 0;
  const names = new Map<string, string>();
  return {
    spawn: async (input) => {
      counter += 1;
      const taskId = `task-${counter}`;
      names.set(taskId, input.name);
      return { taskId, name: input.name };
    },
    wait: async (taskId) => ({
      taskId,
      name: names.get(taskId) ?? taskId,
      status: 'completed',
      finalText: `done:${taskId}`,
      digest: `Finding: ${taskId} finished.`,
    }),
    output: async (taskId) => ({ taskId, name: names.get(taskId) ?? taskId, status: 'running' }),
    send: async () => {},
    stop: async () => {},
  };
}

describe('WorkflowLifecycleController', () => {
  let dir = '';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wf-lifecycle-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('subscribes, polls, and reads result/artifacts without REPL helpers', async () => {
    const manager = createWorkflowRunManager();
    const controller = createWorkflowLifecycleController({ runManager: manager, runBaseDir: dir });
    const processEvents: string[] = [];
    const unsubscribe = controller.subscribeWorkflowProcess((event) => processEvents.push(event.type));
    const module: WorkflowModule = {
      meta: { name: 'controller-test', description: 'controller', readOnly: true },
      run: async (wf) => {
        await wf.runAgent({ name: 'reader', prompt: 'read', readOnly: true });
        await wf.artifact('report', { ok: true });
        return 'final controller result';
      },
    };

    const run = manager.start({
      module,
      args: {},
      runId: 'run-controller',
      runDir: join(dir, 'run-controller'),
      backend: fakeBackend(),
    });

    await run.done;
    unsubscribe();

    expect(controller.getWorkflowProcessSnapshot('run-controller')?.status).toBe('completed');
    expect(controller.listWorkflowProcessSnapshots()).toHaveLength(1);
    expect(processEvents).toContain('workflow_started');
    expect(processEvents).toContain('workflow_finished');
    await expect(controller.readWorkflowResult('run-controller')).resolves.toBe('final controller result');
    await expect(controller.readWorkflowArtifact('run-controller', 'report')).resolves.toEqual({ ok: true });
  });

  it('preflights workflow capsules through the lifecycle controller', async () => {
    const manager = createWorkflowRunManager();
    const controller = createWorkflowLifecycleController({ runManager: manager, runBaseDir: dir });
    const capsule = createWorkflowCapsule({
      minKodaxVersion: '0.7.49',
      manifest: {
        name: 'needs-tool',
        description: 'needs a tool',
        phases: ['scan'],
        readOnly: true,
        maxAgents: 1,
        maxConcurrency: 1,
        patterns: ['classify-and-act'],
      },
      source: 'export default async function run() { return "ok"; }',
      requires: {
        tools: ['read'],
      },
    });

    const result = await controller.preflightWorkflowCapsule({
      capsule,
      env: {
        availableTools: [],
      },
    });

    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({
      severity: 'error',
      requirement: 'tools:read',
    }));
  });

  it('prunes only terminal persisted runs and protects active runs', async () => {
    const manager = createWorkflowRunManager();
    const controller = createWorkflowLifecycleController({
      runManager: manager,
      runBaseDir: dir,
      now: () => 1_000,
    });
    const terminalDir = join(dir, 'run-old');
    const activeDir = join(dir, 'run-active');
    const module: WorkflowModule = {
      meta: { name: 'active', description: 'active', readOnly: true },
      run: async () => new Promise(() => undefined),
    };
    manager.start({
      module,
      args: {},
      runId: 'run-active',
      runDir: activeDir,
      backend: fakeBackend(),
    });
    mkdirSync(terminalDir, { recursive: true });
    mkdirSync(activeDir, { recursive: true });
    writeFileSync(
      join(terminalDir, 'run.json'),
      JSON.stringify({
        runId: 'run-old',
        workflow: 'old',
        status: 'completed',
        totalSpawned: 0,
        artifacts: [],
        eventCount: 0,
        startedAt: 1,
        endedAt: 2,
        args: {},
      }),
      'utf8',
    );
    writeFileSync(
      join(activeDir, 'run.json'),
      JSON.stringify({
        runId: 'run-active',
        workflow: 'active',
        status: 'running',
        totalSpawned: 0,
        artifacts: [],
        eventCount: 0,
        startedAt: 1,
        endedAt: 2,
        args: {},
      }),
      'utf8',
    );

    const dryRun = await controller.pruneWorkflowRuns({ keep: 0, dryRun: true });
    expect(dryRun).toMatchObject({
      deleted: 0,
      protectedRuns: 1,
      candidates: ['run-old'],
      dryRun: true,
    });

    const actual = await controller.pruneWorkflowRuns({ keep: 0 });
    expect(actual.deleted).toBe(1);
    await expect(controller.readWorkflowArtifact('run-old', 'missing')).resolves.toBeUndefined();
    expect(controller.getWorkflowProcessSnapshot('run-active')?.status).toBe('running');
  });

  it('deletes one terminal persisted run while protecting active or non-terminal runs', async () => {
    const manager = createWorkflowRunManager();
    const controller = createWorkflowLifecycleController({ runManager: manager, runBaseDir: dir });
    const doneDir = join(dir, 'run-done');
    const runningDir = join(dir, 'run-running');
    mkdirSync(doneDir, { recursive: true });
    mkdirSync(runningDir, { recursive: true });
    writeFileSync(
      join(doneDir, 'run.json'),
      JSON.stringify({
        runId: 'run-done',
        workflow: 'done',
        status: 'completed',
        totalSpawned: 0,
        artifacts: [],
        eventCount: 0,
        startedAt: 1,
        endedAt: 2,
        args: {},
      }),
      'utf8',
    );
    writeFileSync(
      join(runningDir, 'run.json'),
      JSON.stringify({
        runId: 'run-running',
        workflow: 'running',
        status: 'running',
        totalSpawned: 0,
        artifacts: [],
        eventCount: 0,
        startedAt: 1,
        endedAt: 0,
        args: {},
      }),
      'utf8',
    );

    await expect(controller.deleteWorkflowRun('run-running')).resolves.toBe(false);
    await expect(controller.deleteWorkflowRun('run-done')).resolves.toBe(true);
    expect(existsSync(doneDir)).toBe(false);
    expect(existsSync(runningDir)).toBe(true);
  });

  it('renames persisted run display names and exposes them in process snapshots', async () => {
    const manager = createWorkflowRunManager();
    const controller = createWorkflowLifecycleController({ runManager: manager, runBaseDir: dir });
    const runPath = join(dir, 'run-display');
    mkdirSync(runPath, { recursive: true });
    writeFileSync(
      join(runPath, 'run.json'),
      JSON.stringify({
        runId: 'run-display',
        workflow: 'generated',
        status: 'completed',
        totalSpawned: 0,
        artifacts: [],
        eventCount: 0,
        startedAt: 1,
        endedAt: 2,
        args: {},
      }),
      'utf8',
    );

    await expect(controller.renameWorkflowRun('run-display', 'Readable Audit')).resolves.toBe(true);

    expect(controller.getWorkflowProcessSnapshot('run-display')).toMatchObject({
      runId: 'run-display',
      workflowName: 'generated',
      displayName: 'Readable Audit',
    });
  });

  it('resolves and renames saved workflow capsules through the lifecycle controller', async () => {
    const manager = createWorkflowRunManager();
    const savedDir = join(dir, 'saved');
    const controller = createWorkflowLifecycleController({
      runManager: manager,
      runBaseDir: dir,
      savedWorkflowDirs: { project: savedDir },
    });
    await saveGeneratedWorkflow({
      dir: savedDir,
      name: 'saved-audit',
      manifest: {
        name: 'saved-audit',
        description: 'saved audit',
        phases: ['scan'],
        readOnly: true,
        maxAgents: 1,
        maxConcurrency: 1,
        patterns: ['classify-and-act'],
      },
      source: 'export default async function run() { return "ok"; }',
    });

    await expect(controller.resolveWorkflowIdentity('saved-audit')).resolves.toMatchObject({
      kind: 'saved',
      savedWorkflow: {
        name: 'saved-audit',
      },
    });
    const renamed = await controller.renameSavedWorkflow('saved-audit', 'Saved Audit v2');

    expect(renamed?.name).toBe('Saved-Audit-v2');
    expect(renamed?.path.endsWith('Saved-Audit-v2.workflow.json')).toBe(true);
    await expect(loadSavedWorkflowCapsule(renamed?.path ?? '')).resolves.toMatchObject({
      manifest: {
        name: 'Saved-Audit-v2',
      },
    });
  });

  it('replaces saved workflow capsules through the lifecycle controller', async () => {
    const manager = createWorkflowRunManager();
    const savedDir = join(dir, 'saved-replace');
    const controller = createWorkflowLifecycleController({
      runManager: manager,
      runBaseDir: dir,
      savedWorkflowDirs: { project: savedDir },
    });
    await saveGeneratedWorkflow({
      dir: savedDir,
      name: 'saved-audit',
      manifest: {
        name: 'saved-audit',
        description: 'saved audit',
        phases: ['scan'],
        readOnly: true,
        maxAgents: 1,
        maxConcurrency: 1,
        patterns: ['classify-and-act'],
      },
      source: 'export default async function run() { return "old"; }',
    });

    const replaced = await controller.replaceSavedWorkflow({
      name: 'saved-audit',
      manifest: {
        name: 'generated-revision',
        description: 'saved audit revision',
        phases: ['scan'],
        readOnly: true,
        maxAgents: 1,
        maxConcurrency: 1,
        patterns: ['classify-and-act'],
      },
      source: 'export default async function run() { return "new"; }',
      provenance: {
        fromWorkflowName: 'saved-audit',
        revisionOf: 'saved-audit',
        replacesWorkflowName: 'saved-audit',
        createdAt: '2026-06-15T00:00:00.000Z',
        kodaxVersion: '0.7.50',
      },
    });

    expect(replaced?.name).toBe('saved-audit');
    expect(existsSync(replaced?.previousPath ?? '')).toBe(true);
    await expect(loadSavedWorkflowCapsule(replaced?.path ?? '')).resolves.toMatchObject({
      manifest: {
        name: 'saved-audit',
        description: 'saved audit revision',
      },
      provenance: {
        replacesWorkflowName: 'saved-audit',
      },
    });
  });

  it('skips malformed persisted event lines and rejects path-like run ids', async () => {
    const manager = createWorkflowRunManager();
    const controller = createWorkflowLifecycleController({ runManager: manager, runBaseDir: dir });
    const runPath = join(dir, 'run-persisted');
    mkdirSync(runPath, { recursive: true });
    writeFileSync(
      join(runPath, 'run.json'),
      JSON.stringify({
        runId: 'run-persisted',
        workflow: 'persisted',
        status: 'completed',
        totalSpawned: 1,
        artifacts: [],
        eventCount: 3,
        startedAt: 1,
        endedAt: 2,
        args: {},
      }),
      'utf8',
    );
    writeFileSync(
      join(runPath, 'events.jsonl'),
      [
        JSON.stringify({ seq: 0, type: 'workflow_started' }),
        '{bad json',
        JSON.stringify({
          seq: 1,
          type: 'agent_completed',
          data: {
            taskId: 'task-1',
            name: 'reader',
            status: 'completed',
            summary: 'persisted result',
          },
        }),
        JSON.stringify({ seq: 2, type: 'workflow_completed' }),
      ].join('\n'),
      'utf8',
    );

    expect(controller.getWorkflowProcessSnapshot('.')?.status).toBeUndefined();
    expect(controller.getWorkflowProcessSnapshot('run-persisted')?.status).toBe('completed');
    await expect(controller.readWorkflowResult('run-persisted')).resolves.toBe('persisted result');
  });
});
