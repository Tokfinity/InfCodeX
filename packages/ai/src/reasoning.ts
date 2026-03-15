import {
  KodaXProviderConfig,
  KodaXReasoningCapability,
  KodaXReasoningMode,
  KodaXReasoningRequest,
  KodaXTaskType,
  KodaXThinkingBudgetMap,
  KodaXThinkingDepth,
} from './types.js';

export const KODAX_REASONING_MODE_SEQUENCE: KodaXReasoningMode[] = [
  'off',
  'auto',
  'quick',
  'balanced',
  'deep',
];

export const KODAX_DEFAULT_THINKING_BUDGETS: KodaXThinkingBudgetMap = {
  low: 6000,
  medium: 10000,
  high: 20000,
};

export const KODAX_REASONING_SAFETY_RESERVE = 4096;

export function getReasoningCapability(
  config: KodaXProviderConfig,
): KodaXReasoningCapability {
  if (config.reasoningCapability) {
    return config.reasoningCapability;
  }

  return config.supportsThinking ? 'native-toggle' : 'prompt-only';
}

export function isReasoningEnabled(
  reasoning?: boolean | KodaXReasoningRequest,
): boolean {
  return normalizeReasoningRequest(reasoning).enabled;
}

export function normalizeReasoningRequest(
  reasoning?: boolean | KodaXReasoningRequest,
): Required<KodaXReasoningRequest> {
  if (typeof reasoning === 'boolean') {
    return {
      enabled: reasoning,
      mode: reasoning ? 'auto' : 'off',
      depth: reasoning ? 'medium' : 'off',
      taskType: 'unknown',
      executionMode: 'implementation',
    };
  }

  const mode = reasoning?.mode ?? 'off';
  const depth = reasoning?.depth ?? getDefaultThinkingDepthForMode(mode);
  const enabled =
    reasoning?.enabled ??
    (mode !== 'off' && depth !== 'off');

  return {
    enabled: enabled && mode !== 'off' && depth !== 'off',
    mode,
    depth: enabled ? depth : 'off',
    taskType: reasoning?.taskType ?? 'unknown',
    executionMode: reasoning?.executionMode ?? 'implementation',
  };
}

export function getDefaultThinkingDepthForMode(
  mode: KodaXReasoningMode,
): KodaXThinkingDepth {
  switch (mode) {
    case 'quick':
      return 'low';
    case 'balanced':
    case 'auto':
      return 'medium';
    case 'deep':
      return 'high';
    case 'off':
    default:
      return 'off';
  }
}

export function resolveThinkingBudget(
  config: KodaXProviderConfig,
  depth: KodaXThinkingDepth,
  taskType: KodaXTaskType = 'unknown',
): number {
  if (depth === 'off') {
    return 0;
  }

  const defaultBudgets: KodaXThinkingBudgetMap = {
    ...KODAX_DEFAULT_THINKING_BUDGETS,
    ...(config.defaultThinkingBudgets ?? {}),
  };

  const taskOverride = config.taskBudgetOverrides?.[taskType];
  const requestedBudget = taskOverride?.[depth] ?? defaultBudgets[depth];

  if (config.thinkingBudgetCap) {
    return Math.min(requestedBudget, config.thinkingBudgetCap);
  }

  return requestedBudget;
}

export function clampThinkingBudget(
  requestedBudget: number,
  maxOutputTokens: number,
  safetyReserve = KODAX_REASONING_SAFETY_RESERVE,
): number {
  const hardCap = Math.max(1024, maxOutputTokens - safetyReserve);
  return Math.max(1024, Math.min(requestedBudget, hardCap));
}

export function mapDepthToOpenAIReasoningEffort(
  depth: KodaXThinkingDepth,
): 'low' | 'medium' | 'high' | undefined {
  switch (depth) {
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    case 'high':
      return 'high';
    default:
      return undefined;
  }
}
