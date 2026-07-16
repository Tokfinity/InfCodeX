/**
 * ../../index.js Compaction Types
 */

import type { KodaXMessage } from '@kodax-ai/llm';
import type {
  KodaXCompactMemorySeed,
  KodaXSessionArtifactLedgerEntry,
} from '../../types.js';

export interface CompactionConfig {
  /** Whether automatic compaction is enabled. */
  enabled: boolean;
  /**
   * Optional early trigger percentage. `100` means capacity-only; values below
   * 100 explicitly opt in to semantic compaction before physical pressure.
   */
  triggerPercent: number;
  /**
   * @deprecated V2 compaction no longer uses this option.
   *
   * The system now combines protected recent context, lightweight pruning, and
   * rolling summaries automatically.
   */
  keepRecentPercent?: number;
  /** Percentage of the most recent context that is never compacted or pruned. Defaults to 20. */
  protectionPercent?: number;
  /**
   * Percentage of the context window used as the chunk size for each rolling
   * summary pass. Defaults to 10.
   */
  rollingSummaryPercent?: number;
  /**
   * Explicit legacy opt-in for destructive pre-summary tool-result pruning.
   * Undefined keeps the complete evidence for semantic summarization.
   */
  pruningThresholdTokens?: number;
  /**
   * Legacy deterministic-pruning gap ratio. Only relevant when
   * `pruningThresholdTokens` is explicitly configured.
   */
  pruningGapRatio?: number;
  /** Optional override for the provider context window. */
  contextWindow?: number;
}

export interface CompactionDetails {
  readFiles: string[];
  modifiedFiles: string[];
}

export interface CompactionAnchor {
  summary: string;
  tokensBefore: number;
  tokensAfter: number;
  entriesRemoved: number;
  reason: string;
  artifactLedgerId?: string;
  details?: CompactionDetails;
  memorySeed?: KodaXCompactMemorySeed;
}

export interface CompactionUpdate {
  anchor?: CompactionAnchor;
  artifactLedger?: KodaXSessionArtifactLedgerEntry[];
  memorySeed?: KodaXCompactMemorySeed;
  /**
   * FEATURE_072: ledger-summary + file-content messages produced by
   * `buildPostCompactAttachments` + `buildFileContentMessages`. Agent.ts
   * passes these separately from the kept-tail messages so REPL-side
   * `applySessionCompaction` can store them natively on the CompactionEntry
   * rather than inlining them as loose `[Post-compact: ...]` system messages
   * in lineage. Agent.ts keeps inlining them into its local flat `messages`
   * via `injectPostCompactAttachments` (P4 belt-and-suspenders); the lineage
   * is the persistence source of truth.
   */
  postCompactAttachments?: readonly KodaXMessage[];
}

export interface CompactionResult {
  compacted: boolean;
  messages: KodaXMessage[];
  summary?: string;
  tokensBefore: number;
  tokensAfter: number;
  entriesRemoved: number;
  details?: CompactionDetails;
  artifactLedger?: KodaXSessionArtifactLedgerEntry[];
  anchor?: CompactionAnchor;
  memorySeed?: KodaXCompactMemorySeed;
}

export interface FileOperations {
  readFiles: string[];
  modifiedFiles: string[];
}
