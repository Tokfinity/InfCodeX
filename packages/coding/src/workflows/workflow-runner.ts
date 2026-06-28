/**
 * FEATURE_217 (v0.7.49) Phase D — Headless workflow orchestrator.
 *
 * Ties together: the approval gate, the coding agent backend (Phase B),
 * the durable run-graph writer, and the agent-layer `runWorkflow`
 * envelope. This is the REPL-agnostic core the `/workflow` command
 * (Phase D.2) drives; it is fully testable with a fake backend + temp
 * run dir + a stub approval callback.
 */

import {
  createWorkflowProcessTracker,
  runWorkflow,
} from '@kodax-ai/agent';
import type {
  WorkflowAgentBackend,
  WorkflowApproval,
  WorkflowApprovalSummary,
  WorkflowEvent,
  WorkflowLimits,
  WorkflowMeta,
  WorkflowModule,
  WorkflowProcessEvent,
  WorkflowRunState,
} from '@kodax-ai/agent';

import { dirname } from 'node:path';

import { createCodingWorkflowBackend, type WorkflowChildOptions } from './agent-adapter.js';
import type { WorkflowHostPolicy } from './invocation-policy.js';
import {
  createRunGraphWriter,
  type WorkflowRunProcessMetadata,
  type WorkflowScriptSnapshotInput,
} from './run-graph.js';
import {
  workflowWorktreeBaseDir,
  sweepWorkflowRunWorktrees,
  pruneStaleWorkflowWorktrees,
  type WorktreeSweepDeps,
} from './worktree-sweep.js';
import { buildToolExecutionContext } from '../agent-runtime/tool-execution-context.js';
import type { KodaXOptions, KodaXToolExecutionContext } from '../types.js';

/** Mirrors the private `dispatch-child-tasks.ts` constant. */
const DEFAULT_MAX_ITERATIONS_PER_CHILD = 200;

export const SYSTEM_WORKFLOW_LIMITS = {
  maxAgents: 64,
  maxConcurrency: 16,
  tokenBudget: 200_000,
} as const;

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
  /** Optional host/SDK ceilings. These may only lower manifest/system limits. */
  readonly hostPolicy?: WorkflowHostPolicy;
  readonly signal?: AbortSignal;
  /** Extra event sink (e.g. live UI), in addition to the durable writer. */
  readonly onEvent?: (event: WorkflowEvent) => void;
  /** Host/SDK process snapshot stream. */
  readonly onWorkflowProcessEvent?: (event: WorkflowProcessEvent) => void;
  readonly now?: () => number;
  readonly scriptSnapshot?: WorkflowScriptSnapshotInput;
  readonly processMetadata?: WorkflowRunProcessMetadata;
  /** Optional lifecycle gate, used by WorkflowRunManager pause/resume. */
  readonly beforeSpawn?: () => Promise<void>;
  /** Test seam: inject git/mtime for the worktree sweep (FEATURE_217 Layer 2/3). */
  readonly worktreeSweepDeps?: WorktreeSweepDeps;
}

export type RunWorkflowModuleOutcome =
  | { readonly kind: 'denied'; readonly summary: WorkflowApprovalSummary }
  | { readonly kind: 'completed'; readonly result: unknown; readonly state: WorkflowRunState }
  | { readonly kind: 'failed'; readonly error: Error; readonly state: WorkflowRunState };

/** Build the pre-run approval summary from a workflow module's metadata. */
export function buildApprovalSummary(
  module: WorkflowModule,
  hostPolicy?: WorkflowHostPolicy,
): WorkflowApprovalSummary {
  const meta = module.meta;
  const limits = clampWorkflowLimits(meta, hostPolicy);
  return {
    name: meta.name,
    description: meta.description,
    phases: meta.phases ?? [],
    ...(meta.plannedAgents !== undefined ? { plannedAgents: meta.plannedAgents } : {}),
    maxAgents: limits.maxAgents ?? null,
    maxConcurrency: limits.maxConcurrency ?? null,
    tokenBudget: limits.tokenBudget ?? null,
    writesFiles: meta.readOnly !== true,
  };
}

function clampLimit(value: number | undefined, hardCap: number): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value <= 0) return 1;
  return Math.min(value, hardCap);
}

function clampEffectiveLimit(
  manifestValue: number | undefined,
  hostValue: number | undefined,
  hardCap: number,
): number | undefined {
  const manifestLimit = clampLimit(manifestValue, hardCap);
  const hostLimit = clampLimit(hostValue, hardCap);
  if (manifestLimit === undefined) return hostLimit;
  if (hostLimit === undefined) return manifestLimit;
  return Math.min(manifestLimit, hostLimit);
}

