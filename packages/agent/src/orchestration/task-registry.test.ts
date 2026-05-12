/**
 * Unit tests for the agent-layer ChildTaskRegistry primitive.
 *
 * Pin set:
 *   - Happy-path registration + automatic cleanup on resolve (Bug A
 *     hotfix `c1bdaf4e` regression guard, agent-layer mirror of
 *     `packages/coding/src/tools/async-dispatch.test.ts`'s pin).
 *   - Crash-path cleanup on reject (Bug A crash branch).
 *   - Rejection of an in-flight child is NOT surfaced as
 *     `unhandledRejection` even when the caller never awaits.
 *   - Duplicate `task_id` throws (helper does NOT silently
 *     overwrite — that would orphan the in-flight promise).
 */

import { describe, expect, it } from 'vitest';

import { type ChildTaskRegistry, registerChildTask } from './task-registry.js';

/** Convenience: yields the microtask queue twice. */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('registerChildTask — agent-layer ChildTaskRegistry primitive', () => {
  it('adds the promise under task_id and cleans up on resolve (Bug A happy path)', async () => {
    const registry: ChildTaskRegistry<{ summary: string }> = new Map();
    let resolveChild!: (value: { summary: string }) => void;
    const childPromise = new Promise<{ summary: string }>((resolve) => {
      resolveChild = resolve;
    });

    registerChildTask(registry, 'c1', childPromise);
    // In-flight — entry must be present so the idle-yield outer loop
    // can wrap it on the next race.
    expect(registry.has('c1')).toBe(true);

    resolveChild({ summary: 'done' });
    // Await the child promise so the cleanup `.finally` is reachable,
    // then flush one extra microtask cycle so the cleanup runs before
    // we inspect (the cleanup runs in the microtask queue alongside
    // any consumer `.then`/`.finally`).
    await registry.get('c1');
    await flushMicrotasks();

    expect(registry.has('c1')).toBe(false);
  });

  it('cleans up on reject without surfacing unhandledRejection (Bug A crash branch)', async () => {
    const registry: ChildTaskRegistry<{ summary: string }> = new Map();
    let rejectChild!: (err: Error) => void;
    const childPromise = new Promise<{ summary: string }>((_resolve, reject) => {
      rejectChild = reject;
    });

    registerChildTask(registry, 'c2', childPromise);
    expect(registry.has('c2')).toBe(true);

    // Note: we deliberately do NOT attach a consumer `.catch` here —
    // the helper's `.catch(() => {})` on the cleanup chain is the
    // load-bearing piece that prevents the rejection from
    // surfacing as `unhandledRejection`. Track unhandled rejections
    // on process so the test fails loud if the helper regresses.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    try {
      rejectChild(new Error('boom'));
      // Drain the rejection through registry.get's `.catch` so the
      // node test runner doesn't pick it up itself.
      await registry.get('c2')?.catch(() => undefined);
      await flushMicrotasks();

      expect(registry.has('c2')).toBe(false);
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('throws when task_id is already in flight (no silent overwrite)', () => {
    const registry: ChildTaskRegistry<{ summary: string }> = new Map();
    const first = new Promise<{ summary: string }>(() => {});
    const second = new Promise<{ summary: string }>(() => {});

    registerChildTask(registry, 'dup', first);
    expect(() => registerChildTask(registry, 'dup', second)).toThrowError(
      /already in flight/,
    );
    // First entry MUST still be the registered one — the helper must
    // not partially-mutate the registry on the throwing path.
    expect(registry.get('dup')).toBe(first);
  });

  it('multiple concurrent registrations all clean up independently', async () => {
    const registry: ChildTaskRegistry<number> = new Map();
    const resolvers: Array<(value: number) => void> = [];
    for (let i = 0; i < 5; i++) {
      const p = new Promise<number>((resolve) => resolvers.push(resolve));
      registerChildTask(registry, `c${i}`, p);
    }
    expect(registry.size).toBe(5);

    // Settle out of order — cleanup must still match each entry to
    // the right id.
    resolvers[2]?.(20);
    resolvers[0]?.(0);
    resolvers[4]?.(40);
    resolvers[1]?.(10);
    resolvers[3]?.(30);
    await Promise.all(Array.from(registry.values()));
    await flushMicrotasks();

    expect(registry.size).toBe(0);
  });

  it('cleanup does not run before the promise settles', async () => {
    const registry: ChildTaskRegistry<string> = new Map();
    const childPromise = new Promise<string>(() => {});

    registerChildTask(registry, 'long-running', childPromise);
    // Flush microtasks several times — the cleanup must NOT run
    // until the underlying promise settles. This guards against an
    // accidental "delete on register" bug.
    await flushMicrotasks();
    await flushMicrotasks();
    expect(registry.has('long-running')).toBe(true);
  });
});
