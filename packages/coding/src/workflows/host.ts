/**
 * FEATURE_246 Part A1 (ADR-046) — the coding WorkflowHost entrypoint.
 *
 * `startManagedWorkflow` is the single capability both the REPL `/workflow`
 * command / AMAW intercept AND the model-callable `run_workflow` tool call. It
 * resolves a workflow module from one of three sources (inline `{manifest,
 * source}` written by the Worker, a saved module, or a natural-language request
 * routed through the generator), mints the run id + durable run dir, and starts
 * it on the (agent-layer) run manager. UI — approval rendering, progress, final
 * messages — stays in the REPL, which passes an `approval` callback + `onEvent`
 * sink. This removes the start-glue that previously lived in the REPL
 * (`startGeneratedWorkflowFromRequest`).
 */

import { join } from 'node:path';

import {
  createRestrictedWorkflowModule,
  validateWorkflowScriptManifest,
} from '@kodax-ai/agent';
import type {
  WorkflowApproval,
  WorkflowApprovalSummary,
  WorkflowEvent,
  WorkflowModule,
} from '@kodax-ai/agent';

import { generateWorkflowFromOptions } from './generator.js';
import {
  getDefaultWorkflowRunManager,
  type ManagedWorkflowRun,
  type WorkflowRunManager,
} from './run-manager.js';
import type { WorkflowRunProcessMetadata, WorkflowScriptSnapshotInput } from './run-graph.js';
import { buildApprovalSummary } from './workflow-runner.js';
import type { KodaXOptions } from '../types.js';

/** Where the workflow script comes from. */
export type ManagedWorkflowSource =
  | { readonly kind: 'inline'; readonly manifest: unknown; readonly source: string }
  | { readonly kind: 'saved'; readonly module: WorkflowModule }
  | { readonly kind: 'request'; readonly request: string };

export interface StartManagedWorkflowInput {
  readonly source: ManagedWorkflowSource;
  readonly args: unknown;
  readonly options: KodaXOptions;
  /** Durable run-graph base dir (one run dir per run id is created under it). */
  readonly runsBaseDir: string;
  /** Override the minted run id (tests / explicit rerun ids). */
  readonly runId?: string;
  /** Defaults to the shared coding singleton (which wraps the agent default). */
  readonly manager?: WorkflowRunManager;
  /** Pre-run approval gate; when omitted the run auto-proceeds (headless). */
  readonly approval?: WorkflowApproval;
  readonly processMetadata?: WorkflowRunProcessMetadata;
  readonly onEvent?: (event: WorkflowEvent) => void;
  readonly signal?: AbortSignal;
  /** Test seam: override the NL→workflow generator. */
  readonly generateWorkflow?: typeof generateWorkflowFromOptions;
  /** Test seam: clock for the minted run id. */
  readonly now?: () => number;
}

export type StartManagedWorkflowResult =
  | { readonly kind: 'declined'; readonly reason: string }
  | {
      readonly kind: 'started';
      readonly runId: string;
      readonly runDir: string;
      readonly module: WorkflowModule;
      readonly managed: ManagedWorkflowRun;
      readonly approvalSummary: WorkflowApprovalSummary;
      readonly scriptSnapshot?: WorkflowScriptSnapshotInput;
    };

interface ResolvedModule {
  readonly module: WorkflowModule;
  readonly scriptSnapshot?: WorkflowScriptSnapshotInput;
}

async function resolveModule(
  input: StartManagedWorkflowInput,
): Promise<ResolvedModule | { readonly declined: string }> {
  const source = input.source;
  if (source.kind === 'saved') {
    return { module: source.module };
  }
  if (source.kind === 'inline') {
    // Validate manifest + source through the SAME gate generated workflows use,
    // so a malformed inline script fails closed exactly like a generated one.
    const manifest = validateWorkflowScriptManifest(source.manifest);
    const module = createRestrictedWorkflowModule({ manifest, source: source.source });
    return { module, scriptSnapshot: { manifest, source: source.source } };
  }
  const generate = input.generateWorkflow ?? generateWorkflowFromOptions;
  const generated = await generate({ request: source.request, options: input.options });
  if (generated.kind === 'declined') {
    return { declined: generated.reason };
  }
  return { module: generated.module, scriptSnapshot: generated.scriptSnapshot };
}

export async function startManagedWorkflow(
  input: StartManagedWorkflowInput,
): Promise<StartManagedWorkflowResult> {
  const resolved = await resolveModule(input);
  if ('declined' in resolved) {
    return { kind: 'declined', reason: resolved.declined };
  }
  const { module, scriptSnapshot } = resolved;

  const now = input.now ?? (() => Date.now());
  const runId = input.runId ?? `run-${now().toString(36)}`;
  const runDir = join(input.runsBaseDir, runId);
  const manager = input.manager ?? getDefaultWorkflowRunManager();
  const approvalSummary = buildApprovalSummary(module, input.options.workflowHostPolicy);

  const managed = manager.startFromOptions({
    module,
    args: input.args,
    options: input.options,
    runId,
    runDir,
    ...(scriptSnapshot ? { scriptSnapshot } : {}),
    ...(input.processMetadata ? { processMetadata: input.processMetadata } : {}),
    ...(input.approval ? { approval: input.approval } : {}),
    ...(input.onEvent ? { onEvent: input.onEvent } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });

  return {
    kind: 'started',
    runId,
    runDir,
    module,
    managed,
    approvalSummary,
    ...(scriptSnapshot ? { scriptSnapshot } : {}),
  };
}
