/**
 * FEATURE_130 v0.7.36 — parseRetryAfter helper unit tests.
 *
 * Covers the four header forms in the design spec plus the helper's
 * boundary contracts: clamping, jitter-disable for determinism,
 * concurrent invocation safety, and shape detection of error objects
 * across the SDK variants the 12 provider adapters surface.
 */
import { describe, expect, it } from 'vitest';

import {
  extractHeadersFromError,
  parseRetryAfter,
} from './retry-after.js';

describe('parseRetryAfter — header forms', () => {
  it('parses integer Retry-After seconds', () => {
    const result = parseRetryAfter(
      { 'retry-after': '120' },
      { attempt: 0, withJitter: false },
    );
    expect(result.type).toBe('header');
    if (result.type !== 'header') return;
    expect(result.waitMs).toBe(120_000);
    expect(result.source).toBe('retry-after-seconds');
    expect(result.cappedFromHeader).toBe(false);
  });

  it('parses Retry-After HTTP-date relative to now', () => {
    const fixedNow = Date.parse('2026-05-07T10:00:00.000Z');
    const targetDate = 'Thu, 07 May 2026 10:00:30 GMT';
    const result = parseRetryAfter(
      { 'retry-after': targetDate },
      { attempt: 0, now: () => fixedNow, withJitter: false },
    );
    expect(result.type).toBe('header');
    if (result.type !== 'header') return;
    // 30 seconds in the future (allow tiny rounding).
    expect(result.waitMs).toBeGreaterThanOrEqual(29_500);
    expect(result.waitMs).toBeLessThanOrEqual(30_500);
    expect(result.source).toBe('retry-after-date');
  });

  it('parses Anthropic retry-after-ms millisecond extension', () => {
    const result = parseRetryAfter(
      { 'retry-after-ms': '45000' },
      { attempt: 0, withJitter: false },
    );
    expect(result.type).toBe('header');
    if (result.type !== 'header') return;
    expect(result.waitMs).toBe(45_000);
    expect(result.source).toBe('retry-after-ms');
  });

  it('falls back to exponential backoff when no Retry-After header is present', () => {
    const result = parseRetryAfter({}, { attempt: 2, withJitter: false });
    expect(result.type).toBe('backoff');
    if (result.type !== 'backoff') return;
    // base=1000, attempt=2 → 1000 * 4 = 4000ms.
    expect(result.waitMs).toBe(4_000);
    expect(result.source).toBe('exponential-backoff');
    expect(result.attempt).toBe(2);
  });

  it('caps exponential backoff at maxBackoffMs (default 30s)', () => {
    const result = parseRetryAfter({}, { attempt: 10, withJitter: false });
    expect(result.type).toBe('backoff');
    if (result.type !== 'backoff') return;
    expect(result.waitMs).toBe(30_000);
  });

  it('respects custom baseBackoffMs / maxBackoffMs', () => {
    const result = parseRetryAfter(
      {},
      { attempt: 3, baseBackoffMs: 500, maxBackoffMs: 8_000, withJitter: false },
    );
    expect(result.type).toBe('backoff');
    if (result.type !== 'backoff') return;
    // base=500, attempt=3 → 500*8 = 4000ms < cap → 4000ms.
    expect(result.waitMs).toBe(4_000);
  });
});

describe('parseRetryAfter — Headers API support', () => {
  it('reads retry-after from a Web Headers object', () => {
    const headers = new Headers({ 'retry-after': '5' });
    const result = parseRetryAfter(headers, { attempt: 0, withJitter: false });
    expect(result.type).toBe('header');
    if (result.type !== 'header') return;
    expect(result.waitMs).toBe(5_000);
  });

  it('reads retry-after-ms from a Web Headers object', () => {
    const headers = new Headers({ 'retry-after-ms': '7500' });
    const result = parseRetryAfter(headers, { attempt: 0, withJitter: false });
    expect(result.type).toBe('header');
    if (result.type !== 'header') return;
    expect(result.waitMs).toBe(7_500);
  });

  it('handles uppercase header names in plain objects', () => {
    const result = parseRetryAfter(
      { 'Retry-After': '10' },
      { attempt: 0, withJitter: false },
    );
    expect(result.type).toBe('header');
    if (result.type !== 'header') return;
    expect(result.waitMs).toBe(10_000);
  });
});

