import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { createRestrictedWorkflowModule } from '@kodax-ai/agent';
import type { WorkflowModule, WorkflowScriptManifest } from '@kodax-ai/agent';

import { startManagedWorkflow } from './host.js';
import type {
  ManagedWorkflowRun,
  ManagedWorkflowSnapshot,
  WorkflowRunManager,
} from './run-manager.js';
import type {
  RunWorkflowFromOptionsInput,
  RunWorkflowModuleOutcome,
} from './workflow-runner.js';
import type { WorkflowGenerationResult } from './generator.js';
import type { KodaXOptions } from '../types.js';

const MANIFEST: WorkflowScriptManifest = {
  name: 'inline-wf',
  description: 'inline test workflow',
  phases: ['investigate'],
  readOnly: true,
  maxAgents: 4,
  maxConcurrency: 2,
  patterns: ['fan-out-and-synthesize'],
};

const SOURCE = 'async function run(wf, args) { return { synthesis: "ok" }; }';

function completedOutcome(runId: string): RunWorkflowModuleOutcome {
  return {
    kind: 'completed',
    result: { synthesis: 'ok' },
    state: { runId, status: 'completed', totalSpawned: 0, events: [], artifacts: [] },
  };
}

function fakeManager(): { manager: WorkflowRunManager; calls: RunWorkflowFromOptionsInput[] } {
  const calls: RunWorkflowFromOptionsInput[] = [];
  const run = (runId: string): ManagedWorkflowRun => ({
    runId,
    done: Promise.resolve(completedOutcome(runId)),
    getSnapshot: (): ManagedWorkflowSnapshot | undefined => undefined,
    getProcessSnapshot: () => undefined,
  });
  const manager: WorkflowRunManager = {
    start: () => {
      throw new Error('start() not used by the host');
    },
    startFromOptions: (input) => {
      calls.push(input);
      return run(input.runId);
    },
    list: () => [],
    get: () => undefined,
    subscribeWorkflowProcess: () => () => {},
    getWorkflowProcessSnapshot: () => undefined,
    listWorkflowProcessSnapshots: () => [],
    pause: () => false,
    resume: () => false,
    stop: () => false,
  };
  return { manager, calls };
}

const OPTIONS = {} as KodaXOptions;
const RUNS_DIR = join('/tmp', 'kodax-runs');

describe('startManagedWorkflow', () => {
  it('inline: validates + builds the module, mints run dir, starts on the manager', async () => {
    const { manager, calls } = fakeManager();
    const result = await startManagedWorkflow({
      source: { kind: 'inline', manifest: MANIFEST, source: SOURCE },
      args: { request: 'x' },
      options: OPTIONS,
      runsBaseDir: RUNS_DIR,
      runId: 'run-inline',
      manager,
    });
    expect(result.kind).toBe('started');
    if (result.kind !== 'started') return;
    expect(result.runId).toBe('run-inline');
    expect(result.runDir).toBe(join(RUNS_DIR, 'run-inline'));
    expect(result.scriptSnapshot).toEqual({ manifest: MANIFEST, source: SOURCE });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.runId).toBe('run-inline');
    expect(calls[0]?.runDir).toBe(join(RUNS_DIR, 'run-inline'));
    expect(calls[0]?.module.meta.name).toBe('inline-wf');
    expect(calls[0]?.args).toEqual({ request: 'x' });
  });

  it('inline: rejects a malformed manifest through the same gate as generation', async () => {
    const { manager } = fakeManager();
    await expect(
      startManagedWorkflow({
        source: { kind: 'inline', manifest: { name: 'bad' }, source: SOURCE },
        args: {},
        options: OPTIONS,
        runsBaseDir: RUNS_DIR,
        runId: 'run-bad',
        manager,
      }),
    ).rejects.toThrow();
  });

  it('request: returns declined when the generator declines (no run started)', async () => {
    const { manager, calls } = fakeManager();
    const result = await startManagedWorkflow({
      source: { kind: 'request', request: 'just say hi' },
      args: {},
      options: OPTIONS,
      runsBaseDir: RUNS_DIR,
      manager,
      generateWorkflow: async () =>
        ({ kind: 'declined', reason: 'too simple', rawText: '{}' }) satisfies WorkflowGenerationResult,
    });
    expect(result).toEqual({ kind: 'declined', reason: 'too simple' });
    expect(calls).toHaveLength(0);
  });

  it('request: starts the generated module + threads its script snapshot', async () => {
    const { manager, calls } = fakeManager();
    const module = createRestrictedWorkflowModule({ manifest: MANIFEST, source: SOURCE });
    const result = await startManagedWorkflow({
      source: { kind: 'request', request: 'audit the diff' },
      args: {},
      options: OPTIONS,
      runsBaseDir: RUNS_DIR,
      runId: 'run-gen',
      manager,
      generateWorkflow: async () =>
        ({
          kind: 'generated',
          manifest: MANIFEST,
          source: SOURCE,
          module,
          scriptSnapshot: { manifest: MANIFEST, source: SOURCE },
          approvalSummary: 'audit summary',
          rawText: '{}',
        }) satisfies WorkflowGenerationResult,
    });
    expect(result.kind).toBe('started');
    expect(calls[0]?.module).toBe(module);
    expect(calls[0]?.scriptSnapshot).toEqual({ manifest: MANIFEST, source: SOURCE });
  });

  it('saved: starts the provided module with no script snapshot', async () => {
    const { manager, calls } = fakeManager();
    const module: WorkflowModule = createRestrictedWorkflowModule({ manifest: MANIFEST, source: SOURCE });
    const result = await startManagedWorkflow({
      source: { kind: 'saved', module },
      args: {},
      options: OPTIONS,
      runsBaseDir: RUNS_DIR,
      runId: 'run-saved',
      manager,
    });
    expect(result.kind).toBe('started');
    if (result.kind === 'started') expect(result.scriptSnapshot).toBeUndefined();
    expect(calls[0]?.scriptSnapshot).toBeUndefined();
  });

  it('threads the approval gate through to the manager', async () => {
    const { manager, calls } = fakeManager();
    const approval = (): boolean => true;
    await startManagedWorkflow({
      source: { kind: 'inline', manifest: MANIFEST, source: SOURCE },
      args: {},
      options: OPTIONS,
      runsBaseDir: RUNS_DIR,
      runId: 'run-appr',
      manager,
      approval,
    });
    expect(calls[0]?.approval).toBe(approval);
  });
});
