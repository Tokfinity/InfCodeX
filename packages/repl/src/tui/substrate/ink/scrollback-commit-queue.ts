/**
 * FEATURE_214 Phase 2 — commit-once scrollback queue (the core logic).
 *
 * Codex `emitted_stable_len` / `PendingHistoryLines` model, made pure so it is
 * unit-testable in isolation from the engine's terminal writes (Phase 2b wires
 * the flush into engine.js's render loop via insert-history / DECSTBM).
 *
 * The discipline (spec docs/features/v0.7.46.md §4): a finalized history entry is
 * rendered to scrollback rows and inserted into native scrollback EXACTLY ONCE.
 * `entries[0..committedCount]` are NEVER re-rendered into the live cell-frame — the
 * root of the "same history visible in both scrollback and the current frame"
 * duplication. `committedCount` is monotonic; it only resets on a Phase 4 reflow
 * (resize), where every finalized entry is re-rendered at the new width.
 */

/** Monotonic commit bookkeeping. Immutable — `takePendingScrollback` returns a new state. */
export interface ScrollbackCommitState {
  /** Count of finalized ENTRIES already flushed to native scrollback. Never decreases except on a reflow reset. */
  readonly committedCount: number;
}

export const initialScrollbackCommitState: ScrollbackCommitState = { committedCount: 0 };

export interface PendingScrollback {
  /** Rendered rows of the newly-finalized entries, to insert into scrollback this frame. */
  readonly pendingScrollbackLines: readonly string[];
  /** Advanced commit state — `committedCount` now equals `finalizedEntries.length`. */
  readonly nextState: ScrollbackCommitState;
}

/**
 * Compute the rows to flush to scrollback this frame: only the finalized entries
 * BEYOND `committedCount`, rendered to rows at the current width by the caller-
 * supplied `renderEntryToRows` (so a width change is handled by the Phase 4 reflow
 * reset, not here). Entries already counted are never re-rendered.
 *
 * Pure: no terminal writes, no mutation of `state`.
 */
export function takePendingScrollback<Entry>(
  finalizedEntries: readonly Entry[],
  renderEntryToRows: (entry: Entry) => readonly string[],
  state: ScrollbackCommitState,
): PendingScrollback {
  // Clamp guards a never-expected shrink (finalized history is append-only); a
  // shrink without a reflow would otherwise re-flush already-committed rows.
  const committedCount = Math.min(state.committedCount, finalizedEntries.length);
  const newEntries = finalizedEntries.slice(committedCount);

  const pendingScrollbackLines: string[] = [];
  for (const entry of newEntries) {
    for (const row of renderEntryToRows(entry)) {
      pendingScrollbackLines.push(row);
    }
  }

  return {
    pendingScrollbackLines,
    nextState: { committedCount: finalizedEntries.length },
  };
}

/**
 * Phase 4 reflow: drop the committed bookkeeping so every finalized entry is
 * re-rendered at the new width and re-flushed on the next frame (the caller also
 * clears native scrollback with `ESC[3J` before re-flushing).
 */
export function resetScrollbackCommit(): ScrollbackCommitState {
  return initialScrollbackCommitState;
}
