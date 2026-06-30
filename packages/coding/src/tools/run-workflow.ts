/**
 * FEATURE_246 Part A3 (ADR-046) — `run_workflow` tool handler.
 *
 * Thin model-facing front-end over the coding WorkflowHost (`ctx.workflowHost`,
 * wired by tool-execution-context). The Worker authors a workflow inline
 * (`{ manifest, source }`); this starts it on the managed run lifecycle and
 * surfaces the synthesized result. All safety (sandbox / validation / verification
 * / caps) lives in the host + runtime; this handler only validates the call shape.
 *
 * ADR-049: by default this runs ASYNC / idle-yield (reusing the FEATURE_155
 * machinery) — it registers the workflow's completion in the Worker's
 * `childTaskRegistry`, returns immediately, and the synthesized result arrives as a
 * `<task-completed>` block via the idle-yield outer loop. So the REPL is not locked
 * for the whole (often multi-minute) run. When no registry is wired (SDK / headless,
 * or `KODAX_ASYNC_WORKFLOW=0`) it falls back to the blocking path.
 */

import { enqueueChildTaskNotification, registerChildTask } from '@kodax-ai/agent';

import type { ToolResult } from './types.js';
import type {
  KodaXChildExecutionResult,
  KodaXToolExecutionContext,
  WorkflowToolHostInlineInput,
  WorkflowToolHostResult,
} from '../types.js';

// The registry is typed `Promise<KodaXChildExecutionResult>`; the workflow's
// idle-yield entry only needs to SETTLE (the synthesis reaches the Worker via the
// separately-enqueued `<task-completed>` notification, not this value), so a minimal
// result is sufficient — the workflow's own run-graph owns its real accounting.
const EMPTY_CHILD_RESULT: KodaXChildExecutionResult = {
  results: [],
  mergedFindings: [],
  mergedArtifacts: [],
  totalTokensUsed: 0,
  cancelledChildren: [],
};

/** Turn a settled host result into the text the Worker sees (shared by the async
 *  notification summary and the blocking-fallback return). */
function formatWorkflowOutcome(result: WorkflowToolHostResult): string {
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
}

function readManifestName(manifest: unknown): string {
  if (typeof manifest === 'object' && manifest !== null && 'name' in manifest) {
    const name = (manifest as { readonly name?: unknown }).name;
    if (typeof name === 'string' && name.trim().length > 0) return name;
  }
  return 'workflow';
}

export async function toolRunWorkflow(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<ToolResult> {
  const host = ctx.workflowHost;
  if (!host) {
    return '[Tool Error] run_workflow is unavailable on this turn. Workflow authoring is enabled in AMAW mode, or in AMA via the /workflow command (which runs this turn with workflow authoring on). Use dispatch_child_task for a single sub-task.';
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

  // ADR-049: async / idle-yield path (default when the Worker's childTaskRegistry is
  // wired). Start the workflow, register its completion, and return immediately so
  // the turn yields instead of blocking. Mirrors dispatch_child_task's async path.
  const registry = ctx.childTaskRegistry;
  if (registry !== undefined && process.env.KODAX_ASYNC_WORKFLOW !== '0') {
    let started: Awaited<ReturnType<typeof host.startInline>>;
    try {
      started = await host.startInline(inlineInput);
    } catch (error) {
      return `[Tool Error] run_workflow failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (started.kind === 'declined') {
      return `Workflow not started: ${started.reason ?? 'the workflow was declined'}`;
    }
    const taskId = started.runId;
    const done = started.done;
    // Guard a run-id collision with an in-flight task BEFORE starting the settle
    // pump. If we created the settle IIFE first and registerChildTask then threw,
    // the orphaned settle would still fire enqueueChildTaskNotification for the
    // colliding taskId — injecting a spurious <task-completed> for the OTHER run.
    // `has` + `registerChildTask` run synchronously (no await between), so this is
    // race-free within a call; fall back to blocking so the result is never lost.
    if (registry.has(taskId)) {
      return formatWorkflowOutcome(await done);
    }
    // The settle promise enqueues the `<task-completed>` notification (which carries
    // the synthesis the Worker reads) when the run finishes, then resolves so the
    // idle-yield loop wakes the Worker. Its resolved value is a settle signal only.
    const settle = (async (): Promise<KodaXChildExecutionResult> => {
      let summary: string;
      try {
        summary = formatWorkflowOutcome(await done);
      } catch (error) {
        summary = `[Tool Error] Workflow ${taskId} failed: ${error instanceof Error ? error.message : String(error)}`;
      }
      enqueueChildTaskNotification({ taskId, summary });
      return EMPTY_CHILD_RESULT;
    })();
    registerChildTask(registry, taskId, settle);
    return (
      `task_id:${taskId}\n` +
      `Workflow "${readManifestName(manifest)}" started (run ${taskId}) and is now running in the background. ` +
      `Do NOT wait for it inline — its synthesized result will arrive on its own as a ` +
      `<task-completed task_id="${taskId}"> block in a later message. ` +
      `Idle-yield now (end your turn with no tool calls) if you have nothing else to do, ` +
      `or continue with other useful work; you will be resumed automatically when it finishes.`
    );
  }

  // Blocking fallback: no idle-yield registry (SDK / headless), or explicitly disabled.
  try {
    const result = await host.runInline(inlineInput);
    if (result.kind === 'declined') {
      return `Workflow not started: ${result.reason ?? 'the workflow was declined'}`;
    }
    return formatWorkflowOutcome(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `[Tool Error] run_workflow failed: ${message}`;
  }
}
