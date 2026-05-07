/**
 * v0.7.35.1 FEATURE_142 Batch D — Runtime middleware barrel.
 *
 * Generic, agent-flavor-agnostic substrate middleware uplifted from
 * `@kodax/coding/src/agent-runtime/` per the Batch D narrowed scope.
 * The other coding/agent-runtime/ files stay there because they couple
 * to `KodaXEvents` / `KodaXToolExecutionContext` / `KodaXManagedProtocolPayload`
 * / coding TOOL_REGISTRY / extension hook / managed-protocol signals.
 *
 * v0.7.36 follow-up: the original Batch D landed three more modules
 * (`compaction-trigger`, `compaction-fallback`, `context-window`) here,
 * but they all consume `CompactionConfig` / `needsCompaction` from
 * `@kodax/session-lineage`, which itself depends on `@kodax/agent` —
 * that introduced a circular `tsc -b` build dependency that only worked
 * via stale dist artifacts. Those three modules moved to
 * `@kodax/session-lineage/src/runtime-middleware/` to break the cycle;
 * downstream consumers in `@kodax/coding` import them from
 * `@kodax/session-lineage` directly.
 *
 * Coding callers can keep importing the remaining symbols at their
 * existing sites — `@kodax/coding`'s `index.ts` re-exports them at the
 * same names. Future agent consumers (e.g. `@kodax/data-analysis-agent`)
 * import directly from `@kodax/agent`.
 */

export {
  cleanupIncompleteToolCalls,
  validateAndFixToolHistory,
} from './history-cleanup.js';
