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
  KodaXChildModelHint,
  KodaXAmaFanoutClass,
  KodaXChildExecutionResult,
  KodaXToolExecutionContext,
} from '../types.js';
import type { ToolProgress } from './types.js';
import { executeChildAgents, type ChildExecutorOptions } from '../child-executor.js';
import { applyToolResultGuardrail } from './tool-result-policy.js';
// FEATURE_155 (v0.7.39) — dispatch banner steers the LLM to idle-yield
// (end the turn text-only when out of useful work). The v0.7.38
// `await_child_task` wording branch was retired in Slice C3 because
// the underlying tool was removed in Slice C1.

/* ---------- Constants ---------- */

const DEFAULT_MAX_ITERATIONS_PER_CHILD = 200;
// FEATURE_121 (v0.7.40): `MAX_FINDING_CHARS = 8000` was removed — the sync
// dispatch path now uses `applyToolResultGuardrail('child_task_summary', ...)`
// (50KB threshold + spill-to-file) for parity with the async/envelope path.
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
  // FEATURE_120 v0.7.39 Phase 4 — optional `model_hint` field. Routing
  // is a no-op for now (every child still runs on the parent's model);
  // FEATURE_102 (v0.7.45) is the planned consumer. Parsed tolerantly:
  // unknown strings fall back to undefined so a misuse doesn't fail
  // the dispatch.
  const modelHintRaw = typeof input.model_hint === 'string' ? input.model_hint.trim() : '';
  const modelHint: KodaXChildModelHint | undefined =
    modelHintRaw === 'fast' || modelHintRaw === 'balanced' || modelHintRaw === 'deep'
      ? modelHintRaw
      : undefined;

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
    modelHint,
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
        const rawSummary =
          status === 'completed'
            ? (result.mergedFindings[0]?.evidence.join('\n') ?? childResult?.summary ?? '')
            : `failed: ${childResult?.summary ?? 'no result'}`;
        // FEATURE_121 (v0.7.40): per-banner guardrail. Replaces the previous
        // `summary.slice(0, 200)` 200-char hard truncate. For ≤50KB output the
        // full content is inlined; for >50KB the framework writes to
        // `getAgentConfigPath('tool-results')/<id>.txt` and the envelope
        // banner carries a preview + spill path that Worker can Read on demand.
        const guarded = await applyToolResultGuardrail('child_task_summary', rawSummary, ctx);
        enqueueChildTaskNotification({
          taskId: childId,
          summary: guarded.content,
        });
        return result;
      } catch (err) {
        // Re-enqueue a background notification even on crash so the Worker
        // doesn't block waiting for a task that will never settle into the
        // user-visible queue.
        const message = err instanceof Error ? err.message : String(err);
        // FEATURE_121 (v0.7.40): crash messages are typically small (<1KB) so
        // the guardrail will inline them; routing through the same path keeps
        // success / failure envelope semantics uniform.
        const guarded = await applyToolResultGuardrail(
          'child_task_summary',
          `crash: ${message}`,
          ctx,
        );
        enqueueChildTaskNotification({
          taskId: childId,
          summary: guarded.content,
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
      // FEATURE_121 (v0.7.40): same guardrail as the async branch envelope
      // path. Replaces the previous `slice(0, 1000)` 1000-char hard
      // truncate. For ≤50KB content the full message inlines; for >50KB
      // the framework spills to file and the tool result carries
      // preview + path that Worker can Read on demand.
      const failedSummary = childResult?.summary ?? 'no result';
      const guarded = await applyToolResultGuardrail(
        'child_task_summary',
        `Child task "${childId}" failed: ${failedSummary}`,
        ctx,
      );
      return guarded.content;
    }

    const finding = result.mergedFindings[0];
    // FEATURE_121 (v0.7.40): replace MAX_FINDING_CHARS=8000 hard slice
    // with the unified `child_task_summary` guardrail (50KB threshold +
    // spill-to-file). Sync legacy path now matches the async/envelope
    // semantics — 8000 chars was the same silent data loss bug as the
    // async-path's 200-char banner truncate before FEATURE_121 fix.
    const raw = finding
      ? finding.evidence.join('\n')
      : childResult.summary;
    const guarded = await applyToolResultGuardrail('child_task_summary', raw, ctx);
    return guarded.content;
  } finally {
    emitDispatchEnd();
  }
}
