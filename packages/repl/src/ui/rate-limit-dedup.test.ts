import { describe, expect, it } from 'vitest';

import { isDuplicateLegacyRateLimit } from './rate-limit-dedup.js';

describe('isDuplicateLegacyRateLimit', () => {
  const structured = { attempt: 2, maxAttempts: 3, waitMs: 45_000 };

  it('suppresses the legacy line when it matches the structured line exactly', () => {
    expect(
      isDuplicateLegacyRateLimit(structured, { attempt: 2, maxAttempts: 3, delayMs: 45_000 }),
    ).toBe(true);
  });

  it('keeps the legacy line when no structured line was recorded (structured callback not wired)', () => {
    expect(
      isDuplicateLegacyRateLimit(null, { attempt: 2, maxAttempts: 3, delayMs: 45_000 }),
    ).toBe(false);
  });

  it('keeps the legacy line for a different attempt (a separate retry)', () => {
    expect(
      isDuplicateLegacyRateLimit(structured, { attempt: 3, maxAttempts: 3, delayMs: 45_000 }),
    ).toBe(false);
  });

  it('keeps the legacy line when the wait differs (not the same event)', () => {
    expect(
      isDuplicateLegacyRateLimit(structured, { attempt: 2, maxAttempts: 3, delayMs: 4_000 }),
    ).toBe(false);
  });

  it('keeps the legacy line when maxAttempts differs', () => {
    expect(
      isDuplicateLegacyRateLimit(structured, { attempt: 2, maxAttempts: 4, delayMs: 45_000 }),
    ).toBe(false);
  });
});
