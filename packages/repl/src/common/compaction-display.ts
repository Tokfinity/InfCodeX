import { calculateMaxContextInputTokens } from '@kodax-ai/agent';

/** Human-readable auto-compaction policy for banners and help surfaces. */
export function formatCompactionPolicy(
  contextWindow: number,
  triggerPercent: number,
): string {
  if (triggerPercent >= 100) {
    return 'capacity-driven';
  }

  const triggerTokens = Math.round(contextWindow * triggerPercent / 100 / 1000);
  return `@ ${triggerPercent}% (${triggerTokens}k)`;
}

/** Effective pressure threshold used only for status-bar colouring. */
export function resolveCompactionThresholdTokens(
  contextWindow: number,
  triggerPercent: number,
  reservedResponseTokens = 0,
): number {
  const capacityLimit = calculateMaxContextInputTokens(
    contextWindow,
    reservedResponseTokens,
  );
  if (triggerPercent >= 100) {
    return capacityLimit;
  }

  return Math.min(
    capacityLimit,
    Math.floor(contextWindow * triggerPercent / 100),
  );
}
