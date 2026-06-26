import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker, type WorkerOptions } from 'node:worker_threads';
import type {
  ImpactEstimateResult,
  ModuleContextResult,
  ProcessContextResult,
  RepoIntelligenceIndex,
  SymbolContextResult,
} from './semantic-types.js';
import type { CycleAnalysis } from './cyclic-deps.js';
import type {
  SemanticLookupKind,
  SemanticLookupResult,
} from './semantic-lookup-query.js';
import type {
  KodaXRepoRoutingSignals,
  KodaXToolExecutionContext,
} from '../types.js';
import type { RepoIntelligenceAnalysisProfile } from './semantic-shared.js';

type RepoContext = Pick<KodaXToolExecutionContext, 'executionCwd' | 'gitRoot'>;
type IndexOptions = { targetPath?: string; refresh?: boolean; profile?: RepoIntelligenceAnalysisProfile };
type ModuleOptions = IndexOptions & { module?: string };
type SymbolOptions = IndexOptions & { symbol: string; module?: string };
type ProcessOptions = IndexOptions & { entry?: string; module?: string };
type ImpactOptions = IndexOptions & { symbol?: string; module?: string; path?: string };
type SemanticLookupOptions = IndexOptions & { query: string; lookupKind: SemanticLookupKind; limit: number };

type SemanticWorkerRequest =
  | { id: number; kind: 'buildIndex'; context: RepoContext; options: IndexOptions }
  | { id: number; kind: 'getIndex'; context: RepoContext; options: IndexOptions }
  | { id: number; kind: 'module'; context: RepoContext; options: ModuleOptions }
  | { id: number; kind: 'symbol'; context: RepoContext; options: SymbolOptions }
  | { id: number; kind: 'process'; context: RepoContext; options: ProcessOptions }
  | { id: number; kind: 'impact'; context: RepoContext; options: ImpactOptions }
  | { id: number; kind: 'routing'; context: RepoContext; options: IndexOptions }
  | { id: number; kind: 'semanticLookup'; context: RepoContext; options: SemanticLookupOptions }
  | { id: number; kind: 'cyclicDeps'; context: RepoContext; options: IndexOptions };

type SemanticWorkerRequestPayload =
  SemanticWorkerRequest extends infer Request
    ? Request extends { id: number }
      ? Omit<Request, 'id'>
      : never
    : never;

type SemanticWorkerResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: { message: string; stack?: string } };

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  keepAlive: boolean;
}

interface WorkerState {
  worker: Worker;
  pending: Map<number, PendingRequest>;
}

interface WorkerRequestHandle {
  state: WorkerState;
  id: number;
}

const DEFAULT_WORKER_OLD_SPACE_MB = 2048;
const DEFAULT_WORKER_TIMEOUT_MS = 120_000;
let nextRequestId = 1;
let workerState: WorkerState | undefined;
const workerRequestHandles = new WeakMap<Promise<unknown>, WorkerRequestHandle>();

function readWorkerOldSpaceMb(): number {
  const configured = Number(process.env.KODAX_REPO_INTELLIGENCE_WORKER_OLD_SPACE_MB);
  if (Number.isFinite(configured) && configured >= 512) {
    return Math.floor(configured);
  }
  return DEFAULT_WORKER_OLD_SPACE_MB;
}

function readWorkerTimeoutMs(): number {
  const configured = Number(process.env.KODAX_REPO_INTELLIGENCE_WORKER_TIMEOUT_MS);
  if (Number.isFinite(configured) && configured >= 5_000) {
    return Math.floor(configured);
  }
  return DEFAULT_WORKER_TIMEOUT_MS;
}

function resolveWorkerUrl(): URL {
  if (import.meta.url.endsWith('.ts')) {
    return new URL('./semantic-worker.ts', import.meta.url);
  }
  if (process.env.KODAX_BUNDLED === 'true') {
    return pathToFileURL(join(dirname(process.execPath), 'semantic-worker.js'));
  }
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const sidecarDir = basename(currentDir) === 'chunks' ? dirname(currentDir) : currentDir;
  return pathToFileURL(join(sidecarDir, 'semantic-worker.js'));
}

