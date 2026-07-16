import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { setAgentConfigHome } from '../runtime/agent-home.js';
import { setKodaXDiagnosticSink, type KodaXDiagnostic } from '../diagnostics.js';
import type { KodaXMemoryOutcomeDigest } from '../types.js';
import {
  completeEpisodeReview,
  drainPendingEpisodeReviews,
  listPendingEpisodeReviews,
  persistPendingEpisodeReview,
  rewindPendingEpisodeReviews,
} from './review-inbox.js';

const identity = {
  tenantId: 'tenant-a',
  agentId: 'agent-a',
  projectId: 'project-a',
  sessionId: 'session-a',
} as const;

function digest(sequence = 1): KodaXMemoryOutcomeDigest {
  return {
    id: `digest-${sequence}`,
    reviewKey: `review-${sequence}`,
    sessionId: identity.sessionId,
    branchId: identity.sessionId,
    sequence,
    objective: 'Ship memory',
    approach: 'Run tests',
    outcome: 'succeeded',
    summary: 'Tests passed',
    evidenceRefs: ['tool:test'],
    visibility: 'prompt_safe',
    createdAt: '2026-07-12T00:00:00.000Z',
  };
}

describe('FEATURE_260 episode review inbox', () => {
  let home: string | undefined;

  afterEach(async () => {
    setAgentConfigHome(undefined);
    if (home !== undefined) await rm(home, { recursive: true, force: true });
  });

  it('upserts one minimized pending review idempotently', async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'kodax-review-inbox-'));
    setAgentConfigHome(home);

    const first = await persistPendingEpisodeReview(identity, digest());
    const second = await persistPendingEpisodeReview(identity, digest());
    const pending = await listPendingEpisodeReviews({ tenantId: identity.tenantId });

    expect(first.path).toBe(second.path);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ reviewKey: 'review-1', ownerSessionRef: 'session-a' });
    expect(await readFile(first.path, 'utf8')).not.toContain('tenant-a');
  });

  it('writes a receipt before removing the pending entry', async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'kodax-review-inbox-complete-'));
    setAgentConfigHome(home);
    await persistPendingEpisodeReview(identity, digest());

    const receipt = await completeEpisodeReview(identity, 'review-1', ['proposal-1']);

    expect(receipt.acknowledged).toBe(true);
    expect(await listPendingEpisodeReviews({ tenantId: identity.tenantId })).toEqual([]);
    expect(JSON.parse(await readFile(receipt.receiptPath, 'utf8'))).toMatchObject({
      reviewKey: 'review-1',
      proposalIds: ['proposal-1'],
    });
  });

  it('removes only post-target reviews on rewind', async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'kodax-review-inbox-rewind-'));
    setAgentConfigHome(home);
    await persistPendingEpisodeReview(identity, digest(1));
    await persistPendingEpisodeReview(identity, digest(2));

    expect(await rewindPendingEpisodeReviews(identity, 1)).toBe(1);
    expect((await listPendingEpisodeReviews({ tenantId: identity.tenantId })))
      .toMatchObject([{ digest: { sequence: 1 } }]);
  });

  it('drains only owner-validated reviews and keeps deferred work pending', async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'kodax-review-inbox-drain-'));
    setAgentConfigHome(home);
    await persistPendingEpisodeReview(identity, digest(1));
    await persistPendingEpisodeReview(identity, digest(2));
    await persistPendingEpisodeReview(identity, digest(3));

    const reviewed: string[] = [];
    const result = await drainPendingEpisodeReviews(identity, {
      revalidate: async (entry) => entry.digest.sequence === 1
        ? 'eligible'
        : entry.digest.sequence === 2 ? 'discard' : 'defer',
      review: async (entry) => {
        reviewed.push(entry.reviewKey);
        return [`proposal-${entry.digest.sequence}`];
      },
    });

    expect(result).toEqual({
      reviewed: 1,
      discarded: 1,
      deferred: 1,
      failed: 0,
      failures: [],
    });
    expect(reviewed).toEqual(['review-1']);
    expect((await listPendingEpisodeReviews({ tenantId: identity.tenantId }))
      .map((entry) => entry.reviewKey)).toEqual(['review-3']);
  });

  it('bounds a maintenance drain and retains failed reviews for retry', async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'kodax-review-inbox-bounded-'));
    setAgentConfigHome(home);
    await persistPendingEpisodeReview(identity, digest(1));
    await persistPendingEpisodeReview(identity, digest(2));

    const result = await drainPendingEpisodeReviews(identity, {
      maxEntries: 1,
      revalidate: async () => 'eligible',
      review: async () => {
        throw new Error('transient reviewer failure');
      },
    });

    expect(result).toEqual({
      reviewed: 0,
      discarded: 0,
      deferred: 1,
      failed: 1,
      failures: [{ reviewKey: 'review-1', error: 'transient reviewer failure' }],
    });
    expect(await listPendingEpisodeReviews({ tenantId: identity.tenantId })).toHaveLength(2);
  });

  it('does not drain project-owned reviews without a project identity', async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'kodax-review-inbox-projectless-'));
    setAgentConfigHome(home);
    await persistPendingEpisodeReview(identity, digest());
    let reviewCalls = 0;

    const result = await drainPendingEpisodeReviews({
      tenantId: identity.tenantId,
      agentId: identity.agentId,
      sessionId: identity.sessionId,
    }, {
      revalidate: async () => 'eligible',
      review: async () => {
        reviewCalls += 1;
        return ['proposal-1'];
      },
    });

    expect(result).toEqual({
      reviewed: 0,
      discarded: 0,
      deferred: 1,
      failed: 0,
      failures: [],
    });
    expect(reviewCalls).toBe(0);
    expect(await listPendingEpisodeReviews({ tenantId: identity.tenantId })).toHaveLength(1);
  });

  it('still drains reviews that are owned by a project-less identity', async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'kodax-review-inbox-unscoped-'));
    setAgentConfigHome(home);
    const projectless = {
      tenantId: identity.tenantId,
      agentId: identity.agentId,
      sessionId: identity.sessionId,
    } as const;
    await persistPendingEpisodeReview(projectless, digest());

    const result = await drainPendingEpisodeReviews(projectless, {
      revalidate: async () => 'eligible',
      review: async () => ['proposal-1'],
    });

    expect(result.reviewed).toBe(1);
    expect(result.deferred).toBe(0);
    expect(await listPendingEpisodeReviews({ tenantId: identity.tenantId })).toEqual([]);
  });

  it('ignores persisted digests with an invalid evidence shape', async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'kodax-review-inbox-invalid-evidence-'));
    setAgentConfigHome(home);
    const persisted = await persistPendingEpisodeReview(identity, digest());
    const raw = await readFile(persisted.path, 'utf8');
    await writeFile(
      persisted.path,
      raw.replace('"evidenceRefs":', '"evidence": {},\n    "evidenceRefs":'),
      'utf8',
    );

    const diagnostics: KodaXDiagnostic[] = [];
    const restoreDiagnostics = setKodaXDiagnosticSink((diagnostic) => diagnostics.push(diagnostic));
    try {
      expect(await listPendingEpisodeReviews({ tenantId: identity.tenantId })).toEqual([]);
    } finally {
      restoreDiagnostics();
    }
    expect(diagnostics).toEqual([expect.objectContaining({
      source: 'memory.review-inbox',
      level: 'warn',
      message: 'Invalid pending episode review was skipped.',
    })]);
  });

  it('atomically claims a pending review across concurrent drains', async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'kodax-review-inbox-claim-'));
    setAgentConfigHome(home);
    await persistPendingEpisodeReview(identity, digest());
    let releaseReview!: () => void;
    const reviewGate = new Promise<void>((resolve) => {
      releaseReview = resolve;
    });
    let reviewStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      reviewStarted = resolve;
    });
    let reviewCalls = 0;
    const options = {
      revalidate: async () => 'eligible' as const,
      review: async () => {
        reviewCalls += 1;
        reviewStarted();
        await reviewGate;
        return ['proposal-1'];
      },
    };

    const first = drainPendingEpisodeReviews(identity, options);
    await started;
    const second = drainPendingEpisodeReviews(identity, options);
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseReview();
    await Promise.all([first, second]);

    expect(reviewCalls).toBe(1);
    expect(await listPendingEpisodeReviews({ tenantId: identity.tenantId })).toEqual([]);
  });
});
