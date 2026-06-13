import { Script, createContext } from 'node:vm';

import type { WorkflowApi, WorkflowModule } from './types.js';
import type { WorkflowScriptManifest } from './manifest.js';
import { validateWorkflowScriptManifest } from './manifest.js';

export class WorkflowScriptExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowScriptExecutionError';
  }
}

export interface RunRestrictedWorkflowScriptOptions {
  readonly source: string;
  readonly wf: WorkflowApi;
  readonly args?: unknown;
  readonly filename?: string;
  readonly timeoutMs?: number;
}

export interface RestrictedWorkflowModuleInput {
  readonly manifest: WorkflowScriptManifest;
  readonly source: string;
  readonly timeoutMs?: number;
}

function wrapSource(source: string): string {
  return [
    '"use strict";',
    '(async () => {',
    source,
    'if (typeof run !== "function") {',
    '  throw new Error("restricted workflow script must define async function run(wf, args)");',
    '}',
    'return await run(wf, args);',
    '})()',
  ].join('\n');
}

function timeoutAfter(timeoutMs: number): { promise: Promise<never>; clear: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new WorkflowScriptExecutionError(`workflow script timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  return {
    promise,
    clear: () => {
      if (timer) clearTimeout(timer);
    },
  };
}

export async function runRestrictedWorkflowScript(
  opts: RunRestrictedWorkflowScriptOptions,
): Promise<unknown> {
  const context = createContext({
    wf: opts.wf,
    args: opts.args,
    console: Object.freeze({
      info: () => {},
      warn: () => {},
      error: () => {},
    }),
    process: undefined,
    require: undefined,
    module: undefined,
    exports: undefined,
  });

  const timeoutMs = opts.timeoutMs ?? 10000;
  const script = new Script(wrapSource(opts.source), {
    filename: opts.filename ?? 'generated-workflow.js',
  });

  try {
    const result = script.runInContext(context, { timeout: timeoutMs }) as unknown;
    const timeout = timeoutAfter(timeoutMs);
    try {
      return await Promise.race([Promise.resolve(result), timeout.promise]);
    } finally {
      timeout.clear();
    }
  } catch (error) {
    if (error instanceof WorkflowScriptExecutionError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new WorkflowScriptExecutionError(`restricted workflow script failed: ${message}`);
  }
}

export function createRestrictedWorkflowModule(
  input: RestrictedWorkflowModuleInput,
): WorkflowModule {
  const manifest = validateWorkflowScriptManifest(input.manifest);
  return {
    meta: {
      name: manifest.name,
      description: manifest.description,
      phases: manifest.phases,
      readOnly: manifest.readOnly,
      maxAgents: manifest.maxAgents,
      maxConcurrency: manifest.maxConcurrency,
      ...(manifest.tokenBudget !== undefined ? { tokenBudget: manifest.tokenBudget } : {}),
    },
    run: (wf, args) =>
      runRestrictedWorkflowScript({
        wf,
        args,
        source: input.source,
        filename: `${manifest.name}.workflow.js`,
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      }),
  };
}
