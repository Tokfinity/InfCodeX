/**
 * Tool execution context builder — CAP-048
 *
 * Capability inventory: docs/features/v0.7.29-capability-inventory.md#cap-048-kodaxtoolexecutioncontext-construction
 *
 * Class 1 (substrate). Constructs the `KodaXToolExecutionContext`
 * passed to every executeToolCall invocation. The context bundles:
 *
 *   - per-run state: `backups` map (write-tool rollback), abort signal,
 *     extension runtime, working directory + git root.
 *   - declarative wiring forwarded from `options.context`:
 *     mutationTracker, planModeBlockCheck, managedProtocolRole.
 *   - parent agent config snapshot (provider/model/reasoningMode) so
 *     `dispatch_child_task` can spawn children with the parent's
 *     declaration.
 *   - REPL callbacks: askUser, askUserInput, exitPlanMode.
 *   - `emitManagedProtocol` closure that mutates a shared payload ref
 *     so multiple emissions accumulate across the turn loop.
 *
 * **Two FEATURE flags asserted by CAP-048**:
 *   - FEATURE_074: `set_permission_mode` is NOT forwarded as a callback
 *     (security invariant — see `agent.ts` historical comment block).
 *   - FEATURE_067: `onChildProgress` is intentionally `undefined` —
 *     progress is reported via `onToolProgress` instead.
 *
 * Migration history: extracted from `agent.ts:419-460` — pre-FEATURE_100
 * baseline — during FEATURE_100 P3.6p. The `emittedManagedProtocolPayload`
 * was lifted from a function-local `let` into a `{ current }` wrapper
 * (the pattern documented as @mutable-exception (c) on TurnContext) so
 * the `emitManagedProtocol` closure can be defined inside the helper
 * and still observe accumulating mutations.
 */

import { join } from 'node:path';

import type { WorkflowProcessSnapshot } from '@kodax-ai/agent';

import type {
  KodaXManagedProtocolPayload,
  KodaXOptions,
  KodaXToolExecutionContext,
  WorkflowRunProgressView,
  WorkflowToolHost,
  WorkflowToolHostResult,
} from '../types.js';
import type { CapabilityRuntimeContract } from '../extensions/runtime-contract.js';
import { mergeManagedProtocolPayload } from '../managed-protocol.js';
import { resolveExecutionCwd } from '../runtime-paths.js';
import { getSessionScratchDir } from '../session-scratch.js';
import { getDefaultLspService } from '../lsp/service.js';

/**
 * Resolve the on-disk run directory for a `resumeFromRunId`, or undefined when
 * the id is absent or fails sanitization. This id is model-supplied, so this is
 * the ONLY sanitization before it is joined onto `runsBaseDir`: reject anything
 * outside the safe run-id charset (no slashes / absolute paths), and defensively
 * reject any '..' segment — a bare '..' passes the charset yet would escape one
 * level via `join`. Extracted + exported so the traversal guard is directly
 * unit-testable (a future charset/loosening regression must fail CI, not
 * silently reopen a path-escape).
 */
export function resolveResumeFromRunDir(
  runsBaseDir: string,
  resumeFromRunId: string | undefined,
): string | undefined {
  if (!resumeFromRunId) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(resumeFromRunId)) return undefined;
  if (resumeFromRunId.includes('..')) return undefined;
  return join(runsBaseDir, resumeFromRunId);
}

export interface ToolExecutionContextInput {
  readonly options: KodaXOptions;
  /**
   * FEATURE_247 (R7) — runtime-resolved session id, threaded onto the tool
   * ctx so host-registered tools can attribute a call to the right session
   * under concurrent Partner/Coder runs. Callers that have not resolved a
   * session id (isolated tool tests) omit it.
   */
  readonly sessionId?: string;
  /**
   * Capability runtime to bind onto the tool ctx. Tool execution only needs
   * capability lookup methods, not the extension lifecycle surface.
   */
  readonly runtime: CapabilityRuntimeContract | undefined;
  /**
   * Mutable wrapper for the accumulated managed-protocol payload.
   * The `emitManagedProtocol` closure inside the constructed context
   * mutates `.current` via `mergeManagedProtocolPayload`. Caller reads
   * `payloadRef.current` at terminal sites (e.g. inside
   * `finalizeManagedProtocolResult`).
   */
  readonly managedProtocolPayloadRef: { current: KodaXManagedProtocolPayload | undefined };
}

