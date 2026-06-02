/**
 * FEATURE_216 v0.7.45 — Unit tests for the verify-credential orchestrator
 * and error classifier. Hits no upstream — every runner closure is a
 * synchronous Promise that throws a fake SDK-shaped error (or resolves
 * cleanly). Integration tests for real HTTP behavior live separately
 * in `verify-credential-integration.test.ts` (run only when
 * KODAX_INTEGRATION_TEST=1).
 */

import { describe, expect, it } from 'vitest';
import type { VerifyPrimitiveRunner } from './verify-credential.js';
import { classifyVerifyError, runVerifyCredential } from './verify-credential.js';

function fakeSdkError(opts: {
  status?: number;
  className?: string;
  message?: string;
  code?: string;
}): Error {
  const err: Error & {
    status?: number;
    code?: string;
    cause?: { code?: string };
  } = new Error(opts.message ?? `fake ${opts.status ?? 0}`);
  if (opts.className) {
    Object.defineProperty(err, 'constructor', {
      value: { name: opts.className },
      writable: true,
    });
  }
  if (opts.status !== undefined) err.status = opts.status;
  if (opts.code) err.cause = { code: opts.code };
  return err;
}

const okRunner: VerifyPrimitiveRunner = {
  strategy: 'count-tokens',
  approxTokensSpent: 0,
  run: async () => {
    /* succeed */
  },
};

