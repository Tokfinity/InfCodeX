/**
 * FEATURE_125 (v0.7.41) — Process-level singleton for Team Mode.
 *
 * One KodaX process owns at most one `StateWriter` instance. Consumers
 * scattered across the codebase (REPL bootstrap, tool execution
 * contexts, runner-driven adapter, todo store) need a shared handle
 * without threading the writer through every signature. This module
 * is the canonical accessor:
 *
 *   - `setActiveTeamModeWriter(writer)` — REPL bootstrap calls this
 *     once after `createStateWriter`.
 *   - `getActiveTeamModeWriter()` — any module asks the singleton for
 *     the live writer (or null when Team Mode is disabled / hasn't
 *     bootstrapped yet).
 *   - `updateActiveTeamMode(patch)` — convenience for "I want to
 *     bump current_intent / active_files; do nothing if no writer".
 *
 * Mirrors the `activeExtensionRuntime` singleton pattern in
 * `packages/coding/src/extensions/runtime.ts` so familiarity is
 * preserved.
 */

import type { SessionStateSnapshot, StateWriter } from './state-writer.js';

let activeWriter: StateWriter | null = null;

export function setActiveTeamModeWriter(writer: StateWriter | null): void {
  activeWriter = writer;
}

export function getActiveTeamModeWriter(): StateWriter | null {
  return activeWriter;
}

/**
 * Convenience: if a writer is active, merge `patch` into its state +
 * flush. No-op when Team Mode is disabled (no writer was bootstrapped,
 * or `KODAX_DISABLE_MULTI_INSTANCE=1` short-circuited the bootstrap).
 */
export function updateActiveTeamMode(patch: Partial<SessionStateSnapshot>): void {
  activeWriter?.update(patch);
}
