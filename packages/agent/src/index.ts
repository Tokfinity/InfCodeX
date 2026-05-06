/**
 * @kodax/agent
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
  KodaXHarnessProfile,
  KodaXAmaProfile,
  KodaXAmaTactic,
  KodaXAmaFanoutClass,
  KodaXAmaFanoutPolicy,
  KodaXAmaControllerDecision,
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

// ============== Session ==============
export {
  generateSessionId,
  extractTitleFromMessages,
} from './session.js';

export {
  appendSessionLineageLabel,
  applyLineageTruncation,
  applySessionCompaction,
  archiveOldIslands,
  buildSessionTree,
  countActiveLineageMessages,
  createSessionLineage,
  forkSessionLineage,
  getSessionLineagePath,
  getSessionMessagesFromLineage,
  resolveSessionLineageTarget,
  findPreviousUserEntryId,
  rewindSessionLineage,
  setSessionLineageActiveEntry,
} from './session-lineage.js';

// ============== Tokenizer ==============
export {
  estimateTokens,
  countTokens,
} from './tokenizer.js';

// ============== Compaction ==============
export type {
  CompactionAnchor,
  CompactionConfig,
  CompactionDetails,
  CompactionUpdate,
  CompactionResult,
  FileOperations,
} from './compaction/types.js';

export {
  extractArtifactLedger,
  extractFileOps,
  mergeArtifactLedger,
  mergeFileOps,
} from './compaction/file-tracker.js';

export {
  serializeConversation,
} from './compaction/utils.js';

export {
  generateSummary,
  buildCompactionPromptSnapshot,
} from './compaction/summary-generator.js';
export type {
  KodaXCompactionPromptVariant,
  KodaXCompactionPromptSection,
  KodaXCompactionPromptSnapshot,
} from './compaction/summary-generator.js';

export {
  needsCompaction,
  compact,
} from './compaction/compaction.js';

export {
  microcompact,
  DEFAULT_MICROCOMPACTION_CONFIG,
} from './compaction/microcompaction.js';
export type {
  MicrocompactionConfig,
} from './compaction/microcompaction.js';

export {
  buildFileContentMessages,
  buildPostCompactAttachments,
  injectPostCompactAttachments,
  DEFAULT_POST_COMPACT_CONFIG,
  POST_COMPACT_TOKEN_BUDGET,
  POST_COMPACT_MAX_TOKENS_PER_FILE,
} from './compaction/post-compact.js';
export type {
  PostCompactConfig,
  PostCompactAttachments,
} from './compaction/post-compact.js';

// ============== Extension Persistence (FEATURE_034) ==============
export {
  FileExtensionStore,
  createExtensionStore,
} from './persistence.js';

// ============== Layer A Primitives (absorbed from @kodax/core in v0.7.35.1 FEATURE_142) ==============
// FEATURE_082 (v0.7.24) extracted these into @kodax/core; v0.7.35.1 FEATURE_142
// merges them back into @kodax/agent because:
// - @kodax/core had a single consumer (@kodax/coding); 3+ rule violation
// - @kodax/agent IS the agent platform foundation, primitives belong here
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

// AMA H2 role agent declarations (Scout/Planner/Generator/Evaluator)
export {
  SCOUT_AGENT_NAME,
  PLANNER_AGENT_NAME,
  GENERATOR_AGENT_NAME,
  EVALUATOR_AGENT_NAME,
  TASK_ENGINE_ROLE_AGENTS,
  scoutAgent,
  plannerAgent,
  generatorAgent,
  evaluatorAgent,
} from './primitives/task-engine-agents.js';

// ============== Admission Contract (FEATURE_101 v0.7.31; absorbed from @kodax/core in v0.7.35.1) ==============
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
export {
  CORE_INVARIANTS,
  evidenceTrail,
  finalOwner,
  handoffLegality,
  harnessSelectionTiming,
  registerCoreInvariants,
} from './admission/invariants/index.js';

// Capability provider contract — re-exported from @kodax/ai (canonical home
// per ADR-021). Re-export here lets v0.7.35 consumers that imported these
// types from @kodax/core continue to work via @kodax/agent without splitting
// the import. Direct import from @kodax/ai is also supported.
export type {
  CapabilityKind,
  CapabilityProvider,
  CapabilityResult,
} from '@kodax/ai';
