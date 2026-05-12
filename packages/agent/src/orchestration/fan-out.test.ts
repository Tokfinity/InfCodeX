/**
 * Unit tests for `runFanOut` (agent-layer concurrency-bounded fan-out).
 *
 * Pin set covers each capability the v0.7.39 Phase 1d audit identified:
 *
 *   1. Empty bundles → empty result (no events fired).
 *   2. Single bundle (degenerate case — current `executeChildAgents`
 *      production calling pattern).
 *   3. Multi-bundle concurrent within `maxParallel`.
 *   4. Concurrency ceiling actually limits in-flight count.
 *   5. Rejection capture: failed `runOne` lands in `results` with
 *      `status: 'rejected'`.
 *   6. Abort pre-execution: aborts AFTER some bundles started → only
 *      not-yet-started bundles join `cancelled`.
 *   7. Progress event sequence: per-bundle `start` → `item-done` /
 *      `item-failed` with monotonically-increasing `completedCount`.
 *   8. Bundles array is referenced (not cloned) — bundle reference
 *      identity preserved through outcomes + events.
 *   9. maxParallel < 1 throws.
 */

import { describe, expect, it } from 'vitest';

import {
  runFanOut,
  type FanOutProgressEvent,
  type RunFanOutResult,
} from './fan-out.js';

interface Bundle {
  readonly id: string;
  readonly delay?: number;
}

describe('runFanOut — degenerate cases', () => {
  it('returns empty result + zero events for empty bundles', async () => {
    const events: Array<FanOutProgressEvent<Bundle, string>> = [];
    const result = await runFanOut<Bundle, string>({
      bundles: [],
      runOne: async () => 'unreachable',
      maxParallel: 4,
      onProgress: (event) => events.push(event),
    });

    expect(result.results).toEqual([]);
    expect(result.cancelled).toEqual([]);
    expect(events).toEqual([]);
  });

  it('handles single-bundle input (current executeChildAgents call pattern)', async () => {
    const bundle: Bundle = { id: 'only' };
    const events: Array<FanOutProgressEvent<Bundle, string>> = [];

    const result = await runFanOut<Bundle, string>({
      bundles: [bundle],
      runOne: async (b) => `ran-${b.id}`,
      maxParallel: 4,
      onProgress: (event) => events.push(event),
    });

    expect(result.results).toHaveLength(1);
    expect(result.cancelled).toEqual([]);
    const r = result.results[0]!;
    expect(r.status).toBe('fulfilled');
    if (r.status === 'fulfilled') {
      expect(r.bundle).toBe(bundle); // reference identity
      expect(r.value).toBe('ran-only');
    }
    expect(events.map((e) => e.kind)).toEqual(['start', 'item-done']);
  });

  it('throws on maxParallel < 1', async () => {
    await expect(
      runFanOut<Bundle, string>({
        bundles: [{ id: 'a' }],
        runOne: async () => 'x',
        maxParallel: 0,
      }),
    ).rejects.toThrow(/maxParallel must be/);
  });
});

describe('runFanOut — concurrency', () => {
  it('runs up to maxParallel bundles concurrently', async () => {
    const bundles: Bundle[] = Array.from({ length: 6 }, (_, i) => ({
      id: `b${i}`,
    }));
    let inFlight = 0;
    let peak = 0;

    await runFanOut<Bundle, void>({
      bundles,
      runOne: async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 10));
        inFlight--;
      },
      maxParallel: 3,
    });

    // With 6 bundles + maxParallel=3, peak in-flight is exactly 3.
    expect(peak).toBe(3);
  });

  it('strict-serial when maxParallel=1', async () => {
    const bundles: Bundle[] = Array.from({ length: 4 }, (_, i) => ({
      id: `b${i}`,
    }));
    let inFlight = 0;
    let peak = 0;

    await runFanOut<Bundle, void>({
      bundles,
      runOne: async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 2));
        inFlight--;
      },
      maxParallel: 1,
    });

    expect(peak).toBe(1);
  });
});

describe('runFanOut — rejection capture', () => {
  it('captures runOne rejection in results with status=rejected', async () => {
    const bundles: Bundle[] = [
      { id: 'ok-1' },
      { id: 'fail' },
      { id: 'ok-2' },
    ];
    const errBundle = bundles[1]!;

    const result = await runFanOut<Bundle, string>({
      bundles,
      runOne: async (b) => {
        if (b.id === 'fail') throw new Error('runOne boom');
        return `ran-${b.id}`;
      },
      maxParallel: 3,
    });

    expect(result.results).toHaveLength(3);
    const failed = result.results.find((r) => r.status === 'rejected');
    expect(failed).toBeDefined();
    if (failed && failed.status === 'rejected') {
      expect(failed.bundle).toBe(errBundle);
      expect(failed.reason).toBeInstanceOf(Error);
      expect(failed.reason.message).toBe('runOne boom');
    }
    const successes = result.results.filter((r) => r.status === 'fulfilled');
    expect(successes).toHaveLength(2);
  });

  it('coerces non-Error rejections to Error instances', async () => {
    const result = await runFanOut<Bundle, string>({
      bundles: [{ id: 'a' }],
      runOne: async () => {
        throw 'a string';
      },
      maxParallel: 1,
    });
    expect(result.results).toHaveLength(1);
    const r = result.results[0]!;
    expect(r.status).toBe('rejected');
    if (r.status === 'rejected') {
      expect(r.reason).toBeInstanceOf(Error);
      expect(r.reason.message).toBe('a string');
    }
  });
});

