/**
 * KodaX AI Types
 *
 * AI 层类型定义 - 所有 Provider 共享的类型接口
 */

// ============== 内容块类型 ==============

export interface KodaXTextBlock {
  type: 'text';
  text: string;
}

export interface KodaXToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * Tool-result content blocks — a structural subset of the full
 * `KodaXContentBlock` union, restricted to what providers actually accept
 * inside a tool_result envelope. Anthropic / OpenAI multimodal APIs accept
 * text and image blocks inside tool_result; thinking / tool_use / nested
 * tool_result / cache-boundary are not valid there.
 *
 * Carrying these as a stricter subtype (instead of the full union) lets
 * provider serializers narrow without exhaustive type assertions and
 * documents to tool authors what they can actually return.
 */
export interface KodaXToolResultTextItem {
  type: 'text';
  text: string;
}

export interface KodaXToolResultImageItem {
  type: 'image';
  /** Absolute path to the image file. Provider serializers read it into base64 at wire-send time. */
  path: string;
  mediaType?: string;
}

export type KodaXToolResultContentItem =
    | KodaXToolResultTextItem
    | KodaXToolResultImageItem;

export interface KodaXToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  /**
   * Either a plain text string (backwards-compatible default) OR an array
   * of content items. The array form lets multimodal-capable tools (e.g.
   * `read` on an image path) emit images via tool_result, mirroring
   * claudecode's `Read` tool behavior. Providers serialize each variant
   * to their wire format; text-only providers (e.g. older OpenAI-compat
   * gateways) downgrade image items to a placeholder rather than rejecting.
   */
  content: string | readonly KodaXToolResultContentItem[];
  is_error?: boolean;
}

export interface KodaXImageBlock {
  type: 'image';
  path: string;
  mediaType?: string;
}

export interface KodaXThinkingBlock {
  type: 'thinking';
  thinking: string;
  signature?: string;
}

export interface KodaXRedactedThinkingBlock {
  type: 'redacted_thinking';
  data: string;
}

/**
 * FEATURE_116 (v0.7.37) — Cache boundary marker.
 *
 * Marks the end of a cacheable prefix in a request payload. Provider base
 * classes lower this to the wire-level cache mechanism their API supports:
 *
 * - `KodaXAnthropicCompatProvider`: turns the marker into
 *   `cache_control: { type: 'ephemeral' }` on the immediately preceding
 *   block, then strips the marker itself.
 * - `KodaXOpenAICompatProvider`: strips the marker (OpenAI / DeepSeek
 *   auto prefix-cache; Kimi/Zhipu/通义 self-cache via separate cache_id
 *   endpoint deferred to v0.7.45+).
 * - `KodaXAcpProvider` (CLI bridge): strips the marker (CLI bridge does
 *   not touch wire; avoids leaking marker into subprocess input).
 *
 * Place at the suffix of any stable prefix (system prompt, tools array,
 * role prompt). The marker is purely client-side: it MUST be removed
 * before the request is sent over the wire.
 */
export interface KodaXCacheBoundary {
  type: 'cache-boundary';
  /** Optional hint identifying which logical region this boundary terminates. Diagnostic only. */
  hint?: 'system' | 'tools' | 'role-prompt';
}

export type KodaXContentBlock =
    | KodaXTextBlock
    | KodaXToolUseBlock
    | KodaXToolResultBlock
    | KodaXImageBlock
    | KodaXThinkingBlock
    | KodaXRedactedThinkingBlock
    | KodaXCacheBoundary;

// ============== 消息类型 ==============

export interface KodaXMessage {
  role: 'user' | 'assistant' | 'system';
  content: string | KodaXContentBlock[];
  /** Marks messages injected by the system (auto-continue, retry prompts). Hidden in REPL display. */
  _synthetic?: boolean;
}

// ============== 流式结果类型 ==============

export interface KodaXTokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  thoughtTokens?: number;
}

export interface KodaXStreamResult {
  textBlocks: KodaXTextBlock[];
  toolBlocks: KodaXToolUseBlock[];
  thinkingBlocks: (KodaXThinkingBlock | KodaXRedactedThinkingBlock)[];
  usage?: KodaXTokenUsage;
  /** Provider stop reason: 'end_turn' (normal), 'max_tokens' (truncated), 'stop_sequence', 'tool_use', etc. */
  stopReason?: string;
}

// ============== 工具定义 ==============

export interface KodaXToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

// ============== 推理策略类型 ==============

export type KodaXReasoningCapability =
  | 'native-effort'
  | 'native-budget'
  | 'native-toggle'
  | 'none'
  | 'prompt-only'
  | 'unknown';

