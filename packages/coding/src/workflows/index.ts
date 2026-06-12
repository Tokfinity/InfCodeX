/**
 * FEATURE_217 (v0.7.49) — `@kodax-ai/coding` workflows barrel.
 *
 * Exposes the workflow agent backend (Phase B), the built-in read-only
 * workflows (Phase C), and a name-keyed registry the REPL `/workflow`
 * command (Phase D) resolves against.
 */

import type { WorkflowModule } from '@kodax-ai/agent/workflow';

import { parallelInvestigation } from './builtin/parallel-investigation.js';

export * from './agent-adapter.js';
export * from './builtin/parallel-investigation.js';
export * from './run-graph.js';
export * from './workflow-runner.js';
export * from './discovery.js';

/**
 * Erase a workflow's concrete arg/result types for storage in the
 * registry. Args arrive as `unknown` from the CLI / JSON surface and are
 * validated by the workflow itself, so the boundary cast is honest.
 */
function erase<A, R>(module: WorkflowModule<A, R>): WorkflowModule {
  return { meta: module.meta, run: (wf, args) => module.run(wf, args as A) };
}

/** All built-in workflows shipped with KodaX. */
export const BUILTIN_WORKFLOWS: readonly WorkflowModule[] = [erase(parallelInvestigation)];

/** Resolve a built-in workflow by its declared `meta.name`. */
export function getBuiltinWorkflow(name: string): WorkflowModule | undefined {
  return BUILTIN_WORKFLOWS.find((workflow) => workflow.meta.name === name);
}

/** List built-in workflow metadata (for `/workflow` listing). */
export function listBuiltinWorkflows(): readonly WorkflowModule['meta'][] {
  return BUILTIN_WORKFLOWS.map((workflow) => workflow.meta);
}
