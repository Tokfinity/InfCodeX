import { Script, createContext } from 'node:vm';

import type {
  WorkflowApi,
  WorkflowArtifactRef,
  WorkflowBudget,
  WorkflowLogEvent,
  WorkflowModule,
  WorkflowSpawnAgentInput,
  WorkflowSynthesizeInput,
  WorkflowTaskHandle,
  WorkflowTaskResult,
  WorkflowTaskSnapshot,
  WorkflowWaitOptions,
} from './types.js';
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

export const DEFAULT_WORKFLOW_SCRIPT_SYNC_TIMEOUT_MS = 10_000;
export const DEFAULT_WORKFLOW_SCRIPT_WALL_TIMEOUT_MS = 30 * 60 * 1_000;

function wrapSource(source: string): string {
  return [
    '"use strict";',
    source,
    'if (typeof run !== "function") {',
    '  throw new Error("restricted workflow script must define async function run(wf, args)");',
    '}',
    'Promise.resolve(run(wf, args));',
  ].join('\n');
}

type WorkflowRpcMethod =
  | 'artifact'
  | 'log'
  | 'output'
  | 'phaseEnter'
  | 'phaseExit'
  | 'runAgent'
  | 'send'
  | 'spawnAgent'
  | 'stop'
  | 'synthesize'
  | 'wait';

interface WorkflowRpcCommand {
  readonly id: string;
  readonly method: WorkflowRpcMethod;
  readonly input: unknown;
}

interface WorkflowRpcEnvelope {
  readonly value: unknown;
  readonly budget: {
    readonly spent: number;
    readonly remaining: number | null;
  };
}

interface WorkflowRpcPhaseScope {
  close(): void;
  readonly finished: Promise<void>;
  failure(): unknown;
}

interface WorkflowRpcHostState {
  readonly openPhases: Map<string, WorkflowRpcPhaseScope>;
  nextPhaseToken(): string;
}

function jsonStringify(value: unknown, label: string): string {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? 'null' : json;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new WorkflowScriptExecutionError(`${label} must be JSON-serializable: ${message}`);
  }
}

function jsonClone(value: unknown, label: string): unknown {
  if (value === undefined) return undefined;
  return JSON.parse(jsonStringify(value, label)) as unknown;
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new WorkflowScriptExecutionError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new WorkflowScriptExecutionError(`workflow command ${key} must be a non-empty string`);
  }
  return value;
}

function budgetEnvelope(wf: WorkflowApi, value: unknown): WorkflowRpcEnvelope {
  const budget = workflowBudget(wf);
  const remaining = budget.remaining();
  return {
    value,
    budget: {
      spent: budget.spent(),
      remaining: Number.isFinite(remaining) ? remaining : null,
    },
  };
}

function workflowBudget(wf: WorkflowApi): WorkflowBudget {
  const maybe = (wf as { readonly budget?: WorkflowBudget }).budget;
  return maybe ?? {
    total: null,
    spent: () => 0,
    remaining: () => Infinity,
  };
}

