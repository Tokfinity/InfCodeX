import { describe, expect, it, vi } from 'vitest';

import type { MemoryController, MemoryPack } from '../memory-control/index.js';
import {
  createMemoryAgent,
  MEMORY_POLICY_VERSION,
  type MemoryAgentTraceEvent,
  type MemoryObservation,
  type PersistedOutcomeDigest,
} from './index.js';

const identity = {
  tenantId: 'tenant-a',
  workspaceId: 'workspace-a',
  userId: 'user-a',
  agentId: 'agent-a',
  projectId: 'project-a',
  sessionId: 'session-a',
} as const;

function pack(): MemoryPack {
  return {
    generatedAt: '2026-07-12T00:00:00.000Z',
    taskFingerprint: 'task',
    memoryRevision: 'memory-1',
    candidates: [],
    promptHints: [],
    hints: [],
    omitted: [],
    traceMetadata: {
      selectedRefIds: [],
      omittedRefIds: [],
      taskFingerprint: 'task',
      suppressed: false,
    },
  };
}

function controller(memoryPack = pack()): MemoryController {
  return {
    listInbox: vi.fn(),
    showProposal: vi.fn(),
    approveProposal: vi.fn(),
    rejectProposal: vi.fn(),
    listRefs: vi.fn(),
    readRef: vi.fn(),
    runCurator: vi.fn(),
    maybeRunAutoCurator: vi.fn(),
    buildMemoryPack: vi.fn().mockResolvedValue(memoryPack),
    reviewMemoryFeedback: vi.fn(),
  } as unknown as MemoryController;
}

function constraint(overrides: Partial<MemoryObservation> = {}): MemoryObservation {
  return {
    id: 'observation-1',
    sequence: 1,
    kind: 'constraint',
    summary: 'Do not modify generated files.',
    evidence: [{
      ref: 'user:turn-1',
      requestedGrade: 'authoritative',
      source: 'user',
      observedAt: '2026-07-12T00:00:00.000Z',
    }],
    visibility: 'prompt_safe',
    actionSignature: 'write:generated',
    occurredAt: '2026-07-12T00:00:00.000Z',
    ...overrides,
  };
}

