/**
 * KodaX Core Types
 *
 * 核心类型定义 - 重新导出 @kodax-ai/agent 类型 + Coding 特定类型
 */

// ============== Import from @kodax-ai/agent ==============
// 通用 Agent 类型从 @kodax-ai/agent 导入

// FEATURE_221: SDK consumers inject their own product manual topics.
import type { KodaXManualTopicInput } from './self-knowledge/types.js';
import type { KodaXTimeoutConfig } from './timeouts.js';

import type {
  KodaXImageBlock,
  KodaXTextBlock,
  KodaXToolUseBlock,
  KodaXToolResultBlock,
  KodaXThinkingBlock,
  KodaXRedactedThinkingBlock,
  KodaXContentBlock,
  KodaXMessage,
  KodaXTokenUsage,
  KodaXStreamResult,
  KodaXToolDefinition,
  KodaXProviderConfig,
  KodaXProviderStreamOptions,
  KodaXReasoningCapability,
  KodaXReasoningMode,
  KodaXThinkingDepth,
  KodaXTaskType,
  KodaXExecutionMode,
  KodaXRiskLevel,
  KodaXTaskComplexity,
  KodaXTaskWorkIntent,
  KodaXTaskFamily,
  KodaXTaskActionability,
  KodaXExecutionPattern,
  KodaXMutationSurface,
  KodaXAssuranceIntent,
  KodaXTaskRoutingDecision,
  KodaXThinkingBudgetMap,
  KodaXTaskBudgetOverrides,
  KodaXReasoningRequest,
  KodaXJsonValue,
  KodaXExtensionSessionRecord,
  KodaXExtensionSessionState,
  KodaXExtensionStoreEntry,
  KodaXExtensionStore,
  KodaXFileInputArtifact,
  KodaXImageInputArtifact,
  KodaXImageMediaType,
  KodaXInputArtifact,
  KodaXInputArtifactSource,
  KodaXVideoInputArtifact,
  KodaXVideoMediaType,
  KodaXCompactMemoryProgress,
  KodaXCompactMemorySeed,
  KodaXSessionBranchSummaryEntry,
  KodaXSessionCompactionEntry,
  KodaXSessionData,
  KodaXSessionEntry,
  KodaXSessionEntryBase,
  KodaXSessionArtifactLedgerEntry,
  KodaXSessionLabelEntry,
  KodaXSessionLineage,
  KodaXSessionMessageEntry,
  KodaXSessionNavigationOptions,
  KodaXSessionScope,
  KodaXSessionMeta,
  KodaXSessionRuntimeInfo,
  KodaXSessionStorage,
  KodaXSessionTreeNode,
  KodaXSessionUiHistoryItem,
  KodaXSessionUiHistoryItemType,
  KodaXSessionUiTextHistoryItem,
  KodaXSessionUiTextHistoryItemType,
  KodaXSessionUiToolCall,
  KodaXSessionUiToolCallStatus,
  KodaXSessionUiToolGroupHistoryItem,
  KodaXSessionWorkspaceKind,
  SessionErrorMetadata,
  ChildTaskRegistry,
  TaskAbortRegistry,
  WorkflowIsolation,
  WorkflowEventCorrelation,
  WorkflowProcessEvent,
} from '@kodax-ai/agent';
// v0.7.35.1 FEATURE_142 (A-R4): AMA / harness types live in @kodax-ai/llm
// (coding-AMA vocabulary; see ADR-021). Imported directly here instead of
// going through @kodax-ai/agent's re-export, which has been removed.
import type {
  KodaXHarnessProfile,
  KodaXChildFanoutClass,
  KodaXReviewScale,
  KodaXStableEffortIntent,
  KodaXWireReasoningEffort,
  KodaXReasoningEffortRequest,
  KodaXReasoningEffortPreset,
  KodaXReasoningEffortWireStrategy,
  KodaXThinkingWireStrategy,
  KodaXReasoningProfile,
  KodaXNormalizedReasoningRequest,
} from '@kodax-ai/llm';
import type { CompactionUpdate } from '@kodax-ai/agent';
// FEATURE_093 (v0.7.24): use the narrow runtime contract from
// `./extensions/runtime-contract.ts` to avoid `types.ts ↔ extensions/runtime.ts`
// circular imports. The concrete `KodaXExtensionRuntime` class implements
// this contract plus ~40 internal methods that consumers do not reach
// through Options / ToolExecutionContext fields.
import type {
  CapabilityRuntimeContract,
  ExtensionRuntimeContract,
} from './extensions/runtime-contract.js';
import type {
  FailureStage,
  ResilienceErrorClass,
  RecoveryAction,
  RecoveryLadderStep,
} from './resilience/types.js';

// Re-export all types from @kodax-ai/agent
export type {
  KodaXImageBlock,
  KodaXTextBlock,
  KodaXToolUseBlock,
  KodaXToolResultBlock,
  KodaXThinkingBlock,
  KodaXRedactedThinkingBlock,
  KodaXContentBlock,
  KodaXMessage,
  KodaXTokenUsage,
  KodaXStreamResult,
  KodaXToolDefinition,
  KodaXProviderConfig,
  KodaXProviderStreamOptions,
  KodaXReasoningCapability,
  KodaXStableEffortIntent,
  KodaXWireReasoningEffort,
  KodaXReasoningEffortRequest,
  KodaXReasoningEffortPreset,
  KodaXReasoningEffortWireStrategy,
  KodaXThinkingWireStrategy,
  KodaXReasoningProfile,
  KodaXReasoningMode,
  KodaXThinkingDepth,
  KodaXTaskType,
  KodaXExecutionMode,
  KodaXRiskLevel,
  KodaXTaskComplexity,
  KodaXTaskWorkIntent,
  KodaXTaskFamily,
  KodaXTaskActionability,
  KodaXExecutionPattern,
  KodaXMutationSurface,
  KodaXAssuranceIntent,
  KodaXHarnessProfile,
  KodaXChildFanoutClass,
  KodaXReviewScale,
  KodaXTaskRoutingDecision,
  KodaXThinkingBudgetMap,
  KodaXTaskBudgetOverrides,
  KodaXReasoningRequest,
  KodaXNormalizedReasoningRequest,
  KodaXJsonValue,
  KodaXExtensionSessionRecord,
  KodaXExtensionSessionState,
  KodaXExtensionStoreEntry,
  KodaXExtensionStore,
  KodaXFileInputArtifact,
  KodaXImageInputArtifact,
  KodaXImageMediaType,
  KodaXInputArtifact,
  KodaXInputArtifactSource,
  KodaXVideoInputArtifact,
  KodaXVideoMediaType,
  KodaXCompactMemoryProgress,
  KodaXCompactMemorySeed,
  KodaXSessionBranchSummaryEntry,
  KodaXSessionCompactionEntry,
  KodaXSessionData,
  KodaXSessionEntry,
  KodaXSessionEntryBase,
  KodaXSessionArtifactLedgerEntry,
  KodaXSessionLabelEntry,
  KodaXSessionLineage,
  KodaXSessionMessageEntry,
  KodaXSessionNavigationOptions,
  KodaXSessionScope,
  KodaXSessionMeta,
  KodaXSessionRuntimeInfo,
  KodaXSessionStorage,
  KodaXSessionTreeNode,
  KodaXSessionUiHistoryItem,
  KodaXSessionUiHistoryItemType,
  KodaXSessionUiTextHistoryItem,
  KodaXSessionUiTextHistoryItemType,
  KodaXSessionUiToolCall,
  KodaXSessionUiToolCallStatus,
  KodaXSessionUiToolGroupHistoryItem,
  KodaXSessionWorkspaceKind,
  SessionErrorMetadata,
  WorkflowEventCorrelation,
  WorkflowProcessEvent,
};

// ============== 事件接口 ==============

export interface KodaXWorkflowEventMeta {
  readonly workflowCorrelation?: WorkflowEventCorrelation;
}

export interface KodaXActivityEventMeta extends KodaXWorkflowEventMeta {
  readonly childAgentId?: string;
  readonly childAgentName?: string;
  readonly parentToolId?: string;
  readonly liveOnly?: boolean;
}

export interface KodaXToolEventMeta extends KodaXActivityEventMeta {
  readonly toolId?: string;
}

export interface KodaXSidecarMessageEvent {
  readonly source: 'sidecar-verifier';
  readonly verdict: 'revise' | 'blocked';
  readonly recipient: 'main-agent' | 'user';
  readonly delivery: 'synthetic-user-message' | 'budget-exhausted' | 'terminal-block';
  /** Exact actionable text from the sidecar. `budget-exhausted` means it was not injected. */
  readonly content: string;
  readonly suggestedFix?: string;
  readonly trace?: string;
}

export interface KodaXTodoDriftWarningEvent {
  readonly kind: 'work_started_without_claimed_todo';
  readonly toolName: string;
  readonly toolCallId?: string;
  readonly count: number;
  readonly pendingCount: number;
  readonly openCount: number;
  readonly firstPendingTodoId?: string;
  readonly firstPendingTodoSubject?: string;
}

export interface KodaXEvents {
  /** FEATURE_229: correlates child-agent SDK callbacks back to a workflow run/item. */
  workflowCorrelation?: WorkflowEventCorrelation;
  // 流式输出
  onTextDelta?: (text: string, meta?: KodaXActivityEventMeta) => void;
  onThinkingDelta?: (text: string, meta?: KodaXActivityEventMeta) => void;
  onThinkingEnd?: (thinking: string, meta?: KodaXActivityEventMeta) => void;
  onToolUseStart?: (
    tool: { name: string; id: string; input?: Record<string, unknown> },
    meta?: KodaXToolEventMeta,
  ) => void;
  onToolResult?: (
    result: { id: string; name: string; content: string },
    meta?: KodaXToolEventMeta,
  ) => void;
  /** FEATURE_067 v2: Real-time tool execution progress update. Updates the tool's display in the REPL transcript. */
  onToolProgress?: (
    update: { id: string; message: string },
    meta?: KodaXToolEventMeta,
  ) => void;
  onToolInputDelta?: (
    toolName: string,
    partialJson: string,
    meta?: KodaXToolEventMeta,
  ) => void;
  onStreamEnd?: (meta?: KodaXActivityEventMeta) => void;
  /** Fired once when a child-agent run fully leaves the child executor. */
  onChildActivityEnd?: (meta?: KodaXActivityEventMeta) => void;

