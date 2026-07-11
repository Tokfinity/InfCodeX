/**
 * FEATURE_217 / FEATURE_246 — built-in workflow registry.
 *
 * A leaf module (imports only built-in workflow modules) so both the workflows
 * barrel and the nested-`workflow()` resolver can read the registry without the
 * `index.ts → workflow-runner.ts → index.ts` re-export cycle.
 */

import type { WorkflowModule } from '@kodax-ai/agent';

import { parallelInvestigation } from './parallel-investigation.js';
import { scopedReview } from './scoped-review.js';

/**
 * Erase a workflow's concrete arg/result types for storage in the registry.
 * Args arrive as `unknown` from the CLI / JSON surface and are validated by the
 * workflow itself, so the boundary cast is honest.
 */
function erase<A, R>(module: WorkflowModule<A, R>): WorkflowModule {
  return { meta: module.meta, run: (wf, args) => module.run(wf, args as A) };
}

/** All built-in workflows shipped with KodaX. */
export const BUILTIN_WORKFLOWS: readonly WorkflowModule[] = [
  erase(parallelInvestigation),
  erase(scopedReview),
];

/** Resolve a built-in workflow by its declared `meta.name`. */
export function getBuiltinWorkflow(name: string): WorkflowModule | undefined {
  return BUILTIN_WORKFLOWS.find((workflow) => workflow.meta.name === name);
}

/** List built-in workflow metadata (for `/workflow` listing). */
export function listBuiltinWorkflows(): readonly WorkflowModule['meta'][] {
  return BUILTIN_WORKFLOWS.map((workflow) => workflow.meta);
}
