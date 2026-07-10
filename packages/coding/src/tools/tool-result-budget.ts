import type {
  RuntimeContextBudgetSnapshot,
  RuntimeContextPressure,
} from '../agent-runtime/context-budget.js';
import type { ToolResultPolicy } from './tool-result-policy.js';

export type ToolResultBudgetReason =
  | 'large_window'
  | 'normal_pressure'
  | 'small_window_pressure'
  | 'critical_pressure';

export interface ToolResultBudget {
  readonly pressure: RuntimeContextPressure;
  readonly contextWindow: number;
  readonly aggregateInlineBytes: number;
  readonly perResultInlineBytes: number;
  readonly reason: ToolResultBudgetReason;
}

export interface ToolResultBudgetUsageInput {
  readonly contextWindow: number;
  readonly currentTokens: number;
}

const TOKENS_TO_BYTES = 4;
const MIN_AGGREGATE_INLINE_BYTES = 12 * 1024;
const MIN_PER_RESULT_INLINE_BYTES = 4 * 1024;
const LARGE_WINDOW_AGGREGATE_BYTES = 192 * 1024;
const LARGE_WINDOW_PER_RESULT_BYTES = 64 * 1024;

export function buildToolResultBudget(
  snapshot: RuntimeContextBudgetSnapshot,
): ToolResultBudget {
  return buildToolResultBudgetFromPressure({
    availableTokens: snapshot.availableTokens,
    contextWindow: snapshot.contextWindow,
    pressure: snapshot.pressure,
    smallWindow: snapshot.smallWindow,
  });
}

export function buildToolResultBudgetFromUsage(
  input: ToolResultBudgetUsageInput,
): ToolResultBudget {
  const contextWindow = Math.max(0, Math.floor(input.contextWindow));
  const currentTokens = Math.max(0, Math.floor(input.currentTokens));
  const availableTokens = contextWindow > 0 ? Math.max(0, contextWindow - currentTokens) : 0;
  const usedRatio = contextWindow > 0 ? currentTokens / contextWindow : 1;
  const smallWindow = contextWindow > 0 && contextWindow <= 32_000;
  return buildToolResultBudgetFromPressure({
    availableTokens,
    contextWindow,
    pressure: classifyPressure(contextWindow, availableTokens, usedRatio, smallWindow),
    smallWindow,
  });
}

function buildToolResultBudgetFromPressure(input: {
  readonly availableTokens: number;
  readonly contextWindow: number;
  readonly pressure: RuntimeContextPressure;
  readonly smallWindow: boolean;
}): ToolResultBudget {
  if (input.pressure === 'critical') {
    return {
      pressure: input.pressure,
      contextWindow: input.contextWindow,
      aggregateInlineBytes: Math.max(MIN_AGGREGATE_INLINE_BYTES, Math.floor(input.availableTokens * TOKENS_TO_BYTES * 0.2)),
      perResultInlineBytes: MIN_PER_RESULT_INLINE_BYTES,
      reason: 'critical_pressure',
    };
  }

  if (input.smallWindow || input.pressure === 'high') {
    const aggregate = Math.max(
      MIN_AGGREGATE_INLINE_BYTES,
      Math.floor(input.availableTokens * TOKENS_TO_BYTES * 0.35),
    );
    return {
      pressure: input.pressure,
      contextWindow: input.contextWindow,
      aggregateInlineBytes: aggregate,
      perResultInlineBytes: Math.min(16 * 1024, Math.max(MIN_PER_RESULT_INLINE_BYTES, Math.floor(aggregate / 3))),
      reason: 'small_window_pressure',
    };
  }

  if (input.pressure === 'medium') {
    return {
      pressure: input.pressure,
      contextWindow: input.contextWindow,
      aggregateInlineBytes: 96 * 1024,
      perResultInlineBytes: 32 * 1024,
      reason: 'normal_pressure',
    };
  }

  return {
    pressure: input.pressure,
    contextWindow: input.contextWindow,
    aggregateInlineBytes: LARGE_WINDOW_AGGREGATE_BYTES,
    perResultInlineBytes: LARGE_WINDOW_PER_RESULT_BYTES,
    reason: 'large_window',
  };
}

export function clampToolResultPolicyToBudget(
  policy: ToolResultPolicy,
  budget: ToolResultBudget | undefined,
): ToolResultPolicy {
  if (!budget) return policy;
  const maxBytes = Math.min(policy.maxBytes, budget.perResultInlineBytes);
  return {
    ...policy,
    maxBytes,
    maxLines: Math.min(policy.maxLines, estimateLineCap(policy, maxBytes)),
  };
}

function estimateLineCap(policy: ToolResultPolicy, maxBytes: number): number {
  return Math.max(20, Math.floor(policy.maxLines * (maxBytes / Math.max(1, policy.maxBytes))));
}

function classifyPressure(
  contextWindow: number,
  availableTokens: number,
  usedRatio: number,
  smallWindow: boolean,
): RuntimeContextPressure {
  if (contextWindow <= 0 || availableTokens <= 0 || usedRatio >= 0.9) return 'critical';
  if (usedRatio >= 0.75) return 'high';
  if (usedRatio >= 0.55 || (smallWindow && usedRatio >= 0.4)) return 'medium';
  return 'low';
}