  // 状态通知
  onSessionStart?: (info: { provider: string; sessionId: string }) => void;
  onIterationStart?: (iter: number, maxIter: number) => void;
  /** Called after each iteration with current token count for UI updates */
  onIterationEnd?: (info: {
    iter: number;
    maxIter: number;
    tokenCount: number;
    tokenSource: 'api' | 'estimate';
    usage?: KodaXTokenUsage;
    contextTokenSnapshot?: KodaXContextTokenSnapshot;
    /**
     * FEATURE_072: identifies whether this event originates from the parent
     * REPL's agent loop or from a worker (Scout / role worker / evaluator)
     * spawned by the task engine. The REPL uses this to avoid mutating the
     * parent's `contextTokenSnapshot` with worker-derived values — workers
     * still fire `onIterationEnd` for live-token-count UX, but they must not
     * overwrite the parent's context state. Absence is treated as 'parent'
     * for backward compatibility.
     */
    scope?: 'parent' | 'worker';
  }) => void;
  onCompactStart?: () => void;
  /** Emitted when compaction finishes and actually changed the context */
  onCompact?: (estimatedTokens: number) => void;
  /** Emitted when compaction changes the context so UI can refresh token usage immediately */
  onCompactStats?: (info: { tokensBefore: number; tokensAfter: number }) => void;
  /** Emitted with the rewritten message history when automatic compaction changes the context. */
  onCompactedMessages?: (messages: KodaXMessage[], update?: CompactionUpdate) => void;
  /** Emitted to silently dismiss the compaction UI if compaction aborted or completed without changes */
  onCompactEnd?: () => void;
  /** Whether the caller has queued follow-up input waiting for the next round */
  hasPendingInputs?: () => boolean;
  /**
   * FEATURE_164 (v0.7.41) — mid-turn user message injection.
   *
   * Fired by the Runner-driven path's `beforeNextTurn` hook AFTER it
   * drains queued user prompts (mode:'prompt') from the canonical
   * MessageQueue and splices them into the transcript before the next
   * LLM call. Replaces the legacy v0.7.26 "mid-iteration yield" path
   * that returned an empty `{text:'', toolCalls:[]}` to force the round
   * to terminate — that path polluted the transcript with an empty
   * assistant turn and confused the model when the next round picked
   * up the same prompts.
   *
   * REPL implementations use this hook to render the injected
   * prompts as user-role history items immediately, so the user sees
   * their typed query as part of the conversation without waiting for
   * the round to end. SDK consumers that don't care about UI visibility
   * can omit this hook — the messages still reach the LLM via the
   * transcript injection.
   *
   * Fires once per Runner iteration boundary, with the array of
   * prompt contents in queue order. Empty arrays are not surfaced.
   */
  onMidTurnUserMessages?: (contents: readonly string[]) => void;
  onRetry?: (
    reason: string,
    attempt: number,
    maxAttempts: number,
    meta?: KodaXActivityEventMeta,
  ) => void;
  onProviderRateLimit?: (
    attempt: number,
    maxRetries: number,
    delayMs: number,
    meta?: KodaXActivityEventMeta,
  ) => void;
  /**
   * FEATURE_130 (v0.7.36) — structured retry-after notification.
   *
   * Fires whenever a provider's `withRateLimit` loop catches a 429 /
   * 503 / 529 (overloaded) response and decides to wait before
   * retrying. Supersedes the legacy `onProviderRateLimit` (kept for
   * back-compat) by carrying the parsed source of the wait duration —   * UI layers (InkREPL spinner, cost tracker) can surface the
   * difference between "provider told us to wait 45s" and "no header,
   * we're guessing 4s exp-backoff".
   *
   * Pattern B (FEATURE_119) interaction: each in-flight child agent
   * fires its own `onRetryAfter` independently. Multiple children
   * sharing a quota (e.g. 5 coding-plan providers under one tier)
   * surface concurrent waits — the UI deduplicates by provider, not
   * by call site.
   */
  onRetryAfter?: (
    payload: {
      provider: string;
      waitMs: number;
      reason: 'rate-limit' | 'overloaded';
      source:
        | 'retry-after-seconds'
        | 'retry-after-date'
        | 'retry-after-ms'
        | 'exponential-backoff';
      attempt: number;
      maxAttempts: number;
    },
    meta?: KodaXActivityEventMeta,
  ) => void;
  /**
   * Passive capability learning: fired when a provider HARD-rejects a
   * reasoning-effort value. Hosts can record it via the agent-layer capability
   * cache so the rung is narrowed out of the ladder and never offered/sent
   * again.
   */
  onReasoningEffortRejected?: (event: {
    provider: string;
    model: string;
    effort: string;
  }) => void;
  onRepoIntelligenceTrace?: (event: KodaXRepoIntelligenceTraceEvent) => void;
  /**
   * Fired when the Sidecar Verifier produces an actionable message.
   *
   * `revise` is usually injected back into the main agent as a synthetic user
   * message; if the reanimate budget is already exhausted, the same verdict is
   * surfaced with `delivery: "budget-exhausted"` and no injection occurs.
   * `blocked` is surfaced terminally to the user. Accept remains silent here
   * because there is no sidecar-to-agent reply to show.
   */
  onSidecarMessage?: (event: KodaXSidecarMessageEvent) => void;
  /**
   * FEATURE_097 (v0.7.34): emitted whenever the Scout-seeded todo list
   * changes — initial seed at `emit_scout_verdict`, per-item updates from
   * `todo_update` tool calls, and Evaluator-verdict auto-handling
   * (accept/revise/replan). Single-rail (no `KodaXManagedTaskStatusEvent`
   * snapshot fallback): KodaX is a single-process CLI, all consumers live
   * in one event loop, so subscriber lag is not a real failure mode
   * (FEATURE_086 onRepoIntelligenceTrace single-rail precedent).
   */
  onTodoUpdate?: (items: TodoList) => void;
  /**
   * Warn-only telemetry: a successful real work tool completed while the
   * visible todo list had pending items but no item marked in_progress.
   * The runner does not mutate the todo list for this signal; it only
   * nudges the next model turn to call todo_update explicitly.
   */
  onTodoDriftWarning?: (event: KodaXTodoDriftWarningEvent) => void;
  /** Structured provider recovery event (Feature 045) */
  onProviderRecovery?: (
    event: ProviderRecoveryEvent,
    meta?: KodaXActivityEventMeta,
  ) => void;
  onComplete?: () => void;
  onError?: (error: Error) => void;
  onManagedTaskStatus?: (status: KodaXManagedTaskStatusEvent) => void;
  /** FEATURE_229: workflow process snapshot stream for SDK/host panels. */
  onWorkflowProcessEvent?: (event: WorkflowProcessEvent) => void;
  /**
   * Fired when Scout's managed-task completion is inferred but the harness
   * detected suspicious signals (mutation expected but none happened, budget
   * exhausted, tool calls followed by text-only exit without explicit
   * completion, etc.). The task still completes — this is an observability
   * signal, not a retry trigger. UI layers can surface a warning so users
   * know to verify the result.
   */
  onScoutSuspiciousCompletion?: (payload: {
    confidence: 'uncertain';
    signals: KodaXScoutSuspiciousSignal[];
    sessionId?: string;
    lastTextPreview: string;
  }) => void;
  /**
   * FEATURE_167 (v0.7.41) — Evaluator terminal-verdict fallback.
   *
   * Fires when the runner-driven outer loop detects that the Evaluator
   * exited a turn without `emit_verdict` AND the B1 retry exhausted its
   * cap. The runner THEN writes a synthesized terminal verdict into
   * `recorder.verdict` (B2) and fires this event so SDK consumers
   * (REPL status line, telemetry sinks, dashboards) can surface the
   * fallback rather than mistake it for a real `accept`. The verdict
   * carries a stable `reason` so post-hoc filtering can isolate
   * synthesized terminations.
   *
   * Fires AFTER `recorder.verdict` is committed but BEFORE
   * `formatDeterministicEvaluatorResult` builds the final `KodaXResult`
   * — consumers see the synth signal in causal order before the result
   * surfaces.
   */
  /** Returns a formatted cost report for the current session. Set by agent at session start. */
  getCostReport?: { current: (() => string) | null };

  // 用户交互（可选，由 REPL 层实现）
  /** Tool execution hook - called before tool execution, return false to block - 工具执行前回调 */
  beforeToolExecute?: (
    tool: string,
    input: Record<string, unknown>,
    meta?: KodaXToolEventMeta
  ) => Promise<boolean | string>;
  /** Ask user a question interactively - Issue 069 - 交互式向用户提问 */
  askUser?: (options: AskUserQuestionOptions, meta?: KodaXToolEventMeta) => Promise<string>;
  /** Ask user multiple independent questions sequentially - 澶氶棶棰橀『搴忔彁闂?*/
  askUserMulti?: (
    options: AskUserMultiOptions,
    meta?: KodaXToolEventMeta,
  ) => Promise<Record<string, string> | undefined>;
  /** Ask user for free-text input - 自由文本输入 (Issue 112) */
  askUserInput?: (
    options: { question: string; default?: string },
    meta?: KodaXToolEventMeta,
  ) => Promise<string | undefined>;
  /**
   * FEATURE_074: Exit plan mode with user approval. Called by the `exit_plan_mode` tool.
   * Returns:
   *   - `true` when the user approved the plan (mode flipped to accept-edits).
   *   - `false` when the user rejected the plan (mode stays plan).
   *   - `'not-in-plan-mode'` when the session is not currently in plan mode, so
   *     the tool is being called out-of-context. The tool turns this into an
   *     explicit error instead of a silent no-op.
   */
  exitPlanMode?: (plan: string) => Promise<boolean | 'not-in-plan-mode'>;
  /** Managed-worker role currently allowed to emit structured protocol payload. */
}


