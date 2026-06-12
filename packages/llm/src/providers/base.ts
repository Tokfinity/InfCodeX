/**
 * KodaX Base Provider
 *
 * Provider 抽象基类 - 所有 Provider 的公共基础
 */

import {
  KodaXProviderConfig,
  KodaXModelDescriptor,
  KodaXMessage,
  KodaXToolDefinition,
  KodaXProviderStreamOptions,
  KodaXProviderCapabilityProfile,
  KodaXReasoningCapability,
  KodaXReasoningOverride,
  KodaXReasoningRequest,
  KodaXStreamResult,
  KodaXVerifyCredentialResult,
} from '../types.js';
import { KodaXError, KodaXRateLimitError, KodaXProviderError } from '../errors.js';
import { parseRetryAfter, extractHeadersFromError } from '../retry/retry-after.js';
import type { RetryAfterSource } from '../retry/retry-after.js';
import { KODAX_MAX_TOKENS } from '../constants.js';
import {
  cloneCapabilityProfile,
  NATIVE_PROVIDER_CAPABILITY_PROFILE,
} from './capability-profile.js';
import {
  getReasoningCapability,
  normalizeReasoningRequest,
} from '../reasoning.js';
import {
  buildReasoningOverrideKey,
  loadReasoningOverride,
  reasoningCapabilityToOverride,
  reasoningOverrideToCapability,
  saveReasoningOverride,
} from '../reasoning-overrides.js';

function parseEnvInt(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function abortError(): DOMException {
  return new DOMException('Request aborted', 'AbortError');
}

function waitForRetryDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (delayMs <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      if (timeout) clearTimeout(timeout);
      cleanup();
      reject(abortError());
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);
  });
}

/**
 * FEATURE_130 (v0.7.36): structured payload fired through
 * `KodaXEvents.onRetryAfter` whenever a provider's `withRateLimit`
 * loop catches a 429 / 503 / 529 response and decides to wait. The
 * `source` field carries which retry-after header form (or fallback)
 * produced the wait duration so UI surfaces can show "provider asked
 * us to wait 45s" vs "no header, exp-backoff guess of 4s".
 */
export interface KodaXRetryAfterEvent {
  readonly provider: string;
  readonly waitMs: number;
  readonly reason: 'rate-limit' | 'overloaded';
  readonly source: RetryAfterSource;
  readonly attempt: number;
  readonly maxAttempts: number;
}

export type KodaXOnRetryAfterCallback = (event: KodaXRetryAfterEvent) => void;

export abstract class KodaXBaseProvider {
  abstract readonly name: string;
  abstract readonly supportsThinking: boolean;
  protected abstract readonly config: KodaXProviderConfig;

  /**
   * Per-request override for `max_tokens` in the next provider call. Consumed
   * once and cleared in `withRateLimit` after the next successful response.
   * Two callers set this:
   *   1. Context-overflow recovery inside `withRateLimit` (reduces budget
   *      when the model reports "prompt too long").
   *   2. The agent loop's max_tokens escalation path, which flips this to
   *      `KODAX_ESCALATED_MAX_OUTPUT_TOKENS` when a capped-budget turn
   *      returns `stop_reason: max_tokens`. See `coding/src/agent.ts`.
   */
  protected maxOutputTokensOverride?: number;

  /**
   * Public setter for the one-shot override above. Callers outside the
   * provider package (notably the agent loop's escalation branch) use this
   * to stage a larger budget for the next stream call in the same logical
   * turn. Pass `undefined` to clear a stale override explicitly.
   */
  public setMaxOutputTokensOverride(value: number | undefined): void {
    this.maxOutputTokensOverride = value;
  }

  /**
   * Returns the max_tokens value the provider will currently use on its
   * next request. Precedence (highest to lowest):
   *   1. One-shot override (agent escalation, context-overflow recovery)
   *   2. User env var `KODAX_MAX_OUTPUT_TOKENS` (explicit user intent)
   *   3. Active model descriptor's `maxOutputTokens` (FEATURE_098)
   *   4. Provider config default
   *   5. Global `KODAX_MAX_TOKENS` fallback
   * Used by provider stream() paths and by the agent loop to decide
   * whether escalation is applicable (see `coding/src/agent.ts`).
   */
  public getEffectiveMaxOutputTokens(model?: string): number {
    if (this.maxOutputTokensOverride !== undefined) {
      return this.maxOutputTokensOverride;
    }
    const envOverride = parseEnvInt(process.env.KODAX_MAX_OUTPUT_TOKENS);
    if (envOverride !== undefined) {
      return envOverride;
    }
    const descriptorMax = this.getModelDescriptor(model)?.maxOutputTokens;
    if (descriptorMax !== undefined) {
      return descriptorMax;
    }
    return this.config.maxOutputTokens ?? KODAX_MAX_TOKENS;
  }

