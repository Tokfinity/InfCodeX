/**
 * FEATURE_246 Part A3 (ADR-046) — `run_workflow` tool handler.
 *
 * Thin model-facing front-end over the coding WorkflowHost (`ctx.workflowHost`,
 * wired by tool-execution-context). The Worker authors a workflow inline
 * (`{ manifest, source }`); this starts it on the managed run lifecycle, awaits
 * the result, and returns the synthesized text. All safety (sandbox / validation
 * / verification / caps) lives in the host + runtime; this handler only
 * validates the call shape and surfaces the outcome.
 */

import type { ToolResult } from './types.js';
import type { KodaXToolExecutionContext } from '../types.js';

export async function toolRunWorkflow(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<ToolResult> {
  const host = ctx.workflowHost;
  if (!host) {
    return '[Tool Error] run_workflow is unavailable here — workflows run only in multi-agent mode with a configured run directory. Use dispatch_child_task for a single sub-task.';
  }

  const source = input.source;
  if (typeof source !== 'string' || source.trim().length === 0) {
    return '[Tool Error] run_workflow requires a non-empty `source` string defining `async function run(wf, args) { ... }`.';
  }
  const manifest = input.manifest;
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    return '[Tool Error] run_workflow requires a `manifest` object (name, description, phases, readOnly, maxAgents, maxConcurrency, patterns).';
  }

  try {
    const result = await host.runInline({
      manifest,
      source,
      ...(input.args !== undefined ? { args: input.args } : {}),
    });

    if (result.kind === 'declined') {
      return `Workflow not started: ${result.reason ?? 'the workflow was declined'}`;
    }
    if (result.status === 'completed' || result.status === 'completed_unverified') {
      const text = result.resultText?.trim();
      const prefix = result.status === 'completed_unverified'
        ? `Workflow ${result.runId} completed with verification warnings.\n\n`
        : '';
      return text && text.length > 0
        ? `${prefix}${text}`
        : `Workflow ${result.runId} completed (no displayable result text was returned).`;
    }
    const detail = result.error ?? result.resultText ?? '';
    return `[Tool Error] Workflow ${result.runId ?? ''} ${result.status ?? 'did not complete'}${detail ? `: ${detail}` : ''}`.trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `[Tool Error] run_workflow failed: ${message}`;
  }
}
