import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_WINDOW_MS,
  ENV_VAR,
  readWindowFromEnv,
  speculativeRace,
} from './speculative.js';

const originalEnvValue = process.env[ENV_VAR];

afterEach(() => {
  if (originalEnvValue === undefined) {
    delete process.env[ENV_VAR];
  } else {
    process.env[ENV_VAR] = originalEnvValue;
  }
});

describe('readWindowFromEnv', () => {
  it('returns undefined when env var unset', () => {
    delete process.env[ENV_VAR];
    expect(readWindowFromEnv()).toBeUndefined();
  });

  it('returns undefined when env var empty string', () => {
    process.env[ENV_VAR] = '';
    expect(readWindowFromEnv()).toBeUndefined();
  });

  it('parses positive integer', () => {
    process.env[ENV_VAR] = '750';
    expect(readWindowFromEnv()).toBe(750);
  });

  it('returns 0 for 0 (disable)', () => {
    process.env[ENV_VAR] = '0';
    expect(readWindowFromEnv()).toBe(0);
  });

  it('coerces negative to 0', () => {
    process.env[ENV_VAR] = '-100';
    expect(readWindowFromEnv()).toBe(0);
  });

  it('returns undefined for non-numeric', () => {
    process.env[ENV_VAR] = 'fast';
    expect(readWindowFromEnv()).toBeUndefined();
  });

  it('floors fractional values', () => {
    process.env[ENV_VAR] = '500.9';
    expect(readWindowFromEnv()).toBe(500);
  });
});

describe('speculativeRace — promise wins window', () => {
  it('resolves with the value when promise settles fast', async () => {
    const promise = Promise.resolve('ok');
    const result = await speculativeRace(promise, 100);
    expect(result).toEqual({ kind: 'resolved', value: 'ok' });
  });

  it('resolves with the value when promise settles within window', async () => {
    const promise = new Promise<number>((resolve) => setTimeout(() => resolve(42), 10));
    const result = await speculativeRace(promise, 200);
    expect(result).toEqual({ kind: 'resolved', value: 42 });
  });
});

describe('speculativeRace — window expires first', () => {
  it('returns window-expired when promise outlasts window', async () => {
    const slow = new Promise<string>((resolve) => setTimeout(() => resolve('late'), 200));
    const result = await speculativeRace(slow, 20);
    expect(result.kind).toBe('window-expired');
  });

  it('the original promise can still be awaited after window expiry', async () => {
    const slow = new Promise<string>((resolve) => setTimeout(() => resolve('late-arrival'), 50));
    const raceResult = await speculativeRace(slow, 10);
    expect(raceResult.kind).toBe('window-expired');
    // Caller continues to await the same promise
    const eventual = await slow;
    expect(eventual).toBe('late-arrival');
  });
});

describe('speculativeRace — disabled (windowMs=0)', () => {
  it('waits forever for the promise when windowMs=0', async () => {
    const promise = new Promise<string>((resolve) => setTimeout(() => resolve('done'), 30));
    const result = await speculativeRace(promise, 0);
    expect(result).toEqual({ kind: 'resolved', value: 'done' });
  });

  it('reads windowMs=0 from env when arg omitted', async () => {
    process.env[ENV_VAR] = '0';
    const promise = new Promise<string>((resolve) => setTimeout(() => resolve('env-disabled'), 20));
    const result = await speculativeRace(promise);
    expect(result).toEqual({ kind: 'resolved', value: 'env-disabled' });
  });
});

describe('speculativeRace — precedence', () => {
  it('explicit arg wins over env', async () => {
    process.env[ENV_VAR] = '1000';
    // Explicit short window should expire even when env says 1000ms
    const slow = new Promise<string>((resolve) => setTimeout(() => resolve('late'), 100));
    const result = await speculativeRace(slow, 10);
    expect(result.kind).toBe('window-expired');
  });

  it('falls back to default when neither arg nor env supplied', async () => {
    delete process.env[ENV_VAR];
    expect(DEFAULT_WINDOW_MS).toBe(500);
    // Default 500ms — a 50ms promise should resolve in time.
    const promise = new Promise<string>((resolve) => setTimeout(() => resolve('within-default'), 50));
    const result = await speculativeRace(promise);
    expect(result).toEqual({ kind: 'resolved', value: 'within-default' });
  });
});

describe('speculativeRace — rejection handling', () => {
  it('propagates rejection when promise fails within window', async () => {
    const failing = Promise.reject(new Error('classifier blew up'));
    await expect(speculativeRace(failing, 100)).rejects.toThrow('classifier blew up');
  });

  it('absorbs late rejection silently (no UnhandledPromiseRejection)', async () => {
    // Promise rejects AFTER window expires. The race returns window-expired;
    // late rejection is swallowed by an internal no-op handler.
    const lateReject = new Promise<string>((_, reject) => setTimeout(() => reject(new Error('too-late')), 50));
    const result = await speculativeRace(lateReject, 10);
    expect(result.kind).toBe('window-expired');
    // Caller would await the original promise and catch the rejection there:
    await expect(lateReject).rejects.toThrow('too-late');
  });
});