  /**
   * Hard cap on a single streaming request's wall-clock duration (ms).
   * Returns undefined when no cap is configured. Consumed by the
   * resilience layer to abort a doomed stream before the server-side
   * kill window fires; routed through `non_streaming_fallback`.
   *
   * Cascade (highest to lowest):
   *   1. Active model descriptor's `streamMaxDurationMs`
   *   2. Provider config default
   *   3. undefined (watchdog disabled)
   */
  public getStreamMaxDurationMs(model?: string): number | undefined {
    const descriptorValue = this.getModelDescriptor(model)?.streamMaxDurationMs;
    if (descriptorValue !== undefined) {
      return descriptorValue;
    }
    return this.config.streamMaxDurationMs;
  }

  /**
   * Resolves whether OpenAI-compat `reasoning_content` should echo back
   * on replayed assistant messages for the given model. Same cascade as
   * `getStreamMaxDurationMs`. Defaults to false when neither layer sets it.
   */
  public getEffectiveReplayReasoningContent(model?: string): boolean {
    const descriptorValue = this.getModelDescriptor(model)?.replayReasoningContent;
    if (descriptorValue !== undefined) {
      return descriptorValue;
    }
    return this.config.replayReasoningContent ?? false;
  }

  /**
   * Resolves whether Anthropic-style thinking signatures must verify
   * strictly (Anthropic proper only). Same cascade as
   * `getStreamMaxDurationMs`. Defaults to false (lenient) when neither
   * layer sets it — matches third-party Anthropic-compat behavior.
   */
  public getEffectiveStrictThinkingSignature(model?: string): boolean {
    const descriptorValue = this.getModelDescriptor(model)?.strictThinkingSignature;
    if (descriptorValue !== undefined) {
      return descriptorValue;
    }
    return this.config.strictThinkingSignature ?? false;
  }

  abstract stream(
    messages: KodaXMessage[],
    tools: KodaXToolDefinition[],
    system: string,
    reasoning?: boolean | KodaXReasoningRequest,
    streamOptions?: KodaXProviderStreamOptions,
    signal?: AbortSignal
  ): Promise<KodaXStreamResult>;

  supportsNonStreamingFallback(): boolean {
    return false;
  }

  async complete(
    _messages: KodaXMessage[],
    _tools: KodaXToolDefinition[],
    _system: string,
    _reasoning?: boolean | KodaXReasoningRequest,
    _streamOptions?: KodaXProviderStreamOptions,
    _signal?: AbortSignal,
  ): Promise<KodaXStreamResult> {
    throw new KodaXProviderError(`${this.name} does not support non-streaming fallback`);
  }

  isConfigured(): boolean {
    return !!process.env[this.config.apiKeyEnv];
  }