export function clampWorkflowLimits(
  meta: WorkflowMeta,
  hostPolicy?: WorkflowHostPolicy,
): WorkflowLimits {
  const maxAgents = clampEffectiveLimit(
    meta.maxAgents,
    hostPolicy?.maxAgents,
    SYSTEM_WORKFLOW_LIMITS.maxAgents,
  );
  const maxConcurrency = clampEffectiveLimit(
    meta.maxConcurrency,
    hostPolicy?.maxConcurrency,
    SYSTEM_WORKFLOW_LIMITS.maxConcurrency,
  );
  const tokenBudget = clampEffectiveLimit(
    meta.tokenBudget,
    hostPolicy?.tokenBudget,
    SYSTEM_WORKFLOW_LIMITS.tokenBudget,
  );
  return {
    ...(maxAgents !== undefined ? { maxAgents } : {}),
    ...(maxConcurrency !== undefined ? { maxConcurrency } : {}),
    ...(tokenBudget !== undefined ? { tokenBudget } : {}),
  };
}

function workflowResultSummary(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim().length > 0) return value;
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const synthesis = record.synthesis;
  if (typeof synthesis === 'string' && synthesis.trim().length > 0) return synthesis;
  if (typeof synthesis === 'object' && synthesis !== null) {
    const text = (synthesis as Record<string, unknown>).text;
    if (typeof text === 'string' && text.trim().length > 0) return text;
  }
  for (const key of ['summary', 'report', 'text', 'result']) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate;
  }
  return undefined;
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
  const limits = clampWorkflowLimits(opts.module.meta, opts.hostPolicy);
  const summary = buildApprovalSummary(opts.module, opts.hostPolicy);
  if (opts.approval) {
    const approved = await opts.approval(summary);
    if (!approved) return { kind: 'denied', summary };
  }

  const now = opts.now ?? (() => Date.now());

  // FEATURE_217 Layer 3 — reclaim worktrees orphaned by a previous hard kill
  // before this run starts allocating its own. Fail-soft, never blocks the run.
  // Git runs from the same cwd `toolWorktreeCreate` used (`executionCwd ?? gitRoot`)
  // so `git worktree list/remove` resolves the repo even when `gitRoot` is unset.
  const gitRoot = opts.ctx?.executionCwd ?? opts.ctx?.gitRoot;
  await pruneStaleWorkflowWorktrees(
    { workflowRunsRoot: dirname(opts.runDir), gitRoot },
    { now, ...opts.worktreeSweepDeps },
  );

  const writer = createRunGraphWriter(opts.runDir, { now });
  const processTracker = opts.onWorkflowProcessEvent
    ? createWorkflowProcessTracker({
        runId: opts.runId,
        workflowName: opts.module.meta.name,
        displayName: opts.processMetadata?.displayName ?? opts.module.meta.name,
        ...(opts.processMetadata?.goal !== undefined ? { goal: opts.processMetadata.goal } : {}),
        ...(opts.processMetadata?.source !== undefined ? { source: opts.processMetadata.source } : {}),
        ...(opts.processMetadata?.savedWorkflowName !== undefined
          ? { savedWorkflowName: opts.processMetadata.savedWorkflowName }
          : {}),
        ...(opts.processMetadata?.sourceRunId !== undefined
          ? { sourceRunId: opts.processMetadata.sourceRunId }
          : {}),
        ...(opts.processMetadata?.sourceWorkflowName !== undefined
          ? { sourceWorkflowName: opts.processMetadata.sourceWorkflowName }
          : {}),
        ...(opts.processMetadata?.revisionOf !== undefined
          ? { revisionOf: opts.processMetadata.revisionOf }
          : {}),
        ...(opts.processMetadata?.hostMetadata !== undefined
          ? { hostMetadata: { ...opts.processMetadata.hostMetadata } }
          : {}),
        ...(opts.module.meta.phases !== undefined ? { phases: opts.module.meta.phases } : {}),
        ...(limits.maxAgents !== undefined ? { maxAgents: limits.maxAgents } : {}),
        ...(opts.module.meta.plannedAgents !== undefined
          ? { plannedAgents: opts.module.meta.plannedAgents }
          : {}),
        ...(limits.tokenBudget !== undefined ? { tokenBudget: limits.tokenBudget } : {}),
        now: () => new Date(now()).toISOString(),
      })
    : undefined;
  const scriptSnapshot = opts.scriptSnapshot
    ? writer.writeScriptSnapshot(opts.scriptSnapshot)
    : undefined;
  const baseBackend = opts.backend ?? buildBackend(opts);
  const gatedBackend = opts.beforeSpawn
    ? withBeforeSpawn(baseBackend, opts.beforeSpawn)
    : baseBackend;
  // Route `wf.artifact` writes through the durable run-graph writer.
  const backend: WorkflowAgentBackend = {
    ...gatedBackend,
    writeArtifact: async (name, value) => writer.writeArtifact(name, value),
  };

  const startedAt = now();
  let outcome: Awaited<ReturnType<typeof runWorkflow>>;
  try {
    outcome = await runWorkflow(
      {
        runId: opts.runId,
        args: opts.args,
        backend,
        limits,
        ...(opts.signal ? { signal: opts.signal } : {}),
        summarizeResult: workflowResultSummary,
        onEvent: (event) => {
          writer.onEvent(event);
          if (processTracker) {
            opts.onWorkflowProcessEvent?.(processTracker.applyEvent(event));
          }
          opts.onEvent?.(event);
        },
      },
      (wf) => opts.module.run(wf, opts.args),
    );
  } finally {
    // FEATURE_217 Layer 2 — reclaim any worktree still registered under this
    // run's base dir on every terminal path (success / failure / cancel),
    // covering aborted or spawn-without-wait children that skipped per-child
    // cleanup. Fail-soft.
    await sweepWorkflowRunWorktrees(
      { baseDir: workflowWorktreeBaseDir(opts.runDir), gitRoot },
      { now, ...opts.worktreeSweepDeps },
    );
  }

  const resultSummary = outcome.ok ? workflowResultSummary(outcome.result) : undefined;
  writer.writeRunJson({
    meta: opts.module.meta,
    args: opts.args,
    state: outcome.state,
    startedAt,
    endedAt: now(),
    ...(scriptSnapshot ? { scriptSnapshot } : {}),
    ...(resultSummary !== undefined ? { resultSummary } : {}),
    ...(opts.processMetadata !== undefined ? { processMetadata: opts.processMetadata } : {}),
  });

  return outcome.ok
    ? { kind: 'completed', result: outcome.result, state: outcome.state }
    : { kind: 'failed', error: outcome.error, state: outcome.state };
}