export function buildToolExecutionContext(
  input: ToolExecutionContextInput,
): KodaXToolExecutionContext {
  const { options, runtime, managedProtocolPayloadRef, sessionId } = input;
  const events = options.events ?? {};
  const executionCwd = resolveExecutionCwd(options.context);
  const sessionScratchDir = getSessionScratchDir(options);

  return {
    backups: new Map(),
    gitRoot: options.context?.gitRoot ?? undefined,
    // FEATURE_247 (R7) — session/profile attribution for host-registered tools
    // (Space artifact/source/KB) so concurrent Partner/Coder sessions don't
    // cross. All optional passthrough; absent ⇒ same as before.
    sessionId,
    taskSurface: options.context?.taskSurface,
    agentProfile: options.context?.agentProfile,
    agentScope: options.context?.agentScope,
    selfManual: options.selfManual,
    // FEATURE_222 skill security — forward the host's skill dynamic-context policy
    // so the LLM-triggered `skill` tool routes `!`cmd`` through the host broker
    // (or refuses) instead of the built-in execSync fallback.
    skillDynamicContext: options.skillDynamicContext,
    // FEATURE_132 v0.7.47 — LSP service for edit-time diagnostics reflux.
    // Host-injected when present, else the process-wide default (which is
    // a no-op unless a language server is installed; `KODAX_LSP=0` disables).
    lspService: options.context?.lspService ?? getDefaultLspService(),
    executionCwd,
    sessionScratchDir,
    extensionRuntime: runtime,
    askUser: events.askUser, // Issue 069
    askUserMulti: events.askUserMulti,
    askUserInput: events.askUserInput, // Issue 112
    // FEATURE_074: only forward exit_plan_mode. set_permission_mode is
    // intentionally NOT forwarded — activating it would silently widen
    // permissions on misfires.
    exitPlanMode: events.exitPlanMode,
    abortSignal: options.abortSignal, // Issue 113
    managedProtocolRole: options.context?.managedProtocolEmission?.enabled
      ? options.context.managedProtocolEmission.role
      : undefined,
    emitManagedProtocol: options.context?.managedProtocolEmission?.enabled
      ? (payload: Partial<KodaXManagedProtocolPayload>) => {
          managedProtocolPayloadRef.current = mergeManagedProtocolPayload(
            managedProtocolPayloadRef.current,
            payload,
          );
        }
      : undefined,
    mutationTracker: options.context?.mutationTracker,
    // FEATURE_074: forward parent's plan-mode predicate so
    // dispatch_child_task can enforce plan mode on child tool calls.
    planModeBlockCheck: options.context?.planModeBlockCheck,
    // FEATURE_092 phase 2b.7b slice D: forward parent-Runner guardrails so
    // dispatch_child_task can register the SAME instances on the child's
    // Runner — auto-mode state (engine + denial tracker + circuit breaker)
    // propagates across parent/child without per-child reset.
    guardrails: options.guardrails,
    parentAgentConfig: {
      provider: options.provider,
      model: options.modelOverride ?? options.model,
      reasoningMode: options.reasoningMode,
      effort: options.effort,
      repoIntelligenceMode: options.context?.repoIntelligenceMode,
      repoIntelligenceTrace: options.context?.repoIntelligenceTrace,
    },
    parentEvents: events,
    // FEATURE_067: onChildProgress removed — progress flows through
    // reportToolProgress → onToolProgress instead.
    onChildProgress: undefined,
    // FEATURE_119 v0.7.36 Pattern B — async child registry, scoped to one
    // run. Both SA (single-agent loop) and AMA (managed-task harness)
    // build their ctx through this helper, so both surfaces get the
    // launch-and-await split. The dispatch tool gates async-vs-sync on
    // `KODAX_ASYNC_DISPATCH !== '0'`; the registry only reaches the tool
    // when async dispatch is enabled.
    //
    // FEATURE_123 v0.7.44 — child runtimes pass the parent's registry
    // through `options.context.inheritedChildTaskRegistry` so peer
    // `send_message` lookups find sibling task_ids. Children stay
    // unable to mutate the registry because `dispatch_child_task` is
    // still in CHILD_EXCLUDE_TOOLS_BASE.
    childTaskRegistry: options.context?.inheritedChildTaskRegistry ?? new Map(),
    // FEATURE_123 v0.7.44 — agent identity propagation. Top-level
    // Worker leaves both undefined; child-executor forwards
    // `bundle.id` (self) + the parent's currentAgentId (parent) when
    // spawning a sub-runtime.
    currentAgentId: options.context?.currentAgentId,
    parentAgentId: options.context?.parentAgentId,
    // FEATURE_192 v0.7.44 Phase F — pull the goal-tools context from
    // the host-supplied binding (built by `buildGoalRuntimeBinding`).
    // When unset, leave undefined; the 3 goal tools fall back to
    // `makeDisabledGoalToolsContext()` at their own call site.
    goalContext: options.context?.goalRuntime?.goalContext,
    // FEATURE_123 v0.7.44 — per-turn send_message flood throttle
    // counter. Allocated once per runtime; runner-driven.ts resets
    // `count = 0` at each turn boundary via beforeNextTurn.
    sendMessageTurnCounter: { count: 0 },
    // FEATURE_120 v0.7.39 Phase 3b — per-child AbortController registry,
    // populated by `dispatch_child_task` at launch time and drained
    // when the child settles. The `task_stop` tool reads this map to
    // request graceful exit of a specific child. Paired lifetime with
    // `childTaskRegistry` — same async-mode gating.
    childAbortControllers: new Map(),
    // FEATURE_177 v0.7.45 — per-child progress snapshot map backing the
    // `task_output` tool. Initialised here so dispatch + tool both see
    // the same Map instance. Lifecycle paired with `childTaskRegistry`
    // (one map per parent runner). Children's SA contexts do not
    // inherit this field — `child-executor.executeReadChild/WriteChild`
    // pass a fresh `KodaXOptions` to `runKodaX` and only forward
    // workspace/system-prompt context, not the parent's registries.
    childProgressSnapshots: new Map(),
    // Gap A — run-level workflow progress getters keyed by runId. The async
    // run_workflow path registers one on start so task_output(runId) can render
    // live workflow progress while it runs (removed on settle).
    workflowRunProgress: new Map(),
    // FEATURE_246 Part A2 (ADR-046) — model-launched workflow capability. Wired
    // when the host configured a runs dir AND the turn runs as `ama` or `amaw`
    // (widened by FEATURE_249). AMA and AMAW both carry run_workflow standing;
    // the difference is disposition, not availability: AMAW additionally gets the
    // ORCHESTRATION DEFAULT complexity directive (amawOrchestrationAvailable), while
    // AMA activates the tool only on an explicit natural-language request. SA (solo)
    // never hosts a workflow (fails the agentMode gate + SA_SOLO_EXCLUDE_TOOLS). The
    // lazy import keeps the static graph acyclic (workflows -> agent-runtime).
    workflowHost: buildWorkflowToolHost(options, sessionId),
  };
}

