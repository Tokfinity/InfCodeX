import { describe, expect, it, vi } from 'vitest';

import { Script } from 'node:vm';

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
  validateRestrictedWorkflowSource,
  WorkflowScriptExecutionError,
} from './index.js';
import { DEFAULT_WORKFLOW_SCRIPT_SYNC_TIMEOUT_MS } from './script-runner.js';

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
    snapshot: async (): Promise<WorkflowTaskSnapshot> => notImplemented('snapshot'),
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
  it('does not arm node:vm watchdog timeouts for trusted host RPC polling', async () => {
    const { wf } = fakeWorkflowApi();
    const originalRunInContext = Script.prototype.runInContext;
    const optionsSeen: unknown[] = [];
    const spy = vi
      .spyOn(Script.prototype, 'runInContext')
      .mockImplementation(function (
        this: Script,
        context: Parameters<Script['runInContext']>[0],
        options?: Parameters<Script['runInContext']>[1],
      ): ReturnType<Script['runInContext']> {
        optionsSeen.push(options);
        const args = options === undefined ? [context] : [context, options];
        return Reflect.apply(originalRunInContext, this, args) as ReturnType<Script['runInContext']>;
      });

    try {
      await expect(
        runRestrictedWorkflowScript({
          wf,
          source: `
            async function run(wf) {
              const result = await wf.runAgent({
                name: 'reader',
                prompt: 'check rpc timeout usage',
                readOnly: true
              });
              return result.finalText;
            }
          `,
        }),
      ).resolves.toBe('done:check rpc timeout usage');
    } finally {
      spy.mockRestore();
    }

    expect(optionsSeen.length).toBeGreaterThan(2);
    expect(optionsSeen[0]).toBeUndefined();
    expect(optionsSeen[1]).toMatchObject({ timeout: DEFAULT_WORKFLOW_SCRIPT_SYNC_TIMEOUT_MS });
    expect(optionsSeen.slice(2).every((options) => options === undefined)).toBe(true);
  });

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

  it('exposes snapshot as the preferred task snapshot alias', async () => {
    const { wf } = fakeWorkflowApi();
    const result = await runRestrictedWorkflowScript({
      wf: {
        ...wf,
        snapshot: async (taskId): Promise<WorkflowTaskSnapshot> => ({
          taskId,
          name: 'reader',
          status: 'running',
          lastText: 'partial',
        }),
      },
      source: `
        async function run(wf) {
          const snapshot = await wf.snapshot('task-123');
          return { status: snapshot.status, lastText: snapshot.lastText };
        }
      `,
    });

    expect(result).toEqual({ status: 'running', lastText: 'partial' });
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

  it('wraps compile failures as workflow script execution errors', async () => {
    const { wf } = fakeWorkflowApi();
    await expect(
      runRestrictedWorkflowScript({
        wf,
        source: [
          'async function run() {',
          '  return "line one',
          'line two";',
          '}',
        ].join('\n'),
      }),
    ).rejects.toThrow(/restricted workflow script failed to compile/);
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

  it('fails invalid task commands inside the script boundary', async () => {
    const { wf } = fakeWorkflowApi();
    await expect(
      runRestrictedWorkflowScript({
        wf,
        source: `
          async function run(wf) {
            void wf.stop('', 'missing task id');
            return 'unreached';
          }
        `,
      }),
    ).rejects.toThrow(/taskId must be a non-empty string/);
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

  it('does not use the sync timeout as a 10s wall-clock cap for child waits', async () => {
    vi.useFakeTimers();
    try {
      const startedAt = new Date('2026-06-13T10:00:00.000Z');
      vi.setSystemTime(startedAt);
      const { wf } = fakeWorkflowApi();
      let resolveAgent: ((result: WorkflowTaskResult) => void) | undefined;
      const slowWorkflowApi: WorkflowApi = {
        ...wf,
        runAgent: async (input): Promise<WorkflowTaskResult> => {
          void input;
          return new Promise<WorkflowTaskResult>((resolve) => {
            resolveAgent = resolve;
          });
        },
      };

      const run = runRestrictedWorkflowScript({
        wf: slowWorkflowApi,
        source: `
          async function run(wf) {
            const result = await wf.runAgent({
              name: 'slow-reader',
              prompt: 'slow but valid',
              readOnly: true
            });
            return result.finalText;
          }
        `,
      });

      await vi.advanceTimersByTimeAsync(1);
      vi.setSystemTime(new Date(startedAt.getTime() + 10_050));
      await vi.advanceTimersByTimeAsync(1);
      resolveAgent?.({
        taskId: 'task-slow',
        name: 'slow-reader',
        status: 'completed',
        finalText: 'done:slow but valid',
      });
      await vi.advanceTimersByTimeAsync(1);
      await expect(run).resolves.toBe('done:slow but valid');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not apply a default total wall-clock timeout to long agent workflows', async () => {
    vi.useFakeTimers();
    try {
      const startedAt = new Date('2026-06-13T10:00:00.000Z');
      vi.setSystemTime(startedAt);
      const { wf } = fakeWorkflowApi();
      let resolveAgent: ((result: WorkflowTaskResult) => void) | undefined;
      const slowWorkflowApi: WorkflowApi = {
        ...wf,
        runAgent: async (input): Promise<WorkflowTaskResult> => {
          void input;
          return new Promise<WorkflowTaskResult>((resolve) => {
            resolveAgent = resolve;
          });
        },
      };

      const run = runRestrictedWorkflowScript({
        wf: slowWorkflowApi,
        source: `
          async function run(wf) {
            const result = await wf.runAgent({
              name: 'very-slow-reader',
              prompt: 'slow but still valid',
              readOnly: true
            });
            return result.finalText;
          }
        `,
      });

      await vi.advanceTimersByTimeAsync(1);
      vi.setSystemTime(new Date(startedAt.getTime() + 31 * 60 * 1_000));
      await vi.advanceTimersByTimeAsync(1);
      resolveAgent?.({
        taskId: 'task-very-slow',
        name: 'very-slow-reader',
        status: 'completed',
        finalText: 'done:slow but still valid',
      });
      await vi.advanceTimersByTimeAsync(1);
      await expect(run).resolves.toBe('done:slow but still valid');
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a runAgent call with a missing prompt instead of spawning a child', async () => {
    const { wf, prompts } = fakeWorkflowApi();
    await expect(
      runRestrictedWorkflowScript({
        wf,
        source: `
          async function run(wf) {
            return await wf.runAgent({ name: 'reader' });
          }
        `,
      }),
    ).rejects.toThrow(/runAgent input prompt must be a non-empty string/);
    expect(prompts).toEqual([]);
  });

  it('rejects a spawnAgent call with a blank name', async () => {
    const { wf } = fakeWorkflowApi();
    await expect(
      runRestrictedWorkflowScript({
        wf,
        source: `
          async function run(wf) {
            return await wf.spawnAgent({ name: '   ', prompt: 'do work' });
          }
        `,
      }),
    ).rejects.toThrow(/spawnAgent input name must be a non-empty string/);
  });

  it('rejects a runAgent call whose readOnly flag is not a boolean', async () => {
    const { wf, prompts } = fakeWorkflowApi();
    await expect(
      runRestrictedWorkflowScript({
        wf,
        source: `
          async function run(wf) {
            return await wf.runAgent({ name: 'reader', prompt: 'do work', readOnly: 'yes' });
          }
        `,
      }),
    ).rejects.toThrow(/readOnly must be a boolean/);
    expect(prompts).toEqual([]);
  });

  it('validates runAgent verification postconditions at the script boundary', async () => {
    const { wf, prompts } = fakeWorkflowApi();
    await expect(
      runRestrictedWorkflowScript({
        wf,
        source: `
          async function run(wf) {
            return await wf.runAgent({
              name: 'writer',
              prompt: 'write docs',
              readOnly: false,
              verification: { requiresMutation: 'yes' }
            });
          }
        `,
      }),
    ).rejects.toThrow(/verification requiresMutation must be a boolean/);
    expect(prompts).toEqual([]);

    await expect(
      runRestrictedWorkflowScript({
        wf,
        source: `
          async function run(wf) {
            return await wf.runAgent({
              name: 'writer',
              prompt: 'write docs',
              readOnly: false,
              verification: { enforcement: 'loud' }
            });
          }
        `,
      }),
    ).rejects.toThrow(/verification enforcement must be "hard" or "warn"/);

    const seen: Array<unknown> = [];
    const wfWithVerifier: WorkflowApi = {
      ...wf,
      runAgent: async (input): Promise<WorkflowTaskResult> => {
        seen.push(input.verification);
        return {
          taskId: 'task-1',
          name: input.name,
          status: 'completed',
          finalText: 'done',
        };
      },
    };

    await runRestrictedWorkflowScript({
      wf: wfWithVerifier,
      source: `
        async function run(wf) {
          const result = await wf.runAgent({
            name: 'writer',
            prompt: 'write docs',
            readOnly: false,
            verification: {
              requiresMutation: true,
              enforcement: 'warn',
              requiredChangedPaths: ['docs/features/v0.1.16.md'],
              minFinalTextChars: 80,
              rejectPreparatoryFinalText: true
            }
          });
          return result.finalText;
        }
      `,
    });

    expect(seen).toEqual([{
      enforcement: 'warn',
      requiresMutation: true,
      requiredChangedPaths: ['docs/features/v0.1.16.md'],
      minFinalTextChars: 80,
      rejectPreparatoryFinalText: true,
    }]);
  });

  it('rejects a synthesize call with a missing rubric', async () => {
    const { wf } = fakeWorkflowApi();
    await expect(
      runRestrictedWorkflowScript({
        wf,
        source: `
          async function run(wf) {
            return await wf.synthesize({ inputs: ['a', 'b'] });
          }
        `,
      }),
    ).rejects.toThrow(/synthesize input rubric must be a non-empty string/);
  });

  it('rejects a synthesize call whose inputs are neither array, string, nor object', async () => {
    const { wf } = fakeWorkflowApi();
    await expect(
      runRestrictedWorkflowScript({
        wf,
        source: `
          async function run(wf) {
            return await wf.synthesize({ inputs: 42, rubric: 'merge' });
          }
        `,
      }),
    ).rejects.toThrow(/synthesize input inputs must be an array, string, or object/);
  });

  it('accepts a synthesize call whose inputs are a single pre-combined string', async () => {
    const { wf } = fakeWorkflowApi();
    const result = await runRestrictedWorkflowScript({
      wf,
      source: `
        async function run(wf) {
          const combined = ['## a', 'finding a', '## b', 'finding b'].join('\\n');
          const syn = await wf.synthesize({ inputs: combined, rubric: 'merge' });
          return syn.text;
        }
      `,
    });
    expect(result).toBe('synthesis');
  });
});

describe('createRestrictedWorkflowModule', () => {
  it('validates generated source before returning a runnable module', () => {
    expect(() =>
      createRestrictedWorkflowModule({
        manifest: {
          name: 'bad-generated-demo',
          description: 'demo',
          phases: ['run'],
          readOnly: true,
          maxAgents: 1,
          maxConcurrency: 1,
          patterns: ['fan-out-and-synthesize'],
        },
        source: 'function run() { return "not the generated async contract"; }',
      }),
    ).toThrow(/async function run/);
  });

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

describe('validateRestrictedWorkflowSource', () => {
  it('validates the wrapped restricted workflow source', () => {
    expect(() =>
      validateRestrictedWorkflowSource('async function run() { return "ok"; }', {
        requireAsyncRun: true,
      }),
    ).not.toThrow();

    expect(() =>
      validateRestrictedWorkflowSource('async function run() { return "unterminated; }', {
        requireAsyncRun: true,
      }),
    ).toThrow(/failed to compile/);
  });

  it('ignores forbidden words inside strings while rejecting real host access', () => {
    expect(() =>
      validateRestrictedWorkflowSource(
        [
          'async function run(wf) {',
          '  return await wf.runAgent({',
          '    name: "reader",',
          '    prompt: "Review Workflow Process Events and output rendering.",',
          '    readOnly: true',
          '  });',
          '}',
        ].join('\n'),
        { requireAsyncRun: true },
      ),
    ).not.toThrow();

    expect(() =>
      validateRestrictedWorkflowSource('async function run() { return process.cwd(); }', {
        requireAsyncRun: true,
      }),
    ).toThrow(/forbidden restricted workflow token: process/);
  });
});
