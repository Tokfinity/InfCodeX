/**
 * FEATURE_121 (v0.7.40) — Envelope aggregate budget enforcer.
 *
 * Provides the coding-layer implementation of `EnvelopeAggregateEnforcer`
 * (a pure `string[] → string[] | Promise<string[]>` callback type
 * defined in `@kodax-ai/agent` `orchestration/idle-yield.ts`).
 *
 * The agent layer drains the background message queue and joins fragments
 * into one synthetic user message. Per-banner spillover already happens at
 * enqueue time (see `dispatch-child-tasks.ts` calling
 * `applyToolResultGuardrail('child_task_summary', ...)`); per-banner limit
 * is 50KB head + spill-to-file.
 *
 * The aggregate enforcer is the second line of defense: when N banners each
 * < 50KB still combine to exceed the envelope limit (e.g. 5×40KB = 200KB),
 * this hook forces additional banners to spill until the joined envelope
 * fits under the limit.
 *
 * Limit constant `ENVELOPE_AGGREGATE_LIMIT_BYTES` defaults to 200KB to
 * mirror claudecode's `MAX_TOOL_RESULTS_PER_MESSAGE_CHARS` (see
 * `c:/Works/claudecode/src/constants/toolLimits.ts:49`).
 *
 * Layer independence: this file lives in `@kodax-ai/coding`. The
 * `@kodax-ai/agent` side never imports it; it only accepts a callback of
 * the abstract `EnvelopeAggregateEnforcer` shape. Caller in
 * `runner-driven.ts` constructs the enforcer with the live
 * `KodaXToolExecutionContext` and passes it down via
 * `runWithIdleYield({ envelopeAggregateEnforcer })`.
 */

import type { EnvelopeAggregateEnforcer } from '@kodax-ai/agent';
import type { KodaXToolExecutionContext } from '../types.js';
import { applyToolResultGuardrail } from './tool-result-policy.js';

export const ENVELOPE_AGGREGATE_LIMIT_BYTES = 200 * 1024;

export function createEnvelopeAggregateBudgetEnforcer(
  ctx: KodaXToolExecutionContext,
): EnvelopeAggregateEnforcer {
  return async (fragments) => {
    // Fast path: total within budget, nothing to do.
    const total = fragments.reduce((sum, f) => sum + f.length, 0);
    if (total <= ENVELOPE_AGGREGATE_LIMIT_BYTES) return fragments;

    // Reclaim by force-spilling the largest fragments first until total fits.
    const indexed = fragments.map((content, idx) => ({ idx, content, size: content.length }));
    indexed.sort((a, b) => b.size - a.size);

    const result: string[] = [...fragments];
    let runningTotal = total;

    for (const item of indexed) {
      if (runningTotal <= ENVELOPE_AGGREGATE_LIMIT_BYTES) break;
      // forceSpill clamps the effective preview window to a small head/tail
      // window and routes through the spill-to-file path regardless of
      // `policy.maxBytes`. The replaced fragment is a short preview + the
      // absolute path Worker can Read on demand.
      const forced = await applyToolResultGuardrail(
        'child_task_summary',
        item.content,
        ctx,
        { forceSpill: true },
      );
      result[item.idx] = forced.content;
      runningTotal = runningTotal - item.size + forced.content.length;
    }

    return result;
  };
}