export type KodaXProviderTransport = 'native-api' | 'cli-bridge';

export type KodaXProviderConversationSemantics =
  | 'full-history'
  | 'last-user-message';

export type KodaXProviderMcpSupport = 'native' | 'none';

export type KodaXProviderContextFidelity = 'full' | 'partial' | 'lossy';

export type KodaXProviderToolCallingFidelity = 'full' | 'limited' | 'none';

export type KodaXProviderSessionSupport = 'full' | 'limited' | 'stateless';

export type KodaXProviderLongRunningSupport = 'full' | 'limited' | 'none';

export type KodaXProviderMultimodalSupport = 'none' | 'image-input' | 'full';

export type KodaXProviderEvidenceSupport = 'full' | 'limited' | 'none';

export interface KodaXProviderCapabilityProfile {
  transport: KodaXProviderTransport;
  conversationSemantics: KodaXProviderConversationSemantics;
  mcpSupport: KodaXProviderMcpSupport;
  contextFidelity?: KodaXProviderContextFidelity;
  toolCallingFidelity?: KodaXProviderToolCallingFidelity;
  sessionSupport?: KodaXProviderSessionSupport;
  longRunningSupport?: KodaXProviderLongRunningSupport;
  multimodalSupport?: KodaXProviderMultimodalSupport;
  evidenceSupport?: KodaXProviderEvidenceSupport;
}

export type KodaXReasoningOverride =
  | 'budget'
  | 'effort'
  | 'toggle'
  | 'none';

export type KodaXReasoningMode =
  | 'off'
  | 'auto'
  | 'quick'
  | 'balanced'
  | 'deep';

export type KodaXThinkingDepth =
  | 'off'
  | 'low'
  | 'medium'
  | 'high';

export type KodaXTaskType =
  | 'conversation'
  | 'lookup'
  | 'review'
  | 'bugfix'
  | 'edit'
  | 'refactor'
  | 'plan'
  | 'qa'
  | 'unknown';

export type KodaXExecutionMode =
  | 'conversation'
  | 'lookup'
  | 'pr-review'
  | 'strict-audit'
  | 'implementation'
  | 'planning'
  | 'investigation';

export type KodaXRiskLevel = 'low' | 'medium' | 'high';

export type KodaXTaskComplexity =
  | 'simple'
  | 'moderate'
  | 'complex'
  | 'systemic';

export type KodaXTaskWorkIntent = 'append' | 'overwrite' | 'new';

export type KodaXTaskFamily =
  | 'conversation'
  | 'lookup'
  | 'review'
  | 'implementation'
  | 'investigation'
  | 'planning'
  | 'ambiguous';

export type KodaXTaskActionability =
  | 'non_actionable'
  | 'actionable'
  | 'ambiguous';

export type KodaXExecutionPattern =
  | 'direct'
  | 'checked-direct'
  | 'coordinated';

export type KodaXMutationSurface =
  | 'read-only'
  | 'docs-only'
  | 'code'
  | 'system';

export type KodaXAssuranceIntent =
  | 'default'
  | 'explicit-check';

export type KodaXHarnessProfile =
  | 'H0_DIRECT'
  | 'H1_EXECUTE_EVAL'
  | 'H2_PLAN_EXECUTE_EVAL'
  // FEATURE_114 v0.7.36: PLANNED is the V2 harness profile that
  // collapses Scout / Planner / Generator into a single Worker. The
  // legacy three profiles stay live during the migration window
  // (KODAX_HARNESS_V2 default off until v0.7.40). PLANNED runs preserve
  // the Evaluator structural gate.
  | 'PLANNED';

export type KodaXReviewScale =
  | 'small'
  | 'large'
  | 'massive';

export type KodaXAmaProfile = 'tactical' | 'managed';

export type KodaXAmaTactic =
  | 'direct'
  | 'child-fanout'
  | 'planning-pass'
  | 'verification-pass'
  | 'repair-loop';

export type KodaXAmaFanoutClass =
  | 'finding-validation'
  | 'evidence-scan'
  | 'module-triage'
  | 'hypothesis-check';

export interface KodaXAmaFanoutPolicy {
  admissible: boolean;
  class?: KodaXAmaFanoutClass;
  reason: string;
  maxChildren?: number;
  requiresReadOnly?: boolean;
}

export interface KodaXAmaControllerDecision {
  profile: KodaXAmaProfile;
  tactics: KodaXAmaTactic[];
  fanout: KodaXAmaFanoutPolicy;
  reason: string;
  upgradeTriggers: string[];
}