describe('FEATURE_260 MemoryAgent', () => {
  it('builds a fresh governed pack and performs one bounded event intervention', async () => {
    const initialPack = pack();
    const freshPack: MemoryPack = {
      ...initialPack,
      memoryRevision: 'memory-2',
      candidates: [{
        ref: {
          kind: 'memdir',
          id: 'memdir:procedure-npm',
          scope: 'project',
          owner: 'project',
          lifecycle: 'active',
          authority: 'approved_write',
          visibility: 'prompt_safe',
          sourceRefs: ['tool:test'],
          relatedRefs: [],
          claimKind: 'procedure',
        },
        hook: 'Use npm workspaces for dependency changes.',
        reason: 'semantic candidate',
        bodySnippet: 'Change dependencies through the root npm workspace.',
      }],
    };
    const controlPlane = controller();
    vi.mocked(controlPlane.buildMemoryPack)
      .mockResolvedValueOnce(initialPack)
      .mockResolvedValueOnce(freshPack);
    const candidateSets: string[][] = [];
    const trace: MemoryAgentTraceEvent[] = [];
    const session = await createMemoryAgent({
      controlPlane,
      recallRunner: async (input) => {
        candidateSets.push(input.candidates.map((candidate) => candidate.refId));
        return {
          selectedRefIds: [
            'tool-result:edit-1',
            'memdir:procedure-npm',
            'memdir:not-offered',
          ],
        };
      },
      onTrace: (event) => trace.push(event),
    }).startSession({ identity, objective: 'Change dependencies' });
    session.observe(constraint({
      id: 'failure-1',
      kind: 'outcome',
      summary: 'The edit failed under the current inputs.',
      actionSignature: 'task:dependency-update',
      evidence: [{
        ref: 'tool-result:edit-1',
        requestedGrade: 'observed',
        source: 'tool',
        observedAt: '2026-07-12T00:00:00.000Z',
      }],
    }));
    const input = {
      decisionRevision: 'decision-1',
      objective: 'Change dependencies',
      decisionContext: 'The package graph needs an update.',
      decisionIntent: 'dependency-update',
      actionSignature: 'task:dependency-update',
      throughSequence: 1,
      triggers: ['tool_failure'],
      currentCandidates: [{
        refId: 'current:objective',
        claim: 'Change dependencies',
        claimKind: 'objective',
        source: 'current',
        evidenceRefs: ['user:current-objective'],
      }],
    } as const;

    await expect(session.intervene(input)).resolves.toEqual({
      content: [
        'Change dependencies',
        'The edit failed under the current inputs.',
        'Change dependencies through the root npm workspace.',
      ].join('\n'),
      evidenceRefs: [
        'user:current-objective',
        'tool-result:edit-1',
        'memdir:procedure-npm',
      ],
    });
    expect(candidateSets).toEqual([[
      'current:objective',
      'observation:failure-1',
      'memdir:procedure-npm',
    ]]);
    expect(controlPlane.buildMemoryPack).toHaveBeenNthCalledWith(2, {
      task: 'Change dependencies',
      identity,
      decisionIntent: 'dependency-update',
      actionSignature: 'task:dependency-update',
      maxCandidates: 12,
      maxHints: 12,
      includeSnippets: true,
      purpose: 'intervention',
    });
    expect(trace).toContainEqual(expect.objectContaining({
      type: 'memory.decision',
      receipt: expect.objectContaining({
        triggers: ['tool_failure'],
        candidateIds: [
          'current:objective',
          'observation:failure-1',
          'memdir:procedure-npm',
        ],
        selectedCandidateIds: [
          'current:objective',
          'observation:failure-1',
          'memdir:procedure-npm',
        ],
        injectedEvidenceRefs: [
          'user:current-objective',
          'tool-result:edit-1',
          'memdir:procedure-npm',
        ],
      }),
    }));
  });

  it('recalls an exact constraint synchronously and consumes it once', async () => {
    const controlPlane = controller();
    const session = await createMemoryAgent({ controlPlane }).startSession({
      identity,
      objective: 'Update generated output',
    });
    session.observe(constraint());

    const first = session.recall({
      decisionRevision: 'decision-1',
      objective: 'Update generated output',
      decisionContext: 'Preparing a write',
      decisionIntent: 'write',
      actionSignature: 'write:generated',
      throughSequence: 1,
    });
    const second = session.recall({
      decisionRevision: 'decision-1',
      objective: 'Update generated output',
      decisionContext: 'Preparing a write',
      decisionIntent: 'write',
      actionSignature: 'write:generated',
      throughSequence: 1,
    });

    expect(first).toEqual({
      content: 'Do not modify generated files.',
      evidenceRefs: ['user:turn-1'],
    });
    expect(second).toBeUndefined();
    expect(controlPlane.buildMemoryPack).toHaveBeenCalledTimes(1);
  });

  it('performs one exact-scoped read-only deliberate query per decision epoch and caches repeats', async () => {
    const queryHint = {
      ref: {
        kind: 'memdir' as const,
        id: 'memdir:cold-failure',
        scope: 'project' as const,
        owner: 'project' as const,
        lifecycle: 'active' as const,
        authority: 'approved_write' as const,
        visibility: 'prompt_safe' as const,
        sourceRefs: ['artifact:failure-1'],
        relatedRefs: [],
        claimKind: 'procedure' as const,
      },
      hook: 'Prior unusual failure',
      reason: 'query match',
      bodySnippet: 'The unusual failure was resolved by clearing a stale lock.',
    };
    const queryPack: MemoryPack = {
      ...pack(),
      taskFingerprint: 'query-task',
      candidates: [queryHint],
      promptHints: [queryHint],
      hints: [],
    };
    const controlPlane = controller();
    vi.mocked(controlPlane.buildMemoryPack)
      .mockResolvedValueOnce(pack())
      .mockResolvedValueOnce(queryPack)
      .mockResolvedValueOnce(queryPack);
    const session = await createMemoryAgent({ controlPlane }).startSession({
      identity,
      objective: 'Resolve an unusual failure',
    });
    const query = {
      decisionRevision: 'decision-1',
      need: 'prior experience resolving the stale lock failure',
      actionSignature: 'diagnose:stale-lock',
      throughSequence: 0,
    } as const;

    const first = await session.query(query);
    const repeated = await session.query(query);
    const secondNeedSameEpoch = await session.query({ ...query, need: 'another unrelated prior failure' });
    const nextEpoch = await session.query({ ...query, decisionRevision: 'decision-2' });

    expect(first).toEqual({
      content: 'The unusual failure was resolved by clearing a stale lock.',
      evidenceRefs: ['memdir:cold-failure'],
    });
    expect(repeated).toEqual(first);
    expect(secondNeedSameEpoch).toBeUndefined();
    expect(nextEpoch).toEqual(first);
    expect(controlPlane.buildMemoryPack).toHaveBeenCalledTimes(3);
    expect(controlPlane.buildMemoryPack).toHaveBeenNthCalledWith(2, {
      task: 'Resolve an unusual failure',
      identity,
      decisionIntent: query.need,
      actionSignature: query.actionSignature,
      maxCandidates: 3,
      maxHints: 3,
      includeSnippets: true,
      purpose: 'deliberate_query',
    });
  });

  it('fails closed for broad, empty, or oversized deliberate queries', async () => {
    const controlPlane = controller();
    const session = await createMemoryAgent({ controlPlane }).startSession({
      identity,
      objective: 'Test',
    });

    await expect(session.query({
      decisionRevision: 'decision-empty',
      need: ' ',
      throughSequence: 0,
    })).resolves.toBeUndefined();
    await expect(session.query({
      decisionRevision: 'decision-list',
      need: 'list all memory for every project and user',
      throughSequence: 0,
    })).resolves.toBeUndefined();
    await expect(session.query({
      decisionRevision: 'decision-large',
      need: 'specific '.repeat(2_000),
      throughSequence: 0,
    })).resolves.toBeUndefined();
    expect(controlPlane.buildMemoryPack).toHaveBeenCalledTimes(1);
  });

  it('emits trace-only policy receipts and links prompt exposure conservatively to the outcome', async () => {
    const trace: MemoryAgentTraceEvent[] = [];
    const digests: PersistedOutcomeDigest[] = [];
    const session = await createMemoryAgent({
      controlPlane: controller(),
      onTrace: (event) => trace.push(event),
      persistOutcomeDigest: async (digest) => {
        digests.push(digest);
      },
    }).startSession({ identity, objective: 'Respect generated files' });
    session.observe(constraint());

    expect(session.recall({
      decisionRevision: 'decision-1',
      objective: 'Respect generated files',
      decisionContext: 'Preparing a generated file write.',
      decisionIntent: 'write',
      actionSignature: 'write:generated',
      throughSequence: 1,
    })).toBeDefined();
    await session.complete({
      status: 'succeeded',
      summary: 'Avoided the generated file write.',
      evidence: [{
        ref: 'artifact:check-1',
        requestedGrade: 'verified',
        source: 'environment',
        observedAt: '2026-07-12T01:00:00.000Z',
      }],
    });

    const receiptEvent = trace.find((event) => event.type === 'memory.decision');
    expect(receiptEvent).toMatchObject({
      type: 'memory.decision',
      receipt: {
        policyVersion: MEMORY_POLICY_VERSION,
        selectedRefs: ['user:turn-1'],
        injectedRefs: ['user:turn-1'],
        selectionModes: ['exact'],
      },
    });
    if (receiptEvent?.type !== 'memory.decision') throw new Error('expected decision receipt');
    expect(digests[0]?.memoryInfluence).toEqual([{
      decisionReceiptRef: receiptEvent.receipt.id,
      grade: 'exposed',
    }]);
  });

  it('enforces monotonic observations with idempotent exact duplicates', async () => {
    const session = await createMemoryAgent({ controlPlane: controller() }).startSession({
      identity,
      objective: 'Test',
    });
    const observation = constraint();
    session.observe(observation);
    expect(() => session.observe(observation)).not.toThrow();
    expect(() => session.observe(constraint({ summary: 'conflict' }))).toThrow(/conflicting duplicate/);
    expect(() => session.observe(constraint({ id: 'older', sequence: 0 }))).toThrow(/monotonic/);
  });

  it('rewind removes later observations and permits a new sequence branch', async () => {
    const session = await createMemoryAgent({ controlPlane: controller() }).startSession({
      identity,
      objective: 'Test',
    });
    session.observe(constraint());
    session.observe(constraint({ id: 'observation-2', sequence: 2, actionSignature: 'write:source' }));
    session.rewind({ throughSequence: 1 });
    session.observe(constraint({ id: 'observation-branch', sequence: 2, actionSignature: 'write:source' }));

    expect(session.recall({
      decisionRevision: 'decision-2',
      objective: 'Test',
      decisionContext: 'write source',
      decisionIntent: 'write',
      actionSignature: 'write:source',
      throughSequence: 2,
    })?.evidenceRefs).toEqual(['user:turn-1']);
  });

  it('persists a minimized digest before running episode review', async () => {
    const order: string[] = [];
    const digests: PersistedOutcomeDigest[] = [];
    const session = await createMemoryAgent({
      controlPlane: controller(),
      persistOutcomeDigest: async (digest) => {
        order.push('persist');
        digests.push(digest);
      },
      reviewEpisode: async () => {
        order.push('review');
      },
      now: () => '2026-07-12T01:00:00.000Z',
    }).startSession({ identity, objective: 'Ship memory agent' });
    session.observe(constraint({ kind: 'outcome', summary: 'Tests passed.' }));

    await session.complete({
      status: 'succeeded',
      summary: 'Implemented scoped recall.',
      evidence: [{
        ref: 'tool:test-1',
        requestedGrade: 'verified',
        source: 'environment',
        observedAt: '2026-07-12T00:59:00.000Z',
      }],
    });

    expect(order).toEqual(['persist', 'review']);
    expect(digests).toHaveLength(1);
    expect(digests[0]).toMatchObject({
      sessionId: identity.sessionId,
      sequence: 1,
      objective: 'Ship memory agent',
      outcome: 'succeeded',
      summary: 'Implemented scoped recall.',
      evidenceRefs: ['tool:test-1'],
    });
  });

  it('does not create a durable digest for cancelled episodes', async () => {
    const persistOutcomeDigest = vi.fn();
    const session = await createMemoryAgent({
      controlPlane: controller(),
      persistOutcomeDigest,
    }).startSession({ identity, objective: 'Test' });

    await session.complete({ status: 'cancelled', summary: 'Cancelled', evidence: [] });

    expect(persistOutcomeDigest).not.toHaveBeenCalled();
  });

  it('does not persist restricted secret material', async () => {
    const persistOutcomeDigest = vi.fn();
    const session = await createMemoryAgent({
      controlPlane: controller(),
      persistOutcomeDigest,
    }).startSession({ identity, objective: 'Test' });

    await session.complete({
      status: 'failed',
      summary: 'API_KEY=super-secret-value',
      evidence: [],
    });

    expect(persistOutcomeDigest).not.toHaveBeenCalled();
  });

  it('drops restricted observations and deliberate needs before recall or store access', async () => {
    const controlPlane = controller();
    const session = await createMemoryAgent({ controlPlane }).startSession({ identity, objective: 'Test' });
    session.observe(constraint({ summary: 'token=super-secret-value' }));

    expect(session.recall({
      decisionRevision: 'decision-secret',
      objective: 'Test',
      decisionContext: 'secret lookup',
      decisionIntent: 'write',
      actionSignature: 'write:generated',
      throughSequence: 1,
    })).toBeUndefined();
    await expect(session.query({
      decisionRevision: 'decision-query-secret',
      need: 'token=super-secret-value',
      throughSequence: 1,
    })).resolves.toBeUndefined();
    expect(controlPlane.buildMemoryPack).toHaveBeenCalledTimes(1);
  });

  it('never injects or offers private and sensitive observations', async () => {
    const offered: string[][] = [];
    const session = await createMemoryAgent({
      controlPlane: controller(),
      recallRunner: async (input) => {
        offered.push(input.candidates.map((candidate) => candidate.refId));
        return { selectedRefIds: input.candidates.map((candidate) => candidate.refId) };
      },
    }).startSession({ identity, objective: 'Keep private state private' });
    session.observe(constraint({
      id: 'private-1',
      visibility: 'private',
      actionSignature: 'task:privacy',
    }));
    session.observe(constraint({
      id: 'sensitive-1',
      sequence: 2,
      visibility: 'sensitive',
      actionSignature: 'task:privacy',
    }));

    expect(session.recall({
      decisionRevision: 'decision-private',
      objective: 'Keep private state private',
      decisionContext: 'privacy decision',
      decisionIntent: 'privacy',
      actionSignature: 'task:privacy',
      throughSequence: 2,
    })).toBeUndefined();
    await expect(session.intervene({
      decisionRevision: 'decision-private-intervention',
      objective: 'Keep private state private',
      decisionContext: 'privacy decision',
      decisionIntent: 'privacy',
      actionSignature: 'task:privacy',
      throughSequence: 2,
      triggers: ['context_compacted'],
      currentCandidates: [],
    })).resolves.toBeUndefined();
    expect(offered).toEqual([]);
  });

  it('discards a selector result when the observation revision changes while it is running', async () => {
    const freshPack: MemoryPack = {
      ...pack(),
      candidates: [{
        ref: {
          kind: 'memdir',
          id: 'memdir:procedure-npm',
          scope: 'project',
          owner: 'project',
          lifecycle: 'active',
          authority: 'approved_write',
          visibility: 'prompt_safe',
          sourceRefs: ['tool:test'],
          relatedRefs: [],
        },
        hook: 'Use npm workspaces.',
        reason: 'fresh candidate',
      }],
    };
    const controlPlane = controller();
    vi.mocked(controlPlane.buildMemoryPack)
      .mockResolvedValueOnce(pack())
      .mockResolvedValueOnce(freshPack);
    let resolveSelection: ((value: { readonly selectedRefIds: readonly string[] }) => void) | undefined;
    const selection = new Promise<{ readonly selectedRefIds: readonly string[] }>((resolve) => {
      resolveSelection = resolve;
    });
    const trace: MemoryAgentTraceEvent[] = [];
    const session = await createMemoryAgent({
      controlPlane,
      recallRunner: async () => selection,
      onTrace: (event) => trace.push(event),
    }).startSession({ identity, objective: 'Change dependencies' });

    const intervention = session.intervene({
      decisionRevision: 'decision-stale',
      objective: 'Change dependencies',
      decisionContext: 'dependency update',
      decisionIntent: 'dependency-update',
      throughSequence: 0,
      triggers: ['context_compacted'],
      currentCandidates: [],
    });
    session.observe(constraint({ id: 'newer', sequence: 1 }));
    resolveSelection?.({ selectedRefIds: ['memdir:procedure-npm'] });

    await expect(intervention).resolves.toBeUndefined();
    expect(trace).toContainEqual(expect.objectContaining({
      type: 'recall.intervention.discarded',
      key: expect.any(String),
      detail: 'state_revision_changed',
    }));
  });

  it('clamps requested evidence authority through a registered host source policy', async () => {
    const digests: PersistedOutcomeDigest[] = [];
    const session = await createMemoryAgent({
      controlPlane: controller(),
      sourcePolicy: (evidence) => evidence.source === 'environment' ? 'verified' : 'inferred',
      persistOutcomeDigest: async (digest) => {
        digests.push(digest);
      },
    }).startSession({ identity, objective: 'Test evidence' });

    await session.complete({
      status: 'succeeded',
      summary: 'Verifier completed.',
      evidence: [
        {
          ref: 'environment:check',
          requestedGrade: 'authoritative',
          source: 'environment',
          observedAt: '2026-07-12T02:00:00.000Z',
        },
        {
          ref: 'agent:self-claim',
          requestedGrade: 'authoritative',
          source: 'agent',
          observedAt: '2026-07-12T02:00:00.000Z',
        },
      ],
    });

    expect(digests[0]?.evidence).toMatchObject([
      { ref: 'environment:check', grade: 'verified' },
      { ref: 'agent:self-claim', grade: 'inferred' },
    ]);
  });

  it('keeps the persisted digest and stops awaiting review after the bounded timeout', async () => {
    const trace: MemoryAgentTraceEvent[] = [];
    const persisted: PersistedOutcomeDigest[] = [];
    let reviewWasAborted = false;
    const session = await createMemoryAgent({
      controlPlane: controller(),
      reviewTimeoutMs: 5,
      persistOutcomeDigest: async (digest) => {
        persisted.push(digest);
      },
      reviewEpisode: async (_digest, signal) => {
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => {
            reviewWasAborted = true;
            resolve();
          }, { once: true });
        });
      },
      onTrace: (event) => trace.push(event),
    }).startSession({ identity, objective: 'Timeout review' });

    await session.complete({
      status: 'succeeded',
      summary: 'Digest survives timeout.',
      evidence: [],
    });

    expect(persisted).toHaveLength(1);
    expect(reviewWasAborted).toBe(true);
    expect(trace).toContainEqual(expect.objectContaining({
      type: 'review.timed_out',
      key: persisted[0]?.reviewKey,
    }));
  });
});