// ============== Provider Recovery Event (Feature 045) ==============

/**
 * Structured event emitted during provider recovery.
 * Provides fine-grained information about the failure, recovery strategy,
 * and current state of the retry ladder.
 */
export interface ProviderRecoveryEvent {
  /** The failure stage when the error occurred. */
  stage: FailureStage;
  /** The classified error class. */
  errorClass: ResilienceErrorClass;
  /** Current attempt number (1-based). */
  attempt: number;
  /** Maximum automatic retry attempts. */
  maxAttempts: number;
  /** Delay before next attempt (ms). */
  delayMs: number;
  /** The recovery action being taken. */
  recoveryAction: RecoveryAction;
  /** Step in the recovery ladder (1-4). */
  ladderStep: RecoveryLadderStep;
  /** Whether non-streaming fallback has been used. */
  fallbackUsed: boolean;
  /** Server-provided Retry-After value (ms), if available. */
  serverRetryAfterMs?: number;
}

// ============== Agent 选项 ==============

export interface KodaXSessionOptions {
  id?: string;
  resume?: boolean;
  autoResume?: boolean;
  scope?: KodaXSessionScope;
  /** Consumer-owned private string persisted with the session. */
  tag?: string;
  storage?: KodaXSessionStorage;
  initialMessages?: KodaXMessage[];
  /** Host-provided extension state paired with initialMessages, avoiding a full storage load. */
  initialExtensionState?: KodaXExtensionSessionState;
  /** Host-provided extension records paired with initialMessages, avoiding a full storage load. */
  initialExtensionRecords?: KodaXExtensionSessionRecord[];
  /**
   * Persistence ownership signal (FEATURE_173 dual-writer fix).
   *
   * When `true`, a higher-level host (the interactive REPL) owns writing
   * this session to `storage` — it persists the full lineage / uiHistory /
   * artifactLedger incrementally via `appendSessionDelta`. The runner MUST
   * NOT also snapshot the session: `saveSessionSnapshot` early-returns so
   * the runner's flat full-rewrite `storage.save` can never race / clobber
   * the host's richer incremental writes (which regressed `activeEntryId`
   * to the first round on resume).
   *
   * `storage` is still consulted for LOAD (resume / `resolveInitialMessages`
   * tier 2). When absent (print CLI, ACP, SDK headless), the runner remains
   * the sole writer — unchanged behaviour, fail-safe default.
   */
  persistedByHost?: boolean;
}

export interface KodaXContextTokenSnapshot {
  /** Current best-known token count for the full conversation context. */
  currentTokens: number;
  /** Local estimate for the same message set, used to adjust later message deltas. */
  baselineEstimatedTokens: number;
  /** Whether the snapshot is based on provider/API usage or local estimation. */
  source: 'api' | 'estimate';
  /** Optional turn usage from the latest provider response. */
  usage?: KodaXTokenUsage;
}

export interface KodaXProviderPolicyHints {
  longRunning?: boolean;
  harnessProfile?: KodaXHarnessProfile;
  evidenceHeavy?: boolean;
  multimodal?: boolean;
  capabilityRuntime?: boolean;
  mcpRequired?: boolean;
  brainstorm?: boolean;
  workIntent?: KodaXTaskWorkIntent;
}

// FEATURE_082 / FEATURE_200 Phase F: MCP types live in @kodax-ai/agent; KodaX
// aliases extracted to ./types/mcp.ts and re-exported for backward compat.
export * from './types/mcp.js';


// ============== Todo Plan Surface (FEATURE_097, v0.7.34) ==============

import type { TodoList } from './types/todo.js';
export * from './types/todo.js';

export interface KodaXRepoRoutingSignals {
  workspaceRoot?: string;
  changedFileCount: number;
  changedLineCount: number;
  addedLineCount: number;
  deletedLineCount: number;
  touchedModuleCount: number;
  changedModules: string[];
  crossModule: boolean;
  reviewScale?: KodaXReviewScale;
  riskHints: string[];
  activeModuleId?: string;
  activeModuleConfidence?: number;
  activeImpactConfidence?: number;
  impactedModuleCount?: number;
  impactedSymbolCount?: number;
  predominantCapabilityTier?: 'high' | 'medium' | 'low';
  suggestedComplexity?: KodaXTaskComplexity;
  plannerBias: boolean;
  investigationBias: boolean;
  lowConfidence: boolean;
  capability?: KodaXRepoIntelligenceCapability;
  trace?: KodaXRepoIntelligenceTrace;
}

export interface KodaXTaskCapabilityHint {
  kind: 'skill' | 'tool' | 'command' | 'workflow';
  name: string;
  details?: string;
}

export interface KodaXTaskVerificationCriterion {
  id: string;
  label: string;
  description: string;
  threshold: number;
  weight: number;
  requiredEvidence?: string[];
}

export interface KodaXRuntimeVerificationContract {
  startupCommand?: string;
  cwd?: string;
  env?: Record<string, string>;
  readySignal?: string;
  baseUrl?: string;
  uiFlows?: string[];
  apiChecks?: string[];
  dbChecks?: string[];
  fixtures?: string[];
}

export interface KodaXTaskVerificationContract {
  summary?: string;
  instructions?: string[];
  requiredEvidence?: string[];
  requiredChecks?: string[];
  capabilityHints?: KodaXTaskCapabilityHint[];
  rubricFamily?: 'code-review' | 'frontend' | 'product-completeness' | 'functionality' | 'code-quality';
  criteria?: KodaXTaskVerificationCriterion[];
  runtime?: KodaXRuntimeVerificationContract;
}

export type KodaXSkillProjectionConfidence = 'high' | 'medium' | 'low';

export interface KodaXSkillInvocationContext {
  name: string;
  path: string;
  description?: string;
  arguments?: string;
  allowedTools?: string;
  context?: 'fork';
  agent?: string;
  argumentHint?: string;
  model?: string;
  hookEvents?: string[];
  expandedContent: string;
}

export interface KodaXSkillMap {
  skillSummary: string;
  executionObligations: string[];
  verificationObligations: string[];
  requiredEvidence: string[];
  ambiguities: string[];
  projectionConfidence: KodaXSkillProjectionConfidence;
  rawSkillFallbackAllowed: boolean;
  allowedTools?: string;
  preferredAgent?: string;
  preferredModel?: string;
  invocationContext?: 'fork';
  hookEvents?: string[];
}

export interface KodaXTaskToolPolicy {
  summary: string;
  allowedTools?: string[];
  blockedTools?: string[];
  allowedShellPatterns?: string[];
  allowedWritePathPatterns?: string[];
}

export interface KodaXChildContextBundle {
  id: string;
  fanoutClass: KodaXChildFanoutClass;
  objective: string;
  scopeSummary?: string;
  evidenceRefs: string[];
  constraints: string[];
  readOnly: boolean;
  /**
   * FEATURE_120 v0.7.39 Phase 4 — optional model tier hint that the
   * dispatching agent provides as a UX signal. Routing is a **no-op**
   * for now: every child runs on the parent's model regardless of
   * hint. FEATURE_102 (v0.7.45 capability profile) is the planned
   * consumer that will translate `'fast' | 'balanced' | 'deep'` to a
   * concrete provider/model selection. The field is surfaced + parsed
   * now so prompt-eval data starts accumulating; the routing wire-up
   * lands separately.
   */
  modelHint?: KodaXChildModelHint;
  /**
   * FEATURE_217 (v0.7.49): workflow-level child isolation hint. Default is
   * shared parent cwd; `worktree` is opt-in and parent-managed.
   */
  isolation?: WorkflowIsolation;
  /**
   * FEATURE_191 — optional registered specialist agent name. When set,
   * the child is dispatched with that agent's `instructions` /
   * `tools` / `reasoning` / `guardrails` instead of the stock Worker
   * bundle. Resolved via `resolveConstructedAgent(name)` at dispatch
   * time; unknown names are rejected by `toolDispatchChildTask` with
   * a tool-result error (not throw) before the bundle reaches
   * `executeReadChild` / `executeWriteChild`. Optional — omitting
   * preserves byte-identical v0.7.42 baseline dispatch behavior.
   */
  specialistName?: string;
  /**
   * FEATURE_102 Phase 2 (v0.7.45) — explicit per-dispatch provider/model the
   * dispatching agent chose for this child (e.g. a cross-family second review).
   * Priority in child-executor: `bundle.provider/model` > specialist's declared
   * model > parent default. Omitting both inherits the parent (byte-identical).
   */
  provider?: string;
  model?: string;
  /** Optional per-dispatch reasoning effort. Omit to inherit the parent effort. */
  effort?: KodaXWireReasoningEffort;
  /**
   * FEATURE_246 Part B — optional JSON Schema (opaque) for the child's
   * structured output. When set, the child briefing asks for a fenced JSON
   * block matching it; the child executor parses + validates the result (with
   * one bounded repair turn) and surfaces it on `KodaXChildAgentResult.structured`.
   */
  outputSchema?: unknown;
}

/**
 * FEATURE_120 v0.7.39 Phase 4 — model tier hint. Tier semantics:
 *   - `'fast'` — short lookups (read 1-2 files, simple grep).
 *   - `'balanced'` — normal subtasks (default behavior; same as omit).
 *   - `'deep'` — heavy reasoning (multi-file analysis, complex audit).
 *
 * `omit` ≡ `'balanced'` so the absent case maps to "default routing".
 * Validators MUST reject other strings (the dispatch tool drops
 * unknown values silently with a tolerant fallback to `undefined`).
 */
export type KodaXChildModelHint = 'fast' | 'balanced' | 'deep';