export interface KodaXTaskRoutingDecision {
  primaryTask: KodaXTaskType;
  secondaryTask?: KodaXTaskType;
  taskFamily?: KodaXTaskFamily;
  actionability?: KodaXTaskActionability;
  executionPattern?: KodaXExecutionPattern;
  mutationSurface?: KodaXMutationSurface;
  assuranceIntent?: KodaXAssuranceIntent;
  confidence: number;
  riskLevel: KodaXRiskLevel;
  recommendedMode: KodaXExecutionMode;
  recommendedThinkingDepth: KodaXThinkingDepth;
  complexity: KodaXTaskComplexity;
  workIntent: KodaXTaskWorkIntent;
  requiresBrainstorm: boolean;
  harnessProfile: KodaXHarnessProfile;
  topologyCeiling?: KodaXHarnessProfile;
  upgradeCeiling?: KodaXHarnessProfile;
  reviewScale?: KodaXReviewScale;
  reviewTarget?: 'general' | 'current-worktree' | 'compare-range';
  soloBoundaryConfidence?: number;
  needsIndependentQA?: boolean;
  routingSource?: 'model' | 'fallback' | 'retried-model' | 'retried-fallback';
  routingAttempts?: number;
  routingNotes?: string[];
  reason: string;
}

export interface KodaXThinkingBudgetMap {
  low: number;
  medium: number;
  high: number;
}

export type KodaXTaskBudgetOverrides = Partial<
  Record<KodaXTaskType, Partial<KodaXThinkingBudgetMap>>
>;

export interface KodaXReasoningRequest {
  enabled?: boolean;
  mode?: KodaXReasoningMode;
  depth?: KodaXThinkingDepth;
  taskType?: KodaXTaskType;
  executionMode?: KodaXExecutionMode;
}

// ============== Provider 配置 ==============

export interface KodaXModelDescriptor {
  id: string;
  displayName?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  thinkingBudgetCap?: number;
  reasoningCapability?: KodaXReasoningCapability;
  /**
   * Per-model override for `replayReasoningContent`. Falls through to the
   * provider-level flag when undefined. Lets a single gateway endpoint
   * route models that need the flag (DeepSeek V4) alongside models that
   * would 400 if the flag were on (OpenAI proper).
   */
  replayReasoningContent?: boolean;
  /**
   * Per-model override for `strictThinkingSignature`. Falls through to
   * the provider-level flag when undefined.
   */
  strictThinkingSignature?: boolean;
  /**
   * Per-model override for `streamMaxDurationMs`. Falls through to the
   * provider-level cap when undefined; undefined at both levels disables
   * the watchdog.
   */
  streamMaxDurationMs?: number;
}

export type KodaXProtocolFamily = 'anthropic' | 'openai';
export type KodaXProviderUserAgentMode = 'compat' | 'sdk';

/**
 * FEATURE_216 v0.7.45 — Strategy KodaX uses to verify a provider's API
 * credentials. Per-provider data-driven (set in `provider-capabilities.json`)
 * because the 14 providers KodaX ships do not share a single zero-token
 * verify primitive — empirically 3 distinct strategies are needed:
 *
 *   - `count-tokens`: Anthropic-protocol `messages.countTokens()` —
 *     true 0-token (input_tokens reported but no model invocation).
 *     Use for Anthropic-compat providers whose upstream implements
 *     `/v1/messages/count_tokens`.
 *   - `models-list`: `models.list()` — 0-token, authenticated GET.
 *     Use ONLY when the provider's `/v1/models` endpoint actually
 *     gates on auth (some compat layers expose it publicly → false
 *     positives; others 401 even for valid keys → false negatives).
 *   - `minimal-message`: `{messages,chat.completions}.create({max_tokens:1})`
 *     — ~6-7 tokens / call. Universal fallback for providers where
 *     the above two are unreliable. Cost is trivial for UI-button
 *     "test connection" use cases (≈ $0.00001 per verify).
 *   - `unsupported`: Provider has no verify primitive (CLI bridges
 *     own credentials in their own subprocess token store; the SDK
 *     does not enter that surface).
 */
export type KodaXVerifyStrategy =
  | 'count-tokens'
  | 'models-list'
  | 'minimal-message'
  | 'unsupported';

/**
 * FEATURE_216 v0.7.45 — Never-throws result envelope for
 * `provider.verifyCredential()` / `verifyProviderCredential(name)`.
 * Mirrors `side-query.ts` `SideQueryResult` pattern: every failure
 * mode is captured in the returned object — no rejection, no throw.
 */