describe('runFanOut — abort handling', () => {
  it('skips bundles waiting on semaphore when abort fires; in-flight finish normally', async () => {
    const bundles: Bundle[] = Array.from({ length: 6 }, (_, i) => ({
      id: `b${i}`,
    }));
    const ac = new AbortController();
    const ran: string[] = [];

    // maxParallel=2 — bundles 0/1 start immediately, 2/3/4/5 wait.
    // Abort fires after first wave; only 0/1 finish; 2/3/4/5 should
    // be cancelled.
    const promise = runFanOut<Bundle, string>({
      bundles,
      runOne: async (b) => {
        ran.push(b.id);
        await new Promise((r) => setTimeout(r, 20));
        return `ran-${b.id}`;
      },
      maxParallel: 2,
      abortSignal: ac.signal,
    });

    // Fire abort after 5ms — bundles 0/1 are in-flight; 2/3/4/5
    // are still waiting on the semaphore.
    setTimeout(() => ac.abort(), 5);

    const result = await promise;
    expect(ran).toEqual(['b0', 'b1']);
    expect(result.results).toHaveLength(2);
    // Only the first 2 are fulfilled; the remaining 4 join cancelled.
    expect(result.cancelled).toHaveLength(4);
    expect(result.cancelled.map((b) => b.id)).toEqual(['b2', 'b3', 'b4', 'b5']);
  });

  it('all-aborted before any start → all bundles cancelled, results empty', async () => {
    const ac = new AbortController();
    ac.abort();

    const bundles: Bundle[] = [{ id: 'a' }, { id: 'b' }];
    let ranCount = 0;

    const result = await runFanOut<Bundle, string>({
      bundles,
      runOne: async () => {
        ranCount++;
        return 'unreachable';
      },
      maxParallel: 4,
      abortSignal: ac.signal,
    });

    expect(ranCount).toBe(0);
    expect(result.results).toEqual([]);
    expect(result.cancelled.map((b) => b.id)).toEqual(['a', 'b']);
  });
});

describe('runFanOut — progress events', () => {
  it('fires start + item-done per bundle with monotonic completedCount', async () => {
    const bundles: Bundle[] = [
      { id: 'a' },
      { id: 'b' },
      { id: 'c' },
    ];
    const events: Array<{
      kind: string;
      bundleId: string;
      completedCount: number;
      totalCount: number;
    }> = [];

    await runFanOut<Bundle, string>({
      bundles,
      runOne: async (b) => `ran-${b.id}`,
      maxParallel: 1, // strict-serial to make event order deterministic
      onProgress: (event, ctx) => {
        events.push({
          kind: event.kind,
          bundleId: event.bundle.id,
          completedCount: ctx.completedCount,
          totalCount: ctx.totalCount,
        });
      },
    });

    // Strict-serial: a starts (completed=0), a done (completed=1),
    // b starts (completed=1), b done (completed=2), c starts
    // (completed=2), c done (completed=3).
    expect(events).toEqual([
      { kind: 'start', bundleId: 'a', completedCount: 0, totalCount: 3 },
      { kind: 'item-done', bundleId: 'a', completedCount: 1, totalCount: 3 },
      { kind: 'start', bundleId: 'b', completedCount: 1, totalCount: 3 },
      { kind: 'item-done', bundleId: 'b', completedCount: 2, totalCount: 3 },
      { kind: 'start', bundleId: 'c', completedCount: 2, totalCount: 3 },
      { kind: 'item-done', bundleId: 'c', completedCount: 3, totalCount: 3 },
    ]);
  });

  it('fires item-failed instead of item-done on rejection', async () => {
    const events: string[] = [];
    await runFanOut<Bundle, string>({
      bundles: [{ id: 'a' }],
      runOne: async () => {
        throw new Error('boom');
      },
      maxParallel: 1,
      onProgress: (event, ctx) => {
        events.push(`${event.kind}@${ctx.completedCount}/${ctx.totalCount}`);
      },
    });

    expect(events).toEqual(['start@0/1', 'item-failed@1/1']);
  });
});