function buildBackend(opts: RunWorkflowModuleOptions): WorkflowAgentBackend {
  if (!opts.ctx || !opts.childOptions) {
    throw new Error('runWorkflowModule requires either a backend or ctx + childOptions');
  }
  return createCodingWorkflowBackend({ ctx: opts.ctx, childOptions: opts.childOptions, runId: opts.runId });
}

function withBeforeSpawn(
  backend: WorkflowAgentBackend,
  beforeSpawn: () => Promise<void>,
): WorkflowAgentBackend {
  return {
    ...backend,
    spawn: async (input) => {
      await beforeSpawn();
      return backend.spawn(input);
    },
  };
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
  readonly onWorkflowProcessEvent?: (event: WorkflowProcessEvent) => void;
  readonly now?: () => number;
  readonly scriptSnapshot?: WorkflowScriptSnapshotInput;
  readonly processMetadata?: WorkflowRunProcessMetadata;
  readonly beforeSpawn?: () => Promise<void>;
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
  const ctx: KodaXToolExecutionContext = {
    ...buildToolExecutionContext({
      options: input.options,
      runtime: input.options.extensionRuntime,
      managedProtocolPayloadRef: { current: undefined },
    }),
    // FEATURE_217 Layer B — workflow child worktrees nest under the run dir so
    // they are reclaimable and never pollute the user's project tree.
    workflowWorktreeBaseDir: workflowWorktreeBaseDir(input.runDir),
  };
  const childOptions: WorkflowChildOptions = {
    maxIterationsPerChild: DEFAULT_MAX_ITERATIONS_PER_CHILD,
    parentRole: 'worker',
    // 'tool-dispatch' (not 'workflow') so write-capable children are NOT
    // silently dropped by `validateWriteBundles` — workflows dispatch
    // children exactly like `dispatch_child_task`. Read-only children are
    // unaffected; the per-agent `readOnly` flag still controls write access.
    parentHarness: 'tool-dispatch',
    parentOptions: {
      provider: input.options.provider,
      model: input.options.model,
      reasoningMode: input.options.reasoningMode,
      repoIntelligenceMode: input.options.context?.repoIntelligenceMode,
      repoIntelligenceTrace: input.options.context?.repoIntelligenceTrace,
      extensionRuntime: input.options.extensionRuntime,
      events: input.options.events,
    },
    ...(input.options.guardrails ? { guardrails: input.options.guardrails } : {}),
    ...(ctx.planModeBlockCheck
      ? { planModeBlockCheck: ctx.planModeBlockCheck }
      : {}),
  };
  const onWorkflowProcessEvent =
    input.onWorkflowProcessEvent || input.options.events?.onWorkflowProcessEvent
      ? (event: WorkflowProcessEvent): void => {
          input.onWorkflowProcessEvent?.(event);
          input.options.events?.onWorkflowProcessEvent?.(event);
        }
      : undefined;
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
    ...(onWorkflowProcessEvent ? { onWorkflowProcessEvent } : {}),
    ...(input.options.workflowHostPolicy ? { hostPolicy: input.options.workflowHostPolicy } : {}),
    ...(input.now ? { now: input.now } : {}),
    ...(input.scriptSnapshot ? { scriptSnapshot: input.scriptSnapshot } : {}),
    ...(input.processMetadata ? { processMetadata: input.processMetadata } : {}),
    ...(input.beforeSpawn ? { beforeSpawn: input.beforeSpawn } : {}),
  });
}
