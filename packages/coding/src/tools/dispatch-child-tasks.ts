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

import { emitKodaXDiagnostic, enqueueChildTaskNotification, registerChildTask } from '@kodax-ai/agent';
import type {
  KodaXChildAgentResult,
  KodaXChildContextBundle,
  KodaXChildModelHint,
  KodaXChildFanoutClass,
  KodaXChildExecutionResult,
  KodaXToolExecutionContext,
} from '../types.js';
import type { ToolProgress } from './types.js';
import { executeChildAgents, type ChildExecutorOptions } from '../child-executor.js';
import {
  applyChildSnapshotEvent,
  finalizeChildSnapshot,
  initChildSnapshot,
  type ChildProgressStatus,
} from '../child-progress-snapshot.js';
// FEATURE_191 — specialist agent resolution at dispatch time. `resolveConstructedAgent`
// returns `Agent | undefined`; unknown names are surfaced as tool-result
// errors before bundle construction (no throw — Worker self-corrects).
import {
  listConstructedAgents,
  resolveConstructedAgent,
} from '../construction/agent-resolver.js';
import { applyToolResultGuardrail } from './tool-result-policy.js';
import {
  LARGE_CONTENT_THRESHOLD_BYTES,
  DEFAULT_SUMMARY_MAX_CHARS,
} from './blob-summarizer.js';
import { normalizeReasoningEffortValue } from '@kodax-ai/llm';
import { formatSize } from './truncate.js';
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
let generatedChildTaskIdCounter = 0;

function createGeneratedChildTaskId(): string {
  generatedChildTaskIdCounter =
    generatedChildTaskIdCounter >= Number.MAX_SAFE_INTEGER
      ? 1
      : generatedChildTaskIdCounter + 1;
  return `child-${Date.now().toString(36)}-${generatedChildTaskIdCounter.toString(36)}`;
}

/**
 * FEATURE_121 v0.7.40 follow-up — child-task summary guardrail with
 * LLM-summarize last-resort fallback.
 *
 * Three-layer failure chain:
 *
 *   1. Spill success → preview + marker (Worker can Read full content)
 *   2. Spill failure + content ≤ 100KB → inline full content
 *      (data-loss guard; Worker sees full payload, may exceed envelope cap)
 *   3. Spill failure + content > 100KB AND ctx.summarizeBlob present →
 *      LLM-summarize to ~8KB + lossy-banner marker
 *      ↳ Summarizer failure → fall back to layer 2 (inline full content)
 *      ↳ No summarizer configured → fall back to layer 2
 *
 * The 100KB threshold avoids paying an LLM call on contents that would
 * inline acceptably anyway (≤25K tokens on common 128K models). The
 * lossy banner explicitly flags compression so the Worker knows fine-
 * grained detail may be missing; it should NOT silently treat the
 * summary as the source of truth for diff-precision work.
 *
 * Caller passes the toolName ('child_task_summary' for all 4 dispatch
 * sites) and the raw pre-guardrail content. Returns the banner string
 * to emit verbatim downstream (enqueueChildTaskNotification or
 * sync-tool-result return).
 */
async function applyChildSummaryGuardrailWithSummarizer(
  toolName: string,
  rawContent: string,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  const guarded = await applyToolResultGuardrail(toolName, rawContent, ctx);

  // Normal success path or small-payload inline fallback: return as-is.
  if (!guarded.spillFailed) return guarded.content;
  if (rawContent.length <= LARGE_CONTENT_THRESHOLD_BYTES) return guarded.content;
  if (!ctx.summarizeBlob) return guarded.content;

  // Layer 3: try LLM-summarize the oversized payload.
  try {
    const summary = await ctx.summarizeBlob(rawContent, {
      maxChars: DEFAULT_SUMMARY_MAX_CHARS,
      abortSignal: ctx.abortSignal,
    });
    return [
      `[SPILL FAILED — original ${formatSize(rawContent.length)} compressed via LLM summarizer; raw content unavailable.`,
      `Worker: treat this summary as LOSSY. Critical decisions OK; fine-grained detail may be missing.`,
      `Re-run upstream tool with narrower scope if you need verbatim source.]`,
      '',
      summary,
    ].join('\n');
  } catch (err) {
    // Summarizer failed too — fall back to the inline-full-content path.
    // Match the same diagnostic discipline as the upstream
    // applyToolResultGuardrail spill-failure guard. Prepend an emergency
    // banner so the Worker can SEE that this oversized inline is a last-
    // resort dump (spill failed AND summarize failed) rather than mistaking
    // it for normal authoritative content. Without the banner the Worker
    // sees a 100KB+ raw blob with zero signal that anything went wrong —
    // exactly the silent-data-loss-adjacent surface the FEATURE_121
    // contract is meant to close.
    const cause = err instanceof Error ? err.message : String(err);
    emitKodaXDiagnostic({
      source: 'coding:dispatch-child-tasks',
      level: 'error',
      message:
        `LLM summarizer failed for ${toolName} ` +
        `(${formatSize(rawContent.length)}); inlining full content.`,
      detail: err,
    });
    return [
      `[SPILL FAILED AND LLM SUMMARIZER FAILED — original ${formatSize(rawContent.length)} inlined as last-resort emergency dump.`,
      `Summarizer cause: ${cause}.`,
      `Worker: this payload may exceed context budget. Treat as authoritative source but expect possible downstream truncation. Re-run upstream tool with narrower scope if you need a clean replay.]`,
      '',
      guarded.content,
    ].join('\n');
  }
}

