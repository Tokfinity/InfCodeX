import { describe, it, expect } from "vitest";
import {
  initialScrollbackCommitState,
  takePendingScrollback,
  resetScrollbackCommit,
  type ScrollbackCommitState,
} from "./scrollback-commit-queue.js";

/**
 * FEATURE_214 Phase 2 — commit-once scrollback queue core.
 *
 * The two spec invariants this guards (docs/features/v0.7.46.md §4 + §5 tests):
 *   - new finalized history is inserted into scrollback EXACTLY ONCE;
 *   - already-committed history is NEVER re-emitted on a re-render (spinner tick,
 *     keystroke) — the duplication root.
 */

// Each "entry" is a finalized history item; render it to N scrollback rows.
const oneRow = (e: string): readonly string[] => [e];
const rowsOf = (e: { id: string; rows: number }): readonly string[] =>
  Array.from({ length: e.rows }, (_, i) => `${e.id}#${i}`);

describe("scrollback-commit-queue (FEATURE_214 Phase 2 core)", () => {
  it("empty history → no pending, committedCount stays 0", () => {
    const { pendingScrollbackLines, nextState } = takePendingScrollback(
      [],
      oneRow,
      initialScrollbackCommitState,
    );
    expect(pendingScrollbackLines).toEqual([]);
    expect(nextState.committedCount).toBe(0);
  });

  it("first flush emits ALL finalized rows and advances committedCount to length", () => {
    const { pendingScrollbackLines, nextState } = takePendingScrollback(
      ["a", "b", "c"],
      oneRow,
      initialScrollbackCommitState,
    );
    expect(pendingScrollbackLines).toEqual(["a", "b", "c"]);
    expect(nextState.committedCount).toBe(3);
  });

  it("INVARIANT: re-render with the SAME finalized entries emits NOTHING (no re-emit on spinner/input)", () => {
    const entries = ["a", "b", "c"];
    // Frame 1: commit all three.
    const first = takePendingScrollback(entries, oneRow, initialScrollbackCommitState);
    expect(first.pendingScrollbackLines).toEqual(["a", "b", "c"]);

    // Frames 2..N: a spinner tick / keystroke re-renders with the SAME entries.
    let state = first.nextState;
    for (let i = 0; i < 5; i++) {
      const again = takePendingScrollback(entries, oneRow, state);
      expect(again.pendingScrollbackLines).toEqual([]); // committed history never re-emitted
      expect(again.nextState.committedCount).toBe(3);
      state = again.nextState;
    }
  });

  it("INVARIANT: only NEWLY-finalized entries are flushed (incremental commit)", () => {
    const state0 = initialScrollbackCommitState;
    const f1 = takePendingScrollback(["a", "b", "c"], oneRow, state0);
    expect(f1.pendingScrollbackLines).toEqual(["a", "b", "c"]);

    // Two more messages finalized.
    const f2 = takePendingScrollback(["a", "b", "c", "d", "e"], oneRow, f1.nextState);
    expect(f2.pendingScrollbackLines).toEqual(["d", "e"]); // ONLY the new ones
    expect(f2.nextState.committedCount).toBe(5);
  });

  it("multi-row entries: each new entry contributes all its rendered rows, once", () => {
    const entries = [
      { id: "m0", rows: 2 },
      { id: "m1", rows: 3 },
    ];
    const f1 = takePendingScrollback(entries, rowsOf, initialScrollbackCommitState);
    expect(f1.pendingScrollbackLines).toEqual(["m0#0", "m0#1", "m1#0", "m1#1", "m1#2"]);
    expect(f1.nextState.committedCount).toBe(2);

    const f2 = takePendingScrollback(
      [...entries, { id: "m2", rows: 1 }],
      rowsOf,
      f1.nextState,
    );
    expect(f2.pendingScrollbackLines).toEqual(["m2#0"]);
  });

  it("reflow reset → committedCount back to 0 so all entries re-render at the new width", () => {
    const committed: ScrollbackCommitState = { committedCount: 9 };
    const reset = resetScrollbackCommit();
    expect(reset.committedCount).toBe(0);

    const afterReflow = takePendingScrollback(["x", "y"], oneRow, reset);
    expect(afterReflow.pendingScrollbackLines).toEqual(["x", "y"]);
    expect(afterReflow.nextState.committedCount).toBe(2);
    // (committed only referenced to assert reset is independent of prior state)
    expect(committed.committedCount).toBe(9);
  });

  it("clamps a never-expected shrink so committed rows are not re-flushed", () => {
    // committedCount ahead of the (shrunk) entries — guard against re-emit.
    const { pendingScrollbackLines, nextState } = takePendingScrollback(
      ["a", "b"],
      oneRow,
      { committedCount: 5 },
    );
    expect(pendingScrollbackLines).toEqual([]);
    expect(nextState.committedCount).toBe(2);
  });
});