export interface KodaXChildAgentResult {
  childId: string;
  fanoutClass: KodaXChildFanoutClass;
  status: 'completed' | 'blocked' | 'failed';
  disposition: 'candidate' | 'valid' | 'false-positive' | 'needs-more-evidence';
  summary: string;
  evidenceRefs: string[];
  contradictions: string[];
  artifactPaths?: string[];
  sessionId?: string;
  /** Bounded workflow transcript digest. Full `summary` remains the synthesis/audit source. */
  digest?: string;
  /** True when a workflow child digest was attempted but failed (error/timeout/empty distillation). */
  digestFailed?: boolean;
  /** True when a workflow child digest is running asynchronously and may arrive later. */
  digestPending?: boolean;
  /** Actual provider/model selected for this child run, when known. */
  provider?: string;
  model?: string;
  /** Actual iterations consumed by this child agent. */
  actualIterations?: number;
  /** Best-known token usage for this child run. Used by workflow budget accounting. */
  totalTokensUsed?: number;
  /** True when the child exhausted its iteration budget before completing. */
  limitReached?: boolean;
  /**
   * True when the child's `runKodaX` exited via CAP-083 AbortError silent
   * terminal (`KodaXResult.interrupted === true`). Surfaces the
   * "success but empty lastText" path that produces empty
   * `<task-completed task_id="X"></task-completed>` banners.
   * Diagnostic field — populated by child-executor on the success branch
   * and consumed by dispatch-child-tasks' empty-summary fallback.
   */
  interrupted?: boolean;
  /**
   * FEATURE_246 Part B — schema-validated structured output parsed from the
   * child's final text (present only when the bundle carried `outputSchema`
   * and a JSON value was parseable). Surfaced to the workflow runtime as
   * `WorkflowTaskResult.structured`.
   */
  structured?: unknown;
}

export interface KodaXParentReductionContract {
  owner: 'parent';
  strategy: 'direct-parent' | 'evaluator-assisted' | 'reducer-child';
  collapseChildTranscripts: boolean;
  summary: string;
  requiredArtifacts: string[];
}

export interface KodaXChildExecutionResult {
  readonly results: readonly KodaXChildAgentResult[];
  readonly mergedFindings: readonly KodaXChildFinding[];
  readonly mergedArtifacts: readonly string[];
  readonly totalTokensUsed: number;
  readonly cancelledChildren: readonly string[];
}

export interface KodaXChildFinding {
  readonly childId: string;
  readonly objective: string;
  readonly evidence: readonly string[];
  readonly artifacts: readonly string[];
}

export type KodaXAgentMode = 'ama' | 'sa' | 'amaw';
export type KodaXMemoryStrategy = 'continuous' | 'compact' | 'reset-handoff';
export type KodaXBudgetDisclosureZone = 'green' | 'yellow' | 'orange' | 'red';

export interface KodaXManagedTaskHarnessTransition {
  from: KodaXHarnessProfile;
  to: KodaXHarnessProfile;
  round: number;
  source: 'scout' | 'evaluator';
  reason?: string;
  approved: boolean;
  denialReason?: string;
}

export type KodaXManagedTaskPhase =
  | 'starting'
  | 'routing'
  | 'preflight'
  | 'round'
  | 'worker'
  | 'upgrade'
  | 'verifying'
  | 'completed';

export type KodaXManagedLiveEventPresentation =
  | 'status'
  | 'assistant'
  | 'thinking';

export interface KodaXManagedLiveEvent {
  key: string;
  kind: 'progress' | 'completed' | 'notification' | 'warning';
  presentation?: KodaXManagedLiveEventPresentation;
  phase?: KodaXManagedTaskPhase;
  workerId?: string;
  workerTitle?: string;
  summary: string;
  detail?: string;
  persistToHistory?: boolean;
}

export interface KodaXManagedTaskStatusEvent {
  agentMode: KodaXAgentMode;
  harnessProfile: KodaXHarnessProfile;
  activeWorkerId?: string;
  activeWorkerTitle?: string;
  childFanoutClass?: KodaXChildFanoutClass;
  childFanoutCount?: number;
  currentRound?: number;
  maxRounds?: number;
  phase?: KodaXManagedTaskPhase;
  note?: string;
  detailNote?: string;
  events?: KodaXManagedLiveEvent[];
  persistToHistory?: boolean;
  upgradeCeiling?: KodaXHarnessProfile;
  globalWorkBudget?: number;
  budgetUsage?: number;
  budgetApprovalRequired?: boolean;
  /**
   * v0.7.38 FEATURE_156 — true while the runner-driven outer loop is
   * parked in `waitForWakeEvent` (idle-yield from FEATURE_155). The
   * agent is alive but suspended pending an external wake — typically
   * a dispatched child task completing, or a user message arriving via
   * the FEATURE_115 MessageQueue (chat-while-waiting).
   *
   * Default (`undefined` / `false`) means "not idle-waiting" — every
   * pre-FEATURE_156 emit site implicitly sets this. Consumers MUST
   * branch on `=== true` (not truthy / not undefined) so that
   * subsequent role-emits with `idleWaiting` unset naturally transition
   * the UI out of the waiting state.
   *
   * Agent-agnostic: today only the Worker can reach an idle-yield
   * state (the dispatch tool is restricted to Scout/Generator/Worker,
   * and the `hasEmittedHandoff` gate blocks idle-yield post-handoff so
   * Evaluator can never park here), but the field carries no
   * role-specific semantics — `activeWorkerTitle` carries the role
   * identity for display.
   */
  idleWaiting?: boolean;
  /**
   * v0.7.38 FEATURE_156 — count of children the agent is actively
   * waiting on at the idle-yield boundary (`registry.size` snapshot).
   * Status-bar renders this as "waiting for N children" so the user
   * can tell how many outstanding pieces of work are pending. 0 with
   * `idleWaiting=true` is the transitional "background banner queued,
   * registry already drained" state (fast-child race recovery path,
   * see FEATURE_155 hotfix follow-up #2) and renders as "idle —   * resuming".
   */
  idleWaitingPendingCount?: number;
}

export interface KodaXVerificationScorecardCriterion {
  id: string;
  label: string;
  threshold: number;
  score: number;
  passed: boolean;
  weight: number;
  requiredEvidence?: string[];
  evidence?: string[];
  reason?: string;
}

export interface KodaXVerificationScorecard {
  rubricFamily?: KodaXTaskVerificationContract['rubricFamily'];
  overallScore: number;
  verdict: 'accept' | 'revise' | 'blocked';
  criteria: KodaXVerificationScorecardCriterion[];
  trend?: 'improving' | 'flat' | 'regressing';
  summary?: string;
}

export interface KodaXRoleRoundSummary {
  role: KodaXTaskRole;
  round: number;
  objective: string;
  confirmedConclusions: string[];
  unresolvedQuestions: string[];
  nextFocus: string[];
  summary: string;
  sourceWorkerId?: string;
  updatedAt: string;
}

export interface KodaXBudgetExtensionRequest {
  requestedIters: 1 | 2 | 3;
  reason: string;
  completionExpectation: string;
  confidenceToFinish: number;
  fallbackIfDenied: string;
}

export interface KodaXManagedBudgetSnapshot {
  totalBudget: number;
  reserveBudget: number;
  reserveRemaining: number;
  upgradeReserveBudget?: number;
  upgradeReserveRemaining?: number;
  plannedRounds: number;
  currentRound: number;
  spentBudget: number;
  remainingBudget: number;
  workerId?: string;
  role?: KodaXTaskRole;
  currentHarness?: KodaXHarnessProfile;
  upgradeCeiling?: KodaXHarnessProfile;
  zone?: KodaXBudgetDisclosureZone;
  showExactRoundCounter?: boolean;
  allowExtensionRequest?: boolean;
  mustConverge?: boolean;
  softMaxIter?: number;
  hardMaxIter?: number;
  extensionGrantedIters?: number;
  extensionDenied?: boolean;
  extensionReason?: string;
}

/** Mutable tracker for filesystem/shell mutations observed during managed Worker execution. */
export interface ManagedMutationTracker {
  readonly files: Map<string, number>;
  totalOps: number;
  /**
   * Count of high-risk shell mutations (git push/commit/rm, npm install/publish,
   * rm/mv/cp, etc.) the Worker ran via `bash`. Tracked separately from `totalOps`
   * because bash writes are a blind spot — we cannot know which file / how many
   * lines a shell command touched — so the Verifier gate fires conservatively on
   * any risky shell op rather than inferring risk back out of `totalOps`.
   * Optional: defaults to 0 when absent (read as `riskyShellOps ?? 0`).
   */
  riskyShellOps?: number;
  /**
   * Count of filesystem mutations whose touched file could NOT be attributed
   * from the tool input (the path is computed inside the handler): `undo`,
   * `worktree_create` / `worktree_remove`, `stage_construction` /
   * `stage_agent_construction`, or `stage_self_modify`. These bump `totalOps`
   * but leave `files` empty,
   * so without a separate count they would look like trivial no-op work to the
   * Verifier gate. Like `riskyShellOps`, an unattributable write is a blind spot
   * the gate fires on conservatively. Optional: read as `unattributedWriteOps ?? 0`.
   */
  unattributedWriteOps?: number;
  /** Set to true after scope reflection has been injected once. Prevents repeated injection. */
  reflectionInjected?: boolean;
}