function errorEnvelope(error: unknown): WorkflowRpcEnvelope {
  const message = error instanceof Error ? error.message : String(error);
  return {
    value: { message },
    budget: { spent: 0, remaining: null },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildBootstrap(opts: RunRestrictedWorkflowScriptOptions): string {
  const argsJson =
    opts.args === undefined ? 'undefined' : JSON.stringify(jsonStringify(opts.args, 'workflow args'));
  const budget = workflowBudget(opts.wf);
  const budgetTotal = budget.total === null ? 'null' : String(budget.total);
  const budgetRemaining = Number.isFinite(budget.remaining())
    ? String(budget.remaining())
    : 'Infinity';
  return `
"use strict";
globalThis.process = undefined;
globalThis.require = undefined;
globalThis.module = undefined;
globalThis.exports = undefined;
globalThis.fetch = undefined;
globalThis.WebSocket = undefined;
globalThis.XMLHttpRequest = undefined;
globalThis.eval = undefined;
globalThis.Function = undefined;
globalThis.constructor = undefined;

const args = ${argsJson} === undefined ? undefined : JSON.parse(${argsJson});
const __kodaxQueue = [];
const __kodaxPending = new Map();
let __kodaxNextId = 0;
let __kodaxBudgetSpent = ${String(budget.spent())};
let __kodaxBudgetRemaining = ${budgetRemaining};

function __kodaxJsonClone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function __kodaxEnqueue(method, input) {
  const id = String(++__kodaxNextId);
  const command = { id, method, input: __kodaxJsonClone(input) };
  const promise = new Promise((resolve, reject) => {
    __kodaxPending.set(id, { resolve, reject });
  });
  __kodaxQueue.push(command);
  return promise;
}

function __kodaxTakeCommands() {
  return __kodaxQueue.splice(0, __kodaxQueue.length);
}

function __kodaxPendingCount() {
  return __kodaxPending.size;
}

function __kodaxSettle(id, ok, envelopeJson) {
  const pending = __kodaxPending.get(id);
  if (!pending) return;
  __kodaxPending.delete(id);
  const envelope = JSON.parse(envelopeJson);
  if (envelope && envelope.budget) {
    __kodaxBudgetSpent = envelope.budget.spent;
    __kodaxBudgetRemaining = envelope.budget.remaining === null ? Infinity : envelope.budget.remaining;
  }
  if (ok) {
    pending.resolve(envelope.value);
    return;
  }
  const message =
    envelope && envelope.value && typeof envelope.value.message === "string"
      ? envelope.value.message
      : "workflow command failed";
  pending.reject(new Error(message));
}

async function __kodaxParallel(items, options) {
  if (!Array.isArray(items)) {
    throw new Error("wf.parallel expects an array of thunks");
  }
  const requested = options && Number.isInteger(options.concurrency)
    ? options.concurrency
    : items.length;
  const lanes = Math.max(1, Math.min(requested, items.length || 1));
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      const item = items[index];
      if (typeof item !== "function") {
        throw new Error("wf.parallel items must be functions");
      }
      results[index] = await item();
    }
  }
  await Promise.all(Array.from({ length: lanes }, () => worker()));
  return results;
}

const console = Object.freeze({
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  log: () => undefined,
});

const wf = Object.freeze({
  runId: ${JSON.stringify(opts.wf.runId)},
  args,
  budget: Object.freeze({
    total: ${budgetTotal},
    spent: () => __kodaxBudgetSpent,
    remaining: () => __kodaxBudgetRemaining,
  }),
  phase: async (name, fn) => {
    const entered = await __kodaxEnqueue("phaseEnter", { name });
    try {
      return await fn();
    } finally {
      await __kodaxEnqueue("phaseExit", { token: entered && entered.token });
    }
  },
  spawnAgent: (input) => __kodaxEnqueue("spawnAgent", input),
  runAgent: (input) => __kodaxEnqueue("runAgent", input),
  wait: (taskId, opts) => __kodaxEnqueue("wait", { taskId, opts }),
  output: (taskId) => __kodaxEnqueue("output", { taskId }),
  send: (taskId, content) => __kodaxEnqueue("send", { taskId, content }),
  stop: (taskId, reason) => __kodaxEnqueue("stop", { taskId, reason }),
  parallel: __kodaxParallel,
  synthesize: (input) => __kodaxEnqueue("synthesize", input),
  artifact: (name, value) => __kodaxEnqueue("artifact", { name, value }),
  log: (event) => { void __kodaxEnqueue("log", event); },
});
`;
}

function runTrustedHostScript<T>(context: object, source: string): T {
  // These snippets are KodaX-authored RPC glue, not generated workflow code.
  // Avoid node:vm watchdog timeouts here: repeated short timeout runs can
  // abort the Windows Node process before JavaScript can catch anything.
  return new Script(source).runInContext(context) as T;
}

function readCommands(context: object): readonly WorkflowRpcCommand[] {
  const raw = runTrustedHostScript<unknown>(context, 'JSON.stringify(__kodaxTakeCommands())');
  if (typeof raw !== 'string') {
    throw new WorkflowScriptExecutionError('workflow command queue did not serialize');
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new WorkflowScriptExecutionError('workflow command queue must be an array');
  }
  return parsed.map((item): WorkflowRpcCommand => {
    const record = readRecord(item, 'workflow command');
    const id = readString(record, 'id');
    const method = readString(record, 'method') as WorkflowRpcMethod;
    return { id, method, input: record.input };
  });
}

function pendingCount(context: object): number {
  const value = runTrustedHostScript<unknown>(context, '__kodaxPendingCount()');
  if (typeof value !== 'number') {
    throw new WorkflowScriptExecutionError('workflow pending count must be a number');
  }
  return value;
}

function settleCommand(
  context: object,
  command: WorkflowRpcCommand,
  ok: boolean,
  envelope: WorkflowRpcEnvelope,
): void {
  const envelopeJson = jsonStringify(envelope, 'workflow command result');
  const code = `__kodaxSettle(${JSON.stringify(command.id)}, ${ok ? 'true' : 'false'}, ${JSON.stringify(envelopeJson)})`;
  runTrustedHostScript<unknown>(context, code);
}

async function handleCommand(
  wf: WorkflowApi,
  command: WorkflowRpcCommand,
  state: WorkflowRpcHostState,
): Promise<unknown> {
  const input = command.input;
  switch (command.method) {
    case 'artifact': {
      const record = readRecord(input, 'workflow artifact input');
      return wf.artifact(readString(record, 'name'), record.value) satisfies Promise<WorkflowArtifactRef>;
    }
    case 'log':
      wf.log(readRecord(input, 'workflow log input') as unknown as WorkflowLogEvent);
      return undefined;
    case 'output': {
      const record = readRecord(input, 'workflow output input');
      return wf.output(readString(record, 'taskId')) satisfies Promise<WorkflowTaskSnapshot>;
    }
    case 'phaseEnter': {
      const record = readRecord(input, 'workflow phase input');
      const token = state.nextPhaseToken();
      let closePhase: (() => void) | undefined;
      const closed = new Promise<void>((resolve) => {
        closePhase = resolve;
      });
      let phaseFailure: unknown;
      const finished = wf.phase(readString(record, 'name'), async () => closed).then(
        () => undefined,
        (error: unknown) => {
          phaseFailure = error;
        },
      );
      state.openPhases.set(token, {
        close: closePhase!,
        finished,
        failure: () => phaseFailure,
      });
      return { token };
    }
    case 'phaseExit': {
      const record = readRecord(input, 'workflow phase exit input');
      const token = readString(record, 'token');
      const phase = state.openPhases.get(token);
      if (phase) {
        state.openPhases.delete(token);
        phase.close();
        await phase.finished;
        const failure = phase.failure();
        if (failure !== undefined) throw failure;
      }
      return undefined;
    }
    case 'runAgent':
      return wf.runAgent(readRecord(input, 'workflow runAgent input') as unknown as WorkflowSpawnAgentInput) satisfies Promise<WorkflowTaskResult>;
    case 'send': {
      const record = readRecord(input, 'workflow send input');
      await wf.send(readString(record, 'taskId'), readString(record, 'content'));
      return undefined;
    }
    case 'spawnAgent':
      return wf.spawnAgent(readRecord(input, 'workflow spawnAgent input') as unknown as WorkflowSpawnAgentInput) satisfies Promise<WorkflowTaskHandle>;
    case 'stop': {
      const record = readRecord(input, 'workflow stop input');
      await wf.stop(readString(record, 'taskId'), readString(record, 'reason'));
      return undefined;
    }
    case 'synthesize':
      return wf.synthesize(readRecord(input, 'workflow synthesize input') as unknown as WorkflowSynthesizeInput);
    case 'wait': {
      const record = readRecord(input, 'workflow wait input');
      const waitOpts = record.opts === undefined
        ? undefined
        : (readRecord(record.opts, 'workflow wait options') as unknown as WorkflowWaitOptions);
      return wf.wait(readString(record, 'taskId'), waitOpts) satisfies Promise<WorkflowTaskResult>;
    }
    default:
      throw new WorkflowScriptExecutionError(`unsupported workflow command: ${command.method}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function closeOpenPhases(state: WorkflowRpcHostState): Promise<void> {
  const phases = [...state.openPhases.values()];
  state.openPhases.clear();
  for (const phase of phases) phase.close();
  await Promise.all(phases.map((phase) => phase.finished));
  const failure = phases.map((phase) => phase.failure()).find((error) => error !== undefined);
  if (failure !== undefined) throw failure;
}

export async function runRestrictedWorkflowScript(
  opts: RunRestrictedWorkflowScriptOptions,
): Promise<unknown> {
  const wallTimeoutMs = opts.timeoutMs ?? DEFAULT_WORKFLOW_SCRIPT_WALL_TIMEOUT_MS;
  const syncTimeoutMs = Math.min(wallTimeoutMs, DEFAULT_WORKFLOW_SCRIPT_SYNC_TIMEOUT_MS);
  const context = createContext({});
  new Script(buildBootstrap(opts), { filename: 'workflow-capability-bootstrap.js' }).runInContext(context);
  const script = new Script(wrapSource(opts.source), {
    filename: opts.filename ?? 'generated-workflow.js',
  });

  let settled = false;
  let result: unknown;
  let failure: unknown;
  let hostState: WorkflowRpcHostState | undefined;
  try {
    const scriptResult = script.runInContext(context, { timeout: syncTimeoutMs }) as unknown;
    void Promise.resolve(scriptResult).then(
      (value) => {
        settled = true;
        result = value;
      },
      (error) => {
        settled = true;
        failure = error;
      },
    );

    const startedAt = Date.now();
    const inFlight = new Set<Promise<void>>();
    let nextPhaseToken = 0;
    hostState = {
      openPhases: new Map<string, WorkflowRpcPhaseScope>(),
      nextPhaseToken: () => `phase-${++nextPhaseToken}`,
    };

    for (;;) {
      if (Date.now() - startedAt > wallTimeoutMs) {
        throw new WorkflowScriptExecutionError(`workflow script timed out after ${wallTimeoutMs}ms`);
      }

      const commands = readCommands(context);
      for (const command of commands) {
        const task = handleCommand(opts.wf, command, hostState)
          .then((value) => {
            settleCommand(context, command, true, budgetEnvelope(opts.wf, jsonClone(value, 'workflow command result')));
          })
          .catch((error: unknown) => {
            settleCommand(context, command, false, errorEnvelope(error));
          })
          .finally(() => {
            inFlight.delete(task);
          });
        inFlight.add(task);
      }

      if (settled && pendingCount(context) === 0 && inFlight.size === 0) {
        break;
      }

      if (commands.length === 0) {
        await Promise.race([sleep(1), ...inFlight]);
      }
    }

    if (failure !== undefined) {
      throw failure;
    }
    await closeOpenPhases(hostState);
    return jsonClone(result, 'workflow script result');
  } catch (error) {
    // Close any phase scopes if the generated script fails before its
    // finally block can send phaseExit.
    let cleanupError: unknown;
    if (hostState) {
      try {
        await closeOpenPhases(hostState);
      } catch (error2) {
        cleanupError = error2;
      }
    }
    const cleanupSuffix =
      cleanupError === undefined ? '' : `; workflow phase cleanup failed: ${errorMessage(cleanupError)}`;
    if (error instanceof WorkflowScriptExecutionError) {
      if (cleanupError === undefined) throw error;
      throw new WorkflowScriptExecutionError(`${error.message}${cleanupSuffix}`);
    }
    throw new WorkflowScriptExecutionError(
      `restricted workflow script failed: ${errorMessage(error)}${cleanupSuffix}`,
    );
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
