/**
 * FEATURE_192 v0.7.44 Phase B — 3-turn blocked-state validator.
 *
 * Codex `/goal` requires the agent to report the SAME blocker_kind
 * across 3 consecutive goal turns before `update_goal({status:
 * 'blocked'})` is accepted. KodaX implements this with both a prompt
 * rule (taught in the update_goal tool description) AND a runtime
 * counter (this module) so the model can't silently rush the blocked
 * state on a single-turn false signal.
 *
 * Pure functions over `KodaXGoalState.blockerTurnCount` +
 * `lastBlockerKind`. Each call returns the *next* counter values plus
 * an `allowed` flag the caller uses to gate the `update_goal({status:
 * 'blocked'})` tool. Persistence is the caller's responsibility.
 *
 * Why ADR-033 §1 quantitative-anchor exception: "3 turns" is a numeric
 * anchor tied to the runtime counter (physical state in code), not a
 * soft preference — see v0.7.44.md FEATURE_192 §3 audit notes.
 */

import type { KodaXGoalState } from '@kodax-ai/agent';

export interface BlockerAttemptResult {
  /** Whether the blocked-state transition is allowed THIS turn. */
  readonly allowed: boolean;
  /** New counter value to persist (1 / 2 / 3). */
  readonly nextCount: number;
  /** Blocker kind to persist on the next goal entry. */
  readonly nextKind: string;
  /** Human-readable status (also surfaced to the model on rejection). */
  readonly statusMessage: string;
}

const REQUIRED_CONSECUTIVE_TURNS = 3;

/**
 * Record an `update_goal({status:'blocked', blocker_kind})` attempt.
 *
 * Logic:
 *   - If the kind matches `lastBlockerKind`: increment the counter.
 *   - If the kind differs (or `lastBlockerKind` is null): reset to 1.
 *   - `allowed === true` iff the resulting counter reaches the 3-turn
 *     requirement.
 *
 * Returns a structured result so the caller can both gate the tool
 * AND persist the updated counter regardless of `allowed`. Persisting
 * the in-progress count is important — without it, a blocker that
 * spans a process restart would lose its history.
 */
export function recordBlockerAttempt(
  current: KodaXGoalState,
  blockerKind: string,
): BlockerAttemptResult {
  const trimmed = blockerKind.trim();
  if (trimmed.length === 0) {
    return {
      allowed: false,
      nextCount: current.blockerTurnCount,
      nextKind: current.lastBlockerKind ?? '',
      statusMessage:
        'blocker_kind must be a non-empty string describing the persistent obstacle.',
    };
  }
  const sameKind = current.lastBlockerKind === trimmed;
  const nextCount = sameKind ? current.blockerTurnCount + 1 : 1;
  const allowed = nextCount >= REQUIRED_CONSECUTIVE_TURNS;
  const statusMessage = allowed
    ? `blocked accepted (${nextCount}/${REQUIRED_CONSECUTIVE_TURNS} consecutive '${trimmed}' turns).`
    : `Blocked state requires the same blocker to persist across ${REQUIRED_CONSECUTIVE_TURNS} consecutive goal turns. Current count: ${nextCount}/${REQUIRED_CONSECUTIVE_TURNS} for '${trimmed}'.`;
  return { allowed, nextCount, nextKind: trimmed, statusMessage };
}

/**
 * Reset the blocker counter — called when the agent makes progress
 * (any non-blocker tool action that suggests the obstacle is gone).
 * The runtime middleware decides WHEN to reset; this is just the
 * canonical shape of the reset fields for `Object.assign` /
 * spread-into-persist patterns.
 */
export function resetBlockerCounter(): Pick<
  KodaXGoalState,
  'blockerTurnCount' | 'lastBlockerKind'
> {
  return { blockerTurnCount: 0, lastBlockerKind: null };
}

/** Exposed for tests / docs that need the canonical constant. */
export const BLOCKER_REQUIRED_CONSECUTIVE_TURNS = REQUIRED_CONSECUTIVE_TURNS;