/** Returns true if Pattern B async dispatch should be used. */
function shouldUseAsyncDispatch(ctx: KodaXToolExecutionContext): boolean {
  if (process.env.KODAX_ASYNC_DISPATCH === '0') return false;
  return ctx.childTaskRegistry !== undefined;
}

/**
 * Empty-summary diagnostic fallback. Produces a visible banner body when
 * the child's `runKodaX` returned `{success:true, lastText:''}` (typical
 * CAP-083 AbortError silent terminal path) or otherwise contributed no
 * text to the merged findings.
 *
 * Pre-fix behavior: `rawSummary` chained `??` against three string sources
 * — but `??` only catches nullish, so empty string `''` fell through and
 * the Worker saw `<task-completed task_id="X">\n\n</task-completed>` with
 * zero observable content. Worker could not distinguish "child genuinely
 * ran but produced no text" from "child aborted before first LLM call"
 * from "envelope guardrail dropped the payload".
 *
 * Post-fix: caller checks `rawSummary.trim().length === 0` and substitutes
 * this fallback BEFORE handing to `applyChildSummaryGuardrailWithSummarizer`.
 * Banner now carries a diagnostic envelope (status / iterations / interrupted
 * / provider / model) so Worker (and humans tailing transcripts) can react
 * meaningfully — typically: re-dispatch with the same objective.
 *
 * The fallback is deliberately verbose; for normal non-empty summaries the
 * Worker pays nothing (this function is only called on the empty branch).
 */
function buildEmptySummaryFallback(args: {
  readonly childId: string;
  readonly status: KodaXChildAgentResult['status'] | undefined;
  readonly iterations: number | undefined;
  readonly interrupted: boolean;
  readonly evidenceRefsCount: number;
  readonly mergedFindingsCount: number;
  readonly resultsCount: number;
  readonly provider: string | undefined;
  readonly model: string | undefined;
}): string {
  const interruptedHint = args.interrupted
    ? 'Child exited via the AbortError silent terminal (CAP-083) — typically means an upstream abortSignal fired before the child produced any text. Most common upstream causes: provider stream RST, parent-turn cleanup that propagated an abort, or a task_stop call.'
    : 'No interrupted flag — likely the model returned no text in its final assistant turn, or the envelope guardrail dropped all content.';
  return [
    `(child task "${args.childId}" completed but produced no observable text output.`,
    `Diagnostic: status=${args.status ?? 'unknown'} interrupted=${args.interrupted} iterations=${args.iterations ?? 'n/a'} results=${args.resultsCount} mergedFindings=${args.mergedFindingsCount} evidenceRefs=${args.evidenceRefsCount} provider=${args.provider ?? '?'} model=${args.model ?? '?'}.`,
    interruptedHint,
    `Treat as inconclusive. Set KODAX_DISPATCH_CHILD_TRACE=1 to capture a JSON trace under \`os.tmpdir()/kodax-dispatch-trace/\` for the next reproduction.)`,
  ].join('\n');
}

