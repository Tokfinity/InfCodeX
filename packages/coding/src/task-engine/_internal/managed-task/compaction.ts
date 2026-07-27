/** Capacity-driven semantic history compaction for Runner-managed tasks. */

import {
  buildFileContentMessages,
  buildPostCompactAttachments,
  ContextCapacityError,
  compact as intelligentCompact,
  DEFAULT_POST_COMPACT_CONFIG,
  emitKodaXDiagnostic,
  exceedsContextCapacity,
  injectPostCompactAttachments,
  needsCompaction,
  POST_COMPACT_TOKEN_BUDGET,
  resolveContextWindow,
  type AgentMessage,
  type CompactionConfig,
  type CompactionResult,
  type CompactionUpdate,
} from '@kodax-ai/agent';
import {
  resolvePromptCacheDisabled,
  type KodaXReasoningRequest,
  type KodaXToolDefinition,
} from '@kodax-ai/llm';

import { resolveProvider } from '../../../providers/index.js';
import { loadCompactionConfig } from '../../../compaction-config.js';
import {
  CODING_SUMMARY_PROMPT,
  CODING_UPDATE_SUMMARY_PROMPT,
} from '../../../agent-runtime/coding-compaction-prompts.js';
import type {
  KodaXContextTokenSnapshot,
  KodaXMessage,
  KodaXOptions,
} from '../../../types.js';
import { countTokens, estimateTokens } from '../../../tokenizer.js';
import { resolveContextTokenCount } from '../../../token-accounting.js';
import { estimateToolSchemaTokens } from '../../../agent-runtime/context-budget.js';
import { createCompactionPromptCacheObserver } from '../../../agent-runtime/prompt-cache-diagnostics.js';
import { derivePromptCacheAffinityKey } from '../../../agent-runtime/prompt-cache-affinity.js';

const COMPACT_CIRCUIT_BREAKER_LIMIT = 3;

export type RunnerCompactionHook = (
  transcript: readonly AgentMessage[],
) => Promise<readonly AgentMessage[] | undefined>;

export interface ContextTokenSnapshotRef {
  current: KodaXContextTokenSnapshot | undefined;
}

export interface BuildManagedTaskCompactionHookOptions {
  readonly resolvedContextCapacity?: Awaited<
    ReturnType<typeof resolveManagedTaskContextCapacity>
  >;
  readonly contextTokenSnapshotRef?: ContextTokenSnapshotRef;
  readonly activeToolDefinitions?: readonly KodaXToolDefinition[];
  /** Exact reasoning envelope used by the managed provider request. */
  readonly reasoning?: KodaXReasoningRequest;
  readonly onPostCompact?: () => void;
}

interface AttachedCompactionContext {
  readonly messages: KodaXMessage[];
  readonly postCompactAttachments?: readonly KodaXMessage[];
}

/** Shared provider/model/window resolution for compaction and result admission. */
export async function resolveManagedTaskContextCapacity(options: KodaXOptions) {
  const provider = resolveProvider(options.provider ?? 'anthropic');
  const activeModel = options.modelOverride ?? options.model;
  const providerWindow = provider.getEffectiveContextWindow?.(activeModel)
    ?? provider.getContextWindow();
  const compactionConfig: CompactionConfig = await loadCompactionConfig(
    providerWindow,
    options.compaction,
  );
  const contextWindow = resolveContextWindow(compactionConfig, provider, activeModel);
  return { provider, activeModel, compactionConfig, contextWindow };
}

async function attachManagedCompactionContext(
  result: CompactionResult,
  fixedOverheadTokens: number,
  contextWindow: number,
  reservedResponseTokens: number,
): Promise<AttachedCompactionContext> {
  if (!result.artifactLedger?.length) {
    return { messages: result.messages };
  }
  const freedTokens = Math.max(0, result.tokensBefore - result.tokensAfter);
  const attachments = buildPostCompactAttachments(result.artifactLedger, freedTokens);
  const attachmentBudget = Math.min(
    Math.floor(freedTokens * DEFAULT_POST_COMPACT_CONFIG.budgetRatio),
    POST_COMPACT_TOKEN_BUDGET,
  );
  const fileBudget = Math.max(0, attachmentBudget - attachments.totalTokens);
  const fileMessages = fileBudget > 0
    ? await buildFileContentMessages(result.artifactLedger, fileBudget)
    : [];
  const fullAttachments = {
    ...attachments,
    fileMessages,
    totalTokens: attachments.totalTokens + estimateTokens(fileMessages as KodaXMessage[]),
  };
  if (fullAttachments.totalTokens <= 0) {
    return { messages: result.messages };
  }
  const messages = injectPostCompactAttachments(result.messages, fullAttachments);
  if (exceedsContextCapacity({
    contextWindow,
    currentTokens: fixedOverheadTokens + estimateTokens(messages),
    reservedResponseTokens,
  })) {
    return { messages: result.messages };
  }
  return {
    messages,
    postCompactAttachments: [
      ...(fullAttachments.ledgerMessage ? [fullAttachments.ledgerMessage] : []),
      ...fullAttachments.fileMessages,
    ],
  };
}