/**
 * FEATURE_247 (R7/R8) — build the `hostMetadata` attribution map stamped onto
 * every workflow process event/snapshot for an inline-started `run_workflow`
 * run, so a host (KodaX-Space) can recover the originating session / surface /
 * project. Each field is included only when known (all values are strings, as
 * `WorkflowProcessSnapshot.hostMetadata` is `Record<string,string>`):
 *   - `sessionId`   — runtime-resolved session id
 *   - `surface`     — SDK-consumer profile surface (e.g. `code` | `partner`)
 *   - `taskSurface` — task surface (`cli` | `repl` | `plan`)
 *   - `projectRoot` — workspace/git root
 */
export function buildWorkflowHostMetadata(
  options: KodaXOptions,
  sessionId: string | undefined,
): Record<string, string> {
  return {
    ...(sessionId ? { sessionId } : {}),
    ...(options.context?.agentProfile?.surface
      ? { surface: options.context.agentProfile.surface }
      : {}),
    ...(options.context?.taskSurface ? { taskSurface: options.context.taskSurface } : {}),
    ...(options.context?.gitRoot ? { projectRoot: options.context.gitRoot } : {}),
  };
}

/** Gap A: distil a workflow's process snapshot into the compact live view a
 *  task_output(runId) peek renders. Mirrors the REPL's workflowLiveSnapshotFromProcess
 *  (per-agent items collapsed to running-names + terminal counts) so the Worker-facing
 *  peek and the human-facing strip stay consistent. Exported for direct unit testing. */
