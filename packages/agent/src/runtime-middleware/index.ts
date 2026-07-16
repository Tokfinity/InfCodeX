/**
 * v0.7.35.1 FEATURE_142 Batch D — Runtime middleware barrel.
 *
 * Generic, agent-flavor-agnostic substrate middleware uplifted from
 * `@kodax-ai/coding/src/agent-runtime/` per the Batch D narrowed scope.
 * The other coding/agent-runtime/ files stay there because they couple
 * to `KodaXEvents` / `KodaXToolExecutionContext` / `KodaXManagedProtocolPayload`
 * / coding TOOL_REGISTRY / extension hook / managed-protocol signals.
 *
 * v0.7.36 follow-up: the original Batch D landed three more modules
 * (`compaction-trigger`, `compaction-fallback`, `context-window`) here,
 * but they all consume `CompactionConfig` / `needsCompaction` from
 * `../session-lineage/index.js`, which itself depends on `@kodax-ai/agent` —
 * that introduced a circular `tsc -b` build dependency that only worked
 * via stale dist artifacts. Those three modules moved to
 * `../session-lineage/index.js/src/runtime-middleware/` to break the cycle;
 * downstream consumers in `@kodax-ai/coding` import them from
 * `../session-lineage/index.js` directly.
 *
 * Coding callers can keep importing the remaining symbols at their
 * existing sites — `@kodax-ai/coding`'s `index.ts` re-exports them at the
 * same names. Future agent consumers (e.g. `@kodax-ai/data-analysis-agent`)
 * import directly from `@kodax-ai/agent`.
 */

export {
  cleanupIncompleteToolCalls,
  validateAndFixToolHistory,
} from './history-cleanup.js';

export {
  editDistance,
  findFuzzyToolMatch,
  invokeLlmJudge,
  createLlmJudgedStopHook,
} from './llm-judge.js';
export type {
  LlmJudgeFailureReason,
  InvokeLlmJudgeOptions,
  CreateLlmJudgedStopHookOptions,
} from './llm-judge.js';