export interface KodaXContextOptions {
  /** Project root used for project-scoped prompts, permissions, and path policy. */
  gitRoot?: string | null;
  /**
   * Explicit working directory used for prompt context, relative tool paths,
   * and shell execution. Defaults to `gitRoot`, then `process.cwd()`.
   */
  executionCwd?: string;
  /**
   * Best-known token snapshot for the current conversation history.
   * When present, the core will prefer it over local estimation and rebase it as
   * messages change.
   */
  contextTokenSnapshot?: KodaXContextTokenSnapshot;
  projectSnapshot?: string;
  longRunning?: {
    featuresFile?: string;
    progressFile?: string;
  };
  /** Optional semantic hints for provider-policy evaluation. */
  providerPolicyHints?: KodaXProviderPolicyHints;
  /** Optional repository routing signals that downstream planning layers can reuse. */
  repoRoutingSignals?: KodaXRepoRoutingSignals;
  /** Optional repo-intelligence mode override for this run. */
  repoIntelligenceMode?: KodaXRepoIntelligenceMode;
  /** Optional repo-intelligence trace toggle for this run. */
  repoIntelligenceTrace?: boolean;
  disableAutoTaskReroute?: boolean;
  /**
   * FEATURE_087/088 (v0.7.28): when true, the prompt builder injects a
   * Tool Construction section that orients the LLM to the
   * scaffold_tool → validate_tool → stage_construction → test_tool →   * activate_tool staircase. Off by default; the surrounding agent (REPL
   * config or task router) flips this on when self-construction is
   * authorized for the session. The corresponding builtin tool handlers
   * are still gated independently by the active-tool set.
   */
  toolConstructionMode?: boolean;
  /** Skills system prompt snippet for progressive disclosure - Skills 系统提示词片段（渐进式披露） */
  skillsPrompt?: string;
  rawUserInput?: string;
  skillInvocation?: KodaXSkillInvocationContext;
  /** Optional repository-intelligence snapshot injected into the system prompt. */
  repoIntelligenceContext?: string;
  /** Optional user-supplied artifacts carried with the current prompt. */
  inputArtifacts?: KodaXInputArtifact[];
  /** Internal execution-mode overlay appended to the system prompt */
  promptOverlay?: string;
  /** Optional task-engine surface label used to track managed tasks across UX entry points. */
  taskSurface?: KodaXTaskSurface;
  /** Optional directory where managed task artifacts should be written. */
  managedTaskWorkspaceDir?: string;
  /** Internal managed-worker protocol emission configuration. */
  managedProtocolEmission?: {
    enabled: boolean;
    role: Exclude<KodaXTaskRole, 'direct'>;
    /** When true, protocol emission is available but not required. Auto-continue won't fire for missing protocol. */
    optional?: boolean;
  };
  /** Mutable mutation tracker shared between worker events and the protocol tool handler. */
  mutationTracker?: ManagedMutationTracker;
  /** FEATURE_067 v3: Tool names to exclude from API-level tool list (child agents). */
  excludeTools?: readonly string[];
  /**
   * FEATURE_067 v3: Override the entire system prompt for this run.
   * When set, buildSystemPromptSnapshot is skipped — only this string is used.
   * Used for child agents that need a focused, lightweight prompt instead of the full system.
   */
  systemPromptOverride?: string;
  /** Optional structured metadata carried into the managed task contract. */
  taskMetadata?: Record<string, KodaXJsonValue>;
  /** Optional structured verification contract carried into managed tasks. */
  taskVerification?: KodaXTaskVerificationContract;
  /**
   * FEATURE_074: Plan-mode block predicate provided by the parent REPL. The predicate
   * closes over live parent state so mid-run mode toggles propagate to in-flight
   * children. Returns the block reason for currently-plan-mode-violating calls, or
   * `null` when the call is allowed right now. When absent, children run without
   * plan-mode enforcement.
   */
  planModeBlockCheck?: (tool: string, input: Record<string, unknown>) => string | null;
  /**
   * FEATURE_123 v0.7.44 — propagate the current agent's id into the
   * spawned runtime so its tools can self-identify (and so peer
   * `send_message` calls can stamp a `from=...` framing tag + reject
   * self-targeted sends).
   */
  currentAgentId?: string;
  /**
   * FEATURE_123 v0.7.44 — propagate the dispatching agent's id (the
   * parent of the soon-to-be-spawned runtime) so `send_message(to:
   * "worker")` from a grand-child routes to its direct parent rather
   * than the top-level Worker.
   */
  parentAgentId?: string;
  /**
   * FEATURE_123 v0.7.44 — when set, the spawned runtime's
   * `ctx.childTaskRegistry` reuses this Map instead of allocating a
   * fresh one. Children pass the parent's registry through so peer
   * routing (`send_message` to a sibling task_id) finds the target.
   * Children remain unable to mutate the registry because
   * `dispatch_child_task` stays in `CHILD_EXCLUDE_TOOLS_BASE`.
   */
  inheritedChildTaskRegistry?: ChildTaskRegistry<KodaXChildExecutionResult>;
  /**
   * FEATURE_192 v0.7.44 Phase F — `/goal` runtime binding.
   *
   * When set, the runner-driven adapter:
   *   1. Wires `binding.goalContext` onto the tool-execution context
   *      so the 3 goal tools (get_goal / create_goal / update_goal)
   *      read + mutate live state.
   *   2. Wraps the `beforeNextTurn` hook with `withGoalBeforeNextTurn`
   *      for turn-end token + wall-time accounting and budget-limit
   *      transitions.
   *   3. Wraps the `stopHook` with `withGoalStopHook` so a Worker
   *      text-only termination with an active goal returns a
   *      continuation prompt (auto-continue on goal).
   *
   * Constructed by the REPL via `buildGoalRuntimeBinding(deps)` from
   * `packages/coding/src/goal/runtime-wiring.ts`. When undefined, the
   * tool context falls back to `makeDisabledGoalToolsContext()` and
   * the lifecycle hooks pass through unmodified.
   */
  goalRuntime?: import('./goal/runtime-wiring.js').GoalRuntimeBinding;

  /**
   * FEATURE_132 (v0.7.47) — native LSP service for edit-time diagnostics
   * reflux. When omitted, `buildToolExecutionContext` falls back to the
   * process-wide default (`getDefaultLspService()`), so diagnostics work
   * out of the box; hosts/tests inject their own to control or disable it.
   *
   * See `packages/coding/src/lsp/service.ts`.
   */
  lspService?: import('./lsp/service.js').LspService;
}

/**
 * FEATURE_221 — an SDK consumer (a product built on KodaX, e.g. KodaX-Space)
 * injects its own product manual so that when ITS users ask "how do I use /
 * configure <product>?", the kodax_manual tool answers with the consumer's
 * topics. `topics` extend the KodaX base (override by id); `productName`
 * re-brands the routing rule + scope anchor. Topics are still byte-capped.
 */
export interface KodaXSelfManualConfig {
  readonly productName?: string;
  readonly topics?: readonly KodaXManualTopicInput[];
}

/**
 * SDK-consumer auto-compaction override. When a field is provided it wins
 * over both the adaptive default and `~/.kodax/config.json`. Lets an
 * embedder that calls `runManagedTask` in-process pin the context window /
 * trigger for a model the built-in capability table doesn't cover (or that
 * it resolves through a custom provider), or disable auto-compaction for a
 * run — without writing to the user's home-dir config file. Omitted fields
 * fall through to the normal resolution cascade.
 */
export interface KodaXCompactionOverride {
  /** Override the resolved provider context window, in tokens. */
  contextWindow?: number;
  /** Override the auto-compaction trigger percentage (0-100). */
  triggerPercent?: number;
  /** Set false to disable automatic compaction for this run. */
  enabled?: boolean;
}

export interface KodaXOptions {
  provider: string;
  model?: string;
  modelOverride?: string;
  effort?: KodaXWireReasoningEffort;
  thinking?: boolean;
  reasoningMode?: KodaXReasoningMode;
  agentMode?: KodaXAgentMode;
  maxIter?: number;
  session?: KodaXSessionOptions;
  context?: KodaXContextOptions;
  events?: KodaXEvents;
  extensionRuntime?: ExtensionRuntimeContract;
  /** FEATURE_229: host-owned policy for workflow auto-start and ceilings. */
  workflowHostPolicy?: import('./workflows/invocation-policy.js').WorkflowHostPolicy;
  /**
   * FEATURE_246 Part A2 (ADR-046): durable run-graph base dir for workflow runs
   * the model launches via `run_workflow`. The host (REPL / SDK) resolves it
   * (e.g. `getAgentConfigPath('workflow-runs', projectKey)`); when set + the
   * agent mode is ama/amaw, the tool-execution context wires `ctx.workflowHost`.
   */
  workflowRunsBaseDir?: string;
  /** FEATURE_221: SDK-consumer self-manual injection (product name + topics). */
  selfManual?: KodaXSelfManualConfig;
  /**
   * FEATURE_092 (v0.7.33): caller-supplied run-scoped guardrails forwarded
   * to `Runner.run` via `RunOptions.guardrails`. Merged with the START
   * agent's declared guardrails (agent-first, then opts). The REPL injects
   * the AutoModeToolGuardrail here when `permissionMode === 'auto'`; SDK
   * consumers can inject custom ToolGuardrail / InputGuardrail / OutputGuardrail
   * instances. Empty / undefined leaves the agent's own declaration unchanged.
   */
  guardrails?: readonly import('@kodax-ai/agent').Guardrail[];
  /** AbortSignal for cancelling the API request */
  abortSignal?: AbortSignal;
  /**
   * v0.7.42 — `RunningSession` plumbing (closes gap 6 reported by KodaX
   * Space). When provided, the substrate `_attach`es low-level mutators
   * onto this control object so the embedder can flip provider / model
   * / reasoning between turns without restarting the run. The mutations
   * land on the live `RuntimeSessionState` and are picked up by the
   * next-turn CAP-055 provider re-resolution. `startKodaX` (the
   * non-blocking entry) is the canonical producer of this field; direct
   * SDK callers can also instantiate one via {@link createSessionControl}.
   */
  sessionControl?: KodaXSessionControl;
  /**
   * SDK-consumer auto-compaction override. Wins over the adaptive default
   * and `~/.kodax/config.json`. See {@link KodaXCompactionOverride}.
   */
  compaction?: KodaXCompactionOverride;
  /**
   * SDK-consumer timeout budgets for user-facing waits. Values are seconds at
   * the public API boundary; KodaX converts them to milliseconds internally.
   * This does not control internal cleanup/resource-protection watchdogs.
   */
  timeouts?: KodaXTimeoutConfig;
}

