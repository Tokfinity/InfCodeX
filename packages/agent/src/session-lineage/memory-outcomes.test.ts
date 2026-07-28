import { describe, expect, it } from 'vitest';

import type { KodaXMemoryOutcomeDigest, KodaXSessionLineage } from '../types.js';
import { rewindSessionLineage } from './kodax-session-lineage.js';
import {
  appendMemoryClientNotice,
  appendMemoryOutcomeDigest,
  appendMemoryReviewReceipt,
  getActiveMemoryOutcomeReviewIds,
} from './memory-outcomes.js';

const base: KodaXSessionLineage = {
  version: 2,
  activeEntryId: 'message-1',
  entries: [{
    type: 'message',
    id: 'message-1',
    logicalId: 'message-1',
    parentId: null,
    timestamp: '2026-07-12T00:00:00.000Z',
    message: { role: 'user', content: 'test' },
  }],
};

const digest: KodaXMemoryOutcomeDigest = {
  id: 'digest-1',
  reviewKey: 'review-1',
  sessionId: 'session-1',
  branchId: 'session-1',
  sequence: 1,
  objective: 'Test',
  approach: 'Run test',
  outcome: 'succeeded',
  summary: 'Passed',
  evidenceRefs: ['tool:test'],
  visibility: 'prompt_safe',
  createdAt: '2026-07-12T00:01:00.000Z',
};

describe('FEATURE_260 outcome lineage', () => {
  it('appends digest and receipt idempotently without changing active context', () => {
    const withDigest = appendMemoryOutcomeDigest(base, digest);
    const duplicate = appendMemoryOutcomeDigest(withDigest, digest);
    const completed = appendMemoryReviewReceipt(duplicate, {
      reviewKey: digest.reviewKey,
      proposalIds: ['proposal-1'],
      completedAt: '2026-07-12T00:02:00.000Z',
    });

    expect(duplicate).toBe(withDigest);
    expect(completed.activeEntryId).toBe('message-1');
    expect(completed.entries.map((entry) => entry.type)).toEqual([
      'message',
      'memory_outcome_digest',
      'memory_review_receipt',
    ]);
  });

  it('drops post-target memory side-state on rewind', () => {
    const withDigest = appendMemoryOutcomeDigest(base, digest);
    const rewound = rewindSessionLineage(withDigest, 'message-1');

    expect(rewound?.entries.some((entry) => entry.type === 'memory_outcome_digest')).toBe(false);
  });

  it('collapses one client notice per episode', () => {
    const first = appendMemoryClientNotice(base, {
      episodeId: 'episode-1',
      summaries: ['Remember npm'],
      proposalIds: ['proposal-1'],
      createdAt: '2026-07-12T00:02:00.000Z',
    });
    const duplicate = appendMemoryClientNotice(first, {
      episodeId: 'episode-1',
      summaries: ['Duplicate'],
      proposalIds: ['proposal-2'],
      createdAt: '2026-07-12T00:03:00.000Z',
    });

    expect(duplicate).toBe(first);
    expect(first.entries.filter((entry) => entry.type === 'client_notice')).toHaveLength(1);
  });

  it('keeps the same review key on distinct branches and deduplicates receipts by job', () => {
    const firstBranch = appendMemoryOutcomeDigest(base, digest, 'job-a');
    const siblingBase: KodaXSessionLineage = {
      ...firstBranch,
      activeEntryId: 'message-2',
      entries: [...firstBranch.entries, {
        type: 'message',
        id: 'message-2',
        logicalId: 'message-2',
        parentId: null,
        timestamp: '2026-07-12T00:03:00.000Z',
        message: { role: 'user', content: 'sibling' },
      }],
    };
    const secondBranch = appendMemoryOutcomeDigest(siblingBase, digest, 'job-b');
    const firstReceipt = appendMemoryReviewReceipt(secondBranch, {
      jobId: 'job-a',
      reviewKey: digest.reviewKey,
      proposalIds: [],
      completedAt: '2026-07-12T00:04:00.000Z',
    });
    const secondReceipt = appendMemoryReviewReceipt(firstReceipt, {
      jobId: 'job-b',
      reviewKey: digest.reviewKey,
      proposalIds: [],
      completedAt: '2026-07-12T00:05:00.000Z',
    });

    expect(secondBranch.entries.filter((entry) => entry.type === 'memory_outcome_digest'))
      .toHaveLength(2);
    expect(secondReceipt.entries.filter((entry) => entry.type === 'memory_review_receipt'))
      .toHaveLength(2);
    expect(getActiveMemoryOutcomeReviewIds(secondBranch)).toEqual(['job-b']);
  });
});
