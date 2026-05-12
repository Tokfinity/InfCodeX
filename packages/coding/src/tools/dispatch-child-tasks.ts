/**
 * dispatch_child_task — FEATURE_067 (v3: single-child async generator tool)
 * + FEATURE_119 v0.7.36 Pattern B (launch + await split).
 *
 * Executes ONE child agent per tool call as an async generator.
 * Yields progress updates that appear in the REPL transcript in real-time.
 * The LLM dispatches multiple children by calling this tool multiple times
 * in parallel (multiple tool_use blocks in one response).
 *
 * Two modes:
 *  - **Sync (legacy / default)**: when `ctx.childTaskRegistry` is undefined
 *    (or env `KODAX_ASYNC_DISPATCH=0`), the tool awaits the executor
 *    inline and returns the finding text. This is byte-equivalent to the
 *    pre-v0.7.36 behavior so existing prompts and prompt-eval baselines
 *    keep working.
 *  - **Async (Pattern B, FEATURE_119)**: when `ctx.childTaskRegistry` is
 *    a Map, the tool launches the executor, registers the in-flight
 *    promise, and returns a `task_id:<id>` banner immediately. The
 *    Worker continues with other useful work; when it runs out, it
 *    ends the turn text-only and the runner-driven outer loop resumes
 *    it via the idle-yield wait mechanic (FEATURE_155 v0.7.39 Slice
 *    C1 — `await_child_task` tool removed; children are reclaimed
 *    automatically via `<task-completed>` notifications spliced into
 *    the next user message). This unblocks the Worker during
 *    long-running children (e.g. 90s `npm test`).
 *
 * Pattern B is the default when the runner provisions a registry, which
 * happens when `KODAX_ASYNC_DISPATCH !== '0'`. Setting
 * `KODAX_ASYNC_DISPATCH=0` forces the legacy sync path everywhere as a
 * back-compat escape hatch.
 */

import { enqueueChildTaskNotification, registerChildTask } from '@kodax-ai/agent';
import type {
  KodaXChildContextBundle,
  KodaXAmaFanoutClass,
  KodaXChildExecutionResult,
  KodaXToolExecutionContext,
} from '../types.js';
import type { ToolProgress } from './types.js';
import { executeChildAgents, type ChildExecutorOptions } from '../child-executor.js';
// FEATURE_155 (v0.7.39) — dispatch banner steers the LLM to idle-yield
// (end the turn text-only when out of useful work). The v0.7.38
// `await_child_task` wording branch was retired in Slice C3 because
// the underlying tool was removed in Slice C1.

/* ---------- Constants ---------- */

const DEFAULT_MAX_ITERATIONS_PER_CHILD = 200;
const MAX_FINDING_CHARS = 8000;
const TOOL_NAME = 'dispatch_child_task';

/** Returns true if Pattern B async dispatch should be used. */
function shouldUseAsyncDispatch(ctx: KodaXToolExecutionContext): boolean {
  if (process.env.KODAX_ASYNC_DISPATCH === '0') return false;
  return ctx.childTaskRegistry !== undefined;
}

/* ---------- Tool handler (async generator) ---------- */

