/**
 * FEATURE_217 (v0.7.49) Phase D — Headless workflow orchestrator.
 *
 * Ties together: the approval gate, the coding agent backend (Phase B),
 * the durable run-graph writer, and the agent-layer `runWorkflow`
 * envelope. This is the REPL-agnostic core the `/workflow` command
 * (Phase D.2) drives; it is fully testable with a fake backend + temp
 * run dir + a stub approval callback.
 */

import { runWorkflow } from '@kodax-ai/agent/workflow';
import type {
  WorkflowAgentBackend,
  WorkflowApproval,
  WorkflowApprovalSummary,
  WorkflowEvent,
  WorkflowModule,
  WorkflowRunState,
} from '@kodax-ai/agent/workflow';

import { createCodingWorkflowBackend, type WorkflowChildOptions } from './agent-adapter.js';
import { createRunGraphWriter } from './run-graph.js';
import { buildToolExecutionContext } from '../agent-runtime/tool-execution-context.js';
import type { KodaXOptions, KodaXToolExecutionContext } from '../types.js';

/** Mirrors the private `dispatch-child-tasks.ts` constant. */
const DEFAULT_MAX_ITERATIONS_PER_CHILD = 200;

export interface RunWorkflowModuleOptions {
  readonly module: WorkflowModule;
  readonly args: unknown;
  readonly runId: string;
  /** Directory for the durable run graph (run.json / events.jsonl / artifacts). */
  readonly runDir: string;
  /** Parent context — required when the backend is built internally. */
  readonly ctx?: KodaXToolExecutionContext;
  /** Per-run child options — required when the backend is built internally. */
  readonly childOptions?: WorkflowChildOptions;
  /** Pre-built backend (test seam). When omitted, built from ctx + childOptions. */
  readonly backend?: WorkflowAgentBackend;
  /** Approval gate. When omitted, the run auto-proceeds (SDK / headless). */
  readonly approval?: WorkflowApproval;
  readonly signal?: AbortSignal;
  /** Extra event sink (e.g. live UI), in addition to the durable writer. */
  readonly onEvent?: (event: WorkflowEvent) => void;
  readonly now?: () => number;
}

export type RunWorkflowModuleOutcome =
  | { readonly kind: 'denied'; readonly summary: WorkflowApprovalSummary }
  | { readonly kind: 'completed'; readonly result: unknown; readonly state: WorkflowRunState }
  | { readonly kind: 'failed'; readonly error: Error; readonly state: WorkflowRunState };

/** Build the pre-run approval summary from a workflow module's metadata. */
export function buildApprovalSummary(module: WorkflowModule): WorkflowApprovalSummary {
  const meta = module.meta;
  return {
    name: meta.name,
    description: meta.description,
    phases: meta.phases ?? [],
    maxAgents: meta.maxAgents ?? null,
    maxConcurrency: meta.maxConcurrency ?? null,
    tokenBudget: meta.tokenBudget ?? null,
    writesFiles: meta.readOnly !== true,
  };
}

/**
 * Run a workflow module end-to-end: approval → runtime + backend +
 * durable run graph → terminal `run.json`. A workflow execution failure
 * surfaces as `{ kind: 'failed' }` and a denied approval as
 * `{ kind: 'denied' }`. Only a misconfiguration (no backend AND no
 * ctx+childOptions) throws — that is a programmer precondition error.
 */
export async function runWorkflowModule(
  opts: RunWorkflowModuleOptions,
): Promise<RunWorkflowModuleOutcome> {
  const summary = buildApprovalSummary(opts.module);
  if (opts.approval) {
    const approved = await opts.approval(summary);
    if (!approved) return { kind: 'denied', summary };
  }

  const now = opts.now ?? (() => Date.now());
  const writer = createRunGraphWriter(opts.runDir, { now });
  const baseBackend = opts.backend ?? buildBackend(opts);
  // Route `wf.artifact` writes through the durable run-graph writer.
  const backend: WorkflowAgentBackend = {
    ...baseBackend,
    writeArtifact: async (name, value) => writer.writeArtifact(name, value),
  };

  const startedAt = now();
  const outcome = await runWorkflow(
    {
      runId: opts.runId,
      args: opts.args,
      backend,
      limits: {
        ...(opts.module.meta.maxAgents !== undefined ? { maxAgents: opts.module.meta.maxAgents } : {}),
        ...(opts.module.meta.maxConcurrency !== undefined ? { maxConcurrency: opts.module.meta.maxConcurrency } : {}),
        ...(opts.module.meta.tokenBudget !== undefined ? { tokenBudget: opts.module.meta.tokenBudget } : {}),
      },
      ...(opts.signal ? { signal: opts.signal } : {}),
      onEvent: (event) => {
        writer.onEvent(event);
        opts.onEvent?.(event);
      },
    },
    (wf) => opts.module.run(wf, opts.args),
  );

  writer.writeRunJson({
    meta: opts.module.meta,
    args: opts.args,
    state: outcome.state,
    startedAt,
    endedAt: now(),
  });

  return outcome.ok
    ? { kind: 'completed', result: outcome.result, state: outcome.state }
    : { kind: 'failed', error: outcome.error, state: outcome.state };
}

function buildBackend(opts: RunWorkflowModuleOptions): WorkflowAgentBackend {
  if (!opts.ctx || !opts.childOptions) {
    throw new Error('runWorkflowModule requires either a backend or ctx + childOptions');
  }
  return createCodingWorkflowBackend({ ctx: opts.ctx, childOptions: opts.childOptions });
}

export interface RunWorkflowFromOptionsInput {
  readonly module: WorkflowModule;
  readonly args: unknown;
  readonly options: KodaXOptions;
  readonly runId: string;
  readonly runDir: string;
  readonly approval?: WorkflowApproval;
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: WorkflowEvent) => void;
  readonly now?: () => number;
}

/**
 * High-level entry: build a tool-execution context + child options from
 * `KodaXOptions` (provider / model / extensionRuntime) and run the
 * workflow module. ctx construction stays inside `@kodax-ai/coding` — the
 * REPL passes plain `KodaXOptions` (from `createKodaXOptions`) rather than
 * reaching into run-loop internals.
 */
export async function runWorkflowFromOptions(
  input: RunWorkflowFromOptionsInput,
): Promise<RunWorkflowModuleOutcome> {
  const ctx = buildToolExecutionContext({
    options: input.options,
    runtime: input.options.extensionRuntime,
    managedProtocolPayloadRef: { current: undefined },
  });
  const childOptions: WorkflowChildOptions = {
    maxIterationsPerChild: DEFAULT_MAX_ITERATIONS_PER_CHILD,
    parentRole: 'worker',
    parentHarness: 'workflow',
    parentOptions: {
      provider: input.options.provider,
      model: input.options.model,
      reasoningMode: input.options.reasoningMode,
      extensionRuntime: input.options.extensionRuntime,
    },
  };
  return runWorkflowModule({
    module: input.module,
    args: input.args,
    runId: input.runId,
    runDir: input.runDir,
    ctx,
    childOptions,
    ...(input.approval ? { approval: input.approval } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.onEvent ? { onEvent: input.onEvent } : {}),
    ...(input.now ? { now: input.now } : {}),
  });
}
