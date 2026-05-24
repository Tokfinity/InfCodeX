/**
 * v0.7.40 — buildManagedTaskCompactionHook parity tests.
 *
 * The pre-v0.7.40 hook had three structural gaps versus SA path's
 * `runCompactionLifecycle`:
 *
 *   1. Trigger check used `estimateTokens(transcript)` (transcript-only,
 *      excludes system + tools schema). With FEATURE_114's 4→2 role
 *      consolidation + FEATURE_161 Worker prompt growth, system+tools
 *      overhead grew to 20-35k tokens, making the transcript-only
 *      estimate systematically under-count by that margin. A 200K
 *      window's 60% trigger (120k) would never fire when API context
 *      was at 130-150k but transcript estimate was ~95-115k.
 *
 *   2. No `microcompact` phase. SA path ran microcompact every turn
 *      (zero LLM cost). AMA hook ran straight into LLM compact.
 *
 *   3. No `gracefulCompactDegradation` fallback. SA path's three-phase
 *      lifecycle (`compaction-orchestration.ts`) used graceful prune
 *      as the third phase when LLM compact threw / returned no diff /
 *      left context still high. AMA hook bailed silently after LLM
 *      failure, letting context grow unbounded.
 *
 * These tests pin all three behaviours so future drift fails a test
 * instead of silently regressing back to monotonic context growth.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@kodax-ai/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kodax-ai/agent')>();
  return {
    ...actual,
    compact: vi.fn(),
    microcompact: vi.fn(),
    gracefulCompactDegradation: vi.fn(),
  };
});

import {
  compact as mockedCompact,
  microcompact as mockedMicrocompact,
  gracefulCompactDegradation as mockedGracefulDegradation,
  type CompactionResult,
} from '@kodax-ai/agent';
import type { KodaXMessage } from '@kodax-ai/llm';
import type { KodaXContextTokenSnapshot, KodaXOptions } from '../../../types.js';
import {
  buildManagedTaskCompactionHook,
  type ContextTokenSnapshotRef,
} from './compaction.js';

const compactMock = mockedCompact as unknown as ReturnType<typeof vi.fn>;
const microcompactMock = mockedMicrocompact as unknown as ReturnType<typeof vi.fn>;
const gracefulDegradationMock = mockedGracefulDegradation as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  compactMock.mockReset();
  microcompactMock.mockReset();
  gracefulDegradationMock.mockReset();
  // Sensible defaults: identity pass-through (so the test surface only
  // overrides what it actually exercises).
  microcompactMock.mockImplementation((msgs) => msgs);
  gracefulDegradationMock.mockImplementation((msgs) => msgs);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeOptions(overrides: Partial<KodaXOptions> = {}): KodaXOptions {
  return {
    provider: 'anthropic',
    model: 'claude-test',
    events: {},
    ...overrides,
  } as KodaXOptions;
}

/**
 * Build a tiny transcript whose `estimateTokens` is negligible. The
 * trigger is forced via the snapshot's `currentTokens` carrying an
 * API-total above the threshold — that's the v0.7.40 bugfix path
 * being exercised. Keeping the transcript tiny avoids tiktoken
 * processing large strings in tests (the trigger check uses
 * `resolveContextTokenCount(transcript, snapshot)` which short-
 * circuits to `snapshot.currentTokens + small-delta` when transcript
 * is small).
 */
function buildLargeTranscript(): KodaXMessage[] {
  return [{ role: 'user', content: 'tiny but tagged as 150k via snapshot' }];
}

function snapshotAtApiTotal(
  apiTotal: number,
  messages: KodaXMessage[],
): KodaXContextTokenSnapshot {
  // Use the actual messages' estimate as the baseline so
  // `resolveContextTokenCount(transcript, snapshot)` returns
  // `apiTotal` when transcript equals messages.
  // estimateTokens of buildLargeTranscript() is roughly the message
  // chars / 4 + structural overhead.
  // We don't import the real function here to keep the test
  // self-contained — we read the actual baseline via dynamic import.
  // For the cold-start tests below we only need the API field.
  return {
    currentTokens: apiTotal,
    baselineEstimatedTokens:
      // approx — actual import below
      messages.reduce(
        (acc, m) =>
          acc
          + 4
          + (typeof m.content === 'string'
            ? Math.ceil(m.content.length / 4)
            : 0),
        0,
      ),
    source: 'api',
  };
}

