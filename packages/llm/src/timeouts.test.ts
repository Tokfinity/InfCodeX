import { describe, expect, it } from 'vitest';

import {
  parseTimeoutSecEnvMs,
  resolveLlmTimeoutConfig,
  timeoutSecToMs,
} from './timeouts.js';

describe('timeoutSecToMs', () => {
  it('converts public seconds to internal milliseconds', () => {
    expect(timeoutSecToMs(120, 'timeout')).toBe(120_000);
    expect(timeoutSecToMs(1.5, 'timeout')).toBe(1_500);
  });

  it('allows zero only for explicit disable-style fields', () => {
    expect(timeoutSecToMs(0, 'idle', { allowZero: true })).toBe(0);
    expect(() => timeoutSecToMs(0, 'timeout')).toThrow(/positive finite number/);
  });

  it('rejects invalid explicit SDK values', () => {
    expect(() => timeoutSecToMs(Number.NaN, 'timeout')).toThrow(/positive finite number/);
    expect(() => timeoutSecToMs(-1, 'timeout')).toThrow(/positive finite number/);
  });
});

describe('parseTimeoutSecEnvMs', () => {
  it('parses positive second env values', () => {
    expect(parseTimeoutSecEnvMs('300')).toBe(300_000);
  });

  it('ignores empty or invalid env values', () => {
    expect(parseTimeoutSecEnvMs(undefined)).toBeUndefined();
    expect(parseTimeoutSecEnvMs('')).toBeUndefined();
    expect(parseTimeoutSecEnvMs('0')).toBeUndefined();
    expect(parseTimeoutSecEnvMs('nope')).toBeUndefined();
  });
});

describe('resolveLlmTimeoutConfig', () => {
  it('maps public LLM timeout seconds to provider milliseconds', () => {
    expect(resolveLlmTimeoutConfig({
      requestTimeoutSec: 900,
      streamIdleTimeoutSec: 0,
      chunkTimeoutSec: 45,
      maxRetryDelaySec: 90,
    })).toEqual({
      requestTimeoutMs: 900_000,
      streamIdleTimeoutMs: 0,
      chunkTimeoutMs: 45_000,
      maxRetryDelayMs: 90_000,
    });
  });

  it('returns undefined when no LLM timeout override is configured', () => {
    expect(resolveLlmTimeoutConfig(undefined)).toBeUndefined();
    expect(resolveLlmTimeoutConfig({})).toBeUndefined();
  });
});
