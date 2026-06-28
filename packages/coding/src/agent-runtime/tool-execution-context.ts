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

import type {
  KodaXManagedProtocolPayload,
  KodaXOptions,
  KodaXToolExecutionContext,
} from '../types.js';
import type { CapabilityRuntimeContract } from '../extensions/runtime-contract.js';
import { mergeManagedProtocolPayload } from '../managed-protocol.js';
import { resolveExecutionCwd } from '../runtime-paths.js';
import { getSessionScratchDir } from '../session-scratch.js';
import { getDefaultLspService } from '../lsp/service.js';

export interface ToolExecutionContextInput {
  readonly options: KodaXOptions;
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
  const { options, runtime, managedProtocolPayloadRef } = input;
  const events = options.events ?? {};
  const executionCwd = resolveExecutionCwd(options.context);
  const sessionScratchDir = getSessionScratchDir(options);

  return {
    backups: new Map(),
    gitRoot: options.context?.gitRoot ?? undefined,
    selfManual: options.selfManual,
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
      model: options.model,
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
  };
}
