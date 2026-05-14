/**
 * @kodax-ai/session-lineage — Session 实体 + 持久化 + Lineage 追踪 +
 * LineageCompaction + DefaultSummaryCompaction.
 *
 * Originally populated in FEATURE_082 Slice 3 by moving the lineage
 * implementation out of `@kodax-ai/coding/src/extensions/lineage`.
 * v0.7.35.1 FEATURE_142 Batch B absorbed `@kodax-ai/agent`'s session.ts /
 * session-lineage.ts / persistence.ts / compaction/ subdirectory so this
 * package now owns the full session subsystem. Depends on `@kodax-ai/agent`
 * for `Session` / `SessionEntry` / `SessionExtension` / `CompactionPolicy`
 * primitives.
 *
 * `@kodax-ai/coding` retains a barrel re-export as a convenience for
 * batteries-included consumers; that is not a deprecation shim.
 */

// ============== LineageExtension (Layer B SessionExtension) ==============
export type {
  LineageArtifactLedgerPayload,
  LineageEntryType,
  LineageLabelPayload,
  LineageTreeNode,
} from './lineage.js';
export { LINEAGE_ENTRY_TYPES, LineageExtension } from './lineage.js';

export type { LineageCompactionDelegates } from './compaction.js';
export { LineageCompaction } from './compaction.js';

// ============== Session ID + title helpers (v0.7.35.1 FEATURE_142 Batch B) ==============
export {
  generateSessionId,
  extractTitleFromMessages,
} from './session.js';

// ============== KodaXSessionLineage operations (v0.7.35.1 FEATURE_142 Batch B) ==============
export {
  appendSessionLineageLabel,
  applyLineageTruncation,
  applySessionCompaction,
  archiveOldIslands,
  buildSessionTree,
  countActiveLineageMessages,
  createSessionLineage,
  forkSessionLineage,
  getSessionLineagePath,
  getSessionMessagesFromLineage,
  resolveSessionLineageTarget,
  findPreviousUserEntryId,
  rewindSessionLineage,
  setSessionLineageActiveEntry,
} from './kodax-session-lineage.js';

// ============== Compaction orchestration (v0.7.35.1 FEATURE_142 Batch B) ==============
export type {
  CompactionAnchor,
  CompactionConfig,
  CompactionDetails,
  CompactionUpdate,
  CompactionResult,
  FileOperations,
} from './compaction/types.js';

export {
  extractArtifactLedger,
  extractFileOps,
  mergeArtifactLedger,
  mergeFileOps,
} from './compaction/file-tracker.js';

export {
  serializeConversation,
} from './compaction/utils.js';

export {
  generateSummary,
  buildCompactionPromptSnapshot,
  DEFAULT_SUMMARY_PROMPT,
  DEFAULT_UPDATE_SUMMARY_PROMPT,
} from './compaction/summary-generator.js';
export type {
  KodaXCompactionPromptVariant,
  KodaXCompactionPromptSection,
  KodaXCompactionPromptSnapshot,
} from './compaction/summary-generator.js';

export {
  COMPACTION_SUMMARY_PREFIX,
  needsCompaction,
  compact,
} from './compaction/compaction.js';

export {
  microcompact,
  DEFAULT_MICROCOMPACTION_CONFIG,
} from './compaction/microcompaction.js';
export type {
  MicrocompactionConfig,
} from './compaction/microcompaction.js';

export {
  buildFileContentMessages,
  buildPostCompactAttachments,
  injectPostCompactAttachments,
  DEFAULT_POST_COMPACT_CONFIG,
  POST_COMPACT_TOKEN_BUDGET,
  POST_COMPACT_MAX_TOKENS_PER_FILE,
} from './compaction/post-compact.js';
export type {
  PostCompactConfig,
  PostCompactAttachments,
} from './compaction/post-compact.js';

// ============== Extension persistence (FEATURE_034; v0.7.35.1 FEATURE_142 Batch B) ==============
export {
  FileExtensionStore,
  createExtensionStore,
} from './persistence.js';

// ============== Runtime middleware (v0.7.36 — moved here from @kodax-ai/agent to break build cycle) ==============
// Originally uplifted to @kodax-ai/agent in v0.7.35.1 FEATURE_142 Batch D under
// the "generic agent platform middleware" framing, but that introduced a
// circular `tsc -b` build dependency (agent → session-lineage → agent) which
// only worked when stale dist artifacts were already present. v0.7.36 moves
// these three modules back to session-lineage — semantically appropriate
// since they all consume CompactionConfig / needsCompaction. The remaining
// two Batch D middleware modules (history-cleanup / boundary-tracker-session)
// stay in @kodax-ai/agent (no compaction-domain deps).
export {
  shouldCompact,
  gracefulCompactDegradation,
  resolveContextWindow,
  DEFAULT_CONTEXT_WINDOW,
} from './runtime-middleware/index.js';
export type { ShouldCompactInput } from './runtime-middleware/index.js';
