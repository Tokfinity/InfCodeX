import {
  calculateMaxContextInputTokens,
  resolveCompactionPolicy,
} from '@kodax-ai/agent';

/** Human-readable auto-compaction policy for banners and help surfaces. */
export function formatCompactionPolicy(
  contextWindow: number,
  triggerPercent: number,
  triggerTokens?: number,
): string {
  const policy = resolveCompactionPolicy(
    { triggerPercent, triggerTokens },
    contextWindow,
  );
  const percentage = policy.config.triggerPercent;
  const effectiveK = Math.round(policy.triggerTokens / 1000);
  if (policy.absoluteTriggerTokens === undefined) {
    return `@ ${percentage}% (${effectiveK}k)`;
  }
  const absoluteK = Math.round(policy.absoluteTriggerTokens / 1000);
  return `@ min(${percentage}%, ${absoluteK}k) (${effectiveK}k)`;
}

/** Effective pressure threshold used only for status-bar colouring. */
export function resolveCompactionThresholdTokens(
  contextWindow: number,
  triggerPercent: number,
  reservedResponseTokens = 0,
  triggerTokens?: number,
): number {
  const capacityLimit = calculateMaxContextInputTokens(
    contextWindow,
    reservedResponseTokens,
  );
  return resolveCompactionPolicy(
    { triggerPercent, triggerTokens },
    contextWindow,
    capacityLimit,
  ).triggerTokens;
}
