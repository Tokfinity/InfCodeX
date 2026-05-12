/**
 * @kodax-ai/agent
 *
 * 通用 Agent 框架 - 会话管理和消息处理
 *
 * 这个包提供了通用的 Agent 功能：
 * - 会话 ID 生成和标题提取
 * - Token 估算
 * - 消息压缩
 * - 通用常量配置
 */

// ============== Types ==============
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
  // v0.7.35.1 FEATURE_142 (A-R4): KodaXHarnessProfile / KodaXAmaProfile /
  // KodaXAmaTactic / KodaXAmaFanoutClass / KodaXAmaFanoutPolicy /
  // KodaXAmaControllerDecision are coding-AMA-specific vocabulary; the
  // canonical home is `@kodax-ai/llm`. Removed from `@kodax-ai/agent`'s public
  // re-export per ADR-021 (the universal Agent framework must not expose
  // coding-AMA terms in its surface). Coding-side consumers import directly
  // from `@kodax-ai/llm`.
  KodaXTaskRoutingDecision,
  KodaXThinkingBudgetMap,
  KodaXTaskBudgetOverrides,
  KodaXReasoningRequest,
  KodaXJsonValue,
  KodaXExtensionSessionRecord,
  KodaXExtensionSessionState,
  KodaXExtensionStoreEntry,
  KodaXExtensionStore,
  KodaXCompactMemoryProgress,
  KodaXCompactMemorySeed,
  KodaXSessionArchiveMarkerEntry,
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
  KodaXSessionMeta,
  KodaXSessionScope,
  KodaXSessionRuntimeInfo,
  KodaXSessionStorage,
  KodaXSessionTreeNode,
  KodaXSessionUiHistoryItem,
  KodaXSessionUiHistoryItemType,
  KodaXSessionWorkspaceKind,
  SessionErrorMetadata,
} from './types.js';

// ============== Constants ==============
export {
  KODAX_MAX_TOKENS,
  KODAX_DEFAULT_TIMEOUT,
  KODAX_HARD_TIMEOUT,
  KODAX_MAX_RETRIES,
  KODAX_RETRY_BASE_DELAY,
  KODAX_MAX_INCOMPLETE_RETRIES,
  KODAX_MAX_MAXTOKENS_RETRIES,
  KODAX_STAGGER_DELAY,
  KODAX_API_MIN_INTERVAL,
  PROMISE_PATTERN,
} from './constants.js';

// ============== Tokenizer ==============
export {
  estimateTokens,
  countTokens,
} from './tokenizer.js';

// ============== Session entities + persistence + compaction implementations ==============
// v0.7.35.1 FEATURE_142 Batch B: session.ts / session-lineage.ts / persistence.ts /
// compaction/ moved from @kodax-ai/agent to @kodax-ai/session-lineage. Consumers should
// `import ... from '@kodax-ai/session-lineage'` directly. @kodax-ai/agent stays as the
// pure Agent platform foundation (primitives + admission + tokenizer + types);
// session implementation, persistence, and compaction orchestration live in
// @kodax-ai/session-lineage. See ADR-021 + docs/features/v0.7.35.1.md.
//
// Symbols moved (NOT re-exported here to keep the agent → session-lineage
// dependency direction unidirectional, avoiding a cycle):
//   - generateSessionId, extractTitleFromMessages
//   - KodaXSessionLineage operations (createSessionLineage / applySessionCompaction /
//     forkSessionLineage / rewindSessionLineage / buildSessionTree / …)
//   - FileExtensionStore, createExtensionStore
//   - CompactionConfig + needsCompaction / compact / microcompact / post-compact / …
//   - CompactionAnchor / CompactionDetails / CompactionUpdate / CompactionResult /
//     FileOperations / KodaXCompactionPromptSnapshot / …

// ============== Layer A Primitives (absorbed from @kodax-ai/core in v0.7.35.1 FEATURE_142) ==============
// FEATURE_082 (v0.7.24) extracted these into @kodax-ai/core; v0.7.35.1 FEATURE_142
// merges them back into @kodax-ai/agent because:
// - @kodax-ai/core had a single consumer (@kodax-ai/coding); 3+ rule violation
// - @kodax-ai/agent IS the agent platform foundation, primitives belong here
// See ADR-001 (updated) / ADR-021 / docs/features/v0.7.35.1.md.

// Agent + Handoff
export type {
  Agent,
  AgentMessage,
  AgentMiddlewareDeclaration,
  AgentReasoningProfile,
  AgentTool,
  Guardrail,
  Handoff,
  ReasoningDepth,
} from './primitives/agent.js';
export { createAgent, createHandoff } from './primitives/agent.js';

// Base Session interface (the @experimental thick KodaXSessionLineage at root
// stays as the coding-preset session implementation; this is the Layer A
// primitive that LineageExtension is composed over)
export type {
  InMemorySessionOptions,
  MessageEntry,
  Session,
  SessionEntry,
  SessionExtension,
  SessionForkOptions,
} from './primitives/session.js';
export { createInMemorySession } from './primitives/session.js';

