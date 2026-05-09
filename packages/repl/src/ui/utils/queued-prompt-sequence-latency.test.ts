/**
 * FEATURE_149 Phase 1.4 (v0.7.38) — queued-prompt-sequence injection latency floor.
 *
 * The legacy `stageQueuedPrompt` floored every queued round at +50ms via
 * `await new Promise(r => setTimeout(r, 50))`. This test measures the
 * wall-clock between `runRound` resolving for round N and `runRound` being
 * invoked for round N+1, under a no-op `onBeforeQueuedRound`. The floor
 * must remain well below the legacy 50ms ceiling.
 *
 * Threshold rationale: 5ms gives generous headroom for slow CI hardware
 * while still catching any regression that re-introduces a 10ms+ artificial
 * wait. The actual floor on a typical dev machine is sub-millisecond.
 */

import { describe, it, expect } from "vitest";
import { runQueuedPromptSequence } from "./queued-prompt-sequence.js";

describe("queued-prompt-sequence latency floor", () => {
  // FEATURE_149 Phase B3 (v0.7.38): pending follow-ups now drain into a
  // SINGLE batched round, so a multi-prompt queue produces 1 handoff
  // measurement (round 1 → batched round 2). The old 50ms `setTimeout`
  // floor would have been observable across that single handoff just as
  // it was across N handoffs pre-B3.
  it("hands off from round N to round N+1 in < 5ms (no setTimeout floor)", async () => {
    const queue = ["round-2", "round-3", "round-4", "round-5"];
    const handoffMs: number[] = [];
    let lastRoundFinishedAt = 0;
    let roundIndex = 0;

    await runQueuedPromptSequence<void>({
      initialPrompt: "round-1",
      runRound: async () => {
        if (lastRoundFinishedAt !== 0) {
          handoffMs.push(performance.now() - lastRoundFinishedAt);
        }
        roundIndex += 1;
        await Promise.resolve();
        lastRoundFinishedAt = performance.now();
      },
      shiftPendingPrompt: () => queue.shift(),
      onBeforeQueuedRound: async () => {
        // No-op stand-in for `stageQueuedPrompt` — the production callback
        // performs synchronous React state writes, also sub-ms in cost.
      },
    });

    // Initial round + 1 batched round = 2 invocations; queue fully drained
    // in a single shift loop so we should observe exactly 1 handoff.
    expect(roundIndex).toBe(2);
    expect(handoffMs).toHaveLength(1);

    for (const ms of handoffMs) {
      expect(ms).toBeLessThan(5);
    }
  });

  it("with a 50ms setTimeout in onBeforeQueuedRound, handoff exceeds 50ms (sanity check)", async () => {
    // Pin the test to confirm the measurement methodology: re-introduce
    // the legacy setTimeout(50) deliberately and verify the test would
    // catch it. This guards against future false-negatives where the
    // measurement no longer reflects real handoff time.
    const queue = ["round-2"];
    let prevRoundEnd = 0;
    let measuredHandoff = 0;

    await runQueuedPromptSequence<void>({
      initialPrompt: "round-1",
      runRound: async () => {
        if (prevRoundEnd !== 0) {
          measuredHandoff = performance.now() - prevRoundEnd;
        }
        prevRoundEnd = performance.now();
      },
      shiftPendingPrompt: () => queue.shift(),
      onBeforeQueuedRound: async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      },
    });

    expect(measuredHandoff).toBeGreaterThanOrEqual(40); // some scheduler slack
  });
});
