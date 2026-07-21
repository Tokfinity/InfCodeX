import type { CompactionConfig } from './types.js';

export const DEFAULT_COMPACTION_TRIGGER_PERCENT = 75;
export const MIN_COMPACTION_TRIGGER_PERCENT = 15;
export const MAX_COMPACTION_TRIGGER_PERCENT = 90;
export const COMPACTION_PROTECTION_RATIO = 0.2;

export type CompactionTriggerSource =
  | 'percentage'
  | 'absolute'
  | 'physical_capacity';

export interface ResolvedCompactionPolicy {
  readonly config: CompactionConfig;
  readonly percentageTriggerTokens: number;
  readonly absoluteTriggerTokens?: number;
  readonly physicalCapacityTokens: number;
  readonly triggerTokens: number;
  readonly protectionTokens: number;
  readonly triggerSource: CompactionTriggerSource;
}

function normalizeTriggerPercent(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_COMPACTION_TRIGGER_PERCENT;
  }
  return Math.min(
    MAX_COMPACTION_TRIGGER_PERCENT,
    Math.max(MIN_COMPACTION_TRIGGER_PERCENT, value),
  );
}

function normalizeAbsoluteTrigger(value: number | undefined): number | undefined {
  if (value === undefined || value === 0) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('compaction.triggerTokens must be 0 or a positive safe integer');
  }
  return value;
}

/** Normalize every public large-compaction entry to one always-on policy. */
export function normalizeCompactionConfig(
  input: Partial<CompactionConfig>,
): CompactionConfig {
  const triggerTokens = normalizeAbsoluteTrigger(input.triggerTokens);
  return {
    ...input,
    enabled: true,
    triggerPercent: normalizeTriggerPercent(input.triggerPercent),
    triggerTokens,
  };
}

/** Resolve token budgets after provider capacity/reserve is known. */
export function resolveCompactionPolicy(
  input: Partial<CompactionConfig>,
  contextWindow: number,
  physicalCapacityTokens: number = contextWindow,
): ResolvedCompactionPolicy {
  const config = normalizeCompactionConfig(input);
  const percentageTriggerTokens = Math.floor(
    contextWindow * (config.triggerPercent / 100),
  );
  const candidates: Array<{
    source: CompactionTriggerSource;
    tokens: number;
  }> = [
    { source: 'percentage', tokens: percentageTriggerTokens },
    { source: 'physical_capacity', tokens: physicalCapacityTokens },
  ];
  if (config.triggerTokens !== undefined) {
    candidates.push({ source: 'absolute', tokens: config.triggerTokens });
  }
  const selected = candidates.reduce((smallest, candidate) => (
    candidate.tokens < smallest.tokens ? candidate : smallest
  ));

  return {
    config,
    percentageTriggerTokens,
    absoluteTriggerTokens: config.triggerTokens,
    physicalCapacityTokens,
    triggerTokens: selected.tokens,
    protectionTokens: Math.floor(selected.tokens * COMPACTION_PROTECTION_RATIO),
    triggerSource: selected.source,
  };
}
