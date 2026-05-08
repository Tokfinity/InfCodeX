/**
 * @kodax-ai/session-lineage/runtime-middleware — barrel export.
 *
 * Compaction-related substrate middleware. Originally uplifted to
 * `@kodax-ai/agent/src/runtime-middleware/` in v0.7.35.1 FEATURE_142
 * Batch D under the "generic agent platform middleware" framing, but
 * that introduced a circular `tsc -b` build dependency
 * (`agent → session-lineage → agent`) which only worked when stale
 * `dist/` artifacts were already present. v0.7.36 moves these three
 * files back to session-lineage to break the cycle — semantically
 * appropriate since they all consume session-lineage's
 * `CompactionConfig` and `needsCompaction`, so the compaction
 * lifecycle's substrate middleware belongs alongside the compaction
 * implementation itself.
 *
 * The remaining two Batch D middleware modules (`history-cleanup` /
 * `boundary-tracker-session`) stay in `@kodax-ai/agent` because they have
 * no compaction-domain dependencies.
 */

export { shouldCompact } from './compaction-trigger.js';
export type { ShouldCompactInput } from './compaction-trigger.js';

export { gracefulCompactDegradation } from './compaction-fallback.js';

export {
  DEFAULT_CONTEXT_WINDOW,
  resolveContextWindow,
} from './context-window.js';