describe('buildManagedTaskCompactionHook — v0.7.40 parity gaps', () => {
  describe('Phase 1: microcompact runs every call (even below trigger)', () => {
    it('returns microcompacted transcript when microcompact prunes and threshold not crossed', async () => {
      // Snapshot makes API total 50k — well below 120k trigger.
      // Microcompact returns a DIFFERENT array (simulates a pruned
      // tool_result block). Hook should return that array even
      // though LLM compact never runs.
      const messages: KodaXMessage[] = [
        { role: 'user', content: 'hi' },
      ];
      const prunedMessages: KodaXMessage[] = [
        { role: 'user', content: 'hi (post-microcompact)' },
      ];
      microcompactMock.mockReturnValueOnce(prunedMessages);

      const snapshotRef: ContextTokenSnapshotRef = {
        current: snapshotAtApiTotal(50_000, messages),
      };

      const hook = await buildManagedTaskCompactionHook(makeOptions(), {
        contextTokenSnapshotRef: snapshotRef,
      });
      const result = await hook!(messages);
      // Deep equality, not reference: the hook spreads the
      // microcompact output into its working array, so the returned
      // reference differs from `prunedMessages` even though contents
      // match. Runner.run's `compacted !== transcript` reference
      // check (runner.ts:730) still picks up the new array correctly.
      expect(result).toEqual(prunedMessages);
      expect(compactMock).not.toHaveBeenCalled();
    });

    it('returns undefined when microcompact made no changes and threshold not crossed', async () => {
      const messages: KodaXMessage[] = [{ role: 'user', content: 'hi' }];
      microcompactMock.mockReturnValueOnce(messages); // identity = no change

      const snapshotRef: ContextTokenSnapshotRef = {
        current: snapshotAtApiTotal(50_000, messages),
      };

      const hook = await buildManagedTaskCompactionHook(makeOptions(), {
        contextTokenSnapshotRef: snapshotRef,
      });
      const result = await hook!(messages);
      expect(result).toBeUndefined();
      expect(compactMock).not.toHaveBeenCalled();
    });
  });

  describe('Phase 2: trigger check uses snapshot-aware token accounting', () => {
    it('fires LLM compact when snapshot says API total > trigger (even if transcript-only estimate is below)', async () => {
      // Build a tiny transcript (~10 tokens) so transcript-only
      // estimate is far below 120k. Snapshot says API total is
      // 150k. Hook should trigger because the snapshot puts us
      // above the threshold.
      const messages: KodaXMessage[] = [{ role: 'user', content: 'tiny' }];
      const snapshotRef: ContextTokenSnapshotRef = {
        current: snapshotAtApiTotal(150_000, messages),
      };

      const successResult: CompactionResult = {
        compacted: true,
        messages: [{ role: 'user', content: 'compacted' }],
        tokensBefore: 150_000,
        tokensAfter: 50_000,
        entriesRemoved: 3,
        summary: 'summary',
        details: { readFiles: [], modifiedFiles: [] },
        artifactLedger: [],
        memorySeed: {
          objective: undefined,
          constraints: [],
          progress: { completed: [], inProgress: [], blockers: [] },
          keyDecisions: [],
          nextSteps: [],
          keyContext: [],
          importantTargets: [],
          tombstones: [],
        },
      };
      compactMock.mockResolvedValueOnce(successResult);

      const hook = await buildManagedTaskCompactionHook(makeOptions(), {
        contextTokenSnapshotRef: snapshotRef,
      });
      const result = await hook!(messages);
      expect(compactMock).toHaveBeenCalledTimes(1);
      expect(result).toEqual(successResult.messages);
    });

    it('does NOT fire LLM compact when no snapshot ref provided and transcript-only estimate is below trigger', async () => {
      // Without snapshot ref, hook falls back to raw estimate.
      // Tiny transcript → far below trigger → no compaction.
      const messages: KodaXMessage[] = [{ role: 'user', content: 'tiny' }];
      const hook = await buildManagedTaskCompactionHook(makeOptions());
      const result = await hook!(messages);
      expect(result).toBeUndefined();
      expect(compactMock).not.toHaveBeenCalled();
    });
  });

  describe('Phase 3: graceful degradation fallback', () => {
    it('falls back to graceful prune when LLM compact throws', async () => {
      const messages = buildLargeTranscript();
      const snapshotRef: ContextTokenSnapshotRef = {
        current: snapshotAtApiTotal(150_000, messages),
      };
      compactMock.mockRejectedValueOnce(new Error('zhipu LLM 400'));

      const prunedByGraceful: KodaXMessage[] = [
        { role: 'user', content: 'graceful prune' },
      ];
      gracefulDegradationMock.mockReturnValueOnce(prunedByGraceful);

      const hook = await buildManagedTaskCompactionHook(makeOptions(), {
        contextTokenSnapshotRef: snapshotRef,
      });
      const result = await hook!(messages);

      expect(compactMock).toHaveBeenCalledTimes(1);
      expect(gracefulDegradationMock).toHaveBeenCalledTimes(1);
      expect(result).toEqual(prunedByGraceful);
    });

    it('falls back to graceful prune when LLM compact returns compacted: false', async () => {
      const messages = buildLargeTranscript();
      const snapshotRef: ContextTokenSnapshotRef = {
        current: snapshotAtApiTotal(150_000, messages),
      };
      const noCompactResult: CompactionResult = {
        compacted: false,
        messages,
        tokensBefore: 150_000,
        tokensAfter: 150_000,
        entriesRemoved: 0,
      };
      compactMock.mockResolvedValueOnce(noCompactResult);

      const prunedByGraceful: KodaXMessage[] = [
        { role: 'user', content: 'graceful prune' },
      ];
      gracefulDegradationMock.mockReturnValueOnce(prunedByGraceful);

      const hook = await buildManagedTaskCompactionHook(makeOptions(), {
        contextTokenSnapshotRef: snapshotRef,
      });
      const result = await hook!(messages);

      expect(gracefulDegradationMock).toHaveBeenCalledTimes(1);
      expect(result).toEqual(prunedByGraceful);
    });

    it('falls back to graceful prune when LLM compact succeeded but tokensAfter is still over trigger × gapRatio', async () => {
      const messages = buildLargeTranscript();
      const snapshotRef: ContextTokenSnapshotRef = {
        current: snapshotAtApiTotal(150_000, messages),
      };
      // LLM "partial success" — compacted=true but tokensAfter
      // (~105k) is still above triggerTokens (120k) × 0.8 = 96k.
      // Graceful should still fire.
      const partialResult: CompactionResult = {
        compacted: true,
        messages,
        tokensBefore: 150_000,
        tokensAfter: 105_000,
        entriesRemoved: 1,
        summary: 'partial',
        details: { readFiles: [], modifiedFiles: [] },
        artifactLedger: [],
        memorySeed: {
          objective: undefined,
          constraints: [],
          progress: { completed: [], inProgress: [], blockers: [] },
          keyDecisions: [],
          nextSteps: [],
          keyContext: [],
          importantTargets: [],
          tombstones: [],
        },
      };
      compactMock.mockResolvedValueOnce(partialResult);

      const prunedByGraceful: KodaXMessage[] = [
        { role: 'user', content: 'graceful after partial' },
      ];
      gracefulDegradationMock.mockReturnValueOnce(prunedByGraceful);

      const hook = await buildManagedTaskCompactionHook(makeOptions(), {
        contextTokenSnapshotRef: snapshotRef,
      });
      const result = await hook!(messages);

      expect(gracefulDegradationMock).toHaveBeenCalledTimes(1);
      expect(result).toEqual(prunedByGraceful);
    });
  });

  describe('snapshot ref maintenance', () => {
    it('rebases snapshot to estimate after successful LLM compaction', async () => {
      const messages = buildLargeTranscript();
      const snapshotRef: ContextTokenSnapshotRef = {
        current: snapshotAtApiTotal(150_000, messages),
      };

      const compactedMessages: KodaXMessage[] = [
        { role: 'user', content: 'compacted small' },
      ];
      compactMock.mockResolvedValueOnce({
        compacted: true,
        messages: compactedMessages,
        tokensBefore: 150_000,
        tokensAfter: 50_000,
        entriesRemoved: 5,
        summary: 's',
        details: { readFiles: [], modifiedFiles: [] },
        artifactLedger: [],
        memorySeed: {
          objective: undefined,
          constraints: [],
          progress: { completed: [], inProgress: [], blockers: [] },
          keyDecisions: [],
          nextSteps: [],
          keyContext: [],
          importantTargets: [],
          tombstones: [],
        },
      } satisfies CompactionResult);

      const hook = await buildManagedTaskCompactionHook(makeOptions(), {
        contextTokenSnapshotRef: snapshotRef,
      });
      await hook!(messages);

      // Snapshot's currentTokens should now reflect the compacted
      // estimate (much smaller than 150k), not the original 150k.
      expect(snapshotRef.current).toBeDefined();
      expect(snapshotRef.current!.currentTokens).toBeLessThan(50_000);
      expect(snapshotRef.current!.source).toBe('estimate');
    });
  });

  describe('circuit breaker still works (3 strikes → skip LLM, graceful still fires)', () => {
    it('skips LLM compact after 3 consecutive failures but graceful still attempts prune', async () => {
      const messages = buildLargeTranscript();
      const snapshotRef: ContextTokenSnapshotRef = {
        current: snapshotAtApiTotal(150_000, messages),
      };
      const noCompactResult: CompactionResult = {
        compacted: false,
        messages,
        tokensBefore: 150_000,
        tokensAfter: 150_000,
        entriesRemoved: 0,
      };
      // First 3 calls return no-compact → counter climbs to 3.
      compactMock
        .mockResolvedValueOnce(noCompactResult)
        .mockResolvedValueOnce(noCompactResult)
        .mockResolvedValueOnce(noCompactResult);
      // Graceful no-op: return the SAME reference passed in (the
      // hook's spread copy `workingMessages`). Returning `messages`
      // (test-side reference) would compare unequal to the spread
      // copy and the hook would treat it as a successful prune,
      // rebasing the snapshot and skipping subsequent LLM retries.
      gracefulDegradationMock.mockImplementation((wm: KodaXMessage[]) => wm);

      const hook = await buildManagedTaskCompactionHook(makeOptions(), {
        contextTokenSnapshotRef: snapshotRef,
      });

      // First three calls — LLM tried each time, fails each time.
      await hook!(messages);
      await hook!(messages);
      await hook!(messages);
      expect(compactMock).toHaveBeenCalledTimes(3);

      // Fourth call — circuit breaker tripped, LLM skipped, but
      // graceful is still called.
      gracefulDegradationMock.mockClear();
      const degradedMessages: KodaXMessage[] = [
        { role: 'user', content: 'graceful after breaker' },
      ];
      gracefulDegradationMock.mockReturnValueOnce(degradedMessages);
      const result = await hook!(messages);
      expect(compactMock).toHaveBeenCalledTimes(3); // unchanged
      expect(gracefulDegradationMock).toHaveBeenCalledTimes(1);
      expect(result).toEqual(degradedMessages);
    });
  });

  describe('FEATURE_177 v0.7.42 — onPostCompact fires for read-file-state cache invalidation', () => {
    it('fires onPostCompact after a full LLM compaction succeeds', async () => {
      const messages = buildLargeTranscript();
      const snapshotRef: ContextTokenSnapshotRef = {
        current: snapshotAtApiTotal(150_000, messages),
      };
      compactMock.mockResolvedValueOnce({
        compacted: true,
        messages: [{ role: 'user', content: 'compacted' }],
        tokensBefore: 150_000,
        tokensAfter: 50_000,
        entriesRemoved: 3,
        summary: 's',
        details: { readFiles: [], modifiedFiles: [] },
        artifactLedger: [],
        memorySeed: {
          objective: undefined,
          constraints: [],
          progress: { completed: [], inProgress: [], blockers: [] },
          keyDecisions: [],
          nextSteps: [],
          keyContext: [],
          importantTargets: [],
          tombstones: [],
        },
      } satisfies CompactionResult);

      const onPostCompact = vi.fn();
      const hook = await buildManagedTaskCompactionHook(makeOptions(), {
        contextTokenSnapshotRef: snapshotRef,
        onPostCompact,
      });
      await hook!(messages);
      expect(onPostCompact).toHaveBeenCalledTimes(1);
    });

    it('fires onPostCompact after gracefulCompactDegradation prunes (LLM failed)', async () => {
      const messages = buildLargeTranscript();
      const snapshotRef: ContextTokenSnapshotRef = {
        current: snapshotAtApiTotal(150_000, messages),
      };
      compactMock.mockRejectedValueOnce(new Error('LLM 400'));
      gracefulDegradationMock.mockReturnValueOnce([
        { role: 'user', content: 'graceful' },
      ]);

      const onPostCompact = vi.fn();
      const hook = await buildManagedTaskCompactionHook(makeOptions(), {
        contextTokenSnapshotRef: snapshotRef,
        onPostCompact,
      });
      await hook!(messages);
      expect(onPostCompact).toHaveBeenCalledTimes(1);
    });

    it('fires onPostCompact when microcompact mutates below trigger (no LLM compact)', async () => {
      // This is the cache-stale-from-microcompact gap the user
      // surfaced: microcompact clears tool_results aged >= 20 turns
      // to `[Cleared: ...]` stubs without firing the compaction event
      // surface. If the readFileStateCache is not also cleared, it
      // returns "refer to your earlier read" stubs pointing at
      // tool_results whose actual content has been wiped → LLM is
      // stuck with neither cache content nor transcript content.
      const messages: KodaXMessage[] = [
        { role: 'user', content: 'tiny' },
      ];
      const microcompacted: KodaXMessage[] = [
        { role: 'user', content: 'tiny (post-microcompact)' },
      ];
      microcompactMock.mockReturnValueOnce(microcompacted);

      const snapshotRef: ContextTokenSnapshotRef = {
        current: snapshotAtApiTotal(50_000, messages), // below 120k trigger
      };

      const onPostCompact = vi.fn();
      const hook = await buildManagedTaskCompactionHook(makeOptions(), {
        contextTokenSnapshotRef: snapshotRef,
        onPostCompact,
      });
      const result = await hook!(messages);

      expect(result).toEqual(microcompacted);
      expect(compactMock).not.toHaveBeenCalled();
      expect(onPostCompact).toHaveBeenCalledTimes(1);
    });

    it('does NOT fire onPostCompact when microcompact made no changes and no LLM compaction', async () => {
      const messages: KodaXMessage[] = [{ role: 'user', content: 'tiny' }];
      microcompactMock.mockReturnValueOnce(messages); // identity = no change
      const snapshotRef: ContextTokenSnapshotRef = {
        current: snapshotAtApiTotal(50_000, messages),
      };

      const onPostCompact = vi.fn();
      const hook = await buildManagedTaskCompactionHook(makeOptions(), {
        contextTokenSnapshotRef: snapshotRef,
        onPostCompact,
      });
      await hook!(messages);
      expect(onPostCompact).not.toHaveBeenCalled();
    });

    it('fires onPostCompact when LLM throws + graceful no-op + microcompact mutated (above-trigger edge)', async () => {
      // needsCompact=true, LLM throws, graceful returns identity,
      // microcompact already did some work. Without the second branch
      // in compaction.ts:404, this edge would silently keep the
      // micro-pruned transcript while leaving the read cache pointing
      // at now-cleared tool_results.
      const messages = buildLargeTranscript();
      const microcompacted: KodaXMessage[] = [
        { role: 'user', content: 'tiny (post-microcompact)' },
      ];
      microcompactMock.mockReturnValueOnce(microcompacted);

      const snapshotRef: ContextTokenSnapshotRef = {
        current: snapshotAtApiTotal(150_000, messages),
      };
      compactMock.mockRejectedValueOnce(new Error('LLM threw'));
      // Graceful returns the same reference it got → degraded=false.
      gracefulDegradationMock.mockImplementation((wm: KodaXMessage[]) => wm);

      const onPostCompact = vi.fn();
      const hook = await buildManagedTaskCompactionHook(makeOptions(), {
        contextTokenSnapshotRef: snapshotRef,
        onPostCompact,
      });
      await hook!(messages);
      expect(onPostCompact).toHaveBeenCalledTimes(1);
    });

    it('swallows errors thrown by onPostCompact (cache bug must not crash the hook)', async () => {
      const messages: KodaXMessage[] = [{ role: 'user', content: 'tiny' }];
      microcompactMock.mockReturnValueOnce([
        { role: 'user', content: 'micro' },
      ]);
      const snapshotRef: ContextTokenSnapshotRef = {
        current: snapshotAtApiTotal(50_000, messages),
      };

      const onPostCompact = vi.fn(() => {
        throw new Error('cache went bang');
      });
      const hook = await buildManagedTaskCompactionHook(makeOptions(), {
        contextTokenSnapshotRef: snapshotRef,
        onPostCompact,
      });
      // Must not throw.
      await expect(hook!(messages)).resolves.toBeDefined();
      expect(onPostCompact).toHaveBeenCalledTimes(1);
    });
  });
});
