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

function fakeWorkflowApi(): { wf: WorkflowApi; prompts: string[]; phases: string[] } {
  const prompts: string[] = [];
  const phases: string[] = [];
  const wf: WorkflowApi = {
    runId: 'run-script',
    args: undefined,
    budget: {
      total: 100,
      spent: () => 0,
      remaining: () => 100,
    },
    phase: async (name, fn) => {
      phases.push(`start:${name}`);
      try {
        return await fn();
      } finally {
        phases.push(`finish:${name}`);
      }
    },
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
  return { wf, prompts, phases };
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

  it('does not expose host objects through constructor-chain escapes', async () => {
    const { wf } = fakeWorkflowApi();
    await expect(
      runRestrictedWorkflowScript({
        wf,
        source: `
          async function run(wf) {
            return wf.constructor.constructor('return process')().versions.node;
          }
        `,
      }),
    ).rejects.toBeInstanceOf(WorkflowScriptExecutionError);

    await expect(
      runRestrictedWorkflowScript({
        wf,
        source: `
          async function run() {
            return globalThis.constructor.constructor('return process')().versions.node;
          }
        `,
      }),
    ).rejects.toBeInstanceOf(WorkflowScriptExecutionError);
  });

  it('keeps dynamic JavaScript orchestration through wf.parallel', async () => {
    const { wf, prompts } = fakeWorkflowApi();
    const result = await runRestrictedWorkflowScript({
      wf,
      args: { targets: ['a', 'b', 'c'] },
      source: `
        async function run(wf, args) {
          const jobs = args.targets.map((target) => async () => {
            const result = await wf.runAgent({
              name: 'check-' + target,
              prompt: 'check ' + target,
              readOnly: true
            });
            return result.finalText;
          });
          const results = await wf.parallel(jobs, { concurrency: 2 });
          return { count: results.length, results };
        }
      `,
    });

    expect(result).toEqual({
      count: 3,
      results: ['done:check a', 'done:check b', 'done:check c'],
    });
    expect(prompts).toEqual(['check a', 'check b', 'check c']);
  });

  it('bridges generated phase scopes to the host runtime', async () => {
    const { wf, phases } = fakeWorkflowApi();
    const result = await runRestrictedWorkflowScript({
      wf,
      source: `
        async function run(wf) {
          return wf.phase('review', async () => {
            const one = await wf.runAgent({ name: 'r', prompt: 'review', readOnly: true });
            return one.finalText;
          });
        }
      `,
    });

    expect(result).toBe('done:review');
    expect(phases).toEqual(['start:review', 'finish:review']);
  });

  it('propagates host phase failures instead of swallowing them', async () => {
    const { wf } = fakeWorkflowApi();
    const failingPhaseWorkflow: WorkflowApi = {
      ...wf,
      phase: async () => {
        throw new Error('phase writer failed');
      },
    };

    await expect(
      runRestrictedWorkflowScript({
        wf: failingPhaseWorkflow,
        source: `
          async function run(wf) {
            return wf.phase('broken', async () => 'unreached');
          }
        `,
      }),
    ).rejects.toThrow(/phase writer failed/);
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
