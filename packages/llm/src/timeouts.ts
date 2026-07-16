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

export interface KodaXResolvedLlmTimeoutConfig {
  readonly requestTimeoutMs?: number;
  readonly streamIdleTimeoutMs?: number;
  readonly chunkTimeoutMs?: number;
  readonly maxRetryDelayMs?: number;
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

export function resolveLlmTimeoutConfig(
  timeouts: KodaXLlmTimeoutConfig | undefined,
): KodaXResolvedLlmTimeoutConfig | undefined {
  if (!timeouts) return undefined;

  const resolved: KodaXResolvedLlmTimeoutConfig = {
    requestTimeoutMs: timeoutSecToMs(
      timeouts.requestTimeoutSec,
      'timeouts.llm.requestTimeoutSec',
    ),
    streamIdleTimeoutMs: timeoutSecToMs(
      timeouts.streamIdleTimeoutSec,
      'timeouts.llm.streamIdleTimeoutSec',
      { allowZero: true },
    ),
    chunkTimeoutMs: timeoutSecToMs(
      timeouts.chunkTimeoutSec,
      'timeouts.llm.chunkTimeoutSec',
    ),
    maxRetryDelayMs: timeoutSecToMs(
      timeouts.maxRetryDelaySec,
      'timeouts.llm.maxRetryDelaySec',
    ),
  };

  const hasValue = Object.values(resolved).some((value) => value !== undefined);
  return hasValue ? resolved : undefined;
}