/**
 * Symmetric counterpart to `buildEmptySummaryFallback` for the failed-empty
 * path: `status==='failed'` AND `childSummary` is empty/whitespace-only. The
 * pre-fix code substituted the literal `'no result'` here, leaving the Worker
 * to invent infrastructure-failure narratives ("clearly a persistent
 * concurrency issue with child task dispatch") with no diagnostic signal to
 * back the hypothesis.
 *
 * The envelope classifies the most common failure modes from the dispatch
 * pipeline's perspective:
 *
 *   - **silent-drop**: `resultsCount===0`. The child bundle was rejected
 *     before `runFanOut` could even invoke the runner — typically a
 *     validation gate (e.g. `validateWriteBundles` blocking write fan-out
 *     for a role not on its allow-list, the empty-bundles early return, or
 *     a role-gating reject inside `dispatch-child-tasks.ts` itself). This
 *     class is invisible without trace; before the fix the Worker would
 *     loop trying the same dispatch shape.
 *   - **startup-crash**: `iterations===0`. The child runner started but the
 *     first assistant turn produced no text — typically a provider stream
 *     error caught by run-substrate CAP-084 (returns `success:false,
 *     lastText:''`). Most common upstream: rate limit on the first call,
 *     network RST, auth failure, or a guardrail rejecting the first tool
 *     call.
 *   - **mid-run-failure**: `iterations>0`. The child made progress then
 *     errored — same CAP-084 path but later, after some assistant turns
 *     accumulated. `turnState.lastText` was still empty when the error
 *     fired (e.g., the error came mid-tool-result before any text block
 *     in the assistant message).
 *   - **unknown**: classifier couldn't pin a mode. Trace is the next step.
 *
 * The fallback fires only on the empty branch; non-empty `childSummary`
 * uses the unmodified `failed: <summary>` shape.
 */
function buildFailedEmptySummaryFallback(args: {
  readonly childId: string;
  readonly status: KodaXChildAgentResult['status'] | undefined;
  readonly iterations: number | undefined;
  readonly interrupted: boolean;
  readonly resultsCount: number;
  readonly mergedFindingsCount: number;
  readonly readOnly: boolean;
  readonly parentRole: string | undefined;
  readonly provider: string | undefined;
  readonly model: string | undefined;
}): string {
  const mode: 'silent-drop' | 'startup-crash' | 'mid-run-failure' | 'unknown' =
    args.resultsCount === 0
      ? 'silent-drop'
      : (args.iterations ?? null) === 0
        ? 'startup-crash'
        : (args.iterations ?? 0) > 0
          ? 'mid-run-failure'
          : 'unknown';
  const modeHint = (() => {
    if (mode === 'silent-drop') {
      return `Bundle never reached the child runner — typically a validation gate dropped it. Check executeChildAgents early-return paths (validateWriteBundles, empty-bundles guard) against parentRole=${args.parentRole ?? '?'} readOnly=${args.readOnly}.`;
    }
    if (mode === 'startup-crash') {
      return 'Child runner errored before any assistant turn — most often run-substrate CAP-084 (success:false, lastText:\'\') triggered by a provider stream error on the first LLM call (rate limit / network / auth / context-size 4xx).';
    }
    if (mode === 'mid-run-failure') {
      return `Child runner produced ${args.iterations} assistant turn(s) then errored without retaining text — typically a mid-stream provider error or a tool-execution failure that left turnState.lastText empty.`;
    }
    return 'Failure mode could not be classified — no childResult and no exception captured.';
  })();
  return [
    `(child task "${args.childId}" FAILED with no result text.`,
    `Diagnostic: status=${args.status ?? 'failed'} mode=${mode} iterations=${args.iterations ?? 'n/a'} interrupted=${args.interrupted} results=${args.resultsCount} mergedFindings=${args.mergedFindingsCount} readOnly=${args.readOnly} parentRole=${args.parentRole ?? '?'} provider=${args.provider ?? '?'} model=${args.model ?? '?'}.`,
    modeHint,
    `Treat as inconclusive — do NOT invent an infrastructure narrative without evidence. Set KODAX_DISPATCH_CHILD_TRACE=1 for a JSON trace at \`os.tmpdir()/kodax-dispatch-trace/\` to disambiguate the next reproduction.)`,
  ].join('\n');
}

/**
 * Optional diagnostic trace writer. Gated on
 * `process.env.KODAX_DISPATCH_CHILD_TRACE === '1'`. Writes one JSON file per
 * settled child to `os.tmpdir()/kodax-dispatch-trace/{ISO}_{childId}.json`.
 *
 * Why not stderr / logger: KodaX runs inside an Ink TUI; stderr is
 * captured by the renderer and not observable to the user. A flat
 * filesystem trace stays out of the render path and survives process
 * exit for later inspection.
 *
 * Best-effort: any I/O failure is swallowed silently — telemetry must
 * never break dispatch.
 */
