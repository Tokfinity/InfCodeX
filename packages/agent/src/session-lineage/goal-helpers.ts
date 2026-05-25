/**
 * FEATURE_192 v0.7.44 — goal-entry helpers for session lineage.
 *
 * Goals live in `lineage.entries` as `KodaXSessionGoalEntry` records
 * (non-navigable, like labels). Each lifecycle event appends a new
 * goal entry whose `parentId` references the message entry the goal
 * was attached AT — so a fork/rewind that abandons that message
 * also abandons the goal entry attached to it.
 *
 * **Active-branch resolution**: a goal entry counts as "on the active
 * branch" iff its `parentId` is the id of some entry on the active
 * lineage path. Latest-on-branch wins (largest timestamp).
 *
 * This module is intentionally tiny — it does NOT define goal
 * lifecycle policy (creation rules, completion gates, accounting).
 * Those live in `packages/coding/src/goal/` where the runtime
 * middleware composes them. The agent-layer concern is just "given a
 * lineage, what is the current goal?".
 */

import { randomUUID } from 'node:crypto';
import type {
  KodaXGoalEventType,
  KodaXGoalState,
  KodaXSessionEntry,
  KodaXSessionGoalEntry,
  KodaXSessionLineage,
} from '../types.js';
import { getSessionLineagePath } from './kodax-session-lineage.js';

/**
 * Walk the active branch (root → activeEntryId), collect every goal
 * entry whose parentId appears on that path, and return the latest
 * one (largest timestamp string). Returns `null` when no goal entry
 * is attached to the active branch.
 *
 * "Cleared" goals are still returned — callers check `entry.event`
 * / `entry.goal === null` to detect the cleared state. This lets the
 * UI distinguish "never set a goal" (returns null) from "user
 * explicitly cleared the goal" (returns a cleared entry).
 */
export function readLatestGoalFromBranch(
  lineage: KodaXSessionLineage,
): KodaXSessionGoalEntry | null {
  const path = getSessionLineagePath(lineage);
  if (path.length === 0) return null;
  const branchIds = new Set(path.map((e) => e.id));
  // Iterate in reverse so insertion order breaks timestamp ties — two
  // entries appended within the same millisecond produce identical ISO
  // timestamps; the later one in the array is causally later. Strict
  // `>` comparison previously stranded the second of such pairs.
  let latest: KodaXSessionGoalEntry | null = null;
  for (let i = lineage.entries.length - 1; i >= 0; i--) {
    const entry = lineage.entries[i];
    if (entry.type !== 'goal') continue;
    if (entry.parentId === null || !branchIds.has(entry.parentId)) continue;
    // First match in reverse iteration IS the latest by insertion order;
    // confirm timestamp non-decrease to guard against out-of-order writes.
    if (latest === null) {
      latest = entry;
      continue;
    }
    if (entry.timestamp > latest.timestamp) {
      latest = entry;
    }
  }
  return latest;
}

/**
 * Convenience accessor: return just the goal STATE (or null) without
 * the wrapping entry. Callers that don't care which event produced
 * the state use this.
 */
export function readLatestGoalState(
  lineage: KodaXSessionLineage,
): KodaXGoalState | null {
  const entry = readLatestGoalFromBranch(lineage);
  return entry?.goal ?? null;
}

const GOAL_ENTRY_ID_LENGTH = 12;

function makeGoalEntryId(): string {
  return randomUUID().replace(/-/g, '').slice(0, GOAL_ENTRY_ID_LENGTH);
}

/**
 * Append a new goal entry to `lineage.entries`, attaching it to the
 * current activeEntryId. Returns a fresh `KodaXSessionLineage` —
 * caller is responsible for persisting the updated lineage.
 *
 * `goal` may be `null` only when `event === 'cleared'`; the validator
 * enforces this invariant so callers can't accidentally append a
 * non-cleared entry without a state snapshot.
 */
export function appendGoalEntry(
  lineage: KodaXSessionLineage,
  goal: KodaXGoalState | null,
  event: KodaXGoalEventType,
  options: { timestamp?: string; id?: string } = {},
): KodaXSessionLineage {
  if (goal === null && event !== 'cleared') {
    throw new Error(
      `appendGoalEntry: goal=null is only valid when event='cleared', got event='${event}'`,
    );
  }
  if (goal !== null && event === 'cleared') {
    throw new Error(
      `appendGoalEntry: event='cleared' requires goal=null, got goal with id='${goal.id}'`,
    );
  }
  const entry: KodaXSessionGoalEntry = {
    type: 'goal',
    id: options.id ?? makeGoalEntryId(),
    parentId: lineage.activeEntryId,
    timestamp: options.timestamp ?? new Date().toISOString(),
    goal,
    event,
  };
  return {
    ...lineage,
    entries: [...lineage.entries, entry],
  };
}

/**
 * Visible for tests / debugging: predicate matching goal entries.
 */
export function isGoalEntry(
  entry: KodaXSessionEntry,
): entry is KodaXSessionGoalEntry {
  return entry.type === 'goal';
}
