/**
 * v0.7.41 — spinner-tail wall-clock origin lifecycle.
 *
 * `roundStartedAt` powers the inline `(Ns · ↓ T tokens)` stats tail
 * rendered after the live spinner row. The semantics must match the
 * claudecode `loadingStartTimeRef` pattern
 * (`c:/Works/claudecode/src/screens/REPL.tsx:932-953`): captured on
 * round-start, cleared on round-end (whether successful, aborted, or
 * reset), preserved across iteration changes within a round.
 */
import {
  _resetMessageQueueForTests,
} from "@kodax-ai/agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createStreamingManager } from "./StreamingContext.js";

describe("StreamingContext.roundStartedAt lifecycle (v0.7.41)", () => {
  beforeEach(() => {
    _resetMessageQueueForTests();
  });
  afterEach(() => {
    _resetMessageQueueForTests();
  });

  it("starts as null in the default state", () => {
    const mgr = createStreamingManager();
    expect(mgr.getState().roundStartedAt).toBe(null);
    mgr.dispose();
  });

  it("captures Date.now() on startStreaming", () => {
    const mgr = createStreamingManager();
    const before = Date.now();
    mgr.startStreaming();
    const after = Date.now();

    const captured = mgr.getState().roundStartedAt;
    expect(captured).not.toBe(null);
    expect(captured).toBeGreaterThanOrEqual(before);
    expect(captured).toBeLessThanOrEqual(after);
    mgr.dispose();
  });

  it("clears to null on stopStreaming", () => {
    const mgr = createStreamingManager();
    mgr.startStreaming();
    expect(mgr.getState().roundStartedAt).not.toBe(null);
    mgr.stopStreaming();
    expect(mgr.getState().roundStartedAt).toBe(null);
    mgr.dispose();
  });

  it("clears to null on abort()", () => {
    const mgr = createStreamingManager();
    mgr.startStreaming();
    expect(mgr.getState().roundStartedAt).not.toBe(null);
    mgr.abort();
    expect(mgr.getState().roundStartedAt).toBe(null);
    mgr.dispose();
  });

  it("clears to null on abort with preservePendingInputs (queue preserved, timing not)", () => {
    const mgr = createStreamingManager();
    mgr.startStreaming();
    mgr.abort({ preservePendingInputs: true });
    expect(mgr.getState().roundStartedAt).toBe(null);
    mgr.dispose();
  });

  it("clears to null on reset (full reset semantics)", () => {
    const mgr = createStreamingManager();
    mgr.startStreaming();
    expect(mgr.getState().roundStartedAt).not.toBe(null);
    mgr.reset();
    expect(mgr.getState().roundStartedAt).toBe(null);
    mgr.dispose();
  });

  it("startStreaming after a prior round captures a fresh timestamp", () => {
    const mgr = createStreamingManager();
    mgr.startStreaming();
    const first = mgr.getState().roundStartedAt!;
    expect(first).not.toBe(null);
    mgr.stopStreaming();

    // Brief pause so the wall clock advances enough to be observable.
    const wait = 5;
    const target = Date.now() + wait;
    while (Date.now() < target) {
      // spin (vitest doesn't expose fake timers here by default)
    }

    mgr.startStreaming();
    const second = mgr.getState().roundStartedAt!;
    expect(second).not.toBe(null);
    expect(second).toBeGreaterThan(first);
    mgr.dispose();
  });

  it("startNewIteration does NOT clear roundStartedAt (whole-query elapsed semantics)", () => {
    const mgr = createStreamingManager();
    mgr.startStreaming();
    const captured = mgr.getState().roundStartedAt!;
    expect(captured).not.toBe(null);
    // Append something so the iteration-clear branch runs.
    mgr.appendResponse("hello");
    mgr.startNewIteration(2);
    expect(mgr.getState().roundStartedAt).toBe(captured);
    mgr.dispose();
  });
});