function buildCompactionUpdate(
  result: CompactionResult,
  tokensAfter: number,
  preCompactionMessages: readonly KodaXMessage[],
  postCompactAttachments?: readonly KodaXMessage[],
): CompactionUpdate {
  return {
    preCompactionMessages,
    anchor: result.anchor
      ? { ...result.anchor, tokensAfter }
      : undefined,
    artifactLedger: result.artifactLedger,
    memorySeed: result.memorySeed,
    postCompactAttachments,
    report: result.report,
  };
}

function notifyPostCompact(callback: (() => void) | undefined): void {
  if (!callback) return;
  try {
    callback();
  } catch (error) {
    emitKodaXDiagnostic({
      source: 'coding:managed-compaction',
      level: 'warn',
      message: 'Post-compaction callback failed.',
      detail: error,
    });
  }
}

function updateSnapshot(
  ref: ContextTokenSnapshotRef | undefined,
  messages: KodaXMessage[],
  currentTokens: number,
): void {
  if (!ref) return;
  ref.current = {
    currentTokens,
    baselineEstimatedTokens: estimateTokens(messages),
    source: ref.current?.source ?? 'estimate',
    usage: ref.current?.usage,
  };
}

function initializeEnvelopeEstimate(
  ref: ContextTokenSnapshotRef | undefined,
  messages: KodaXMessage[],
  toolDefinitions: readonly KodaXToolDefinition[],
): KodaXContextTokenSnapshot | undefined {
  if (ref?.current) return ref.current;
  const baselineEstimatedTokens = estimateTokens(messages);
  let leadingSystemCount = 0;
  const systemParts: string[] = [];
  while (messages[leadingSystemCount]?.role === 'system') {
    const content = messages[leadingSystemCount]!.content;
    if (typeof content === 'string' && content.trim().length > 0) {
      systemParts.push(content);
    }
    leadingSystemCount += 1;
  }
  const toolSchemaTokens = toolDefinitions.reduce(
    (total, definition) => total + estimateToolSchemaTokens(definition),
    0,
  );
  const snapshot: KodaXContextTokenSnapshot = {
    currentTokens: estimateTokens(messages.slice(leadingSystemCount))
      + countTokens(systemParts.join('\n\n'))
      + toolSchemaTokens,
    baselineEstimatedTokens,
    source: 'estimate',
  };
  if (ref) ref.current = snapshot;
  return snapshot;
}

function splitImmutableSystem(messages: KodaXMessage[]): {
  readonly immutableSystem?: KodaXMessage;
  readonly mutableMessages: KodaXMessage[];
} {
  const first = messages[0];
  if (first?.role !== 'system') return { mutableMessages: messages };
  return {
    immutableSystem: first,
    mutableMessages: messages.slice(1),
  };
}

function prependImmutableSystem(
  immutableSystem: KodaXMessage | undefined,
  messages: KodaXMessage[],
): KodaXMessage[] {
  return immutableSystem ? [immutableSystem, ...messages] : messages;
}