export function toWorkflowRunProgressView(s: WorkflowProcessSnapshot): WorkflowRunProgressView {
  const agents = s.items.filter((item) => item.kind === 'agent');
  const activeAgents = agents.filter((item) => item.status === 'running').map((item) => item.title);
  const activePhaseTitle =
    s.activePhaseId === undefined
      ? undefined
      : s.items.find((item) => item.id === s.activePhaseId)?.title;
  const status: WorkflowRunProgressView['status'] =
    s.status === 'completed'
      ? 'completed'
      : s.status === 'failed'
        ? 'failed'
        : s.status === 'cancelled'
          ? 'stopped'
          : 'running';
  return {
    status,
    workflowName: s.displayName ?? s.workflowName,
    ...(activePhaseTitle !== undefined ? { phase: activePhaseTitle } : {}),
    ...(s.activePhaseIndex !== undefined ? { phaseIndex: s.activePhaseIndex } : {}),
    ...(s.phaseCount !== undefined ? { phaseTotal: s.phaseCount } : {}),
    activeAgents,
    completedAgents: agents.filter((item) => item.status === 'completed').length,
    failedAgents: agents.filter((item) => item.status === 'failed').length,
    stoppedAgents: agents.filter((item) => item.status === 'cancelled').length,
    totalSpawned: s.progress.spawnedAgents,
    ...(s.progress.plannedItems !== undefined ? { plannedAgents: s.progress.plannedItems } : {}),
    ...(s.elapsedMs !== undefined ? { elapsedMs: s.elapsedMs } : {}),
  };
}