/**
 * Low-level mutators handed to a `KodaXSessionControl` by the substrate.
 * Each setter writes directly into the live `RuntimeSessionState`. Called
 * exactly once per session (just after `buildRuntimeSessionState`).
 */
export interface KodaXSessionMutators {
  setProvider(name: string): void;
  setModel(model: string | undefined): void;
  setReasoning(mode: KodaXReasoningMode | undefined): void;
}

/**
 * Embedder-facing control surface. Created by the embedder (or by
 * `startKodaX`), passed in via `KodaXOptions.sessionControl`. The
 * substrate calls `_attach` once, after which the control's setter
 * methods apply live to the in-flight run.
 */
export interface KodaXSessionControl {
  /** @internal — wired by `run-substrate`. Do not call from user code. */
  _attach(mutators: KodaXSessionMutators): void;
}

// ============== 结果类型 ==============

export type KodaXTaskSurface = 'cli' | 'repl' | 'plan';
export type KodaXTaskStatus = 'planned' | 'running' | 'blocked' | 'failed' | 'completed';
// FEATURE_114 v0.7.36: 'worker' is the AMA Harness V2 role that collapses
// scout/planner/generator into a single primary agent driving plan + exec
// behind the KODAX_HARNESS_V2 flag. Evaluator stays a separate role.
// Legacy roles (scout/planner/generator/evaluator) remain on the V1 path
// until v0.7.45 cleanup; both paths share the role-prompt switch.
export type KodaXTaskRole = 'direct' | 'scout' | 'planner' | 'generator' | 'evaluator' | 'worker';

export interface KodaXTaskContract {
  taskId: string;
  surface: KodaXTaskSurface;
  objective: string;
  createdAt: string;
  updatedAt: string;
  status: KodaXTaskStatus;
  primaryTask: KodaXTaskType;
  workIntent: KodaXTaskWorkIntent;
  complexity: KodaXTaskComplexity;
  riskLevel: KodaXRiskLevel;
  harnessProfile: KodaXHarnessProfile;
  recommendedMode: KodaXExecutionMode;
  requiresBrainstorm: boolean;
  reason: string;
  contractSummary?: string;
  successCriteria: string[];
  requiredEvidence: string[];
  constraints: string[];
  contractCreatedByAssignmentId?: string;
  contractUpdatedAt?: string;
  metadata?: Record<string, KodaXJsonValue>;
  verification?: KodaXTaskVerificationContract;
}

export interface KodaXTaskRoleAssignment {
  id: string;
  role: KodaXTaskRole;
  title: string;
  dependsOn: string[];
  status: KodaXTaskStatus;
  agent?: string;
  toolPolicy?: KodaXTaskToolPolicy;
  summary?: string;
  sessionId?: string;
}

export interface KodaXTaskWorkItem {
  id: string;
  assignmentId: string;
  description: string;
  execution: 'serial' | 'parallel';
}

export interface KodaXTaskEvidenceArtifact {
  kind: 'json' | 'text' | 'markdown' | 'image';
  path: string;
  description?: string;
}

export interface KodaXTaskEvidenceEntry {
  assignmentId: string;
  role: KodaXTaskRole;
  status: KodaXTaskStatus;
  title?: string;
  round?: number;
  summary?: string;
  output?: string;
  sessionId?: string;
  signal?: 'COMPLETE' | 'BLOCKED' | 'DECIDE';
  signalReason?: string;
}

export interface KodaXTaskEvidenceBundle {
  workspaceDir: string;
  runId?: string;
  artifacts: KodaXTaskEvidenceArtifact[];
  entries: KodaXTaskEvidenceEntry[];
  routingNotes: string[];
}

export interface KodaXOrchestrationVerdict {
  status: KodaXTaskStatus;
  decidedByAssignmentId: string;
  summary: string;
  signal?: 'COMPLETE' | 'BLOCKED' | 'DECIDE';
  signalReason?: string;
  signalDebugReason?: string;
  disposition?: 'complete' | 'blocked' | 'needs_continuation';
}

export interface KodaXManagedTaskRuntimeState {
  childContextBundles?: KodaXChildContextBundle[];
  childAgentResults?: KodaXChildAgentResult[];
  parentReductionContract?: KodaXParentReductionContract;
  budget?: KodaXManagedBudgetSnapshot;
  scorecard?: KodaXVerificationScorecard;
  qualityAssuranceMode?: 'required' | 'optional';
  memoryStrategies?: Record<string, KodaXMemoryStrategy>;
  memoryNotes?: Record<string, string>;
  roleRoundSummaries?: Partial<Record<KodaXTaskRole, KodaXRoleRoundSummary>>;
  routingAttempts?: number;
  routingSource?: KodaXTaskRoutingDecision['routingSource'];
  currentHarness?: KodaXHarnessProfile;
  upgradeCeiling?: KodaXHarnessProfile;
  harnessTransitions?: KodaXManagedTaskHarnessTransition[];
  // FEATURE_193 (v0.7.43) deep V1 cleanup: V1 Scout role retired. The
  // SDK fields `scoutDecision` (Scout's harness/scope decision) and
  // `skillMap` (Scout's skill-projection slot) have been removed
  // physically — V2 Worker reads skillMap / scope context via
  // `ctx.skillInvocation` and the routing-overlay system-prompt section
  // (FEATURE_143) instead.
  completionContractStatus?: Record<string, 'ready' | 'incomplete' | 'blocked' | 'missing'>;
  rawRoutingDecision?: KodaXTaskRoutingDecision;
  finalRoutingDecision?: KodaXTaskRoutingDecision;
  routingOverrideReason?: string;
  providerRuntimeBehavior?: {
    downgraded?: boolean;
    reasons: string[];
  };
  degradedVerification?: {
    fallbackWorkerId?: string;
    reason: string;
    debugReason?: string;
  };
  degradedContinue?: boolean;
  reviewFilesOrAreas?: string[];
  toolOutputTruncated?: boolean;
  toolOutputTruncationNotes?: string[];
  /**
   * Warn-only todo hygiene telemetry: successful real work started while
   * pending todos existed and no item was marked in_progress. The runner
   * never mutates todo state from this signal.
   */
  todoDriftWarnings?: KodaXTodoDriftWarningEvent[];
  managedTimeline?: KodaXManagedLiveEvent[];
  evidenceAcquisitionMode?: 'overview' | 'diff-bundle' | 'diff-slice' | 'file-read';
  consecutiveEvidenceOnlyIterations?: number;
  globalWorkBudget?: number;
  budgetUsage?: number;
  budgetApprovalRequired?: boolean;
  /** FEATURE_067: Evaluator review prompt for write fan-out diffs. */
  childWriteReviewPrompt?: string;
  /** FEATURE_067: Number of write child diffs pending evaluator review. */
  childWriteDiffCount?: number;
}

export interface KodaXManagedTask {
  contract: KodaXTaskContract;
  roleAssignments: KodaXTaskRoleAssignment[];
  workItems: KodaXTaskWorkItem[];
  evidence: KodaXTaskEvidenceBundle;
  verdict: KodaXOrchestrationVerdict;
  runtime?: KodaXManagedTaskRuntimeState;
}

export interface KodaXManagedVerdictPayload {
  /** FEATURE_184 (v0.7.45): `'sidecar'` is the new architectural source —   *  Sidecar Verifier replaces the in-chain Evaluator role. `'evaluator'`
   *  / `'worker'` are retained for backward-compat reads of session jsonl
   *  written before v0.7.45. New writes use `'sidecar'`. */
  source: 'evaluator' | 'worker' | 'sidecar';
  status: 'accept' | 'revise' | 'blocked';
  reason?: string;
  debugReason?: string;
  followups: string[];
  userFacingText: string;
  userAnswer?: string;
  artifactPath?: string;
  rawArtifactPath?: string;
  rawResponseText?: string;
  nextHarness?: KodaXTaskRoutingDecision['harnessProfile'];
  protocolParseFailed?: boolean;
  verificationDegraded?: boolean;
  preferredFallbackWorkerId?: string;
  /**
   * v0.7.26 Risk-3 fix — Evaluator explicit budget-extension request.
   * When present, the Runner-driven `wrapEmitterWithRecorder` fires the
   * budget-extension dialog regardless of the 90% threshold, using this
   * string as the user-visible summary. Mirrors legacy Evaluator's
   * `budgetRequest` field which was parsed from the fenced-block
   * `kodax-budget-request` payload in v0.7.22.
   */
  budgetRequest?: string;
}

/**
 * Signals surfaced by the harness (not the LLM) when V1 Scout's completion
 * looked suspicious.
 *
 * FEATURE_193 (v0.7.43) deep V1 cleanup: V1 Scout role is retired and the
 * Runner-driven path no longer fires `onScoutSuspiciousCompletion`. The
 * type is kept on the SDK surface so the `KodaXEvents.onScoutSuspiciousCompletion`
 * callback signature continues to compile for pre-1.0 SDK consumers (e.g.
 * the REPL renderers that still register a handler). New code MUST NOT
 * emit this signal.
 */
export type KodaXScoutSuspiciousSignal =
  | 'mutation-expected-but-none'
  | 'budget-exhausted'
  | 'no-formal-completion';

// FEATURE_193 (v0.7.43) deep V1 cleanup: the V1 chain payload slots
// (`scout` / `contract` / `handoff`) and their slice type defs
// (`KodaXManagedScoutPayload` / `KodaXManagedContractPayload` /
// `KodaXManagedHandoffPayload`) have been removed physically — V1 chain
// retired, no V2 caller mints these payloads. Only the verdict slot
// remains; the Sidecar Verifier (FEATURE_184) is the sole emitter on V2.
export interface KodaXManagedProtocolPayload {
  verdict?: KodaXManagedVerdictPayload;
}

export interface KodaXRuntimeSessionSnapshot {
  extensionState?: KodaXExtensionSessionState;
  extensionRecords?: KodaXExtensionSessionRecord[];
}

