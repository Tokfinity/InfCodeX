/**
 * v0.7.35.1 FEATURE_142 Batch D — Runtime middleware barrel.
 *
 * Generic, agent-flavor-agnostic substrate middleware uplifted from
 * `@kodax/coding/src/agent-runtime/` per the Batch D narrowed scope (4
 * files: only those whose dependencies are pure `@kodax/ai` +
 * `@kodax/session-lineage` + agent-internal). The other 8 middleware
 * files in coding/agent-runtime/ remain there because they couple to
 * `KodaXEvents` / `KodaXToolExecutionContext` / `KodaXManagedProtocolPayload`
 * / coding TOOL_REGISTRY / extension hook / managed-protocol signals
 * (see docs/features/v0.7.35.1.md "Batch D" for the per-file
 * disposition).
 *
 * Coding callers can keep importing these symbols at their existing
 * sites — `@kodax/coding`'s `index.ts` re-exports them at the same
 * names. Future agent consumers (e.g. `@kodax/data-analysis-agent`)
 * import directly from `@kodax/agent`.
 */

export { shouldCompact } from './compaction-trigger.js';
export type { ShouldCompactInput } from './compaction-trigger.js';

export { gracefulCompactDegradation } from './compaction-fallback.js';

export {
  resolveContextWindow,
  DEFAULT_CONTEXT_WINDOW,
} from './context-window.js';

export {
  cleanupIncompleteToolCalls,
  validateAndFixToolHistory,
} from './history-cleanup.js';