async function writeDispatchTraceIfEnabled(args: {
  readonly childId: string;
  readonly bundle: KodaXChildContextBundle;
  readonly result: KodaXChildExecutionResult | undefined;
  readonly rawSummary: string;
  readonly bannerContent: string;
  readonly fallbackApplied: boolean;
  readonly provider: string | undefined;
  readonly model: string | undefined;
  readonly error?: unknown;
  readonly durationMs: number;
  /**
   * Which dispatch branch produced this trace. Named `branch` (not `path`)
   * to avoid the shadowing trap with the `path` Node module imported just
   * below — readers skimming the trace JSON shouldn't have to disambiguate.
   */
  readonly branch: 'sync' | 'async-success' | 'async-crash';
}): Promise<void> {
  if (process.env.KODAX_DISPATCH_CHILD_TRACE !== '1') return;
  try {
    const [{ tmpdir }, { join }, fsPromises] = await Promise.all([
      import('os'),
      import('path'),
      import('fs/promises'),
    ]);
    const traceDir = join(tmpdir(), 'kodax-dispatch-trace');
    await fsPromises.mkdir(traceDir, { recursive: true });
    const isoSafe = new Date().toISOString().replace(/[:.]/g, '-');
    const safeChildId = args.childId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
    const filePath = join(traceDir, `${isoSafe}_${safeChildId}.json`);

    const childResult = args.result?.results?.[0];
    const payload = {
      timestamp: new Date().toISOString(),
      branch: args.branch,
      childId: args.childId,
      durationMs: args.durationMs,
      provider: args.provider ?? null,
      model: args.model ?? null,
      bundle: {
        objective: args.bundle.objective,
        readOnly: args.bundle.readOnly,
        scopeSummary: args.bundle.scopeSummary ?? null,
        evidenceRefsCount: args.bundle.evidenceRefs.length,
        constraintsCount: args.bundle.constraints.length,
        modelHint: args.bundle.modelHint ?? null,
        specialistName: args.bundle.specialistName ?? null,
      },
      result: args.result === undefined
        ? null
        : {
            resultsCount: args.result.results.length,
            mergedFindingsCount: args.result.mergedFindings.length,
            cancelledChildrenCount: args.result.cancelledChildren.length,
            childResult: childResult === undefined
              ? null
              : {
                  status: childResult.status,
                  disposition: childResult.disposition,
                  summaryLength: childResult.summary.length,
                  summaryPreview: childResult.summary.slice(0, 200),
                  evidenceRefsCount: childResult.evidenceRefs.length,
                  contradictionsCount: childResult.contradictions.length,
                  actualIterations: childResult.actualIterations ?? null,
                  interrupted: childResult.interrupted ?? null,
                },
          },
      rawSummaryLength: args.rawSummary.length,
      rawSummaryPreview: args.rawSummary.slice(0, 400),
      bannerContentLength: args.bannerContent.length,
      bannerContentPreview: args.bannerContent.slice(0, 400),
      fallbackApplied: args.fallbackApplied,
      error: args.error
        ? {
            message: args.error instanceof Error ? args.error.message : String(args.error),
            name: args.error instanceof Error ? args.error.name : 'unknown',
          }
        : null,
    };
    // mode 0o600 — owner read/write only. Trace payloads carry bundle
    // objectives + summary previews that may include codebase fragments
    // the user wouldn't intend to share with other accounts on the same
    // box. POSIX honors the mode; Windows ignores it (NTFS ACLs are
    // separate), which is acceptable since KodaX is single-user.
    await fsPromises.writeFile(filePath, JSON.stringify(payload, null, 2), { mode: 0o600 });
  } catch {
    // Best-effort — never break dispatch on telemetry I/O failure.
  }
}

/* ---------- Tool handler (async generator) ---------- */