export interface KodaXResult {
  success: boolean;
  lastText: string;
  signal?: 'COMPLETE' | 'BLOCKED' | 'DECIDE';
  signalReason?: string;
  signalDebugReason?: string;
  messages: KodaXMessage[];
  sessionId: string;
  /** Internal raw protocol output retained for artifact persistence after compacting visible failure text. */
  protocolRawText?: string;
  /** Structured managed-task protocol payload separated from visible text. */
  managedProtocolPayload?: KodaXManagedProtocolPayload;
  /** Final visible routing decision for this run, including harness and work intent. */
  routingDecision?: KodaXTaskRoutingDecision;
  /** Managed task summary produced by the task engine for this run. */
  managedTask?: KodaXManagedTask;
  /** Best-known token snapshot after the round completes. */
  contextTokenSnapshot?: KodaXContextTokenSnapshot;
  /** Latest provider usage when the caller has it directly. */
  usage?: KodaXTokenUsage;
  /** Serializable runtime-owned session state for host-owned persistence. */
  runtimeSessionSnapshot?: KodaXRuntimeSessionSnapshot;
  /**
   * FEATURE_076: artifact ledger pre-extracted before round-boundary reshape.
   * Populated when the reshape replaces `messages` with a clean {user, assistant}
   * dialog — tool_result blocks (the source of artifact ledger entries) no
   * longer live in `messages` after reshape. REPL consumers should read this
   * field first, falling back to `extractArtifactLedger(messages)` for
   * backward compatibility on code paths that have not yet been updated.
   */
  artifactLedger?: readonly KodaXSessionArtifactLedgerEntry[];
  /** 是否被用户中断 (Ctrl+C) */
  interrupted?: boolean;
  /** 是否达到迭代上限 */
  limitReached?: boolean;
  /** Error metadata for recovery - 错误元数据用于恢复 */
  errorMetadata?: SessionErrorMetadata;
}

// ============== 工具执行上下文 ==============
// Simplified - no permission checks in core

// FEATURE_222 — the user-interaction types now live at the agent layer so the
// MCP elicitation reverse capability can share the same primitive. Re-exported
// here for backward compatibility (existing `../types.js` imports keep working).
import type {
  AskUserQuestionItem,
  AskUserMultiOptions,
  AskUserQuestionOptions,
} from '@kodax-ai/agent';
export type { AskUserQuestionItem, AskUserMultiOptions, AskUserQuestionOptions };

export interface KodaXToolExecutionContext {
  /** File backups for undo functionality - 文件备份用于撤销功能 */
  backups: Map<string, string>;
  /** Git root directory - Git 鏍圭洰褰?*/
  gitRoot?: string;
  /** FEATURE_221: SDK-consumer self-manual injection, forwarded from KodaXOptions. */
  selfManual?: KodaXSelfManualConfig;
  /** Working directory used to resolve relative paths and execute shell commands. */
  executionCwd?: string;
  /** Session-scoped directory for helper scripts and scratch outputs. */
  sessionScratchDir?: string;
  /**
   * Active skill invocation for the current managed run. Child dispatch uses
   * this to preserve the skill's support-file roots in sub-agent briefings.
   */
  skillInvocation?: KodaXSkillInvocationContext;
  /**
   * FEATURE_217 (v0.7.49): parent dir for `isolation:'worktree'` workflow child
   * worktrees. Workflow runs point this at `<runDir>/worktrees` so worktrees are
   * reclaimable (Layer 2/3 sweep) and never pollute the user's project tree.
   * Absent on non-workflow paths → worktrees fall back to the git root's parent.
   */
  workflowWorktreeBaseDir?: string;
  /** Shared extension capability runtime used by retrieval-family tools. */
  extensionRuntime?: CapabilityRuntimeContract;
  /** Ask user a question interactively (select mode) - 交互式向用户提问 (Issue 069) */
  askUser?: (options: AskUserQuestionOptions) => Promise<string>;
  /** Ask user multiple independent questions sequentially - 澶氶棶棰橀『搴忔彁闂?*/
  askUserMulti?: (options: AskUserMultiOptions) => Promise<Record<string, string> | undefined>;
  /** Ask user for free-text input - 自由文本输入 (Issue 112) */
  askUserInput?: (options: { question: string; default?: string }) => Promise<string | undefined>;
  /**
   * FEATURE_074: Exit plan mode with user approval. Called by the `exit_plan_mode` tool.
   * See KodaXEvents.exitPlanMode for the tri-state return contract.
   */
  exitPlanMode?: (plan: string) => Promise<boolean | 'not-in-plan-mode'>;
  /** Abort signal for cancelling in-flight tool operations (Issue 113) */
  abortSignal?: AbortSignal;
  /**
   * FEATURE_121 v0.7.40 — last-resort LLM blob summarizer.
   *
   * Injected by `runner-driven.ts` at task-engine init using the
   * Worker's own provider/model (same panel, same key). The dispatch
   * tool calls this only when `applyToolResultGuardrail` returned
   * `spillFailed: true` AND the raw content exceeds
   * `LARGE_CONTENT_THRESHOLD_BYTES` (100 KB) — i.e., spill is broken
   * AND inlining the full payload would risk blowing context. The
   * callback compresses to roughly 2-10 KB while preserving structural
   * tokens (paths / line-numbers / error codes). On failure the caller
   * falls back to the existing inline-full-content path; callees are
   * expected to throw `BlobSummarizerError` on empty / aborted /
   * upstream-error.
   *
   * See `packages/coding/src/tools/blob-summarizer.ts`.
   */
  summarizeBlob?: (
    content: string,
    options?: { readonly maxChars?: number; readonly abortSignal?: AbortSignal },
  ) => Promise<string>;
  managedProtocolRole?: Exclude<KodaXTaskRole, 'direct'>;
  emitManagedProtocol?: (payload: Partial<KodaXManagedProtocolPayload>) => void;
  /** FEATURE_067 v2: Parent agent's provider/model for child agent inheritance. */
  parentAgentConfig?: {
    readonly provider: string;
    readonly model?: string;
    readonly reasoningMode?: KodaXReasoningMode;
    readonly effort?: KodaXWireReasoningEffort;
    readonly repoIntelligenceMode?: KodaXRepoIntelligenceMode;
    readonly repoIntelligenceTrace?: boolean;
  };
  /**
   * Parent SDK/REPL callback surface available to child-dispatch tools.
   * `dispatch_child_task` uses this to preserve live child telemetry without
   * copying every callback onto KodaXToolExecutionContext as a separate field.
   */
  parentEvents?: KodaXEvents;
  /**
   * FEATURE_123 v0.7.44 — agentId of the agent whose tool call this
   * context backs. `undefined` for the top-level Worker (main runtime
   * loop); set to the child's `bundle.id` for sub-agent runtimes.
   *
   * Consumed by `send_message` to:
   *   - know who "self" is for broadcast self-exclusion and for the
   *     `from=...` framing tag,
   *   - reject self-targeted sends as a single-hop cycle guard.
   *
   * Wired by `child-executor.executeReadChild` / `executeWriteChild`
   * via `options.context.currentAgentId`.
   */
  currentAgentId?: string;
  /**
   * FEATURE_123 v0.7.44 — agentId of the agent that dispatched the one
   * owning this context. `undefined` for the Worker (top of the tree)
   * and for first-tier children (parent == Worker; routing uses the
   * `'worker'` sentinel rather than an agentId). Set for grand-child
   * runtimes whose parent is itself a child.
   *
   * Consumed by `send_message` when `to === 'worker'`:
   *   - If `parentAgentId` is set, route to that specific id.
   *   - If `parentAgentId` is undefined, route to `agentId: undefined`
   *     (the main loop / top Worker).
   */
  parentAgentId?: string;
  /**
   * FEATURE_123 v0.7.44 — per-turn `send_message` flood throttle counter.
   *
   * Mutable ref that the `send_message` tool increments on every
   * outbound enqueue (broadcast counts as N — one per recipient).
   * `runner-driven.ts`' `beforeNextTurn` resets `count = 0` at every
   * turn boundary so the limit is "per LLM turn", matching the
   * design's "≤5 per child-turn / ≤20 per Worker-turn".
   *
   * The cap chosen by `send_message` is per-call:
   *   - Worker (`currentAgentId === undefined`): 20 outbound enqueues
   *     per turn — Worker is the coordinator + has the higher fan-out
   *     budget.
   *   - Child (`currentAgentId !== undefined`): 5 outbound enqueues
   *     per turn — peer chatter that goes over this is almost always
   *     a misfire (storm vs coordination).
   *
   * When undefined (sync-mode dispatch, no async substrate), the
   * throttle is bypassed.
   */
  sendMessageTurnCounter?: { count: number };
  /**
   * @deprecated FEATURE_067: Removed — use reportToolProgress instead.
   * Previously fired onManagedTaskStatus with activeWorkerId='child',
   * triggering a foreground worker transition that cleared all live tool calls.
   */
  onChildProgress?: (note: string) => void;
  /** FEATURE_067 v2: Callback for long-running tools to report execution progress to the REPL transcript.
   *  The string will be displayed as the tool's "Running:" line in the transcript. */
  reportToolProgress?: (message: string) => void;
  /** Mutation tracker for scope-aware protocol responses. Populated by createWorkerEvents. */
  mutationTracker?: ManagedMutationTracker;
  /**
   * FEATURE_074: Predicate provided by the parent REPL that evaluates plan-mode
   * block reasons for child tool calls. Read lazily at each call — closes over
   * live parent state so mid-run mode toggles propagate into in-flight children.
   */
  planModeBlockCheck?: (tool: string, input: Record<string, unknown>) => string | null;