export interface KodaXVerifyCredentialResult {
  readonly ok: boolean;
  /** HTTP status when applicable (verify primitives that hit the wire). */
  readonly status?: number;
  /**
   * Error category. Stable for UI consumers to map to user-facing
   * states ("invalid key", "no network", "provider doesn't support
   * verification", etc.). `unconfigured` is set by the top-level
   * helper when env var is missing — avoids the provider ctor throw
   * (per FEATURE_198 model-capabilities exposure pattern).
   */
  readonly error?:
    | 'unauthorized'
    | 'network'
    | 'timeout'
    | 'unsupported'
    | 'unconfigured'
    | 'server_error'
    | 'rate_limited'
    | 'unknown';
  /** Upstream error body or short diagnostic, capped to 240 chars. */
  readonly message?: string;
  readonly durationMs: number;
  /** Estimated token cost: 0 (count-tokens / models-list) or ~6-7 (minimal-message). */
  readonly approxTokensSpent: number;
  /** Which strategy ran (or 'unsupported' if no primitive was attempted). */
  readonly strategy: KodaXVerifyStrategy;
}

/**
 * FEATURE_216 v0.7.45 — Best-effort upstream model listing. Distinct from
 * credential verification: this is for "model picker" UIs. Mixes upstream
 * `/v1/models` data with static `provider-capabilities.json` fallback when
 * the upstream endpoint is unreliable. NOT a cred test — for that, call
 * `verifyProviderCredential()`.
 */
export interface KodaXListModelsResult {
  readonly ok: boolean;
  readonly source: 'upstream' | 'static' | 'failed';
  readonly models?: readonly string[];
  readonly error?: string;
  readonly durationMs: number;
}

export interface KodaXCustomProviderConfig {
  name: string;
  protocol: KodaXProtocolFamily;
  baseUrl: string;
  apiKeyEnv: string;
  model: string;
  /**
   * Additional available models beyond the default. Accepts either a
   * plain model id string (legacy) or a KodaXModelDescriptor object
   * (FEATURE_098) carrying per-model `contextWindow` / `maxOutputTokens`
   * / `thinkingBudgetCap` / `reasoningCapability` overrides.
   */
  models?: Array<string | KodaXModelDescriptor>;
  /**
   * Controls which User-Agent header compatibility providers send.
   * - compat: send "KodaX" for gateways that block the official SDK UA
   * - sdk: keep the upstream SDK default User-Agent
   */
  userAgentMode?: KodaXProviderUserAgentMode;
  supportsThinking?: boolean;
  reasoningCapability?: KodaXReasoningCapability;
  capabilityProfile?: KodaXProviderCapabilityProfile;
  contextWindow?: number;
  maxOutputTokens?: number;
  thinkingBudgetCap?: number;
  /**
   * Provider-level default for OpenAI-compat `reasoning_content` echo.
   * Required by DeepSeek V4 thinking mode (replay 400s without it).
   * Defaults to false — must stay false for OpenAI proper or any gateway
   * that rejects unknown fields. Per-model values in `models[]` can
   * override on a model-by-model basis.
   */
  replayReasoningContent?: boolean;
  /**
   * Provider-level default for strict Anthropic thinking-signature
   * verification. Only Anthropic proper cryptographically verifies
   * signatures — third-party Anthropic-compat gateways must keep this
   * false (default). Per-model values in `models[]` can override.
   */
  strictThinkingSignature?: boolean;
  /**
   * Provider-level default streaming wall-clock cap (ms). Set just below
   * a known server-side kill window (zhipu-coding 308s → 300_000). Leave
   * unset to disable the watchdog. Per-model values in `models[]` can
   * override.
   */
  streamMaxDurationMs?: number;
  /**
   * FEATURE_216 v0.7.45 — Which verify primitive this provider supports.
   * Optional: when unset, the SDK derives a default from `protocol`
   * (anthropic → count-tokens / openai → models-list). Set explicitly when
   * the upstream `/v1/models` is public (false-positive risk) or the
   * `messages.count_tokens` endpoint is unimplemented (404), in which
   * case `minimal-message` is the only safe fallback.
   */
  verifyStrategy?: KodaXVerifyStrategy;
}