export async function* toolDispatchChildTask(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): AsyncGenerator<ToolProgress, string, void> {
  // --- Validate input ---
  const id = typeof input.id === 'string' ? input.id.trim() : '';
  const objective = typeof input.objective === 'string' ? input.objective.trim() : '';
  const childId = id || createGeneratedChildTaskId();

  if (!objective) {
    yield { stage: 'error', message: `Child "${childId}": missing objective` };
    return `[Tool Error] ${TOOL_NAME}: Missing required parameter: objective`;
  }

  const role = ctx.managedProtocolRole;
  // FEATURE_193 (v0.7.43): V1 chain retired. Worker (V2 AMA single-loop)
  // is the only role that dispatches children. Pre-F193 V1 role guards
  // (`if (role === 'planner' || role === 'evaluator')` and the
  // Scout-read-only guard) are deleted; the wider `KodaXTaskRole` union
  // still carries the V1 names for pre-1.0 SDK consumer compat, but no
  // production code path reaches this tool with those role values.
  const readOnly = (input.read_only ?? input.readOnly) !== false;
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

  // FEATURE_191 — optional `subagent_type` field. When set, dispatch
  // routes the child through a registered specialist agent's
  // `instructions` + tool whitelist + reasoning + guardrails instead of
  // the stock Worker bundle. Unknown names return a tool-result error
  // (not throw) so the calling Worker can self-correct or fallback to
  // anonymous dispatch.
  const subagentTypeRaw = typeof input.subagent_type === 'string' ? input.subagent_type.trim() : '';
  const specialistName = subagentTypeRaw || undefined;
  let specialistEffort: KodaXChildContextBundle['effort'];
  if (specialistName) {
    const specialist = resolveConstructedAgent(specialistName, ctx.agentScope);
    if (!specialist) {
      const available = listConstructedAgents(ctx.agentScope).map(a => a.name);
      const availableStr = available.length === 0 ? '(none)' : available.join(', ');
      yield { stage: 'error', message: `Child "${childId}": specialist "${specialistName}" not registered` };
      return `[Tool Error] ${TOOL_NAME}: specialist "${specialistName}" not registered. Available: ${availableStr}`;
    }
    // FEATURE_191 A.2c — specialist write dispatch parentRole gate. Mirrors
    // the worker allow-list that `validateWriteBundles` enforces in
    // `child-executor.ts`. Reject here explicitly with a reason rather than
    // letting the bundle silently drop inside `validateWriteBundles`.
    // FEATURE_193 (v0.7.43): pre-V2 surface accepted Worker OR Generator;
    // Generator retired (chain.generator deleted) so only Worker remains as
    // the V2 write dispatcher. `validateWriteBundles` keeps the
    // `parentRole === 'generator'` branch as a defensive dead-branch for
    // test-infrastructure parity (see `child-executor.ts:829` comment).
    if (!readOnly && role !== 'worker') {
      return `[Tool Error] ${TOOL_NAME}: specialist "${specialistName}" is a write dispatch (readOnly=false) but current role "${role ?? 'unknown'}" cannot dispatch write children. Only Worker may dispatch write specialists.`;
    }
    if (specialist.effort !== undefined && specialist.effort.trim().length > 0) {
      try {
        const normalizedEffort = normalizeReasoningEffortValue(specialist.effort);
        specialistEffort = normalizedEffort === 'auto' ? undefined : normalizedEffort;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return `[Tool Error] ${TOOL_NAME}: specialist "${specialistName}" declares invalid effort "${specialist.effort}". ${message}`;
      }
    }
  }

  // FEATURE_102 Phase 2 — optional explicit provider/model for this child.
  // Parsed tolerantly (empty → undefined). An unconfigured provider falls back
  // to the parent in child-executor, so a misuse never fails the dispatch.
  const childProvider =
    typeof input.provider === 'string' && input.provider.trim() ? input.provider.trim() : undefined;
  const childModel =
    typeof input.model === 'string' && input.model.trim() ? input.model.trim() : undefined;
  let childEffort: KodaXChildContextBundle['effort'];
  if (typeof input.effort === 'string' && input.effort.trim()) {
    try {
      const normalizedEffort = normalizeReasoningEffortValue(input.effort);
      childEffort = normalizedEffort === 'auto' ? undefined : normalizedEffort;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `[Tool Error] ${TOOL_NAME}: invalid effort "${input.effort}". ${message}`;
    }
  }
  if (specialistEffort !== undefined && childEffort !== undefined && childEffort !== specialistEffort) {
    return `[Tool Error] ${TOOL_NAME}: specialist "${specialistName ?? 'unknown'}" locks effort "${specialistEffort}", but dispatch requested "${childEffort}". Remove the dispatch effort or match the specialist effort.`;
  }
  const effectiveChildEffort = specialistEffort ?? childEffort;

  const bundle: KodaXChildContextBundle = {
    id: childId,
    fanoutClass: 'evidence-scan' as KodaXChildFanoutClass,
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
    specialistName,
    ...(childProvider ? { provider: childProvider } : {}),
    ...(childModel ? { model: childModel } : {}),
    ...(effectiveChildEffort ? { effort: effectiveChildEffort } : {}),
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
      effort: parentConfig?.effort,
      repoIntelligenceMode: parentConfig?.repoIntelligenceMode,
      repoIntelligenceTrace: parentConfig?.repoIntelligenceTrace,
      extensionRuntime: ctx.extensionRuntime,
      events: ctx.parentEvents,
    },
    // FEATURE_193 (v0.7.43): fallback `'scout'` (V1 role, retired) replaced
    // with `'worker'`. In V2 `role` is set by `wrapDispatchChildTaskForRole`
    // which only passes `'worker'` (see `dispatch-child.ts` role union), so
    // the fallback is unreachable in production paths; the V2 default
    // ensures any future caller hitting the fallback gets a current-day
    // role label instead of a retired one.
    parentRole: role ?? 'worker',
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

    // FEATURE_177 v0.7.45 — initialise the per-child progress snapshot
    // BEFORE launching the child so a concurrent `task_output(childId)`
    // query during the dispatch generator's own yield phase sees
    // `status:'running'` instead of `not_found`. The closure handed to
    // `childOptions.snapshotUpdater` writes through the same Map
    // instance for the lifetime of the child. Snapshot stays in the
    // Map past `childTaskRegistry` cleanup so post-completion peeks
    // work (bounded by `CHILD_PROGRESS_SNAPSHOT_CAP` FIFO prune).
    const snapshotMap = ctx.childProgressSnapshots;
    if (snapshotMap) {
      initChildSnapshot(snapshotMap, {
        childId,
        startedAt: Date.now(),
        maxIterations: options.maxIterationsPerChild,
        parentRole: options.parentRole,
        readOnly: bundle.readOnly,
        specialistName: bundle.specialistName,
      });
    }

    // Replace the parent signal in `options` with the per-child signal
    // so the child executor + child Runner.run observe the merged
    // abort state. Only the async branch needs this — the sync branch
    // returns to the same LLM call before any task_stop could fire.
    const childOptions: ChildExecutorOptions = {
      ...options,
      abortSignal: childAbortController.signal,
      // FEATURE_177 — hand the snapshot writer to the child events
      // bridge. `snapshotMap` may be `undefined` if the runner did not
      // provision the map (e.g., a test ctx); the closure noop's in
      // that case via `applyChildSnapshotEvent`'s undefined-check.
      snapshotUpdater: snapshotMap
        ? (event) => applyChildSnapshotEvent(snapshotMap, childId, event)
        : undefined,
    };

    // Default child-task notification target is the ROOT main agent
    // (agentId === undefined). Subagents may set parentAgentId on the
    // ctx in the future to route to a specific scope; keep it undefined
    // for now — the queue's default-undefined target matches the main
    // Runner loop reading from `getMessageQueue()` at iteration start.
    const asyncDispatchStartTs = Date.now();
    // FEATURE_177: hoisted terminal state for the `.finally` snapshot
    // finalize. Defaults guarantee a non-`running` terminal even if the
    // try/catch bodies throw before populating either variable
    // (code-review HIGH-1). The success/crash branches overwrite both
    // with their authoritative values immediately before the throw or
    // return; `.finally` then writes through to the snapshot exactly
    // once per child lifecycle.
    let terminalStatus: ChildProgressStatus = 'failed';
    let terminalText: string | undefined;
    const childPromise: Promise<KodaXChildExecutionResult> = (async () => {
      try {
        const result = await executeChildAgents([bundle], ctx, childOptions);
        // Background drain: enqueue a task-completed notification so the
        // Sleep-gated mid-turn drain (FEATURE_115) can wake the Worker
        // even if it's currently mid-stream on another tool.
        const childResult = result.results[0];
        const status = childResult?.status ?? 'failed';
        // Truthy-with-trim chain instead of `??` — `??` only catches
        // nullish, so `''` slipped through and produced
        // `<task-completed task_id="X">\n\n</task-completed>` banners
        // with zero observable content (see project memory
        // `project_dispatch_child_empty_banner_bug`). The
        // `.trim().length > 0` filter also catches whitespace-only summaries
        // that would have rendered as visually-empty banners.
        const evidenceText = result.mergedFindings[0]?.evidence.join('\n') ?? '';
        const childSummary = childResult?.summary ?? '';
        let rawSummary: string;
        let fallbackApplied = false;
        if (status === 'completed') {
          if (evidenceText.trim().length > 0) {
            rawSummary = evidenceText;
          } else if (childSummary.trim().length > 0) {
            rawSummary = childSummary;
          } else {
            rawSummary = buildEmptySummaryFallback({
              childId,
              status,
              iterations: childResult?.actualIterations,
              interrupted: childResult?.interrupted === true,
              evidenceRefsCount: childResult?.evidenceRefs.length ?? 0,
              mergedFindingsCount: result.mergedFindings.length,
              resultsCount: result.results.length,
              provider: parentConfig?.provider,
              model: parentConfig?.model,
            });
            fallbackApplied = true;
          }
        } else {
          // FEATURE_176 symmetric: failed-empty path used to substitute the
          // literal 'no result', giving the Worker no signal to distinguish
          // a validation-drop / startup CAP-084 / mid-run failure. Now emits
          // the same diagnostic envelope shape as the success-empty branch
          // so subsequent investigation has at least one mode classification
          // + iteration count + readOnly/parentRole context to grep.
          if (childSummary.trim().length > 0) {
            rawSummary = `failed: ${childSummary}`;
          } else {
            rawSummary = buildFailedEmptySummaryFallback({
              childId,
              status,
              iterations: childResult?.actualIterations,
              interrupted: childResult?.interrupted === true,
              resultsCount: result.results.length,
              mergedFindingsCount: result.mergedFindings.length,
              readOnly: bundle.readOnly,
              parentRole: role,
              provider: parentConfig?.provider,
              model: parentConfig?.model,
            });
            fallbackApplied = true;
          }
        }
        // FEATURE_121 (v0.7.40): per-banner guardrail + LLM-summarize last-
        // resort fallback. Replaces the previous `summary.slice(0, 200)`
        // 200-char hard truncate. For ≤50KB output the full content is
        // inlined; for >50KB the framework writes to
        // `getAgentConfigPath('tool-results')/<id>.txt` and the envelope
        // banner carries a preview + spill path. If spill fails AND content
        // > 100KB, the helper calls `ctx.summarizeBlob` (Worker-same provider)
        // to compress to ~8KB rather than inlining MB+ data that would blow
        // the context window. See `applyChildSummaryGuardrailWithSummarizer`
        // header for the full failure chain.
        const bannerContent = await applyChildSummaryGuardrailWithSummarizer(
          'child_task_summary',
          rawSummary,
          ctx,
        );
        enqueueChildTaskNotification({
          taskId: childId,
          summary: bannerContent,
          source: 'child_task',
          status: status === 'completed' ? 'completed' : 'failed',
        });
        await writeDispatchTraceIfEnabled({
          childId,
          bundle,
          result,
          rawSummary,
          bannerContent,
          fallbackApplied,
          provider: parentConfig?.provider,
          model: parentConfig?.model,
          durationMs: Date.now() - asyncDispatchStartTs,
          branch: 'async-success',
        });
        // FEATURE_177: pin terminal state for `.finally` snapshot
        // finalize. `status === 'completed'` maps to the success
        // terminal; anything else (blocked / failed) collapses to
        // `failed` from the snapshot's perspective — the diagnostic
        // mode= envelope inside `rawSummary` carries the distinction.
        terminalStatus = status === 'completed' ? 'completed' : 'failed';
        terminalText = rawSummary;
        return result;
      } catch (err) {
        // Re-enqueue a background notification even on crash so the Worker
        // doesn't block waiting for a task that will never settle into the
        // user-visible queue.
        const message = err instanceof Error ? err.message : String(err);
        // FEATURE_121 (v0.7.40): crash messages are typically small (<1KB) so
        // the guardrail will inline them; routing through the same path keeps
        // success / failure envelope semantics uniform. The summarize
        // fallback never triggers here (content <<100KB) but threading
        // through the same helper keeps the 4 call sites identical.
        const crashRaw = `crash: ${message.length > 0 ? message : 'unknown error (Error.message was empty)'}`;
        const bannerContent = await applyChildSummaryGuardrailWithSummarizer(
          'child_task_summary',
          crashRaw,
          ctx,
        );
        enqueueChildTaskNotification({
          taskId: childId,
          summary: bannerContent,
          source: 'child_task',
          status: 'failed',
        });
        await writeDispatchTraceIfEnabled({
          childId,
          bundle,
          result: undefined,
          rawSummary: crashRaw,
          bannerContent,
          fallbackApplied: false,
          provider: parentConfig?.provider,
          model: parentConfig?.model,
          error: err,
          durationMs: Date.now() - asyncDispatchStartTs,
          branch: 'async-crash',
        });
        // FEATURE_177: pin terminal state for `.finally` snapshot
        // finalize. AbortError (parent abort OR task_stop) routes to
        // the `aborted` terminal; everything else (provider crash,
        // assertion failure, programmer error) is `failed`. The
        // distinction matters for the Worker's diagnostic envelope —
        // `aborted` means "intentional", `failed` means "unexpected".
        const isAbortError =
          err instanceof Error &&
          (err.name === 'AbortError' || err.message.toLowerCase().includes('aborted'));
        terminalStatus = isAbortError ? 'aborted' : 'failed';
        terminalText = crashRaw;
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
        // FEATURE_177 v0.7.45 — write terminal status + finalText into
        // the snapshot exactly once per child. MUST be in `.finally`
        // (not the success/crash bodies) so a thrown handler inside
        // either branch still leaves the snapshot in a non-`running`
        // terminal state. If `terminalText` is `undefined`
        // (defensive — happens only if the try body threw before the
        // status pin), the default `'failed'` status with no body lets
        // the Worker's task_output reader at least know the child
        // settled.
        finalizeChildSnapshot(snapshotMap, childId, {
          status: terminalStatus,
          finalText: terminalText,
          endedAt: Date.now(),
        });
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

    const childResult = result.results[0];
    const status = childResult?.status ?? 'failed';
    dispatchEndStatus = status;
    yield { stage: 'done', message: `Child "${childId}" → ${status}` };

    if (!childResult || childResult.status === 'failed') {
      // FEATURE_121 (v0.7.40): same guardrail + LLM-summarize fallback as
      // the async branch envelope path. Replaces the previous
      // `slice(0, 1000)` 1000-char hard truncate.
      // FEATURE_176 symmetric: failed-empty path also uses the diagnostic
      // envelope so the Worker's banner carries mode classification +
      // iteration count instead of the bare literal `no result`.
      const hasSummary = childResult?.summary && childResult.summary.trim().length > 0;
      let failedRaw: string;
      let fallbackApplied = false;
      if (hasSummary) {
        failedRaw = `Child task "${childId}" failed: ${childResult!.summary}`;
      } else {
        failedRaw = buildFailedEmptySummaryFallback({
          childId,
          status,
          iterations: childResult?.actualIterations,
          interrupted: childResult?.interrupted === true,
          resultsCount: result.results.length,
          mergedFindingsCount: result.mergedFindings.length,
          readOnly: bundle.readOnly,
          parentRole: role,
          provider: parentConfig?.provider,
          model: parentConfig?.model,
        });
        fallbackApplied = true;
      }
      const bannerContent = await applyChildSummaryGuardrailWithSummarizer(
        'child_task_summary',
        failedRaw,
        ctx,
      );
      await writeDispatchTraceIfEnabled({
        childId,
        bundle,
        result,
        rawSummary: failedRaw,
        bannerContent,
        fallbackApplied,
        provider: parentConfig?.provider,
        model: parentConfig?.model,
        durationMs: Date.now() - dispatchStartTs,
        branch: 'sync',
      });
      return bannerContent;
    }

    const finding = result.mergedFindings[0];
    // FEATURE_121 (v0.7.40): replace MAX_FINDING_CHARS=8000 hard slice
    // with the unified `child_task_summary` guardrail + LLM-summarize
    // fallback. Sync legacy path now matches the async/envelope semantics.
    //
    // Empty-summary fallback (project memory
    // `project_dispatch_child_empty_banner_bug`): when both `finding.evidence`
    // and `childResult.summary` are empty/whitespace-only, substitute the
    // diagnostic envelope so the Worker sees observable content instead of
    // an empty string. Mirrors the async-success path.
    const findingText = finding ? finding.evidence.join('\n') : '';
    const fallbackSummary = childResult.summary;
    let raw: string;
    let fallbackApplied = false;
    if (findingText.trim().length > 0) {
      raw = findingText;
    } else if (fallbackSummary.trim().length > 0) {
      raw = fallbackSummary;
    } else {
      raw = buildEmptySummaryFallback({
        childId,
        status,
        iterations: childResult.actualIterations,
        interrupted: childResult.interrupted === true,
        evidenceRefsCount: childResult.evidenceRefs.length,
        mergedFindingsCount: result.mergedFindings.length,
        resultsCount: result.results.length,
        provider: parentConfig?.provider,
        model: parentConfig?.model,
      });
      fallbackApplied = true;
    }
    const bannerContent = await applyChildSummaryGuardrailWithSummarizer(
      'child_task_summary',
      raw,
      ctx,
    );
    await writeDispatchTraceIfEnabled({
      childId,
      bundle,
      result,
      rawSummary: raw,
      bannerContent,
      fallbackApplied,
      provider: parentConfig?.provider,
      model: parentConfig?.model,
      durationMs: Date.now() - dispatchStartTs,
      branch: 'sync',
    });
    return bannerContent;
  } finally {
    emitDispatchEnd();
  }
}
