/**
 * Graceful compaction degradation — CAP-028
 *
 * Capability inventory: docs/features/v0.7.29-capability-inventory.md#cap-028-graceful-compaction-degradation
 *
 * Class 1 (substrate middleware). Truncation-based fallback that fires
 * when the primary FEATURE_072 lineage compaction fails (LLM error,
 * token overflow during summarization, etc.) so the run can continue
 * instead of hard-failing.
 *
 * Strategy: first materialize a synthetic recovery checkpoint containing the
 * prior summary and an exact user-query ledger, then drop the oldest remaining
 * atomic blocks until the shared effective trigger is met.
 * Three invariants are load-bearing:
 *
 *   1. **Summary preservation** — if the very first message is a
 *      `system` message OR a `user` message containing `'[对话历史摘要]'`
 *      (the FEATURE_072 lineage marker), `startIdx = 1` so the
 *      summary itself is never dropped.
 *
 *   2. **Tool pairing** — `tool_use` blocks (assistant) and
 *      `tool_result` blocks (user) MUST stay paired. If we encounter
 *      a `tool_use` without a following `tool_result` (or a
 *      `tool_result` without a preceding `tool_use`), we skip past
 *      it rather than orphaning its partner. This is critical because
 *      providers reject unpaired tool blocks with `400` errors.
 *
 *   3. **Recent-context preservation** — the loop terminates as soon
 *      as the running token estimate dips below the target, so the
 *      tail of the conversation (most-recent messages) is preserved.
 *
 * The function is INTENTIONALLY destructive — it returns a NEW array
 * with the dropped messages removed. Callers do not mutate the input
 * array directly (the `messages = [...messages.slice(...)]` pattern
 * inside the loop ensures each iteration starts from a fresh copy).
 *
 * The two content-block predicates (`isTypedContentBlock`,
 * `isToolResultContentBlock`) are private helpers carried over with
 * this function — by the time this batch ran, prior batches had
 * already migrated `validateAndFixToolHistory` (the only other
 * consumer of these predicates in HEAD `agent.ts`) into
 * `agent-runtime/history-cleanup.ts` along with its own local copies
 * of the predicates (CAP-002). So at the point of extraction, the
 * predicates' only remaining `agent.ts` consumer was
 * `gracefulCompactDegradation` itself. Co-locating them here keeps
 * the module self-contained.
 *
 * (The original `agent.ts` also defined `isToolUseContentBlock` next
 * to these. In HEAD it had 2 callers inside
 * `validateAndFixToolHistory`; those callers moved with the function
 * to `history-cleanup.ts` (CAP-002) and the agent.ts copy of
 * `isToolUseContentBlock` was left without callers. It is therefore
 * intentionally NOT carried over to this module. The dispatcher's
 * tool-use checks elsewhere in `agent.ts` use the inline pattern
 * `isTypedContentBlock(b) && b.type === 'tool_use'` instead.)
 *
 * Migration history:
 *   - extracted from `agent.ts:185-187` + `195-199` (the two carried
 *     predicates) + `agent.ts:201-266` (`gracefulCompactDegradation`
 *     with its docstring) — pre-FEATURE_100 baseline — during
 *     FEATURE_100 P2.
 *   - moved from `../../index.js/src/runtime-middleware/` to
 *     `@kodax-ai/session-lineage/src/runtime-middleware/` in v0.7.36 to
 *     break the build cycle introduced by FEATURE_142 Batch D
 *     (agent → session-lineage → agent). Semantically this also
 *     reflects that compaction degradation is part of the compaction
 *     lifecycle, which is session-lineage's domain.
 */

import { estimateTokens } from '../../tokenizer.js';
import { calculateMaxContextInputTokens } from '../../context-capacity.js';
import type { KodaXMessage } from '@kodax-ai/llm';

import type { CompactionConfig } from '../compaction/types.js';
import { resolveCompactionPolicy } from '../compaction/policy.js';
import {
  mergeUserQueryLedger,
  parseUserQueryLedger,
  renderUserQueryLedger,
} from '../compaction/query-ledger.js';

const COMPACTION_CHECKPOINT_PREFIX = '[对话历史摘要]\n\n';

/** Request capacity that is not represented by the message array itself. */
export interface GracefulCompactionCapacity {
  /** System prompt and tool-definition tokens outside `messages`. */
  readonly fixedOverheadTokens?: number;
  /** Provider output tokens reserved from the context window. */
  readonly reservedResponseTokens?: number;
}

type MessageContentBlock = Exclude<KodaXMessage['content'], string>[number];

function isTypedContentBlock(block: unknown): block is MessageContentBlock {
  return block !== null && typeof block === 'object' && 'type' in block;
}

function isToolResultContentBlock(
  block: unknown,
): block is Extract<MessageContentBlock, { type: 'tool_result' }> {
  return isTypedContentBlock(block) && block.type === 'tool_result';
}

