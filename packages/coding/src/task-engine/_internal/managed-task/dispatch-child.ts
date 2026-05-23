/**
 * Per-role `dispatch_child_task` wrapper for the runner-driven AMA path.
 *
 * Adapts the async-generator handler to the Runner's `RunnableTool`
 * contract: drives the generator to completion, surfaces intermediate
 * progress via `ctx.reportToolProgress`, captures child write
 * worktrees (FEATURE_067 v2 Evaluator-diff parity), fires the AMA
 * fanout status event, and stamps `managedProtocolRole` on the per-call
 * context so the underlying handler's role-gating logic sees the right
 * label (Scout: read-only; Generator/Worker: full).
 *
 * Extracted from `task-engine/runner-driven.ts` lines ~1641–1709 of
 * the pre-FEATURE_171 monolith as part of FEATURE_171 (v0.7.41)
 * modular split. Zero behavior change — body is byte-identical to the
 * previous in-file declaration.
 */

import type { KodaXToolDefinition } from '@kodax-ai/llm';
import type {
  RunnableTool,
  RunnerToolContext,
  RunnerToolResult,
} from '@kodax-ai/agent';
import { toolDispatchChildTask } from '../../../tools/dispatch-child-tasks.js';
import { incrementManagedBudgetUsage } from './budget.js';
import type { ManagedTaskBudgetController } from './budget.js';
import type {
  KodaXEvents,
  KodaXToolExecutionContext,
} from '../../../types.js';
import type { ObserverBridge } from './types.js';

/**
 * Shard 6d-Q: wrap the dispatch_child_task async-generator tool as a
 * Runner-compatible tool.
 *
 * Differences from coding tools handled by `wrapCodingToolAsRunnable`:
 *   - The handler is `AsyncGenerator<ToolProgress, string, void>`. The
 *     Runner loop does not consume progress events directly; we drive
 *     the generator here, forward progress notes through
 *     `ctx.reportToolProgress` on the parent exec context (best-effort),
 *     and return only the final string.
 *   - `dispatch_child_task` enforces `ctx.managedProtocolRole` for role
 *     gating (Scout: read-only only; Planner/Evaluator: blocked;
 *     Generator: full). The Runner path does not set
 *     `managedProtocolRole` on the base ctx, so each role-specific
 *     wrapper injects the right role on the per-call ctx.
 */
export function wrapDispatchChildTaskForRole(
  definition: KodaXToolDefinition,
  baseCtx: KodaXToolExecutionContext,
  // FEATURE_114 v0.7.36 — `'worker'` joined the dispatch-capable roles
  // for the V2 single-loop path. FEATURE_193 (v0.7.43) retired the V1
  // Scout and Generator chain agents (chain.scout / chain.generator
  // deleted in commit `dcac55ea`), so the role union narrows to a
  // single literal `'worker'` — the only caller is
  // `agent-chain.ts:buildRunnerAgentChain` which builds `workerDispatch`.
  // `managedProtocolRole` is set to this value on the per-call ctx;
  // downstream gates (`validateWriteBundles` in `child-executor.ts`)
  // accept this value as the V2 dispatcher identity.
  role: 'worker',
  budget: ManagedTaskBudgetController | undefined,
  observer: ObserverBridge,
  events?: KodaXEvents,
): RunnableTool {
  return {
    ...definition,
    execute: async (
      input: Record<string, unknown>,
      runnerCtx?: RunnerToolContext,
    ): Promise<RunnerToolResult> => {
      if (budget) incrementManagedBudgetUsage(budget, 1);
      // Fire a fanout status event so the REPL's
      // AmaWorkStrip can render a "Scout/Generator fanning out" badge.
      // Best-effort — Runner tool loop runs each tool_use serially, so
      // per-call count=1 reflects the current invocation; the downstream
      // UI aggregates by `childFanoutClass`.
      observer.notifyChildFanout('evidence-scan');
      // v0.7.26 parity (C2): inject per-call reportToolProgress so the
      // child-task yield stages (ctx.reportToolProgress?.(note) inside
      // toolDispatchChildTask) surface through KodaXEvents.onToolProgress
      // keyed on the current tool_use id. Without this, async-generator
      // progress updates vanish — the REPL's "Running: ..." line never
      // updates. Mirrors the same injection wrapCodingToolAsRunnable
      // already does.
      const toolCallId = runnerCtx?.toolCallId;
      const progressHook = events?.onToolProgress && toolCallId
        ? (message: string) => events.onToolProgress?.({ id: toolCallId, message })
        : undefined;
      // Shallow clone so the managedProtocolRole + per-call progress hook
      // are local to this invocation. The base ctx stays pristine
      // for parallel dispatches.
      const perCallCtx: KodaXToolExecutionContext = {
        ...baseCtx,
        managedProtocolRole: role,
        reportToolProgress: progressHook,
      };
      try {
        const gen = toolDispatchChildTask(input, perCallCtx);
        // Drain the generator. Intermediate yields are surfaced via
        // `ctx.reportToolProgress` (bound above to onToolProgress), so
        // the REPL transcript updates live.
        let next = await gen.next();
        while (!next.done) {
          next = await gen.next();
        }
        const finalValue = typeof next.value === 'string' ? next.value : '';
        return { content: finalValue };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: `[Tool Error] ${definition.name}: ${message}`, isError: true };
      }
    },
  };
}
