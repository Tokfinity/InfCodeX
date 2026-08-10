import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { persistPendingEpisodeReview } from '@kodax-ai/agent';

import {
  listPendingEpisodeReviewSummaries,
  type MemoryContextIdentity,
} from './sdk-experimental-memory.js';
import { deriveCodingMemoryReviewIdentities } from './sdk-coding.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('@kodax-ai/kodax/experimental-memory review inbox', () => {
  it('reads a persisted review job through the public KodaX SDK facade', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kodax-sdk-memory-'));
    tempDirs.push(homeDir);
    const identity: MemoryContextIdentity = {
      configHome: join(homeDir, '.kodax'),
      tenantId: 'tenant-sdk',
      userId: 'user-sdk',
      workspaceId: 'workspace-sdk',
      agentId: 'agent-sdk',
      projectId: 'project-sdk',
      sessionId: 'session-sdk',
    };
    await persistPendingEpisodeReview(identity, {
      id: 'digest-sdk',
      reviewKey: 'review:sdk',
      sessionId: identity.sessionId,
      branchId: 'main',
      sequence: 1,
      objective: 'verify the public SDK',
      approach: 'persist and inspect one review job',
      outcome: 'succeeded',
      summary: 'SDK review job',
      evidenceRefs: [],
      visibility: 'prompt_safe',
      createdAt: '2026-08-10T00:00:00.000Z',
    });

    const owners = deriveCodingMemoryReviewIdentities(
      { provider: 'mock-provider' },
      identity,
      homeDir,
    );
    const summaries = (await Promise.all(owners.map((owner) => (
      listPendingEpisodeReviewSummaries({
        configHome: owner.configHome,
        tenantId: owner.tenantId,
        agentId: owner.agentId,
        projectId: owner.projectId ?? null,
      })
    )))).flat();

    expect(summaries).toEqual([
      expect.objectContaining({
        reviewKey: 'review:sdk',
        ownerSessionRef: 'session-sdk',
        status: 'pending',
        providerAttempts: 0,
        applyAttempts: 0,
      }),
    ]);
  });

  it('keeps a project-less SDK owner isolated from project-owned reviews', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kodax-sdk-memory-projectless-'));
    tempDirs.push(homeDir);
    const identity: MemoryContextIdentity = {
      configHome: join(homeDir, '.kodax'),
      tenantId: 'tenant-sdk-projectless',
      agentId: 'agent-sdk-projectless',
      sessionId: 'session-sdk-projectless',
    };
    const foreignIdentity: MemoryContextIdentity = {
      ...identity,
      projectId: 'project-sdk-foreign',
    };
    await persistPendingEpisodeReview(identity, {
      id: 'digest-sdk-projectless',
      reviewKey: 'review:sdk-projectless',
      sessionId: identity.sessionId,
      branchId: 'main',
      sequence: 1,
      objective: 'verify exact ownerless SDK scope',
      approach: 'query with projectId null',
      outcome: 'succeeded',
      summary: 'ownerless SDK review job',
      evidenceRefs: [],
      visibility: 'prompt_safe',
      createdAt: '2026-08-10T00:00:00.000Z',
    });
    await persistPendingEpisodeReview(foreignIdentity, {
      id: 'digest-sdk-foreign',
      reviewKey: 'review:sdk-foreign',
      sessionId: foreignIdentity.sessionId,
      branchId: 'main',
      sequence: 2,
      objective: 'keep another project isolated',
      approach: 'persist under a project owner',
      outcome: 'failed',
      summary: 'foreign project SDK review job',
      evidenceRefs: [],
      visibility: 'prompt_safe',
      createdAt: '2026-08-10T00:01:00.000Z',
    });

    const [owner] = deriveCodingMemoryReviewIdentities(
      { provider: 'mock-provider' },
      identity,
      homeDir,
    );
    if (owner === undefined) throw new Error('expected an SDK review owner');
    const summaries = await listPendingEpisodeReviewSummaries({
      configHome: owner.configHome,
      tenantId: owner.tenantId,
      agentId: owner.agentId,
      projectId: owner.projectId ?? null,
    });

    expect(summaries).toMatchObject([{ reviewKey: 'review:sdk-projectless' }]);
  });
});
