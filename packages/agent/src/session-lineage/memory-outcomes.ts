import type {
  KodaXMemoryOutcomeDigest,
  KodaXSessionLineage,
  KodaXSessionMemoryOutcomeDigestEntry,
  KodaXSessionMemoryReviewReceiptEntry,
} from '../types.js';

export function appendMemoryOutcomeDigest(
  lineage: KodaXSessionLineage,
  digest: KodaXMemoryOutcomeDigest,
): KodaXSessionLineage {
  if (lineage.entries.some((entry) =>
    entry.type === 'memory_outcome_digest' && entry.digest.reviewKey === digest.reviewKey)) {
    return lineage;
  }
  const entry: KodaXSessionMemoryOutcomeDigestEntry = {
    type: 'memory_outcome_digest',
    id: digest.id,
    logicalId: digest.id,
    parentId: lineage.activeEntryId,
    timestamp: digest.createdAt,
    digest,
  };
  return { ...lineage, entries: [...lineage.entries, entry] };
}

export function appendMemoryReviewReceipt(
  lineage: KodaXSessionLineage,
  input: {
    readonly reviewKey: string;
    readonly proposalIds: readonly string[];
    readonly completedAt: string;
  },
): KodaXSessionLineage {
  if (lineage.entries.some((entry) =>
    entry.type === 'memory_review_receipt' && entry.reviewKey === input.reviewKey)) {
    return lineage;
  }
  const id = `memory-review-receipt:${input.reviewKey.slice(0, 24)}`;
  const entry: KodaXSessionMemoryReviewReceiptEntry = {
    type: 'memory_review_receipt',
    id,
    logicalId: id,
    parentId: lineage.activeEntryId,
    timestamp: input.completedAt,
    reviewKey: input.reviewKey,
    proposalIds: [...input.proposalIds],
    status: input.proposalIds.length === 0 ? 'no_action' : 'completed',
    completedAt: input.completedAt,
  };
  return { ...lineage, entries: [...lineage.entries, entry] };
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