// CompactionPolicy + DefaultSummaryCompaction
// Note: `PolicyCompactionResult` is the Layer A primitive type (renamed from
// `CompactionResult` in v0.7.35.1 FEATURE_142 to disambiguate from agent's
// pre-existing `CompactionResult` in compaction/types.ts).
export type {
  CompactionContext,
  CompactionEntry,
  CompactionEntryPayload,
  CompactionPolicy,
  PolicyCompactionResult,
  DefaultSummaryCompactionOptions,
} from './primitives/compaction.js';
export { DefaultSummaryCompaction } from './primitives/compaction.js';

// Runner + run loop
export type {
  PresetDispatcher,
  PresetTracingContext,
  RunEvent,
  RunOptions,
  RunResult,
} from './primitives/runner.js';
export {
  Runner,
  buildSystemPrompt,
  registerPresetDispatcher,
  _resetPresetDispatchers,
  extractAssistantTextFromMessage,
} from './primitives/runner.js';

export type {
  RunnableTool,
  RunnerLlmResult,
  RunnerLlmReturn,
  RunnerToolCall,
  RunnerToolContext,
  RunnerToolObserver,
  RunnerToolResult,
} from './primitives/runner-tool-loop.js';
export {
  MAX_TOOL_LOOP_ITERATIONS,
  buildAssistantMessageFromLlmResult,
  buildToolResultMessage,
  executeRunnerToolCall,
  isRunnableTool,
  isRunnerLlmResult,
} from './primitives/runner-tool-loop.js';

export type {
  HandoffSignal,
} from './primitives/runner-handoff.js';
export {
  detectHandoffSignal,
  emitHandoffSpan,
  replaceSystemMessage,
} from './primitives/runner-handoff.js';

// Guardrail tri-layer
export type {
  GuardrailContext,
  GuardrailVerdict,
  InputGuardrail,
  OutputGuardrail,
  ToolBeforeOutcome,
  ToolGuardrail,
} from './primitives/guardrail.js';
export {
  GuardrailBlockedError,
  GuardrailEscalateError,
  collectGuardrails,
  runInputGuardrails,
  runOutputGuardrails,
  runToolAfterGuardrails,
  runToolBeforeGuardrails,
} from './primitives/guardrail.js';

// v0.7.35.1 FEATURE_142 (A-R1): SCOUT_AGENT_NAME / PLANNER_AGENT_NAME /
// GENERATOR_AGENT_NAME / EVALUATOR_AGENT_NAME / TASK_ENGINE_ROLE_AGENTS /
// scoutAgent / plannerAgent / generatorAgent / evaluatorAgent moved out of
// @kodax-ai/agent. These role declarations are coding-AMA-specific (H2 state
// machine roles), not generic Agent platform primitives. Canonical home is
// now `@kodax-ai/coding/src/agents/task-engine-agents.ts`. Coding-side
// consumers import from `@kodax-ai/coding`. See ADR-021.

// ============== Admission Contract (FEATURE_101 v0.7.31; absorbed from @kodax-ai/core in v0.7.35.1) ==============
export type {
  AdmissionCtx,
  AdmissionVerdict,
  AdmittedHandle,
  AgentManifest,
  Deliverable,
  InvariantId,
  InvariantResult,
  ManifestPatch,
  ObserveCtx,
  QualityInvariant,
  ReadonlyMutationTracker,
  ReadonlyRecorder,
  RunnerEvent,
  SystemCap,
  TerminalCtx,
  ToolCapability,
  ToolPermission,
} from './admission/admission.js';

export {
  _resetInvariantRegistry,
  applyManifestPatch,
  composePatches,
  getInvariant,
  listRegisteredInvariants,
  registerInvariant,
  resolveEffectiveInvariants,
  resolveRequiredInvariants,
} from './admission/admission-runtime.js';

export type { AdmissionAuditOptions } from './admission/admission-audit.js';
export {
  DEFAULT_SYSTEM_CAP,
  runAdmissionAudit,
  detectInstructionsInjection,
} from './admission/admission-audit.js';

export type { SessionDispatchResult } from './admission/admission-session.js';
export {
  InvariantSession,
  createInvariantSessionForAgent,
  getAdmittedAgentBindings,
  setAdmittedAgentBindings,
  _resetAdmittedAgentBindings,
} from './admission/admission-session.js';

export type { AdmissionMetricsSnapshot } from './admission/admission-metrics.js';
export {
  _resetAdmissionMetrics,
  getAdmissionMetricsSnapshot,
  isAdmissionDebugEnabled,
} from './admission/admission-metrics.js';

