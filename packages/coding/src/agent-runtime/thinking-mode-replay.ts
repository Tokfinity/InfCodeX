/**
 * Promise-signal split for thinking-mode replay — CAP-039
 *
 * Capability inventory: docs/features/v0.7.29-capability-inventory.md#cap-039-promise-signal-split-for-thinking-mode-replay
 *
 * Recognises the convention historically used by V1 managed-protocol
 * harnesses (Scout / Planner / Generator / Evaluator) to embed a single-line
 * signal at the end of an assistant turn — e.g. `[CONFIRMED H1_EXECUTE_EVAL]`.
 * Most of those downstream consumers (`scout-signals.ts`, in-chain Evaluator
 * gating) were retired in FEATURE_184 / FEATURE_193; the helper is kept as
 * the canonical signal-extraction primitive for any future consumer.
 *
 * Returns `[signal, residual]` where:
 *   - `signal`  — uppercased tag (e.g. `CONFIRMED`) or `''` when absent
 *   - `residual` — the second capture group from `PROMISE_PATTERN`, used
 *                  by callers that want the post-signal explanatory text
 *
 * The pattern is owned by `constants.ts` so any future tweak to the
 * grammar happens in one place.
 *
 * Migration history: extracted from `agent.ts:763-767` (pre-FEATURE_100 baseline)
 * during FEATURE_100 P2.
 */

import { PROMISE_PATTERN } from '../constants.js';

export function checkPromiseSignal(text: string): [string, string] {
  const match = PROMISE_PATTERN.exec(text);
  if (match) {
    return [match[1]!.toUpperCase(), match[2] ?? ''];
  }
  return ['', ''];
}
