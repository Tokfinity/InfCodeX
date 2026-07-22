import { emitKodaXDiagnostic } from '@kodax-ai/agent';

import type { KodaXToolExecutionContext, WorkflowToolHostInlineInput } from '../types.js';
import type { ToolResult } from './types.js';

function readManifestName(manifest: unknown): string {
  if (typeof manifest === 'object' && manifest !== null && 'name' in manifest) {
    const name = (manifest as { readonly name?: unknown }).name;
    if (typeof name === 'string' && name.trim().length > 0) return name;
  }
  return 'workflow';
}

/** Start an explicitly requested Workflow under the session Actor tree. */
export async function toolRunWorkflow(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<ToolResult> {
  const host = ctx.workflowHost;
  if (!host) {
    return '[Tool Error] run_workflow is unavailable on this turn. It is exposed only for an explicit Workflow request in AMA mode. Use spawn_agent for a single focused sub-task.';
  }
  if (!ctx.actorControl) {
    return '[Tool Error] run_workflow requires the Runtime-owned Actor control plane.';
  }

  const source = input.source;
  if (typeof source !== 'string' || source.trim().length === 0) {
    return '[Tool Error] run_workflow requires a non-empty `source` string defining `async function run(wf, args) { ... }`.';
  }
  const manifest = input.manifest;
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    return '[Tool Error] run_workflow requires a `manifest` object (name, description, phases, readOnly, maxAgents, maxConcurrency, patterns).';
  }

  const inlineInput: WorkflowToolHostInlineInput = {
    manifest,
    source,
    ...(input.args !== undefined ? { args: input.args } : {}),
    ...(typeof input.resumeFromRunId === 'string' && input.resumeFromRunId.length > 0
      ? { resumeFromRunId: input.resumeFromRunId }
      : {}),
  };
  try {
    const started = await host.startInline(inlineInput);
    if (started.kind === 'declined') {
      return `Workflow not started: ${started.reason ?? 'the workflow was declined'}`;
    }
    void started.done.catch((error: unknown) => emitKodaXDiagnostic({
      source: 'coding:workflow-owner',
      level: 'error',
      message: error instanceof Error ? error.message : String(error),
      detail: { runId: started.runId },
    }));
    const workflowPath = `${ctx.actorControl.callerPath}/workflow:${started.runId}`;
    return [
      `run_id:${started.runId}`,
      `workflow_path:${workflowPath}`,
      `Workflow "${readManifestName(manifest)}" started.`,
      `Use list_agents to inspect progress, wait_agent when its mailbox result is on the critical path, agent_output("${workflowPath}") to read the structured WorkflowOutcome, and interrupt_agent("${workflowPath}") to stop it.`,
    ].join('\n');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `[Tool Error] run_workflow failed: ${message}`;
  }
}
