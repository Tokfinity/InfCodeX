import { describe, expect, it } from 'vitest';

import { providerResilienceConfigFromTimeouts } from './timeouts.js';

describe('providerResilienceConfigFromTimeouts', () => {
  it('maps public LLM timeout seconds to provider resilience milliseconds', () => {
    expect(providerResilienceConfigFromTimeouts({
      llm: {
        requestTimeoutSec: 900,
        streamIdleTimeoutSec: 0,
        chunkTimeoutSec: 45,
        maxRetryDelaySec: 90,
      },
    })).toEqual({
      requestTimeoutMs: 900_000,
      streamIdleTimeoutMs: 0,
      chunkTimeoutMs: 45_000,
      maxRetryDelayMs: 90_000,
    });
  });

  it('returns undefined when no LLM timeout override is configured', () => {
    expect(providerResilienceConfigFromTimeouts(undefined)).toBeUndefined();
    expect(providerResilienceConfigFromTimeouts({ workflow: { generationTimeoutSec: 300 } }))
      .toBeUndefined();
  });
});