describe('FEATURE_216 runVerifyCredential — orchestrator', () => {
  it('strategy="unsupported" → returns unsupported without calling any runner', async () => {
    const r = await runVerifyCredential({
      strategy: 'unsupported',
      runners: [okRunner],
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('unsupported');
    expect(r.strategy).toBe('unsupported');
    expect(r.approxTokensSpent).toBe(0);
    expect(r.durationMs).toBe(0);
  });

  it('strategy declared but no matching runner → unsupported with diagnostic message', async () => {
    const r = await runVerifyCredential({
      strategy: 'count-tokens',
      runners: [], // no runners installed
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('unsupported');
    expect(r.strategy).toBe('count-tokens');
    expect(r.message).toMatch(/not implemented/);
  });

  it('runner succeeds → ok:true + tokens + durationMs', async () => {
    const r = await runVerifyCredential({
      strategy: 'count-tokens',
      runners: [{
        strategy: 'count-tokens',
        approxTokensSpent: 0,
        run: async () => {},
      }],
    });
    expect(r.ok).toBe(true);
    expect(r.strategy).toBe('count-tokens');
    expect(r.approxTokensSpent).toBe(0);
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('runner with approxTokensSpent=7 (minimal-message) → reported in result', async () => {
    const r = await runVerifyCredential({
      strategy: 'minimal-message',
      runners: [{
        strategy: 'minimal-message',
        approxTokensSpent: 7,
        run: async () => {},
      }],
    });
    expect(r.ok).toBe(true);
    expect(r.approxTokensSpent).toBe(7);
  });

  it('runner throws 401 AuthenticationError → unauthorized', async () => {
    const r = await runVerifyCredential({
      strategy: 'count-tokens',
      runners: [{
        strategy: 'count-tokens',
        approxTokensSpent: 0,
        run: async () => {
          throw fakeSdkError({ status: 401, className: 'AuthenticationError', message: '401 Invalid Authentication' });
        },
      }],
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('unauthorized');
    expect(r.status).toBe(401);
    expect(r.message).toContain('Invalid Authentication');
  });

  it('runner throws 403 PermissionDeniedError (Anthropic) → unauthorized', async () => {
    const r = await runVerifyCredential({
      strategy: 'count-tokens',
      runners: [{
        strategy: 'count-tokens',
        approxTokensSpent: 0,
        run: async () => {
          throw fakeSdkError({ status: 403, className: 'PermissionDeniedError', message: '403 Request not allowed' });
        },
      }],
    });
    expect(r.error).toBe('unauthorized');
    expect(r.status).toBe(403);
  });

  it('kimi-code-style 400 AuthenticationError → unauthorized (class wins over status)', async () => {
    const r = await runVerifyCredential({
      strategy: 'count-tokens',
      runners: [{
        strategy: 'count-tokens',
        approxTokensSpent: 0,
        run: async () => {
          throw fakeSdkError({ status: 400, className: 'AuthenticationError', message: '400 Invalid request' });
        },
      }],
    });
    expect(r.error).toBe('unauthorized');
    expect(r.status).toBe(400);
  });

  it('5xx server error → server_error', async () => {
    const r = await runVerifyCredential({
      strategy: 'models-list',
      runners: [{
        strategy: 'models-list',
        approxTokensSpent: 0,
        run: async () => { throw fakeSdkError({ status: 503, message: 'service down' }); },
      }],
    });
    expect(r.error).toBe('server_error');
    expect(r.status).toBe(503);
  });

  it('ECONNREFUSED → network', async () => {
    const r = await runVerifyCredential({
      strategy: 'models-list',
      runners: [{
        strategy: 'models-list',
        approxTokensSpent: 0,
        run: async () => { throw fakeSdkError({ code: 'ECONNREFUSED', message: 'fetch failed' }); },
      }],
    });
    expect(r.error).toBe('network');
  });

  it('timeout fires when runner stalls → timeout', async () => {
    const r = await runVerifyCredential({
      strategy: 'count-tokens',
      timeoutMs: 30,
      runners: [{
        strategy: 'count-tokens',
        approxTokensSpent: 0,
        run: (signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(fakeSdkError({ message: 'aborted' })), { once: true });
          }),
      }],
    });
    expect(r.error).toBe('timeout');
  });

  it('parent signal abort → unknown (not timeout)', async () => {
    const parent = new AbortController();
    setTimeout(() => parent.abort(), 5);
    const r = await runVerifyCredential({
      strategy: 'count-tokens',
      signal: parent.signal,
      timeoutMs: 5000,
      runners: [{
        strategy: 'count-tokens',
        approxTokensSpent: 0,
        run: (signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(fakeSdkError({ message: 'aborted by parent' })), { once: true });
          }),
      }],
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('unknown');
  });

  it('already-aborted parent signal → immediate fail (does not call runner)', async () => {
    const parent = new AbortController();
    parent.abort();
    let runnerCalled = false;
    const r = await runVerifyCredential({
      strategy: 'count-tokens',
      signal: parent.signal,
      runners: [{
        strategy: 'count-tokens',
        approxTokensSpent: 0,
        run: async () => {
          runnerCalled = true;
        },
      }],
    });
    expect(runnerCalled).toBe(false);
    expect(r.ok).toBe(false);
  });
});

describe('FEATURE_216 classifyVerifyError — direct classifier coverage', () => {
  it('generic 400 (no AuthenticationError class) on minimal-message → unknown', () => {
    const err = fakeSdkError({ status: 400, message: '400 Bad Request' });
    const r = classifyVerifyError(err, {
      strategy: 'minimal-message',
      durationMs: 100,
      approxTokensSpent: 0,
    });
    expect(r.error).toBe('unknown');
    expect(r.status).toBe(400);
  });

  it('kimi-code-style 400 (no AuthenticationError class) on count-tokens → unauthorized (strategy-specific)', () => {
    // Empirical kimi-code behavior: count_tokens with bad key returns
    // 400 invalid_request_error rather than 401. The classifier maps
    // this ONLY when running count-tokens to avoid false positives.
    const err = fakeSdkError({ status: 400, message: '400 Invalid request Error' });
    const r = classifyVerifyError(err, {
      strategy: 'count-tokens',
      durationMs: 100,
      approxTokensSpent: 0,
    });
    expect(r.error).toBe('unauthorized');
    expect(r.status).toBe(400);
  });

  it('500 server error → server_error', () => {
    const r = classifyVerifyError(fakeSdkError({ status: 500 }), {
      strategy: 'count-tokens',
      durationMs: 50,
      approxTokensSpent: 0,
    });
    expect(r.error).toBe('server_error');
  });

  it('408 client error → unknown', () => {
    const r = classifyVerifyError(fakeSdkError({ status: 408 }), {
      strategy: 'count-tokens',
      durationMs: 50,
      approxTokensSpent: 0,
    });
    // 408 is not 401/403, not 5xx, not network — falls through to unknown
    expect(r.error).toBe('unknown');
    expect(r.status).toBe(408);
  });

  it('message contains "timeout" without abort cause → timeout', () => {
    const r = classifyVerifyError(new Error('socket hang up timeout'), {
      strategy: 'minimal-message',
      durationMs: 8000,
      approxTokensSpent: 0,
    });
    expect(r.error).toBe('timeout');
  });

  it('abortCause=timeout overrides any other signal → timeout', () => {
    const r = classifyVerifyError(fakeSdkError({ status: 500 }), {
      strategy: 'count-tokens',
      durationMs: 8000,
      approxTokensSpent: 0,
      abortCause: 'timeout',
    });
    expect(r.error).toBe('timeout');
  });

  it('message preserved (truncated to 240 chars)', () => {
    const long = 'X'.repeat(500);
    const r = classifyVerifyError(new Error(long), {
      strategy: 'count-tokens',
      durationMs: 0,
      approxTokensSpent: 0,
    });
    expect(r.message?.length).toBeLessThanOrEqual(240);
  });
});