describe('parseRetryAfter — clamping and edge cases', () => {
  it('clamps absurd retry-after-ms values to maxHeaderWaitMs and flags it', () => {
    const result = parseRetryAfter(
      { 'retry-after-ms': '1800000' }, // 30 minutes
      { attempt: 0, withJitter: false },
    );
    expect(result.type).toBe('header');
    if (result.type !== 'header') return;
    expect(result.waitMs).toBe(120_000); // default cap
    expect(result.cappedFromHeader).toBe(true);
  });

  it('clamps absurd Retry-After seconds to maxHeaderWaitMs and flags it', () => {
    const result = parseRetryAfter(
      { 'retry-after': '600' }, // 10 minutes
      { attempt: 0, withJitter: false },
    );
    expect(result.type).toBe('header');
    if (result.type !== 'header') return;
    expect(result.waitMs).toBe(120_000);
    expect(result.cappedFromHeader).toBe(true);
  });

  it('falls through to backoff when Retry-After is non-numeric and not a date', () => {
    const result = parseRetryAfter(
      { 'retry-after': 'not-a-number' },
      { attempt: 1, withJitter: false },
    );
    expect(result.type).toBe('backoff');
  });

  it('treats zero / negative seconds as missing', () => {
    const result = parseRetryAfter(
      { 'retry-after': '0' },
      { attempt: 0, withJitter: false },
    );
    expect(result.type).toBe('backoff');
  });

  it('falls through to backoff when HTTP-date is in the past', () => {
    const fixedNow = Date.parse('2026-05-07T10:00:00.000Z');
    const result = parseRetryAfter(
      { 'retry-after': 'Mon, 01 Jan 2024 00:00:00 GMT' },
      { attempt: 0, now: () => fixedNow, withJitter: false },
    );
    expect(result.type).toBe('backoff');
  });

  it('returns backoff for undefined headers', () => {
    const result = parseRetryAfter(undefined, { attempt: 0, withJitter: false });
    expect(result.type).toBe('backoff');
  });

  it('jitter adds 0-25% on top of base when enabled', () => {
    const samples = Array.from({ length: 50 }, () =>
      parseRetryAfter({}, { attempt: 1, withJitter: true }),
    );
    for (const r of samples) {
      expect(r.type).toBe('backoff');
      if (r.type !== 'backoff') continue;
      expect(r.waitMs).toBeGreaterThanOrEqual(2_000);
      expect(r.waitMs).toBeLessThanOrEqual(2_500);
    }
  });
});

describe('extractHeadersFromError', () => {
  it('reads .headers (Anthropic SDK shape)', () => {
    const err = { headers: { 'retry-after': '7' } };
    const headers = extractHeadersFromError(err);
    const result = parseRetryAfter(headers, { attempt: 0, withJitter: false });
    expect(result.type).toBe('header');
    if (result.type !== 'header') return;
    expect(result.waitMs).toBe(7_000);
  });

  it('reads .response.headers (OpenAI / fetch shape)', () => {
    const err = { response: { headers: new Headers({ 'retry-after': '4' }) } };
    const headers = extractHeadersFromError(err);
    const result = parseRetryAfter(headers, { attempt: 0, withJitter: false });
    expect(result.type).toBe('header');
    if (result.type !== 'header') return;
    expect(result.waitMs).toBe(4_000);
  });

  it('reads .cause.response.headers (wrapped Error shape)', () => {
    const err = {
      cause: { response: { headers: { 'retry-after-ms': '2500' } } },
    };
    const headers = extractHeadersFromError(err);
    const result = parseRetryAfter(headers, { attempt: 0, withJitter: false });
    expect(result.type).toBe('header');
    if (result.type !== 'header') return;
    expect(result.waitMs).toBe(2_500);
  });

  it('returns undefined for non-object errors', () => {
    expect(extractHeadersFromError('string error')).toBeUndefined();
    expect(extractHeadersFromError(null)).toBeUndefined();
    expect(extractHeadersFromError(undefined)).toBeUndefined();
  });

  it('returns undefined when no headers field is present', () => {
    expect(extractHeadersFromError({ message: 'no headers' })).toBeUndefined();
  });
});

describe('parseRetryAfter — concurrent safety', () => {
  it('multiple parallel calls produce independent results', () => {
    const headers1 = { 'retry-after': '10' };
    const headers2 = { 'retry-after-ms': '20000' };
    const r1 = parseRetryAfter(headers1, { attempt: 0, withJitter: false });
    const r2 = parseRetryAfter(headers2, { attempt: 0, withJitter: false });
    expect(r1.waitMs).toBe(10_000);
    expect(r2.waitMs).toBe(20_000);
    if (r1.type !== 'header' || r2.type !== 'header') return;
    expect(r1.source).toBe('retry-after-seconds');
    expect(r2.source).toBe('retry-after-ms');
  });
});