// FEATURE_101 v1 pure-new invariants
// v0.7.35.1 FEATURE_142 (A-R2): `harnessSelectionTiming` moved to
// `@kodax-ai/coding/src/agent-runtime/invariants/` — its body reads coding's
// AMA Scout-role `confirmedHarness` field, see ADR-021.
export {
  CORE_INVARIANTS,
  evidenceTrail,
  finalOwner,
  handoffLegality,
  registerCoreInvariants,
} from './admission/invariants/index.js';

// Capability provider contract — re-exported from @kodax-ai/llm (canonical home
// per ADR-021). Re-export here lets v0.7.35 consumers that imported these
// types from @kodax-ai/core continue to work via @kodax-ai/agent without splitting
// the import. Direct import from @kodax-ai/llm is also supported.
export type {
  CapabilityKind,
  CapabilityProvider,
  CapabilityResult,
} from '@kodax-ai/llm';

// ============== Agent config home resolver (v0.7.35.1 FEATURE_145) ==============
// 3-tier resolution chain (programmatic override > KODAX_HOME env > ~/.kodax
// default) to centralize ~30 hardcoded `path.join(homedir(), '.kodax', ...)`
// callsites previously scattered across coding / mcp / repl / session-lineage
// / skills. With DI not set + env not set, the resolver returns the same
// path as the prior hardcoded calls — byte-equivalent for existing users.
// Substrate consumers (downstream agents built on @kodax-ai/agent) call
// setAgentConfigHome() once at boot to redirect the entire process.
export {
  getAgentConfigHome,
  getAgentConfigPath,
  setAgentConfigHome,
} from './runtime/agent-home.js';

// ============== Messaging (v0.7.36 FEATURE_115) ==============
// agentId-scoped 2-tier priority queue infrastructure. Generic agent-platform
// primitive per ADR-021 — downstream consumers in @kodax-ai/coding (runner-driven
// mid-turn drain, subagent task-notification routing) and @kodax-ai/repl
// (FEATURE_111 absorbed soft-pause UX). Phase 0.6 study (claude-code-actual-
// usage.md) showed Claude Code's `'now'` priority has zero production usage,
// so KodaX simplifies to 2 tiers.
export type {
  DequeueFilter,
  EnqueueChildTaskNotificationInput,
  EnqueueInput,
  MaybeDrainMidTurnInput,
  MessageMode,
  MessagePriority,
  QueuedMessage,
} from './messaging/index.js';
export {
  MessageQueue,
  YIELD_TOOL_NAMES,
  _resetMessageQueueForTests,
  enqueueChildTaskNotification,
  getMessageQueue,
  maybeDrainMidTurn,
  midTurnDrainPriority,
} from './messaging/index.js';

// ============== Orchestration (v0.7.39 FEATURE_120 Step 0) ==============
// Generic fan-out / idle-yield / steering primitives lifted from
// `@kodax-ai/coding`'s task-engine internals so the agent framework can
// be consumed standalone (ADR-021). Coding-flavor specifics
// (`KodaXChildExecutionResult` shape, AGENTS.md injection, etc.) stay
// in `@kodax-ai/coding` and consume these as generics.
export type {
  ChildTaskRegistry,
  IdleYieldSnapshot,
  RunWithIdleYieldOptions,
  RunWithIdleYieldRunResult,
  WaitForWakeEventOptions,
  WakeEvent,
} from './orchestration/index.js';
export {
  DEFAULT_IDLE_YIELD_MAX_ITERATIONS,
  composeIdleYieldUserMessage,
  countLastAssistantToolCalls,
  detectIdleYield,
  isIdleYieldEnabled,
  registerChildTask,
  runWithIdleYield,
  waitForWakeEvent,
} from './orchestration/index.js';

// ============== Runtime middleware (v0.7.35.1 FEATURE_142 Batch D) ==============
// Generic, agent-flavor-agnostic substrate middleware uplifted from
// `@kodax-ai/coding/src/agent-runtime/`. Per the narrowed Batch D scope, only
// modules whose deps are pure `@kodax-ai/llm` (+ this package's own tokenizer)
// are uplifted; the rest stay in @kodax-ai/coding because they couple to
// coding-flavored events / tool registry / managed protocol signals. See
// docs/features/v0.7.35.1.md "Batch D" for per-file disposition.
//
// v0.7.36 follow-up: the three compaction-related modules (`shouldCompact`,
// `gracefulCompactDegradation`, `resolveContextWindow` + `DEFAULT_CONTEXT_WINDOW`
// / `ShouldCompactInput`) moved to `@kodax-ai/session-lineage/runtime-middleware/`
// to break the build cycle (agent → session-lineage → agent) introduced
// when they were originally placed here. Downstream consumers in
// `@kodax-ai/coding` now import them from `@kodax-ai/session-lineage` directly.
export {
  cleanupIncompleteToolCalls,
  validateAndFixToolHistory,
} from './runtime-middleware/index.js';
