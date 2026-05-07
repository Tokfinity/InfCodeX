/**
 * await_child_task — FEATURE_119 v0.7.36 Pattern B reclaim half.
 *
 * Resolves a previously launched async child task by id.
 *
 * Flow:
 *  1. `dispatch_child_task` launches the executor without awaiting and
 *     registers the in-flight promise into `ctx.childTaskRegistry` keyed
 *     by `task_id`. It returns a `task_id:<id>` banner immediately.
 *  2. The Worker continues with other tools.
 *  3. When the Worker needs the child's result, it calls
 *     `await_child_task({task_id})`. This tool:
 *       - awaits the registered promise
 *       - registers any write-child worktrees for Evaluator diff injection
 *       - extracts the merged finding (or summary) and returns it
 *       - removes the entry from the registry
 *
 * The tool is also enumerated in `YIELD_TOOL_NAMES` (`@kodax/agent`):
 * after a turn that called `await_child_task`, the mid-turn drain
 * upgrades to background priority so `<task-completed>` notifications
 * enqueued by `enqueueChildTaskNotification` are flushed into the next
 * Worker turn.
 *
 * Sync-mode fallback: when `ctx.childTaskRegistry` is undefined
 * (KODAX_ASYNC_DISPATCH=0 forced sync), this tool returns a friendly
 * error directing the caller to use `dispatch_child_task` directly.
 *
 * Implemented as a regular async function (not async generator) so it
 * can be wrapped via `wrapCodingToolAsRunnable`. Progress notes are
 * surfaced via `ctx.reportToolProgress` — the wrapper hooks that to
 * `KodaXEvents.onToolProgress`, identical to how other coding tools
 * stream live status into the REPL.
 */

import type { KodaXToolExecutionContext } from '../types.js';

const TOOL_NAME = 'await_child_task';
const MAX_FINDING_CHARS = 8000;

export async function toolAwaitChildTask(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  const taskIdRaw = typeof input.task_id === 'string' ? input.task_id.trim() : '';
  if (!taskIdRaw) {
    return `[Tool Error] ${TOOL_NAME}: Missing required parameter: task_id`;
  }

  const registry = ctx.childTaskRegistry;
  if (!registry) {
    return (
      `[Tool Error] ${TOOL_NAME}: async dispatch is disabled in this run ` +
      `(KODAX_ASYNC_DISPATCH=0 or registry not provisioned). ` +
      `Use dispatch_child_task directly — it returns the result inline in sync mode.`
    );
  }

  const promise = registry.get(taskIdRaw);
  if (!promise) {
    const inflight = Array.from(registry.keys()).join(', ') || '<none>';
    return (
      `[Tool Error] ${TOOL_NAME}: unknown task_id "${taskIdRaw}". ` +
      `In-flight task ids: ${inflight}. ` +
      `Verify the id you got from dispatch_child_task; each await_child_task removes the entry, ` +
      `so the same id can only be awaited once.`
    );
  }

  ctx.reportToolProgress?.(`Awaiting child "${taskIdRaw}"`);

  let result;
  try {
    result = await promise;
  } catch (err) {
    registry.delete(taskIdRaw);
    const message = err instanceof Error ? err.message : String(err);
    return `Child task "${taskIdRaw}" crashed: ${message.slice(0, 1000)}`;
  }

  // Always remove the entry — successful or not, the promise has settled.
  registry.delete(taskIdRaw);

  const childResult = result.results[0];
  const status = childResult?.status ?? 'failed';
  ctx.reportToolProgress?.(`Child "${taskIdRaw}" → ${status}`);

  if (!childResult || childResult.status === 'failed') {
    return `Child task "${taskIdRaw}" failed: ${childResult?.summary?.slice(0, 1000) ?? 'no result'}`;
  }

  const finding = result.mergedFindings[0];
  if (finding) {
    return finding.evidence.join('\n').slice(0, MAX_FINDING_CHARS);
  }
  return childResult.summary.slice(0, MAX_FINDING_CHARS);
}
