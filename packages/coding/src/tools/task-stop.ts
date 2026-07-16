/**
 * task_stop — coordinator → graceful child task termination tool.
 *
 * FEATURE_120 v0.7.39 Phase 3b. Lets a coordinator-class agent
 * (Worker / Scout) request that a specific in-flight child task launched
 * via `dispatch_child_task` exit gracefully. Composes two primitives:
 *
 *   1. `requestTaskStop` (from `@kodax-ai/agent`) — looks up the
 *      per-child `AbortController` in `ctx.childAbortControllers` and
 *      fires its signal. The child's current tool call completes
 *      atomically (matches FEATURE_115 soft-pause "tool atomicity"
 *      principle); subsequent abort checks surface the cancellation
 *      and the child emits a final summary.
 *
 *   2. `routeMessage` (from `@kodax-ai/agent`) — when a `reason` is
 *      supplied, the reason is wrapped in a
 *      `<coordinator-stop-request>` system-reminder block and
 *      enqueued at user priority so the child LLM sees WHY it was
 *      stopped before emitting its summary.
 *
 * Parent-only: filtered out of child agents via
 * `CHILD_EXCLUDE_TOOLS_BASE` in `child-executor.ts` — children must
 * not be able to stop their siblings.
 *
 * Abort semantics (Node's AbortController contract): firing the
 * signal does NOT interrupt a synchronous tool that's already
 * executing (e.g. a 90s `npm test`). The child's next
 * `signal.throwIfAborted()` or `signal.aborted` poll surfaces the
 * cancellation. This is intentional — partial state from a hard kill
 * is harder to reason about than a clean post-tool exit.
 */

import {
  getMessageQueue,
  requestTaskStop,
  routeMessage,
} from '@kodax-ai/agent';

import type { KodaXToolExecutionContext } from '../types.js';

const TOOL_NAME = 'task_stop';

export async function toolTaskStop(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  // --- Validate input ---
  const taskId =
    typeof input.task_id === 'string' ? input.task_id.trim() : '';
  if (!taskId) {
    return `[Tool Error] ${TOOL_NAME}: Missing required parameter: task_id (child task_id from dispatch_child_task)`;
  }
  const reason =
    typeof input.reason === 'string' && input.reason.trim().length > 0
      ? input.reason.trim()
      : undefined;

  const plane = ctx.agentExecutorPlane?.plane;
  if (plane) {
    try {
      const task = await plane.tasks.get(taskId);
      if (task.route === 'external') {
        const canceled = await plane.tasks.cancel(taskId, reason);
        return `task_stop external task ${taskId}: cancellation=${canceled.cancellation}, state=${canceled.state}.`;
      }
    } catch (error: unknown) {
      if (!(error instanceof Error) || !error.message.startsWith('Agent task not found:')) {
        const message = error instanceof Error ? error.message : String(error);
        return `[Tool Error] ${TOOL_NAME}: ${message}`;
      }
    }
  }

  // --- Reject when async dispatch is disabled (no abort registry) ---
  const abortRegistry = ctx.childAbortControllers;
  if (!abortRegistry) {
    return `[Tool Error] ${TOOL_NAME}: Async dispatch is disabled (no childAbortControllers on context). Children run synchronously and complete inside their dispatch_child_task call — there is no in-flight target to stop.`;
  }

  // --- Request the abort FIRST ---
  // `abortRegistry.has(taskId)` is the authoritative "is this task in
  // flight" gate. Routing the stop-request message BEFORE this check
  // would leak an orphan `<coordinator-stop-request>` block into a
  // dead child's queue when the abort registry has already been
  // drained (the inner IIFE's `.finally` deletes from
  // `childAbortControllers` before `registerChildTask`'s outer
  // `.finally` deletes from `childTaskRegistry` — there is a small
  // window where the latter still reports `.has(taskId) === true`).
  // Order chosen so the message only lands when the abort actually
  // succeeded.
  const stopOutcome = requestTaskStop({
    taskId,
    registry: abortRegistry,
    reason,
  });

  if (!stopOutcome.ok) {
    if (stopOutcome.reason === 'unknown-target') {
      return `[Tool Error] ${TOOL_NAME}: Unknown task_id "${stopOutcome.taskId}". Verify the task_id matches one returned by dispatch_child_task and that the child has not already completed (completed children are auto-cleaned from the registry).`;
    }
    // already-aborted
    return `[Tool Error] ${TOOL_NAME}: Task "${stopOutcome.taskId}" is already aborted (its first-abort cause is preserved). No additional action needed; the child will surface the cancellation at its next abort check.`;
  }

  // --- Enqueue stop-request explanation AFTER successful abort ---
  // Best-effort delivery: if the child is currently awaiting an LLM
  // call, it observes the abort signal first when the call returns;
  // mid-turn drain semantics determine whether the message is seen
  // before the child's final summary. Either way, the message only
  // exists when the abort actually fired.
  const childTaskRegistry = ctx.childTaskRegistry;
  if (reason && childTaskRegistry) {
    const stopRequestContent =
      `<coordinator-stop-request>\n` +
      `Reason: ${reason}\n` +
      `Finish your current tool call gracefully and emit a final summary.\n` +
      `</coordinator-stop-request>`;
    routeMessage({
      to: taskId,
      priority: 'user',
      mode: 'system-reminder',
      content: stopRequestContent,
      registry: childTaskRegistry,
      queue: getMessageQueue(),
    });
  }

  return `task_stop signal sent to ${taskId}. Child will exit at its next abort check (currently-executing tool completes atomically first).`;
}