/** Build the hook invoked before each managed Runner provider request. */
export async function buildManagedTaskCompactionHook(
  options: KodaXOptions,
  hookOptions: BuildManagedTaskCompactionHookOptions = {},
): Promise<RunnerCompactionHook | undefined> {
  const resolved = hookOptions.resolvedContextCapacity
    ?? await resolveManagedTaskContextCapacity(options);
  const { provider, activeModel, compactionConfig, contextWindow } = resolved;

  const events = options.events;
  const snapshotRef = hookOptions.contextTokenSnapshotRef;
  const reservedResponseTokens = provider.getEffectiveMaxOutputTokens(activeModel);
  const diagnosticSessionId = options.context?.contextIdentitySessionId
    ?? options.session?.id;
  const diagnosticAgentId = options.context?.currentAgentId;
  const diagnosticParentAgentId = options.context?.parentAgentId;
  const diagnosticContextId = diagnosticSessionId === undefined
    ? undefined
    : diagnosticAgentId === undefined
      ? diagnosticSessionId
      : `${diagnosticSessionId}/agent/${encodeURIComponent(diagnosticAgentId)}`;
  const diagnosticContextIdentity = {
    ...(diagnosticContextId !== undefined
      ? { contextId: diagnosticContextId }
      : {}),
    contextKind: diagnosticAgentId === undefined ? 'root' as const : 'child' as const,
    ...(diagnosticSessionId !== undefined && diagnosticAgentId !== undefined
      ? {
          parentContextId: diagnosticParentAgentId === undefined
            || diagnosticParentAgentId === '/root'
            ? diagnosticSessionId
            : `${diagnosticSessionId}/agent/${encodeURIComponent(diagnosticParentAgentId)}`,
        }
      : {}),
    ...(diagnosticAgentId !== undefined ? { agentId: diagnosticAgentId } : {}),
  };
  const promptCacheKey = resolvePromptCacheDisabled(options.disablePromptCache)
    ? undefined
    : derivePromptCacheAffinityKey({
        logicalSessionId: diagnosticSessionId,
        ...(diagnosticAgentId !== undefined ? { agentId: diagnosticAgentId } : {}),
      });
  let consecutiveFailures = 0;

  return async (transcript) => {
    const messages = transcript as unknown as KodaXMessage[];
    const snapshot = initializeEnvelopeEstimate(
      snapshotRef,
      messages,
      hookOptions.activeToolDefinitions ?? [],
    );
    const currentTokens = snapshot
      ? resolveContextTokenCount(messages, snapshot)
      : estimateTokens(messages);
    if (!needsCompaction(
      messages,
      compactionConfig,
      contextWindow,
      currentTokens,
      reservedResponseTokens,
    )) return undefined;

    const hardPressure = exceedsContextCapacity({
      contextWindow,
      currentTokens,
      reservedResponseTokens,
    });
    if (consecutiveFailures >= COMPACT_CIRCUIT_BREAKER_LIMIT && !hardPressure) {
      return undefined;
    }

    const startedAt = Date.now();
    events?.onCompactStart?.();
    try {
      const { immutableSystem, mutableMessages } = splitImmutableSystem(messages);
      const systemPrompt = typeof immutableSystem?.content === 'string'
        ? immutableSystem.content
        : undefined;
      const compactionObserver = options.context?.contextDiagnostics === true
        ? createCompactionPromptCacheObserver({
            events,
            enabled: true,
            provider,
            providerName: provider.name,
            ...diagnosticContextIdentity,
            model: activeModel ?? provider.getModel(),
            disablePromptCache: options.disablePromptCache,
          })
        : undefined;
      const cacheContext = systemPrompt !== undefined
        && hookOptions.activeToolDefinitions !== undefined
        ? {
            tools: hookOptions.activeToolDefinitions,
            reasoning: hookOptions.reasoning,
          }
        : undefined;
      const result = await intelligentCompact(
        mutableMessages,
        compactionConfig,
        provider,
        contextWindow,
        undefined,
        systemPrompt,
        currentTokens,
        CODING_SUMMARY_PROMPT,
        CODING_UPDATE_SUMMARY_PROMPT,
        activeModel,
        false,
        reservedResponseTokens,
        cacheContext,
        compactionObserver,
        promptCacheKey !== undefined ? { promptCacheKey } : undefined,
      );
      if (!result.compacted) {
        if (hardPressure) {
          throw new ContextCapacityError({
            contextWindow, currentTokens, reservedResponseTokens,
          }, 'Managed history compaction');
        }
        consecutiveFailures += 1;
        return undefined;
      }

      const fixedOverheadTokens = Math.max(
        0,
        currentTokens - estimateTokens(mutableMessages),
      );
      const attached = await attachManagedCompactionContext(
        result,
        fixedOverheadTokens,
        contextWindow,
        reservedResponseTokens,
      );
      const finalMessages = prependImmutableSystem(
        immutableSystem,
        attached.messages,
      );
      const finalTokens = fixedOverheadTokens + estimateTokens(attached.messages);
      if (exceedsContextCapacity({
        contextWindow,
        currentTokens: finalTokens,
        reservedResponseTokens,
      })) {
        throw new ContextCapacityError({
          contextWindow,
          currentTokens: finalTokens,
          reservedResponseTokens,
        }, 'Managed history compaction');
      }

      consecutiveFailures = needsCompaction(
        finalMessages,
        compactionConfig,
        contextWindow,
        finalTokens,
        reservedResponseTokens,
      ) ? consecutiveFailures + 1 : 0;
      const update = buildCompactionUpdate(
        result,
        finalTokens,
        messages,
        attached.postCompactAttachments,
      );
      events?.onCompactStats?.({ tokensBefore: currentTokens, tokensAfter: finalTokens });
      events?.onCompact?.(finalTokens);
      await events?.onCompactedMessages?.(finalMessages, update);
      notifyPostCompact(hookOptions.onPostCompact);
      updateSnapshot(snapshotRef, finalMessages, finalTokens);
      events?.onContextCompactionFinished?.({
        source: hardPressure ? 'physical_capacity' : 'automatic_threshold',
        tokensBefore: currentTokens,
        tokensAfter: finalTokens,
        committed: true,
        elapsedMs: Date.now() - startedAt,
        ...(result.report ?? {}),
      });
      return finalMessages as readonly AgentMessage[];
    } catch (error) {
      consecutiveFailures += 1;
      if (error instanceof ContextCapacityError) throw error;
      emitKodaXDiagnostic({
        source: 'coding:managed-compaction',
        level: 'error',
        message: 'Managed history compaction summary failed.',
        detail: error,
      });
      if (hardPressure) {
        throw new ContextCapacityError({
          contextWindow, currentTokens, reservedResponseTokens,
        }, 'Managed history compaction');
      }
      return undefined;
    } finally {
      events?.onCompactEnd?.();
    }
  };
}