/**
 * Graceful compact degradation: protect an exact user-query checkpoint, then
 * drop oldest atomic blocks until the shared effective trigger is met.
 */
export function gracefulCompactDegradation(
  messages: KodaXMessage[],
  contextWindow: number,
  config: CompactionConfig,
  capacity?: GracefulCompactionCapacity,
): KodaXMessage[] {
  const physicalCapacityTokens = capacity === undefined
    ? contextWindow
    : calculateMaxContextInputTokens(
        contextWindow,
        capacity.reservedResponseTokens,
      );
  const totalTargetTokens = resolveCompactionPolicy(
    config,
    contextWindow,
    physicalCapacityTokens,
  ).triggerTokens;
  const fixedOverheadTokens = Math.max(
    0,
    Math.floor(capacity?.fixedOverheadTokens ?? 0),
  );
  const targetTokens = Math.max(0, totalTargetTokens - fixedOverheadTokens);
  if (messages.length === 0 || estimateTokens(messages) <= targetTokens) return messages;

  const firstMessage = messages[0];
  const firstContent = typeof firstMessage?.content === 'string'
    ? firstMessage.content
    : '';
  const hasPriorCheckpoint = firstContent.includes(COMPACTION_CHECKPOINT_PREFIX.trim());
  const priorLedger = hasPriorCheckpoint ? parseUserQueryLedger(firstContent) : [];
  const queryLedger = mergeUserQueryLedger(priorLedger, messages);
  const immutableSystem = firstMessage?.role === 'system' && !hasPriorCheckpoint
    ? firstMessage
    : undefined;
  const remaining = messages.slice(immutableSystem || hasPriorCheckpoint ? 1 : 0);
  const priorSummary = hasPriorCheckpoint
    ? firstContent
        .slice(firstContent.indexOf(COMPACTION_CHECKPOINT_PREFIX.trim())
          + COMPACTION_CHECKPOINT_PREFIX.trim().length)
        .split('## User Queries & Corrections')[0]
        ?.trim()
    : undefined;
  const checkpoint: KodaXMessage | undefined = queryLedger.length > 0 || priorSummary
    ? {
        role: 'user',
        content: [
          COMPACTION_CHECKPOINT_PREFIX.trimEnd(),
          priorSummary || 'Emergency recovery checkpoint after semantic compaction failure.',
          renderUserQueryLedger(queryLedger),
        ].join('\n\n'),
        _synthetic: true,
        _source: 'compaction-checkpoint',
      }
    : undefined;
  messages = [
    ...(immutableSystem ? [immutableSystem] : []),
    ...(checkpoint ? [checkpoint] : []),
    ...remaining,
  ];

  // The immutable provider system message and mechanical user-query checkpoint
  // are mandatory layers. Emergency pruning may remove only history after them.
  const startIdx = (immutableSystem ? 1 : 0) + (checkpoint ? 1 : 0);

  let dropIdx = startIdx;
  while (dropIdx < messages.length && estimateTokens(messages) > targetTokens) {
    const msg = messages[dropIdx];
    if (!msg) break;

    const hasToolUse = msg.role === 'assistant' && Array.isArray(msg.content)
      && msg.content.some((b: unknown) => isTypedContentBlock(b) && b.type === 'tool_use');
    const hasToolResult = msg.role === 'user' && Array.isArray(msg.content)
      && msg.content.some(isToolResultContentBlock);

    // Forward pair: assistant(tool_use) followed by user(tool_result) → drop both
    if (hasToolUse) {
      const nextMsg = messages[dropIdx + 1];
      const nextHasResult = nextMsg?.role === 'user' && Array.isArray(nextMsg.content)
        && nextMsg.content.some(isToolResultContentBlock);
      if (nextHasResult) {
        messages = [...messages.slice(0, dropIdx), ...messages.slice(dropIdx + 2)];
        continue;
      }
      // No paired tool_result follows — skip to preserve tool pairing invariant
      dropIdx++;
      continue;
    }

    // Backward pair: user(tool_result) preceded by assistant(tool_use) → drop both
    if (hasToolResult) {
      const prevMsg = messages[dropIdx - 1];
      const prevHasUse = prevMsg?.role === 'assistant' && Array.isArray(prevMsg.content)
        && prevMsg.content.some((b: unknown) => isTypedContentBlock(b) && b.type === 'tool_use');
      if (prevHasUse) {
        messages = [...messages.slice(0, dropIdx - 1), ...messages.slice(dropIdx + 1)];
        continue;
      }
      // No paired assistant precedes — skip to preserve tool pairing invariant
      dropIdx++;
      continue;
    }

    // Non-tool message — safe to drop individually
    messages = [...messages.slice(0, dropIdx), ...messages.slice(dropIdx + 1)];
  }

  return messages;
}
