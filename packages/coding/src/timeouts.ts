import {
  resolveLlmTimeoutConfig,
  type KodaXLlmTimeoutConfig,
} from '@kodax-ai/llm';
import type { ProviderResilienceConfig } from './resilience/types.js';

export type { KodaXLlmTimeoutConfig } from '@kodax-ai/llm';
export {
  parseTimeoutSecEnvMs,
  timeoutSecToMs,
} from '@kodax-ai/llm';

export interface KodaXWorkflowTimeoutConfig {
  /** Workflow harness generation LLM call timeout, in seconds. Default 120s. */
  readonly generationTimeoutSec?: number;
}

/**
 * Public timeout budgets for user-facing waits. Internal cleanup and
 * resource-protection watchdogs intentionally stay outside this SDK contract.
 */
export interface KodaXTimeoutConfig {
  readonly llm?: KodaXLlmTimeoutConfig;
  readonly workflow?: KodaXWorkflowTimeoutConfig;
}

export function providerResilienceConfigFromTimeouts(
  timeouts: KodaXTimeoutConfig | undefined,
): ProviderResilienceConfig | undefined {
  const llm = resolveLlmTimeoutConfig(timeouts?.llm);
  if (!llm) return undefined;

  const config: ProviderResilienceConfig = {};

  if (llm.requestTimeoutMs !== undefined) config.requestTimeoutMs = llm.requestTimeoutMs;
  if (llm.streamIdleTimeoutMs !== undefined) config.streamIdleTimeoutMs = llm.streamIdleTimeoutMs;
  if (llm.chunkTimeoutMs !== undefined) config.chunkTimeoutMs = llm.chunkTimeoutMs;
  if (llm.maxRetryDelayMs !== undefined) config.maxRetryDelayMs = llm.maxRetryDelayMs;

  return Object.keys(config).length > 0 ? config : undefined;
}