function hasTsxImport(execArgv: readonly string[]): boolean {
  return execArgv.some((arg, index) =>
    (arg === '--import' && execArgv[index + 1]?.includes('tsx') === true)
    || arg.startsWith('--import=tsx'));
}

function sanitizeWorkerExecArgv(execArgv: readonly string[]): string[] {
  const sanitized: string[] = [];
  for (let index = 0; index < execArgv.length; index += 1) {
    const arg = execArgv[index];
    if (arg === '--input-type') {
      index += 1;
      continue;
    }
    if (arg.startsWith('--input-type=')) {
      continue;
    }
    sanitized.push(arg);
  }
  return sanitized;
}

function resolveWorkerExecArgv(): string[] {
  const execArgv = sanitizeWorkerExecArgv(process.execArgv);
  if (!hasTsxImport(execArgv)) {
    if (import.meta.url.endsWith('.ts')) {
      execArgv.push('--import', 'tsx');
    }
  }
  return execArgv;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isWorkerResponse(value: unknown): value is SemanticWorkerResponse {
  if (!isRecord(value) || typeof value.id !== 'number' || typeof value.ok !== 'boolean') {
    return false;
  }
  if (value.ok === true) {
    return 'result' in value;
  }
  return isRecord(value.error) && typeof value.error.message === 'string';
}

function cloneableRepoContext(context: RepoContext): RepoContext {
  return {
    executionCwd: context.executionCwd,
    gitRoot: context.gitRoot,
  };
}

function cloneableOptions(options: IndexOptions): IndexOptions {
  return {
    targetPath: options.targetPath,
    refresh: options.refresh,
    profile: options.profile,
  };
}

function cloneableWorkerRequest(request: SemanticWorkerRequestPayload, id: number): SemanticWorkerRequest {
  const base = {
    context: cloneableRepoContext(request.context),
    options: cloneableOptions(request.options),
    id,
  };
  switch (request.kind) {
    case 'buildIndex':
    case 'getIndex':
    case 'cyclicDeps':
    case 'routing':
      return { ...base, kind: request.kind };
    case 'semanticLookup':
      return {
        ...base,
        kind: request.kind,
        options: {
          ...base.options,
          query: request.options.query,
          lookupKind: request.options.lookupKind,
          limit: request.options.limit,
        },
      };
    case 'module':
      return {
        ...base,
        kind: request.kind,
        options: {
          ...base.options,
          module: request.options.module,
        },
      };
    case 'symbol':
      return {
        ...base,
        kind: request.kind,
        options: {
          ...base.options,
          symbol: request.options.symbol,
          module: request.options.module,
        },
      };
    case 'process':
      return {
        ...base,
        kind: request.kind,
        options: {
          ...base.options,
          entry: request.options.entry,
          module: request.options.module,
        },
      };
    case 'impact':
      return {
        ...base,
        kind: request.kind,
        options: {
          ...base.options,
          symbol: request.options.symbol,
          module: request.options.module,
          path: request.options.path,
        },
      };
  }
}

function rejectAll(state: WorkerState, error: Error): void {
  for (const pending of state.pending.values()) {
    clearTimeout(pending.timer);
    pending.reject(error);
  }
  state.pending.clear();
}

function failWorker(state: WorkerState, error: Error): void {
  rejectAll(state, error);
  if (workerState === state) {
    workerState = undefined;
  }
  void state.worker.terminate().catch(() => undefined);
}

function updateWorkerRef(state: WorkerState): void {
  if ([...state.pending.values()].some((pending) => pending.keepAlive)) {
    state.worker.ref();
  } else {
    state.worker.unref();
  }
}

function getWorkerState(): WorkerState {
  if (workerState) return workerState;

  const workerOptions: WorkerOptions = {
    resourceLimits: {
      maxOldGenerationSizeMb: readWorkerOldSpaceMb(),
    },
  };
  workerOptions.execArgv = resolveWorkerExecArgv();
  const state: WorkerState = {
    worker: new Worker(resolveWorkerUrl(), workerOptions),
    pending: new Map<number, PendingRequest>(),
  };
  state.worker.on('message', (message: unknown) => {
    if (!isWorkerResponse(message)) return;
    const pending = state.pending.get(message.id);
    if (!pending) return;
    state.pending.delete(message.id);
    clearTimeout(pending.timer);
    updateWorkerRef(state);
    if (message.ok) {
      pending.resolve(message.result);
      return;
    }
    const error = new Error(message.error.message);
    if (message.error.stack) {
      error.stack = message.error.stack;
    }
    pending.reject(error);
  });
  state.worker.on('error', (error) => {
    failWorker(state, error);
  });
  state.worker.on('exit', (code) => {
    if (workerState === state) {
      workerState = undefined;
    }
    if (state.pending.size > 0) {
      rejectAll(state, new Error(`Repo intelligence worker exited with code ${code}.`));
      return;
    }
    if (code !== 0) {
      rejectAll(state, new Error(`Repo intelligence worker exited with code ${code}.`));
    }
  });
  state.worker.unref();
  workerState = state;
  return state;
}

export async function shutdownRepoIntelligenceWorkerForTest(): Promise<void> {
  const state = workerState;
  if (!state) return;
  workerState = undefined;
  rejectAll(state, new Error('Repo intelligence worker shut down by test cleanup.'));
  await state.worker.terminate();
}

export function detachRepoIntelligenceWorkerRequest(promise: Promise<unknown>): boolean {
  const handle = workerRequestHandles.get(promise);
  if (!handle) return false;
  const pending = handle.state.pending.get(handle.id);
  if (!pending) return false;
  pending.keepAlive = false;
  updateWorkerRef(handle.state);
  return true;
}

function callWorker<T>(request: SemanticWorkerRequestPayload): Promise<T> {
  const state = getWorkerState();
  const id = nextRequestId++;
  const message = cloneableWorkerRequest(request, id);
  const timeoutMs = readWorkerTimeoutMs();
  const promise = new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      failWorker(state, new Error(`Repo intelligence worker request timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    if (typeof timer === 'object' && typeof timer.unref === 'function') {
      timer.unref();
    }
    state.pending.set(id, {
      resolve: (value) => resolve(value as T),
      reject,
      timer,
      keepAlive: true,
    });
    updateWorkerRef(state);
    try {
      state.worker.postMessage(message);
    } catch (error) {
      const pending = state.pending.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        state.pending.delete(id);
      }
      updateWorkerRef(state);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
  workerRequestHandles.set(promise, { state, id });
  return promise;
}

export function buildRepoIntelligenceIndex(
  context: RepoContext,
  options: IndexOptions = {},
): Promise<RepoIntelligenceIndex> {
  return callWorker<RepoIntelligenceIndex>({ kind: 'buildIndex', context, options });
}

export function getRepoIntelligenceIndex(
  context: RepoContext,
  options: IndexOptions = {},
): Promise<RepoIntelligenceIndex> {
  return callWorker<RepoIntelligenceIndex>({ kind: 'getIndex', context, options });
}

export function getModuleContext(
  context: RepoContext,
  options: ModuleOptions = {},
): Promise<ModuleContextResult> {
  return callWorker<ModuleContextResult>({ kind: 'module', context, options });
}

export function getSymbolContext(
  context: RepoContext,
  options: SymbolOptions,
): Promise<SymbolContextResult> {
  return callWorker<SymbolContextResult>({ kind: 'symbol', context, options });
}

export function getProcessContext(
  context: RepoContext,
  options: ProcessOptions,
): Promise<ProcessContextResult> {
  return callWorker<ProcessContextResult>({ kind: 'process', context, options });
}

export function getImpactEstimate(
  context: RepoContext,
  options: ImpactOptions,
): Promise<ImpactEstimateResult> {
  return callWorker<ImpactEstimateResult>({ kind: 'impact', context, options });
}

export function getRepoRoutingSignals(
  context: RepoContext,
  options: IndexOptions = {},
): Promise<KodaXRepoRoutingSignals> {
  return callWorker<KodaXRepoRoutingSignals>({ kind: 'routing', context, options });
}

export function semanticLookup(
  context: RepoContext,
  options: SemanticLookupOptions,
): Promise<SemanticLookupResult> {
  return callWorker<SemanticLookupResult>({ kind: 'semanticLookup', context, options });
}

export function getCyclicDependencyAnalysis(
  context: RepoContext,
  options: IndexOptions = {},
): Promise<CycleAnalysis> {
  return callWorker<CycleAnalysis>({ kind: 'cyclicDeps', context, options });
}