  /**
   * FEATURE_216 v0.7.45 — Lightweight credential verification. Returns
   * a never-throws envelope with `ok` + categorized `error`. Concrete
   * compat base classes (`KodaXAnthropicCompatProvider`,
   * `KodaXOpenAICompatProvider`) override this to dispatch by the
   * `verifyStrategy` field. The default here returns `unsupported` so
   * Provider classes that don't extend a compat base — or future ones
   * yet to be wired — fail safely instead of throwing.
   *
   * Distinct from `isConfigured()`: that one is env-only (no network);
   * this one hits the wire (zero or ~7 tokens depending on strategy)
   * and verifies the key is actually accepted by the upstream.
   */
  async verifyCredential(_opts?: {
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<KodaXVerifyCredentialResult> {
    return {
      ok: false,
      error: 'unsupported',
      strategy: this.config.verifyStrategy ?? 'unsupported',
      durationMs: 0,
      approxTokensSpent: 0,
      message: `Provider class "${this.name}" does not implement verifyCredential()`,
    };
  }

  getModel(): string {
    return this.config.model;
  }

  getAvailableModels(): string[] {
    if (!this.config.models?.length) return [this.config.model];
    return [...new Set([this.config.model, ...this.config.models.map(m => m.id)])];
  }

  getModelDescriptor(modelId?: string): KodaXModelDescriptor | undefined {
    if (!modelId || modelId === this.config.model) {
      return { id: this.config.model };
    }
    return this.config.models?.find(m => m.id === modelId);
  }

  getBaseUrl(): string | undefined {
    return this.config.baseUrl;
  }

  getApiKeyEnv(): string {
    return this.config.apiKeyEnv;
  }

  getCapabilityProfile(): KodaXProviderCapabilityProfile {
    return cloneCapabilityProfile(
      this.config.capabilityProfile ?? NATIVE_PROVIDER_CAPABILITY_PROFILE,
    );
  }

  getConfiguredReasoningCapability(modelOverride?: string): KodaXReasoningCapability {
    const descriptor = this.getModelDescriptor(modelOverride);
    if (descriptor?.reasoningCapability) {
      return descriptor.reasoningCapability;
    }
    return getReasoningCapability(this.config);
  }

  getReasoningCapability(modelOverride?: string): KodaXReasoningCapability {
    const override = loadReasoningOverride(this.name, this.config, modelOverride);
    return override
      ? reasoningOverrideToCapability(override)
      : this.getConfiguredReasoningCapability(modelOverride);
  }

  getReasoningOverride(modelOverride?: string): KodaXReasoningOverride | undefined {
    return loadReasoningOverride(this.name, this.config, modelOverride);
  }

  getReasoningOverrideKey(modelOverride?: string): string {
    return buildReasoningOverrideKey(this.name, this.config, modelOverride);
  }

  protected persistReasoningCapabilityOverride(
    capability: KodaXReasoningCapability,
    modelOverride?: string,
  ): void {
    const override = reasoningCapabilityToOverride(capability);
    if (!override) {
      return;
    }
    saveReasoningOverride(this.name, this.config, override, modelOverride);
  }

  protected shouldFallbackForReasoningError(
    error: unknown,
    ...terms: string[]
  ): boolean {
    const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    const normalizedTerms = terms.map(term => term.toLowerCase());
    const matchesSpecificTerm = normalizedTerms.some((term) => message.includes(term));
    const mentionsParameter =
      message.includes('parameter') ||
      matchesSpecificTerm;

    return (
      message.includes('unknown parameter') ||
      message.includes('invalid parameter') ||
      (message.includes('unsupported') && mentionsParameter)
    );
  }

  protected shouldFallbackForSpecificReasoningError(
    error: unknown,
    ...terms: string[]
  ): boolean {
    const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    const normalizedTerms = terms.map(term => term.toLowerCase());
    const matchesSpecificTerm = normalizedTerms.some((term) => message.includes(term));

    if (!matchesSpecificTerm) {
      return false;
    }

    return (
      message.includes('unknown parameter') ||
      message.includes('invalid parameter') ||
      message.includes('unsupported')
    );
  }

  protected shouldFallbackForForcedToolChoiceError(error: unknown): boolean {
    const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    const mentionsToolChoice =
      message.includes('tool_choice') ||
      message.includes('tool choice') ||
      message.includes('toolchoice');

    if (!mentionsToolChoice) {
      return false;
    }

    return (
      message.includes('unknown parameter') ||
      message.includes('invalid parameter') ||
      message.includes('unsupported')
    );
  }

  protected getReasoningFallbackChain(
    capability: KodaXReasoningCapability,
  ): KodaXReasoningCapability[] {
    switch (capability) {
      case 'native-budget':
        return ['native-budget', 'native-toggle', 'none'];
      case 'native-effort':
        return ['native-effort', 'none'];
      case 'native-toggle':
        return ['native-toggle', 'none'];
      case 'none':
      case 'prompt-only':
      case 'unknown':
      default:
        return ['none'];
    }
  }

  /**
   * 获取模型的上下文窗口大小
   *
   * Backwards-compatible no-arg form: resolves against the provider's
   * default model descriptor. New call sites that know the active
   * model should use `getEffectiveContextWindow(model)` directly.
   * @returns 上下文窗口大小 (tokens)
   */
  getContextWindow(): number {
    return this.getEffectiveContextWindow();
  }

  /**
   * Resolves the context window for a specific model.
   * Precedence (highest to lowest):
   *   1. Active model descriptor's `contextWindow` (FEATURE_098)
   *   2. Provider config default
   *   3. 200_000 fallback
   * The user-level `compaction.contextWindow` is layered on top of
   * this at the call site, so it remains the highest-priority manual
   * override.
   */
  getEffectiveContextWindow(model?: string): number {
    const descriptorWindow = this.getModelDescriptor(model)?.contextWindow;
    if (descriptorWindow !== undefined) {
      return descriptorWindow;
    }
    return this.config.contextWindow ?? 200_000;
  }

  protected getApiKey(): string {
    const key = process.env[this.config.apiKeyEnv];
    if (!key) throw new Error(`${this.config.apiKeyEnv} not set`);
    return key;
  }

  protected shouldLogStreamDiagnostics(): boolean {
    return Boolean(process.env.KODAX_DEBUG_STREAM);
  }

  protected logStreamDiagnostic(...args: unknown[]): void {
    if (this.shouldLogStreamDiagnostics()) {
      console.error(...args);
    }
  }

  protected normalizeReasoning(
    reasoning?: boolean | KodaXReasoningRequest,
  ): Required<KodaXReasoningRequest> {
    return normalizeReasoningRequest(reasoning);
  }

  /**
   * Called when ECONNRESET/EPIPE is detected, indicating a stale keep-alive
   * socket.  Subclasses should override to rebuild their HTTP client with a
   * fresh connection pool so the next retry uses a new TCP connection.
   */
  protected onStaleConnection(): void {
    // Base implementation is a no-op; subclasses override when they hold
    // a pooled HTTP client (e.g. Anthropic SDK, OpenAI SDK).
  }

  protected isRateLimitError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const s = error.message.toLowerCase();
    // FEATURE_130 (v0.7.36): include 'overload' / '503' / '529' keywords so
    // server-overloaded responses also enter the retry path. Overload is
    // labeled as `reason="overloaded"` by classifyRateLimitReason — both
    // conditions flow through the same withRateLimit loop.
    return [
      'rate', 'limit', '速率', '频率', '1302', '429', 'too many',
      'overload', 'overwhelmed', '503', '529', 'busy',
    ].some(k => s.includes(k));
  }

  /**
   * FEATURE_130: classify a rate-limit error as either a 429-style
   * "rate-limit" or a 503/529-style "overloaded" condition. The
   * distinction matters for UI: "rate-limit" usually surfaces a
   * provider-supplied retry-after window; "overloaded" tends to fall
   * through to exponential backoff with no header. Both flow through
   * the same retry path; this only labels the event.
   */
  protected classifyRateLimitReason(error: unknown): 'rate-limit' | 'overloaded' {
    const s = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    if (
      s.includes('overload')
      || s.includes('overwhelmed')
      || s.includes('503')
      || s.includes('529')
      || s.includes('busy')
    ) {
      return 'overloaded';
    }
    return 'rate-limit';
  }

  /**
   * Extract Retry-After delay from error headers (429/529 responses).
   * Returns milliseconds, or undefined when no usable header is present.
   *
   * FEATURE_130 (v0.7.36): now delegates to the shared `parseRetryAfter`
   * helper so all 12 provider adapters get 4-form coverage without each
   * adapter rolling its own parser. The 4 forms supported are:
   *   - `Retry-After: <integer-seconds>`
   *   - `Retry-After: <HTTP-date>`
   *   - `retry-after-ms: <milliseconds>` (Anthropic extension)
   *   - exponential-backoff fallback (returned via `withRateLimit`,
   *     not through this helper — it is `undefined` here when no
   *     header is present, which the caller then resolves to backoff)
   */
  protected extractRetryAfterMs(error: unknown): number | undefined {
    const headers = extractHeadersFromError(error);
    if (!headers) return undefined;
    // Use a fixed attempt of 0 so the helper only returns a header
    // result; the backoff path is composed by the caller below.
    const result = parseRetryAfter(headers, { attempt: 0, withJitter: false });
    return result.type === 'header' ? result.waitMs : undefined;
  }

  /**
   * Detect "prompt too long / context window exceeded" errors and compute
   * a reduced max_tokens for retry.  Returns undefined if not a context
   * overflow error.
   */
  protected parseContextOverflow(error: unknown): number | undefined {
    const msg = String((error as any)?.message ?? '');
    // Anthropic: "prompt is too long: 180000 tokens > 200000 maximum"
    // OpenAI:    "maximum context length is 128000 tokens. However, you requested 150000 tokens"
    // Zhipu/Kimi variants with Chinese messages
    const patterns = [
      /(\d[\d,]*)\s*tokens?.*?(\d[\d,]*)\s*(?:maximum|limit|context)/i,
      /maximum.*?(\d[\d,]*)\s*tokens?.*?requested.*?(\d[\d,]*)/i,
      /exceeds?\s+.*?(\d[\d,]*)\s*.*?(?:limit|max|上限).*?(\d[\d,]*)/i,
    ];
    for (const pat of patterns) {
      const m = msg.match(pat);
      if (m) {
        const a = Number(m[1]!.replace(/,/g, ''));
        const b = Number(m[2]!.replace(/,/g, ''));
        const inputTokens = Math.min(a, b);
        const contextLimit = Math.max(a, b);
        const safetyBuffer = 1000;
        const available = Math.max(3000, contextLimit - inputTokens - safetyBuffer);
        return available;
      }
    }
    return undefined;
  }

  protected isContextOverflowError(error: unknown): boolean {
    const msg = String((error as any)?.message ?? '').toLowerCase();
    return msg.includes('prompt is too long')
      || msg.includes('prompt too long')
      || msg.includes('context length')
      || msg.includes('context_length_exceeded')
      || msg.includes('context window')
      || msg.includes('上下文长度');
  }

  protected async withRateLimit<T>(
    fn: () => Promise<T>,
    signal?: AbortSignal,
    retries = 3,
    onRateLimit?: (attempt: number, maxRetries: number, delayMs: number) => void,
    onRetryAfter?: KodaXOnRetryAfterCallback,
  ): Promise<T> {
    for (let i = 0; i < retries; i++) {
      try {
        const result = await fn();
        this.maxOutputTokensOverride = undefined; // Clear on success
        return result;
      } catch (e) {
        // Context window overflow: compute reduced max_tokens and retry once
        if (this.isContextOverflowError(e) && !this.maxOutputTokensOverride) {
          const reduced = this.parseContextOverflow(e);
          if (reduced) {
            this.maxOutputTokensOverride = reduced;
            onRateLimit?.(i + 1, retries, 0);
            continue; // Retry immediately with reduced max_tokens
          }
        }

        if (this.isRateLimitError(e)) {
          // Last retry exhausted — throw
          if (i === retries - 1) {
            throw new KodaXRateLimitError(
              `API rate limit exceeded after ${retries} retries. Please wait and try again later.`,
              60000
            );
          }

          // FEATURE_130 (v0.7.36): centralized retry-after parsing through
          // `parseRetryAfter` — covers `Retry-After: <seconds>` /
          // `Retry-After: <HTTP-date>` / `retry-after-ms: <ms>` /
          // exponential-backoff fallback. The legacy 500*2^i backoff was
          // identical to base=500ms in the helper, so the wait math is
          // unchanged when there is no header present.
          const headers = extractHeadersFromError(e) ?? {};
          const retryDecision = parseRetryAfter(headers, {
            attempt: i,
            baseBackoffMs: 500,
            maxBackoffMs: 32_000,
            withJitter: true,
          });
          const delay = retryDecision.waitMs;
          const reason = this.classifyRateLimitReason(e);
          // Structured event for the FEATURE_130 UI countdown / cost
          // tracker. Fired BEFORE the sleep so the spinner can render
          // the wait duration in real time.
          onRetryAfter?.({
            provider: this.name,
            waitMs: delay,
            reason,
            source: retryDecision.source,
            attempt: i + 1,
            maxAttempts: retries,
          });
          if (onRateLimit) {
            onRateLimit(i + 1, retries, delay);
          } else if (!onRetryAfter) {
            // Only log to console when neither the legacy nor the
            // structured callback is wired — UI surfaces handle it
            // when at least one is set.
            console.log(`[Rate Limit] Retrying in ${delay / 1000}s (${i + 1}/${retries})...`);
          }

          if (signal?.aborted) {
            throw abortError();
          }

          await waitForRetryDelay(delay, signal);

          if (signal?.aborted) {
            throw abortError();
          }

          continue;
        }
        // Non-rate-limit errors
        if (e instanceof Error) {
          if ((e.name === 'AbortError' || e.name === 'APIUserAbortError') && signal?.aborted) {
            if (e.name === 'AbortError') {
              throw e;
            }
            throw new DOMException(e.message || 'Request aborted', 'AbortError');
          }

          // ECONNRESET / EPIPE: stale keep-alive socket.
          // Flag the provider so subclasses can rebuild the client with
          // a fresh connection pool on the next request.
          const errorCode = (e as any)?.cause?.code ?? (e as any)?.code ?? '';
          if (errorCode === 'ECONNRESET' || errorCode === 'EPIPE') {
            this.onStaleConnection();
          }

          throw new KodaXProviderError(
            `${this.name} API error: ${e.message}`,
            this.name
          );
        }
        throw e;
      }
    }
    throw new KodaXError('Unexpected end of withRateLimit');
  }
}
