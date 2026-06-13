import { describe, expect, it } from 'vitest';

import type {
  WorkflowApi,
  WorkflowArtifactRef,
  WorkflowTaskHandle,
  WorkflowTaskResult,
  WorkflowTaskSnapshot,
} from './index.js';
import {
  createRestrictedWorkflowModule,
  runRestrictedWorkflowScript,
  WorkflowScriptExecutionError,
} from './index.js';

function notImplemented(name: string): never {
  throw new Error(`${name} not implemented`);
}

function fakeWorkflowApi(): { wf: WorkflowApi; prompts: string[] } {
  const prompts: string[] = [];
  const wf: WorkflowApi = {
    runId: 'run-script',
    args: undefined,
    budget: {
      total: 100,
      spent: () => 0,
      remaining: () => 100,
    },
    phase: async (_name, fn) => fn(),
    spawnAgent: async (input): Promise<WorkflowTaskHandle> => {
      prompts.push(input.prompt);
      return { taskId: 'task-1', name: input.name };
    },
    runAgent: async (input): Promise<WorkflowTaskResult> => {
      prompts.push(input.prompt);
      return {
        taskId: 'task-1',
        name: input.name,
        status: 'completed',
        finalText: `done:${input.prompt}`,
      };
    },
    wait: async (): Promise<WorkflowTaskResult> => notImplemented('wait'),
    output: async (): Promise<WorkflowTaskSnapshot> => notImplemented('output'),
    send: async (): Promise<void> => notImplemented('send'),
    stop: async (): Promise<void> => notImplemented('stop'),
    parallel: async <T>(items: readonly (() => Promise<T>)[]): Promise<T[]> =>
      Promise.all(items.map((item) => item())),
    synthesize: async () => ({ text: 'synthesis' }),
    artifact: async (name): Promise<WorkflowArtifactRef> => ({ name }),
    log: () => {},
  };
  return { wf, prompts };
}

describe('runRestrictedWorkflowScript', () => {
  it('runs a generated script through WorkflowApi only', async () => {
    const { wf, prompts } = fakeWorkflowApi();
    const result = await runRestrictedWorkflowScript({
      wf,
      args: { question: 'where is the bug?' },
      source: `
        async function run(wf, args) {
          const first = await wf.runAgent({
            name: 'reader',
            prompt: args.question,
            readOnly: true
          });
          return { text: first.finalText, remaining: wf.budget.remaining() };
        }
      `,
    });

    expect(result).toEqual({ text: 'done:where is the bug?', remaining: 100 });
    expect(prompts).toEqual(['where is the bug?']);
  });

  it('denies direct Node process, require, and dynamic import access', async () => {
    const { wf } = fakeWorkflowApi();
    await expect(
      runRestrictedWorkflowScript({
        wf,
        source: 'async function run() { return process.cwd(); }',
      }),
    ).rejects.toBeInstanceOf(WorkflowScriptExecutionError);

    await expect(
      runRestrictedWorkflowScript({
        wf,
        source: 'async function run() { return require("node:fs"); }',
      }),
    ).rejects.toBeInstanceOf(WorkflowScriptExecutionError);

    await expect(
      runRestrictedWorkflowScript({
        wf,
        source: 'async function run() { return await import("node:fs"); }',
      }),
    ).rejects.toBeInstanceOf(WorkflowScriptExecutionError);
  });

  it('times out synchronous runaway scripts', async () => {
    const { wf } = fakeWorkflowApi();
    await expect(
      runRestrictedWorkflowScript({
        wf,
        timeoutMs: 10,
        source: 'async function run() { while (true) {} }',
      }),
    ).rejects.toBeInstanceOf(WorkflowScriptExecutionError);
  });
});

describe('createRestrictedWorkflowModule', () => {
  it('turns a manifest + generated source into a WorkflowModule', async () => {
    const { wf } = fakeWorkflowApi();
    const module = createRestrictedWorkflowModule({
      manifest: {
        name: 'generated-demo',
        description: 'demo',
        phases: ['run'],
        readOnly: true,
        maxAgents: 1,
        maxConcurrency: 1,
        patterns: ['fan-out-and-synthesize'],
      },
      source: 'async function run() { return "ok"; }',
    });

    expect(module.meta).toMatchObject({
      name: 'generated-demo',
      readOnly: true,
      maxAgents: 1,
      maxConcurrency: 1,
    });
    expect(await module.run(wf, {})).toBe('ok');
  });
});