  /**
   * FEATURE_092 phase 2b.7b slice D: parent-Runner guardrails surfaced into the
   * tool-execution context so `dispatch_child_task` can forward them to the
   * child's `Runner.run` via `KodaXOptions.guardrails`. Sharing the SAME
   * guardrail instance means the auto-mode `engine` + `denialTracker` +
   * `circuitBreaker` state is observed across the parent/child boundary —
   * rate-limit by hitting the threshold from a fresh tracker).
   *
   * Single-process / single-thread execution makes the shared mutable state
   * safe under JS run-to-completion semantics — concurrent child tool calls
   * produce interleaved `recordBlock` / `recordAllow` updates with no tearing.
   */
  guardrails?: readonly import('@kodax-ai/agent').Guardrail[];
  /**
   * FEATURE_097 (v0.7.34): Scout-seeded todo plan store. Populated by
   * runner-driven setup whenever Scout's `executionObligations` reaches
   * the display threshold (≥2 entries); the `todo_update` tool reads
   * `has(id)` / `allIds()` for unknown-id error reasons and calls
   * `updateStatus(...)` for state transitions. The store emits its own
   * `onTodoUpdate` events via the `onChange` callback wired at creation
   * — tools do not have to forward events themselves.
   */
  todoStore?: import('./task-engine/todo-store.js').TodoStore;

  /**
   * FEATURE_125 v0.7.41 — Team Mode Layer 4 race-condition safety net.
   *
   * Cross-process content-hash cache. The Read tool records a sha256
   * of the file content at read time; Edit / MultiEdit / Write tools
   * check the recorded hash against the current on-disk hash before
   * mutating. A mismatch (peer or user-manual edit landed in the gap)
   * causes the tool to reject with a `{ok:false, reason:"...re-read first"}`
   * envelope rather than overwrite blindly.
   *
   * Created once per managed-task in `runner-driven.ts`, passed
   * through to every tool execution. When undefined (e.g., a tool is
   * called outside a managed task or `KODAX_DISABLE_MULTI_INSTANCE=1`
   * was set), the safety net is bypassed — tools fall back to the
   * single-process semantics.
   *
   * See `packages/coding/src/multi-instance/content-hash-cache.ts`.
   */
  contentHashCache?: import('./multi-instance/content-hash-cache.js').ContentHashCache;

  /**
   * FEATURE_132 (v0.7.47) — native LSP service. The write-family tools call
   * `getDiagnosticsBlock(filePath, …)` after a successful write to reflux any
   * type errors into the tool result. Forwarded by `buildToolExecutionContext`
   * from `options.context.lspService` or the process-wide default.
   */
  lspService?: import('./lsp/service.js').LspService;

  /**
   * FEATURE_177 v0.7.42 — per-task read-file-state cache (anti-loop).
   *
   * Tracks `(filePath, offset, limit)` tuples the LLM has already read
   * in this task. On a re-read with unchanged mtime, the Read tool
   * returns a short stub instead of the full content — breaking
   * `narrate-then-re-read` loops on models with structural decoder
   * floors (kimi-code 2026-05). Edit / Write / MultiEdit call `forget`
   * after a successful mutation; the compaction post-hook calls
   * `clear`. Disabled by `KODAX_READ_DEDUP_KILLSWITCH=1`.
   *
   * See `packages/coding/src/multi-instance/read-file-state-cache.ts`.
   */
  readFileStateCache?: import('./multi-instance/read-file-state-cache.js').ReadFileStateCache;

  /**
   * FEATURE_125 v0.7.41 — Team Mode Layer 3 input.
   *
   * Snapshot of sibling KodaX instances captured at the start of the
   * current LLM round by the runner-driven adapter. Mutation tools
   * (Edit / MultiEdit / Write) read this when present to detect
   * `activeFiles` overlap and prepend a soft warning to their tool
   * result. The snapshot is per-round (no automatic refresh during a
   * single tool execution) — slight staleness is acceptable; the
   * warning is informational, not a hard gate.
   *
   * When undefined (Team Mode disabled, solo session, or tool invoked
   * outside a managed task), the warning layer is bypassed silently.
   * The hard-block layer (`contentHashCache`) is independent and
   * still applies.
   *
   * See `packages/coding/src/multi-instance/active-file-warning.ts`.
   */
  siblingSnapshot?: readonly import('@kodax-ai/agent').DiscoveredInstance[];

  /**
   * FEATURE_119 v0.7.36 Pattern B: registry of in-flight async child
   * dispatches. When set, `dispatch_child_task` runs in fire-and-forget
   * mode (returns a `task_id` immediately without awaiting). The Worker
   * launches multiple children in parallel; under FEATURE_155 (v0.7.39)
   * idle-yield, the runner-driven outer loop awaits the registered
   * promises on the Worker's behalf and splices a `<task-completed>`
   * banner into the next user turn — the Worker no longer pulls results
   * itself (the legacy `await_child_task` tool was removed in Slice C1).
   *
   * The map's value is the executor's full result promise, identical to
   * what the legacy synchronous dispatch returned.
   *
   * When `undefined`, dispatch falls back to the legacy synchronous path
   * (await inline, return finding text). The registry is populated by
   * `runner-driven.ts` per turn so each agent run has its own registry
   * scope.
   *
   * **v0.7.39 FEATURE_120 Step 0**: the type alias is now imported from
   * `@kodax-ai/agent`'s orchestration layer (`ChildTaskRegistry<T>`).
   * Structure-compatible with the previous `Map<string, Promise<…>>`
   * inline shape — the rename is a packaging-only change per ADR-021.
   * Coding-flavor consumers should keep using
   * `registerChildTask(registry, id, promise)` (also from
   * `@kodax-ai/agent`) to get the FEATURE_155 Bug A cleanup chain
   * built-in.
   */
  childTaskRegistry?: ChildTaskRegistry<KodaXChildExecutionResult>;

  /**
   * FEATURE_120 v0.7.39 Phase 3b: per-child AbortController registry.
   * Provisioned alongside `childTaskRegistry` by `runner-driven.ts`
   * when async dispatch is enabled. `dispatch_child_task` allocates
   * a fresh `AbortController` per child and registers it here under
   * the child's task id; the child's executor receives the controller's
   * signal (chained with the parent's `abortSignal` so EITHER source
   * can cancel the child). The `task_stop` tool looks up the
   * controller and calls `requestTaskStop` to fire the signal.
   *
   * The map is cleaned in the dispatch handler's `.finally` chain
   * alongside the child-task registry cleanup so an aborted or
   * settled child does not leak its controller reference.
   *
   * Undefined in legacy sync-mode dispatch (same gate as
   * `childTaskRegistry`).
   */
  childAbortControllers?: TaskAbortRegistry;

  /**
   * FEATURE_177 v0.7.45 substrate for the `task_output` tool. Per-child
   * runtime snapshot a parent agent can query mid-flight to peek at
   * iteration count + recent tool-call breadcrumbs without waiting for
   * the child's `<task-completed>` banner.
   *
   * Populated by `dispatch_child_task` at launch (`initChildSnapshot`)
   * and at terminal (`finalizeChildSnapshot` in the child promise's
   * inner-IIFE `.finally`). The `task_output` tool reads from this map.
   *
   * Snapshots survive the child task settling (so post-completion peeks
   * work) and are bounded by `CHILD_PROGRESS_SNAPSHOT_CAP` (FIFO prune
   * by `startedAt` when the cap is exceeded). No TTL — snapshots are
   * cleared with the ctx itself when the parent runner exits.
   *
   * Undefined in legacy sync-mode dispatch (same gate as
   * `childTaskRegistry`). Children's own SA contexts do NOT inherit
   * this map (verified by `buildToolExecutionContext` not forwarding
   * it into child `runKodaX` calls).
   */
  childProgressSnapshots?: Map<string, import('./child-progress-snapshot.js').ChildProgressSnapshot>;

  /**
   * FEATURE_192 v0.7.44 — `/goal` Persistent Goal runtime hook.
   *
   * Wired by the REPL adapter for every session with a lineage. When
   * undefined (sync-dispatch / isolated test harness), the 3 goal
   * tools (`get_goal` / `create_goal` / `update_goal`) fall back to a
   * uniform-error context (`makeDisabledGoalToolsContext`) so the
   * model gets a clear signal rather than a silent failure.
   *
   * See `packages/coding/src/goal/tools-context.ts`.
   */
  goalContext?: import('./goal/tools-context.js').GoalToolsContext;
  /**
   * FEATURE_246 Part A2 (ADR-046): narrow capability the `run_workflow` tool
   * uses to start a managed workflow run. Wired by tool-execution-context (via
   * a lazy import of the coding WorkflowHost) only when the session enables it;
   * absent in SA / when no runs dir is configured, so the tool fails closed.
   */
  workflowHost?: WorkflowToolHost;
}

/** Result of a model-launched workflow run (FEATURE_246 Part A2). */
export interface WorkflowToolHostResult {
  readonly kind: 'declined' | 'started';
  /** declined: why the host/generator declined to run. */
  readonly reason?: string;
  /** started: the minted run id. */
  readonly runId?: string;
  /** started: terminal status once the run settled. */
  readonly status?: string;
  /** started: the run's displayable result text, when completed. */
  readonly resultText?: string;
  /** started: terminal error message, when failed. */
  readonly error?: string;
}

/**
 * Narrow ctx capability for launching workflows from a tool. Intentionally free
 * of any workflow-layer type import (keeps `types.ts` dependency-light); the
 * concrete implementation lives behind a lazy import in tool-execution-context.
 */
export interface WorkflowToolHost {
  /** Start an inline-authored workflow ({manifest, source}) and await its result. */
  runInline(input: {
    readonly manifest: unknown;
    readonly source: string;
    readonly args?: unknown;
  }): Promise<WorkflowToolHostResult>;
}

// FEATURE_200 Phase F: repo-intelligence domain extracted to ./types/repo-intelligence.ts.
import type {
  KodaXRepoIntelligenceMode,
  KodaXRepoIntelligenceTraceEvent,
  KodaXRepoIntelligenceCapability,
  KodaXRepoIntelligenceTrace,
} from './types/repo-intelligence.js';
export * from './types/repo-intelligence.js';