export async function* toolDispatchChildTask(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): AsyncGenerator<ToolProgress, string, void> {
  // --- Validate input ---
  const id = typeof input.id === 'string' ? input.id.trim() : '';
  const objective = typeof input.objective === 'string' ? input.objective.trim() : '';
  const childId = id || `child-${Date.now()}`;

  if (!objective) {
    yield { stage: 'error', message: `Child "${childId}": missing objective` };
    return `[Tool Error] ${TOOL_NAME}: Missing required parameter: objective`;
  }

  const role = ctx.managedProtocolRole;
  if (role === 'planner' || role === 'evaluator') {
    return `[Tool Error] ${TOOL_NAME}: ${role} cannot dispatch child tasks. Only Scout and Generator may use this tool.`;
  }

  const readOnly = (input.read_only ?? input.readOnly) !== false;
  if (role === 'scout' && !readOnly) {
    return `[Tool Error] ${TOOL_NAME}: Scout can only dispatch read-only tasks. Write fan-out is available to Generator only.`;
  }
  // Issue 124 (v0.7.28) A4: structured dispatch telemetry. Reuses the existing
  // reportToolProgress channel (KodaXEvents.onToolProgress) — no new event
  // type, no new logger. Lines are persisted in the REPL transcript and can
  // be aggregated later via `grep '\[dispatch\]'`. The end line is paired
  // via try/finally so an executor exception still produces the marker
  // (with status=error) — keeping start/end pairs balanced for grep-based
  // aggregation.
  const dispatchStartTs = Date.now();
  ctx.reportToolProgress?.(
    `[dispatch] start childId=${childId} role=${role ?? 'unknown'} readOnly=${readOnly}`,
  );
  let dispatchEndStatus = 'error';
  const emitDispatchEnd = (): void => {
    const dispatchDurationMs = Date.now() - dispatchStartTs;
    ctx.reportToolProgress?.(
      `[dispatch] end childId=${childId} status=${dispatchEndStatus} duration_ms=${dispatchDurationMs}`,
    );
  };
  const bundle: KodaXChildContextBundle = {
    id: childId,
    fanoutClass: 'evidence-scan' as KodaXAmaFanoutClass,
    objective,
    readOnly,
    scopeSummary: typeof input.scope_summary === 'string' ? input.scope_summary : undefined,
    evidenceRefs: Array.isArray(input.evidence_refs)
      ? input.evidence_refs.filter((r): r is string => typeof r === 'string')
      : [],
    constraints: Array.isArray(input.constraints)
      ? input.constraints.filter((c): c is string => typeof c === 'string')
      : [],
  };

  // --- Build executor options ---
  const parentConfig = ctx.parentAgentConfig;
  const options: ChildExecutorOptions = {
    maxParallel: 1,
    maxIterationsPerChild: DEFAULT_MAX_ITERATIONS_PER_CHILD,
    abortSignal: ctx.abortSignal,
    parentOptions: {
      provider: parentConfig?.provider,
      model: parentConfig?.model,
      reasoningMode: parentConfig?.reasoningMode,
      extensionRuntime: ctx.extensionRuntime,
    },
    parentRole: role ?? 'scout',
    parentHarness: 'tool-dispatch',
    // Progress from child executor (e.g. "[1/3] Running: ...") flows through
    // reportToolProgress → onToolProgress → REPL transcript/spinner.
    // Generator yields only cover start/done transitions; this callback covers
    // the entire child execution period in between.
    onProgress: (note: string) => {
      ctx.reportToolProgress?.(note);
    },
    // FEATURE_074: forward the parent-injected plan-mode predicate into the child
    // executor. The predicate is a live closure — it reads parent state at each
    // child tool call, so mid-run mode toggles propagate without respawn.
    planModeBlockCheck: ctx.planModeBlockCheck,
    // FEATURE_092 phase 2b.7b slice D: forward parent-Runner guardrails so the
    // child Runner registers the SAME instances — auto-mode engine + tracker
    // state propagate across the parent/child boundary.
    guardrails: ctx.guardrails,
  };

  // FEATURE_119 v0.7.36 Pattern B branch: when a registry is provisioned
  // and KODAX_ASYNC_DISPATCH is not forced off, launch the executor
  // without awaiting and register the in-flight promise. The Worker
  // continues with other useful work; when out of work it ends the turn
  // text-only, and the runner-driven outer loop's idle-yield mechanic
  // (FEATURE_155 v0.7.39) resumes it on the next external wake event.
  // Background drain (FEATURE_115) wakes the Worker when a child
  // completes via `enqueueChildTaskNotification` — the same
  // `<task-completed>` banner is also synthesized into the next user
  // message by `composeIdleYieldUserMessage`.
  if (shouldUseAsyncDispatch(ctx)) {
    const registry = ctx.childTaskRegistry;
    if (!registry) {
      // Defensive — shouldUseAsyncDispatch already gates on this, but the
      // narrowing keeps the type checker honest.
      yield { stage: 'error', message: `Child "${childId}": registry missing` };
      dispatchEndStatus = 'error';
      emitDispatchEnd();
      return `[Tool Error] ${TOOL_NAME}: childTaskRegistry not available`;
    }
    if (registry.has(childId)) {
      yield { stage: 'error', message: `Child "${childId}": duplicate task_id` };
      dispatchEndStatus = 'error';
      emitDispatchEnd();
      return `[Tool Error] ${TOOL_NAME}: task_id "${childId}" is already in flight. Pick a unique id; the existing child will be reclaimed automatically via the idle-yield wait mechanic (its result will arrive as a <task-completed task_id="${childId}"> block in your next user message).`;
    }

    // FEATURE_120 v0.7.39 Phase 3b — allocate per-child AbortController
    // so `task_stop(task_id)` can request graceful exit of THIS child
    // specifically (without aborting siblings or the parent). The
    // child's effective abort signal is the OR of (parent ctx signal,
    // per-child signal): a parent-wide abort still cancels the child
    // via a one-shot listener on the parent signal, which is detached
    // in the cleanup chain below to keep listener counts bounded
    // across long sessions.
    const childAbortController = new AbortController();
    const parentAbortSignal = ctx.abortSignal;
    let detachParentAbortListener: (() => void) | undefined;
    if (parentAbortSignal) {
      if (parentAbortSignal.aborted) {
        childAbortController.abort(parentAbortSignal.reason);
      } else {
        const onParentAbort = (): void => {
          childAbortController.abort(parentAbortSignal.reason);
        };
        parentAbortSignal.addEventListener('abort', onParentAbort, { once: true });
        detachParentAbortListener = (): void => {
          parentAbortSignal.removeEventListener('abort', onParentAbort);
        };
      }
    }

    // Register in the abort registry so `task_stop` can reach this
    // controller. The matching `delete(childId)` happens in the
    // child Promise's `.finally` chain alongside the registerChildTask
    // cleanup.
    const abortRegistry = ctx.childAbortControllers;
    abortRegistry?.set(childId, childAbortController);

    // Replace the parent signal in `options` with the per-child signal
    // so the child executor + child Runner.run observe the merged
    // abort state. Only the async branch needs this — the sync branch
    // returns to the same LLM call before any task_stop could fire.
    const childOptions: ChildExecutorOptions = {
      ...options,
      abortSignal: childAbortController.signal,
    };

    // Capture the worktree-register callback so it can fire at result
    // time (when the child promise settles, before the registry cleanup
    // `.finally` runs below). Without this, write children's worktrees
    // would never be wired into the Evaluator diff injection path on
    // the async branch.
    const registerWorktrees = ctx.registerChildWriteWorktrees;
    // Default child-task notification target is the ROOT main agent
    // (agentId === undefined). Subagents may set parentAgentId on the
    // ctx in the future to route to a specific scope; keep it undefined
    // for now — the queue's default-undefined target matches the main
    // Runner loop reading from `getMessageQueue()` at iteration start.
    const childPromise: Promise<KodaXChildExecutionResult> = (async () => {
      try {
        const result = await executeChildAgents([bundle], ctx, childOptions);
        if (result.worktreePaths && result.worktreePaths.size > 0 && registerWorktrees) {
          registerWorktrees(result.worktreePaths);
        }
        // Background drain: enqueue a task-completed notification so the
        // Sleep-gated mid-turn drain (FEATURE_115) can wake the Worker
        // even if it's currently mid-stream on another tool.
        const childResult = result.results[0];
        const status = childResult?.status ?? 'failed';
        const summary =
          status === 'completed'
            ? (result.mergedFindings[0]?.evidence.join('\n') ?? childResult?.summary ?? '')
            : `failed: ${childResult?.summary ?? 'no result'}`;
        enqueueChildTaskNotification({
          taskId: childId,
          summary: summary.slice(0, 200),
        });
        return result;
      } catch (err) {
        // Re-enqueue a background notification even on crash so the Worker
        // doesn't block waiting for a task that will never settle into the
        // user-visible queue.
        const message = err instanceof Error ? err.message : String(err);
        enqueueChildTaskNotification({
          taskId: childId,
          summary: `crash: ${message.slice(0, 200)}`,
        });
        throw err;
      } finally {
        // FEATURE_120 v0.7.39 Phase 3b — drain the per-child abort
        // registry + detach the parent-signal listener exactly once
        // per child, whether the child completed, failed, or aborted.
        // Runs BEFORE the `registerChildTask` cleanup `.finally`
        // (which deletes from `childTaskRegistry`) because it's
        // chained on the inner async IIFE, not the registry promise.
        abortRegistry?.delete(childId);
        detachParentAbortListener?.();
      }
    })();
    // v0.7.38 FEATURE_155 Bug A hotfix + v0.7.39 FEATURE_120 Step 0
    // packaging: the `registerChildTask` helper bundles the
    // `.finally(() => registry.delete(childId)).catch(() => {})`
    // cleanup chain into a single call. Without that chain the entry
    // stays forever and every subsequent `waitForWakeEvent` call
    // re-observes the already-settled promise, fires another
    // `child-completed` wake, and triggers
    // `composeIdleYieldUserMessage`'s defensive fallback to fabricate
    // a bogus `(child task completed; no summary available)` banner —
    // driving another LLM turn. The trailing `.catch(() => {})`
    // (chained AFTER `.finally`) swallows the rejection so a child
    // that crashes before any consumer awaits doesn't surface as
    // `unhandledRejection` on Node.
    //
    // The duplicate-id guard at L160 (`registry.has(childId)`)
    // protects the dispatch path; `registerChildTask` also throws on
    // duplicates as belt-and-suspenders.
    registerChildTask(registry, childId, childPromise);

    yield { stage: 'launched', message: `Child "${childId}" launched (async)` };
    dispatchEndStatus = 'launched';
    emitDispatchEnd();
    return (
      `task_id:${childId}\n` +
      `Child task "${childId}" is running in the background. ` +
      `Do whatever interleaved work is useful (more dispatches, side-reads, drafting). ` +
      `When you have nothing else useful to do, end your turn with one short status sentence and NO tool calls — ` +
      `the runner will resume you when this child finishes (you will see a <task-completed task_id="${childId}">…</task-completed> block in your next user message).`
    );
  }

  // --- Sync (legacy / forced via KODAX_ASYNC_DISPATCH=0) ---
  try {
    const result = await executeChildAgents([bundle], ctx, options);

    if (result.worktreePaths && result.worktreePaths.size > 0 && ctx.registerChildWriteWorktrees) {
      ctx.registerChildWriteWorktrees(result.worktreePaths);
    }

    const childResult = result.results[0];
    const status = childResult?.status ?? 'failed';
    dispatchEndStatus = status;
    yield { stage: 'done', message: `Child "${childId}" → ${status}` };

    if (!childResult || childResult.status === 'failed') {
      return `Child task "${childId}" failed: ${childResult?.summary?.slice(0, 1000) ?? 'no result'}`;
    }

    const finding = result.mergedFindings[0];
    if (finding) {
      return finding.evidence.join('\n').slice(0, MAX_FINDING_CHARS);
    }
    return childResult.summary.slice(0, MAX_FINDING_CHARS);
  } finally {
    emitDispatchEnd();
  }
}
