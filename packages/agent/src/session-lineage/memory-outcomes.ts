import type {
  KodaXMemoryOutcomeDigest,
  KodaXSessionLineage,
  KodaXSessionMemoryOutcomeDigestEntry,
  KodaXSessionMemoryReviewReceiptEntry,
} from '../types.js';
import { getSessionLineagePath } from './kodax-session-lineage.js';

export function appendMemoryOutcomeDigest(
  lineage: KodaXSessionLineage,
  digest: KodaXMemoryOutcomeDigest,
  jobId?: string,
): KodaXSessionLineage {
  const parentId = lineage.activeEntryId;
  if (lineage.entries.some((entry) => (
    entry.type === 'memory_outcome_digest'
    && (jobId === undefined
      ? entry.jobId === undefined
        && entry.digest.reviewKey === digest.reviewKey
        && entry.parentId === parentId
      : entry.jobId === jobId)
  ))) {
    return lineage;
  }
  const entryId = jobId === undefined
    ? `${digest.id}:${parentId ?? 'root'}`
    : `memory-outcome-job:${jobId}`;
  const entry: KodaXSessionMemoryOutcomeDigestEntry = {
    type: 'memory_outcome_digest',
    id: entryId,
    logicalId: entryId,
    parentId,
    timestamp: digest.createdAt,
    digest,
    ...(jobId === undefined ? {} : { jobId }),
  };
  return { ...lineage, entries: [...lineage.entries, entry] };
}

export function appendMemoryReviewReceipt(
  lineage: KodaXSessionLineage,
  input: {
    readonly jobId?: string;
    readonly reviewKey: string;
    readonly proposalIds: readonly string[];
    readonly completedAt: string;
  },
): KodaXSessionLineage {
  if (lineage.entries.some((entry) => (
    entry.type === 'memory_review_receipt'
    && (input.jobId === undefined
      ? entry.jobId === undefined && entry.reviewKey === input.reviewKey
      : entry.jobId === input.jobId)
  ))) {
    return lineage;
  }
  const receiptIdentity = input.jobId ?? input.reviewKey;
  const id = `memory-review-receipt:${receiptIdentity.slice(0, 64)}`;
  const entry: KodaXSessionMemoryReviewReceiptEntry = {
    type: 'memory_review_receipt',
    id,
    logicalId: id,
    parentId: lineage.activeEntryId,
    timestamp: input.completedAt,
    ...(input.jobId === undefined ? {} : { jobId: input.jobId }),
    reviewKey: input.reviewKey,
    proposalIds: [...input.proposalIds],
    status: input.proposalIds.length === 0 ? 'no_action' : 'completed',
    completedAt: input.completedAt,
  };
  return { ...lineage, entries: [...lineage.entries, entry] };
}

/**
 * Returns exact durable review identities for outcome digests attached to the
 * active branch. New records use jobId; legacy records fall back to digest.id.
 */
export function getActiveMemoryOutcomeReviewIds(
  lineage: KodaXSessionLineage,
): readonly string[] {
  const activePathIds = new Set(
    getSessionLineagePath(lineage).map((entry) => entry.id),
  );
  return lineage.entries
    .filter((entry): entry is KodaXSessionMemoryOutcomeDigestEntry => (
      entry.type === 'memory_outcome_digest'
      && (entry.parentId === null || activePathIds.has(entry.parentId))
    ))
    .map((entry) => entry.jobId ?? entry.digest.id);
}

export function appendMemoryClientNotice(
  lineage: KodaXSessionLineage,
  input: {
    readonly episodeId: string;
    readonly summaries: readonly string[];
    readonly proposalIds: readonly string[];
    readonly createdAt: string;
  },
): KodaXSessionLineage {
  if (lineage.entries.some((entry) =>
    entry.type === 'client_notice'
    && entry.source === 'memory-agent'
    && isNoticeForEpisode(entry.payload, input.episodeId))) {
    return lineage;
  }
  const id = `memory-notice:${input.episodeId.slice(0, 24)}`;
  return {
    ...lineage,
    entries: [...lineage.entries, {
      type: 'client_notice',
      id,
      logicalId: id,
      parentId: lineage.activeEntryId,
      timestamp: input.createdAt,
      source: 'memory-agent',
      content: `Memory updated: ${input.summaries.slice(0, 3).join('; ')}`,
      payload: {
        episodeId: input.episodeId,
        proposalIds: [...input.proposalIds],
      },
    }],
  };
}

function isNoticeForEpisode(payload: import('../types.js').KodaXJsonValue | undefined, episodeId: string): boolean {
  return typeof payload === 'object'
    && payload !== null
    && !Array.isArray(payload)
    && payload.episodeId === episodeId;
}
