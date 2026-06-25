import type { ProviderResilienceConfig } from './resilience/types.js';

export interface KodaXLlmTimeoutConfig {
  /** Main provider request hard timeout, in seconds. Default 600s. */
  readonly requestTimeoutSec?: number;
  /** Idle timeout between stream deltas, in seconds. Set 0 to disable. Default 0. */
  readonly streamIdleTimeoutSec?: number;
  /** Per stream chunk timeout, in seconds. Default 30s. */
  readonly chunkTimeoutSec?: number;
  /** Maximum retry delay, in seconds. Default 60s. */
  readonly maxRetryDelaySec?: number;
}

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

export function timeoutSecToMs(
  value: number | undefined,
  label: string,
  opts: { readonly allowZero?: boolean } = {},
): number | undefined {
  if (value === undefined) return undefined;
  const allowZero = opts.allowZero === true;
  if (!Number.isFinite(value) || (allowZero ? value < 0 : value <= 0)) {
    const suffix = allowZero ? 'a non-negative finite number' : 'a positive finite number';
    throw new Error(`${label} must be ${suffix}`);
  }
  if (value === 0) return 0;
  return Math.max(1, Math.floor(value * 1000));
}

export function parseTimeoutSecEnvMs(
  raw: string | undefined,
): number | undefined {
  if (raw === undefined || raw.trim().length === 0) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.max(1, Math.floor(parsed * 1000));
}

export function providerResilienceConfigFromTimeouts(
  timeouts: KodaXTimeoutConfig | undefined,
): ProviderResilienceConfig | undefined {
  const llm = timeouts?.llm;
  if (!llm) return undefined;

  const config: ProviderResilienceConfig = {};
  const requestTimeoutMs = timeoutSecToMs(llm.requestTimeoutSec, 'timeouts.llm.requestTimeoutSec');
  const streamIdleTimeoutMs = timeoutSecToMs(
    llm.streamIdleTimeoutSec,
    'timeouts.llm.streamIdleTimeoutSec',
    { allowZero: true },
  );
  const chunkTimeoutMs = timeoutSecToMs(llm.chunkTimeoutSec, 'timeouts.llm.chunkTimeoutSec');
  const maxRetryDelayMs = timeoutSecToMs(llm.maxRetryDelaySec, 'timeouts.llm.maxRetryDelaySec');

  if (requestTimeoutMs !== undefined) config.requestTimeoutMs = requestTimeoutMs;
  if (streamIdleTimeoutMs !== undefined) config.streamIdleTimeoutMs = streamIdleTimeoutMs;
  if (chunkTimeoutMs !== undefined) config.chunkTimeoutMs = chunkTimeoutMs;
  if (maxRetryDelayMs !== undefined) config.maxRetryDelayMs = maxRetryDelayMs;

  return Object.keys(config).length > 0 ? config : undefined;
}