export interface KodaXProviderConfig {
  apiKeyEnv: string;
  baseUrl?: string;
  model: string;
  /** Additional available models beyond the default */
  models?: readonly KodaXModelDescriptor[];
  /** Compatibility providers may override the SDK User-Agent when needed. */
  userAgentMode?: KodaXProviderUserAgentMode;
  supportsThinking: boolean;
  reasoningCapability?: KodaXReasoningCapability;
  capabilityProfile?: KodaXProviderCapabilityProfile;
  /** 模型的上下文窗口大小 (tokens) */
  contextWindow?: number;
  /** Provider 允许的最大输出 token */
  maxOutputTokens?: number;
  /** Provider thinking budget 上限 */
  thinkingBudgetCap?: number;
  /** Provider 默认 thinking budget 映射 */
  defaultThinkingBudgets?: Partial<KodaXThinkingBudgetMap>;
  /** 按任务类型覆盖默认 budget */
  taskBudgetOverrides?: KodaXTaskBudgetOverrides;
  /**
   * Echo the prior turn's `reasoning_content` back on replayed assistant
   * messages. Required by DeepSeek V4 thinking mode (replay 400s without it).
   * Other Chinese OpenAI-compat thinking providers use the same field, but
   * each needs per-provider verification before opting in. Must stay false
   * for OpenAI proper.
   */
  replayReasoningContent?: boolean;
  /**
   * Strictly verify Anthropic-style `signature` on `thinking` blocks at
   * serialise time. Only Anthropic proper (anthropic.com) cryptographically
   * verifies signatures — third-party Anthropic-compat servers (kimi-code /
   * ark-coding / mimo-coding / zhipu-coding / minimax-coding) lack the
   * signing key and accept any signature.
   *
   * When true, thinking blocks with empty/cross-provider signatures get
   * converted to a `<prior_reasoning>` text block instead of being passed
   * through (which would 400 on signature verification). Cross-provider
   * `redacted_thinking` blocks (ciphertext signed by their origin) are
   * dropped silently — there's no plaintext to recover and forging the
   * field would also fail server-side decryption.
   *
   * When false (default), thinking blocks pass through unchanged — matches
   * legacy behaviour and works for all third-party Anthropic-compat
   * providers. v0.7.28.
   */
  strictThinkingSignature?: boolean;
  /**
   * Hard cap on a single streaming request's wall-clock duration (ms).
   * When exceeded, the resilience layer aborts the stream with a
   * StreamIncompleteError, which routes through the existing
   * `non_streaming_fallback` path. Mirrors Claude Code's idle watchdog
   * pattern but uses request duration (not idle time) because some
   * providers emit keepalive pings during long tool_use generation.
   *
   * Set per-provider just below the known server-side kill window
   * (e.g. zhipu-coding observed 308s → set 300s here, accounting for
   * the ~RTT margin between client send and server kill timestamp).
   */
  streamMaxDurationMs?: number;
  /**
   * FEATURE_216 v0.7.45 — Which verify primitive this provider's compat
   * base class uses for `verifyCredential()`. Sourced from
   * `provider-capabilities.json` for built-in providers; for custom
   * providers, falls back to a protocol-derived default
   * (anthropic → count-tokens / openai → models-list) when the custom
   * config does not set it explicitly.
   */
  verifyStrategy?: KodaXVerifyStrategy;
}

export interface KodaXProviderStreamOptions {
  onTextDelta?: (text: string) => void;
  onThinkingDelta?: (text: string) => void;
  onThinkingEnd?: (thinking: string) => void;
  onToolInputDelta?: (
    toolName: string,
    partialJson: string,
    meta?: { toolId?: string },
  ) => void;
  /**
   * Fired on provider-side SSE events to manage idle timers.
   *
   * - Called with no argument (or `false`): reset the idle timer.
   *   Fired on every event that indicates active data flow
   *   (content_block_start, content_block_delta, message_delta, etc.).
   *
   * - Called with `true`: **pause** the idle timer (clear without restart).
   *   Fired on `content_block_stop` when the stream has NOT yet ended,
   *   because the server may go silent while generating the next block
   *   (e.g. between text output and tool_use JSON generation).
   *   The hard request timeout still guards against genuinely stuck connections.
   */
  onHeartbeat?: (pause?: boolean) => void;
  /** 当底层 API 遇到 Rate Limit 进行重试时触发 */
  onRateLimit?: (attempt: number, maxRetries: number, delayMs: number) => void;
  /**
   * FEATURE_130 (v0.7.36): structured retry-after callback. Carries the
   * parsed source (`retry-after-seconds` / `retry-after-date` /
   * `retry-after-ms` / `exponential-backoff`) so UI surfaces and the
   * cost tracker can distinguish "provider-told us to wait" from
   * "we're guessing with backoff". Coexists with the legacy
   * `onRateLimit` flat callback above — both fire if both are wired.
   */
  onRetryAfter?: (event: {
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
  }) => void;
  /** 会话标识，用于多轮对话上下文恢复 */
  sessionId?: string;
  /** Override the provider's default model for a single request */
  modelOverride?: string;
  /** AbortSignal for cancelling the stream request */
  signal?: AbortSignal;
}
