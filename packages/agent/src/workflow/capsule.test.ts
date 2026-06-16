/**
 * FEATURE_217 (v0.7.49) Phase M — workflow capsule contract tests.
 */

import { describe, expect, it } from 'vitest';

import type { WorkflowApi, WorkflowScriptManifest } from './index.js';
import {
  createWorkflowCapsule,
  createWorkflowModuleFromCapsule,
  validateWorkflowCapsule,
} from './index.js';

const manifest: WorkflowScriptManifest = {
  name: 'capsule-demo',
  description: 'Reusable generated workflow',
  phases: ['run'],
  readOnly: true,
  maxAgents: 1,
  maxConcurrency: 1,
  patterns: ['fan-out-and-synthesize'],
};

const source = 'async function run() { return "ok"; }';

function fakeWorkflowApi(): WorkflowApi {
  return {
    runId: 'run-capsule',
    args: {},
    budget: {
      total: null,
      spent: () => 0,
      remaining: () => Infinity,
    },
    phase: async (_name, fn) => fn(),
    spawnAgent: async () => ({ taskId: 'task-1', name: 'task' }),
    runAgent: async () => ({
      taskId: 'task-1',
      name: 'task',
      status: 'completed',
      finalText: 'done',
    }),
    wait: async () => ({
      taskId: 'task-1',
      name: 'task',
      status: 'completed',
      finalText: 'done',
    }),
    snapshot: async () => ({ taskId: 'task-1', name: 'task', status: 'completed' }),
    output: async () => ({ taskId: 'task-1', name: 'task', status: 'completed' }),
    send: async () => {},
    stop: async () => {},
    parallel: async <T>(items: readonly (() => Promise<T>)[]): Promise<T[]> =>
      Promise.all(items.map((item) => item())),
    synthesize: async () => ({ text: 'summary' }),
    artifact: async (name) => ({ name }),
    log: () => {},
  };
}

describe('WorkflowCapsule', () => {
  it('creates and validates the minimal reusable capsule shape', () => {
    const capsule = createWorkflowCapsule({
      minKodaxVersion: '0.7.49',
      manifest,
      source,
      intent: {
        taskClass: 'code-audit',
        originalRequest: '请并行审计 packages/agent',
        reusableFor: ['代码审计', '多候选验证'],
      },
      inputs: {
        description: '传入新的中文 request 即可复用这个 workflow。',
        examples: [{ request: '请审计 packages/repl' }],
      },
      requires: {
        environment: ['git-repo'],
        tools: ['read_file'],
        mcp: ['github'],
        skills: ['feature-list-tracker'],
        modelTiers: ['balanced', 'deep'],
      },
      provenance: {
        fromRunId: 'run-abc',
        createdAt: '2026-06-13T00:00:00.000Z',
        kodaxVersion: '0.7.49',
      },
    });

    expect(capsule.format).toBe('kodax.workflow');
    expect(capsule.version).toBe(1);
    expect(capsule.workflowApiVersion).toBe(1);
    expect(capsule.source).toBe(source);
    expect(validateWorkflowCapsule(capsule)).toEqual(capsule);
  });

  it('rejects malformed capsule identity, source, manifest, and requirements', () => {
    expect(() =>
      validateWorkflowCapsule({
        format: 'other',
        version: 1,
        workflowApiVersion: 1,
        minKodaxVersion: '0.7.49',
        manifest,
        source,
      }),
    ).toThrow(/format/);

    expect(() =>
      validateWorkflowCapsule({
        format: 'kodax.workflow',
        version: 1,
        workflowApiVersion: 1,
        minKodaxVersion: '0.7.49',
        manifest,
        source: '',
      }),
    ).toThrow(/source/);

    expect(() =>
      validateWorkflowCapsule({
        format: 'kodax.workflow',
        version: 1,
        workflowApiVersion: 1,
        minKodaxVersion: '0.7.49',
        manifest: { ...manifest, patterns: ['unsupported'] },
        source,
      }),
    ).toThrow(/unsupported/);

    expect(() =>
      validateWorkflowCapsule({
        format: 'kodax.workflow',
        version: 1,
        workflowApiVersion: 1,
        minKodaxVersion: '0.7.49',
        manifest,
        source,
        requires: { environment: ['docker'] },
      }),
    ).toThrow(/environment/);
  });

  it('materializes a capability-generated workflow module from a capsule', async () => {
    const capsule = createWorkflowCapsule({
      minKodaxVersion: '0.7.49',
      manifest,
      source,
    });

    const module = createWorkflowModuleFromCapsule(capsule);

    expect(module.meta.name).toBe('capsule-demo');
    expect(module.meta.maxAgents).toBe(1);
    await expect(module.run(fakeWorkflowApi(), {})).resolves.toBe('ok');
  });
});