function buildWorkflowToolHost(
  options: KodaXOptions,
  sessionId?: string,
): WorkflowToolHost | undefined {
  const runsBaseDir = options.workflowRunsBaseDir;
  // Opt-in diagnostic for "the Worker has no run_workflow" reports: shows the
  // exact gate inputs at every tool-context build so a live run pinpoints which
  // condition failed (no runs dir vs not-amaw) without guessing. Set
  // KODAX_DEBUG_WORKFLOW_GATE=1. Off by default (zero cost on the hot path).
  if (process.env.KODAX_DEBUG_WORKFLOW_GATE) {
    const decision = runsBaseDir === undefined
      ? 'no-host: workflowRunsBaseDir undefined'
      : (options.agentMode !== 'amaw' && options.agentMode !== 'ama')
        ? `no-host: agentMode=${String(options.agentMode)} (need ama|amaw)`
        : 'host wired';
    process.stderr.write(
      `[workflow-gate] agentMode=${String(options.agentMode)} runsBaseDir=${runsBaseDir ?? '<undef>'} -> ${decision}\n`,
    );
  }
  if (runsBaseDir === undefined) return undefined;
  // FEATURE_249: run_workflow host is available to AMA and AMAW (widened from the
  // former amaw-only gate). AMA can now activate a workflow directly from natural
  // language — the Worker calls run_workflow when the user asks — matching the
  // reference non-ultracode posture (tool available, LLM decides on request). The
  // FEATURE_248 complexity directive (ORCHESTRATION DEFAULT) stays STRICTLY
  // amaw-only via the independent amawOrchestrationAvailable gate (runner-driven.ts),
  // so AMA is request-driven, not complexity-driven. SA never reaches here with a
  // run_workflow surface: agentMode 'sa' fails this gate, and SA_SOLO_EXCLUDE_TOOLS
  // (task-engine.ts) excludes run_workflow regardless.
  if (options.agentMode !== 'amaw' && options.agentMode !== 'ama') return undefined;
  // ADR-049: `startInline` starts the run and returns a `done` promise WITHOUT
  // awaiting it, so the async run_workflow path can register `done` in the Worker's
  // childTaskRegistry and idle-yield. `runInline` (the blocking path, kept for
  // SDK/headless and as a fallback) is just `startInline` + `await done`.
  const startInline: WorkflowToolHost['startInline'] = async ({ manifest, source, args, resumeFromRunId, signal }) => {
    // Lazy literal imports break the static cycle: workflow-runner imports
    // buildToolExecutionContext, so agent-runtime must not statically import
    // the workflows host/run-manager.
    const [{ startManagedWorkflow }, { getDefaultWorkflowRunManager }] = await Promise.all([
      import('../workflows/host.js'),
      import('../workflows/run-manager.js'),
    ]);
    // Stop signal = the session signal AND the per-run signal (from task_stop),
    // whichever fires first. AbortSignal.any needs Node >= 20 (KodaX baseline).
    const abortSignals = [options.abortSignal, signal].filter(
      (s): s is AbortSignal => s !== undefined,
    );
    const combinedSignal = abortSignals.length === 0
      ? undefined
      : abortSignals.length === 1
        ? abortSignals[0]
        : AbortSignal.any(abortSignals);
    // FEATURE_246 (P1 review): live workflow progress reaches the REPL through
    // options.events.onWorkflowProcessEvent — already forwarded by the runner
    // (runWorkflowFromOptions). We do NOT subscribe the run manager here as well:
    // that would deliver every process event twice (the gap was the REPL not
    // *consuming* the hook, not the host not *emitting* it). The REPL renders it
    // with the same work-strip the slash path uses.
    const started = await startManagedWorkflow({
      source: { kind: 'inline', manifest, source },
      args,
      options,
      runsBaseDir,
      manager: getDefaultWorkflowRunManager(),
      // FEATURE_246 Part D: resume seeds the result cache from the prior run.
      // Path-traversal guard lives in resolveResumeFromRunDir (model-supplied id).
      ...(() => {
        const resumeFromRunDir = resolveResumeFromRunDir(runsBaseDir, resumeFromRunId);
        return resumeFromRunDir ? { resumeFromRunDir } : {};
      })(),
      ...(combinedSignal ? { signal: combinedSignal } : {}),
      // FEATURE_247 (R7/R8): host attribution on workflow process events. The
      // hostMetadata map flows through the tracker onto every emitted
      // WorkflowProcessSnapshot, so a consumer (KodaX-Space) subscribed to
      // onWorkflowProcessEvent can recover which session / surface / project an
      // inline-started run belongs to.
      processMetadata: { hostMetadata: buildWorkflowHostMetadata(options, sessionId) },
    });
    if (started.kind === 'declined') {
      return { kind: 'declined', reason: started.reason };
    }
    const workflowQualityWarnings = started.qualityWarnings?.map(
      (warning) => `${warning.code}: ${warning.message}`,
    );
    const done = started.managed.done.then((outcome): WorkflowToolHostResult => {
      const snap = started.managed.getSnapshot?.();
      // A child agent that completes but fails its sidecar verifier in warn-only
      // mode settles as `completed_unverified` and emits an `agent_unverified`
      // event — but the overall run status is still `completed`. Surface those
      // child names so the Worker's tool reply flags the partial verification
      // failure instead of silently swallowing it.
      const verificationWarnings = outcome.kind === 'completed'
        ? outcome.state.events.reduce<string[]>((names, event) => {
            if (event.type === 'agent_unverified') {
              const name = event.data?.name ?? event.data?.taskId;
              names.push(typeof name === 'string' && name.length > 0 ? name : 'agent');
            }
            return names;
          }, [])
        : [];
      return {
        kind: 'started',
        runId: started.runId,
        ...(snap?.status !== undefined ? { status: snap.status } : {}),
        ...(snap?.resultText !== undefined ? { resultText: snap.resultText } : {}),
        ...(snap?.error !== undefined ? { error: snap.error } : {}),
        ...(verificationWarnings.length > 0 ? { verificationWarnings } : {}),
        ...(workflowQualityWarnings && workflowQualityWarnings.length > 0 ? { workflowQualityWarnings } : {}),
      };
    });
    // Gap A: expose the run's live process snapshot as a compact progress view so
    // the async run_workflow path can register it for task_output(runId) peeks.
    const getProgress = (): WorkflowRunProgressView | undefined => {
      const process = started.managed.getProcessSnapshot?.();
      return process ? toWorkflowRunProgressView(process) : undefined;
    };
    return {
      kind: 'started',
      runId: started.runId,
      done,
      ...(workflowQualityWarnings && workflowQualityWarnings.length > 0 ? { workflowQualityWarnings } : {}),
      getProgress,
    };
  };
  return {
    startInline,
    runInline: async (input) => {
      const s = await startInline(input);
      if (s.kind === 'declined') return { kind: 'declined', reason: s.reason };
      return await s.done;
    },
  };
}
