import {
  createAgentActorController,
  type AgentActorSnapshot,
  type AgentExecutionInput,
  type AgentExecutionResult,
  type AgentMetadataValue,
  type AgentTurnExecutor,
} from '@kodax-ai/agent';
import { describe, expect, it } from 'vitest';

import { buildPatternTrace } from './pattern-trace.js';

const OWNER = { actorPath: '/root', turnId: 'root-turn-1' } as const;

class StrategyExecutor implements AgentTurnExecutor {
  execute(input: AgentExecutionInput): Promise<AgentExecutionResult> {
    const role = strategyRole(input);
    if (role === 'challenger') {
      return Promise.resolve({
        output: 'challenge complete',
        structured: {
          schemaVersion: 1,
          outcomes: [{
            target: { evidenceRef: 'finding:auth-boundary' },
            disposition: 'refuted',
            evidenceRefs: ['file:packages/agent/src/actors/controller.ts'],
          }],
          assertedCoverage: ['actor output ownership'],
        },
      });
    }
    return Promise.resolve({ output: 'investigation complete' });
  }
}

describe('F274 PatternTrace reconstruction', () => {
  it('returns no fabricated trace for legacy turns without strategy metadata', async () => {
    const controller = await createAgentActorController({ executor: new StrategyExecutor() });
    await controller.spawn('/root', { taskName: 'legacy', objective: 'Inspect.' });
    await settle();

    expect(buildPatternTrace(controller.bind('/root'))).toBeUndefined();
  });

  it('aggregates durable participant and disposition facts without treating count as proof', async () => {
    const controller = await createAgentActorController({ executor: new StrategyExecutor() });
    await controller.spawn('/root', {
      taskName: 'investigator',
      objective: 'Inspect the actor boundary.',
      forkTurns: 'none',
      metadata: qualityMetadata('investigator', ['file:packages/agent/src/actors/controller.ts']),
    });
    await controller.spawn('/root', {
      taskName: 'challenger',
      objective: 'Challenge the auth-boundary finding.',
      forkTurns: 1,
      metadata: qualityMetadata('challenger', ['finding:auth-boundary']),
    });
    await settle();

    const trace = buildPatternTrace(controller.bind('/root'));
    expect(trace).toMatchObject({
      schemaVersion: 1,
      omittedStageCount: 0,
      stages: [{
        ownerTurnRef: OWNER,
        stageId: 'review-stage',
        pattern: 'fan-out-and-synthesize',
        laneRelation: 'coverage',
        status: 'completed',
        dispositionCounts: { confirmed: 0, refuted: 1, unresolved: 0 },
        actorAssertedCoverage: ['actor output ownership'],
        contextFacts: {
          sharedEvidenceRefCount: 0,
          contextProjectionOmitted: false,
        },
      }],
    });
    expect(trace?.stages[0]?.participantTurnRefs).toHaveLength(2);
  });

  it('rebuilds byte-identical trace after Actor snapshot restart', async () => {
    let snapshot: AgentActorSnapshot | undefined;
    const store = {
      async load() { return snapshot; },
      async save(next: AgentActorSnapshot) { snapshot = structuredClone(next); },
    };
    const first = await createAgentActorController({
      executor: new StrategyExecutor(),
      store,
    });
    await first.spawn('/root', {
      taskName: 'challenger',
      objective: 'Challenge the finding.',
      metadata: qualityMetadata('challenger', ['finding:auth-boundary']),
    });
    await settle();
    const before = buildPatternTrace(first.bind('/root'));

    const restored = await createAgentActorController({
      executor: new StrategyExecutor(),
      store,
    });
    const after = buildPatternTrace(restored.bind('/root'));

    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });

  it('marks a required parse-only result as degraded when structured output is unavailable', async () => {
    const executor: AgentTurnExecutor = {
      execute: async () => ({ output: 'prose only' }),
    };
    const controller = await createAgentActorController({ executor });
    await controller.spawn('/root', {
      taskName: 'filter',
      objective: 'Filter the candidates.',
      metadata: qualityMetadata('filter', ['finding:auth-boundary']),
    });
    await settle();

    expect(buildPatternTrace(controller.bind('/root'))?.stages[0]).toMatchObject({
      status: 'degraded',
      degradedReasons: ['structured_result_unavailable'],
    });
  });

  it('keeps exact terminal Actor targets stable across later Actor reuse', async () => {
    const controller = await createAgentActorController({
      executor: {
        execute: async (input) => {
          if (input.actor.taskName === 'candidate') return { output: 'candidate v1' };
          return {
            output: 'candidate challenged',
            structured: {
              schemaVersion: 1,
              outcomes: [{
                target: {
                  actorPath: '/root/candidate',
                  turnId: 'turn_root_candidate_1',
                },
                disposition: 'confirmed',
                evidenceRefs: ['agent-turn:/root/candidate#turn=turn_root_candidate_1'],
              }],
              assertedCoverage: [],
            },
          };
        },
      },
    });
    const candidate = await controller.spawn('/root', {
      taskName: 'candidate',
      objective: 'Produce candidate v1.',
    });
    await settle();
    await controller.spawn('/root', {
      taskName: 'challenger',
      objective: 'Challenge candidate v1.',
      metadata: qualityMetadata('challenger', [
        `agent-turn:${candidate.actorPath}#turn=${candidate.turnId}`,
      ]),
    });
    await settle();
    await controller.followup('/root', '/root/candidate', 'Produce candidate v2.');
    await settle();

    expect(buildPatternTrace(controller.bind('/root'))?.stages[0]).toMatchObject({
      targetActorTurnRefs: [{
        actorPath: candidate.actorPath,
        turnId: candidate.turnId,
      }],
      dispositionCounts: { confirmed: 1, refuted: 0, unresolved: 0 },
    });
  });

  it('does not aggregate an Actor disposition that was not a declared stage target', async () => {
    let candidateTurnId = '';
    const controller = await createAgentActorController({
      executor: {
        execute: async (input) => {
          if (input.actor.taskName === 'candidate') return { output: 'candidate' };
          return {
            output: 'undeclared challenge',
            structured: {
              schemaVersion: 1,
              outcomes: [{
                target: {
                  actorPath: '/root/candidate',
                  turnId: candidateTurnId,
                },
                disposition: 'confirmed',
                evidenceRefs: [],
              }],
              assertedCoverage: ['should not be admitted'],
            },
          };
        },
      },
    });
    const candidate = await controller.spawn('/root', {
      taskName: 'candidate',
      objective: 'Produce a candidate.',
    });
    candidateTurnId = candidate.turnId;
    await settle();
    await controller.spawn('/root', {
      taskName: 'challenger',
      objective: 'Challenge only the declared finding.',
      metadata: qualityMetadata('challenger', ['finding:declared']),
    });
    await settle();

    const stage = buildPatternTrace(controller.bind('/root'))?.stages[0];
    expect(stage?.status).toBe('degraded');
    expect(stage?.degradedReasons).toContain('undeclared_disposition_target');
    expect(stage?.dispositionCounts).toBeUndefined();
  });

  it('keeps per-target refuted and unresolved facts when a sibling outcome is invalid', async () => {
    const controller = await createAgentActorController({
      executor: {
        execute: async () => ({
          output: 'mixed outcome',
          structured: {
            schemaVersion: 1,
            outcomes: [
              {
                target: { evidenceRef: 'finding:a' },
                disposition: 'confirmed',
                evidenceRefs: ['file:packages/agent/src/actors/controller.ts'],
              },
              {
                target: { evidenceRef: 'finding:b' },
                disposition: 'refuted',
                evidenceRefs: ['finding:b-refutation'],
              },
              {
                target: { evidenceRef: 'finding:c' },
                disposition: 'unresolved',
                evidenceRefs: ['finding:c-gap'],
              },
              {
                target: { evidenceRef: 'finding:undeclared' },
                disposition: 'confirmed',
                evidenceRefs: [],
              },
            ],
            assertedCoverage: [],
          },
        }),
      },
    });
    await controller.spawn('/root', {
      taskName: 'multi-target-challenger',
      objective: 'Classify every target.',
      metadata: qualityMetadata('challenger', ['finding:a', 'finding:b', 'finding:c']),
    });
    await settle();

    const stage = buildPatternTrace(controller.bind('/root'))?.stages[0];
    expect(stage).toMatchObject({
      status: 'degraded',
      dispositionCounts: { confirmed: 1, refuted: 1, unresolved: 1 },
      dispositionFacts: [
        { targetEvidenceRef: 'finding:a', disposition: 'confirmed' },
        { targetEvidenceRef: 'finding:b', disposition: 'refuted' },
        { targetEvidenceRef: 'finding:c', disposition: 'unresolved' },
      ],
      degradedReasons: ['undeclared_disposition_target'],
    });
  });

  it('marks a mixed completed and failed stage as degraded', async () => {
    const controller = await createAgentActorController({
      executor: {
        execute: async (input) => {
          if (input.actor.taskName === 'failed-lane') throw new Error('lane failed');
          return { output: 'lane complete' };
        },
      },
    });
    await controller.spawn('/root', {
      taskName: 'completed-lane',
      objective: 'Complete one lane.',
      metadata: qualityMetadata('investigator', []),
    });
    await controller.spawn('/root', {
      taskName: 'failed-lane',
      objective: 'Fail one lane.',
      metadata: qualityMetadata('investigator', []),
    });
    await settle();

    expect(buildPatternTrace(controller.bind('/root'))?.stages[0]).toMatchObject({
      status: 'degraded',
      degradedReasons: ['participant_failed'],
    });
  });

  it('bounds participant projection while retaining effective route groups', async () => {
    const controller = await createAgentActorController({
      maxConcurrentThreadsPerSession: 20,
      executor: {
        execute: async () => ({
          output: 'replicated',
          turnMetadata: {
            effectiveProvider: 'provider-a',
            effectiveModel: 'model-a',
          },
        }),
      },
    });
    for (let lane = 0; lane < 13; lane += 1) {
      await controller.spawn('/root', {
        taskName: `bounded-${lane}`,
        objective: 'Replicate independently.',
        metadata: qualityMetadata('investigator', [], 'replication'),
      });
    }
    await settle();

    const stage = buildPatternTrace(controller.bind('/root'))?.stages[0];
    expect(stage?.participantTurnRefs).toHaveLength(12);
    expect(stage?.contextFacts.participants).toHaveLength(12);
    expect(stage?.contextFacts).toMatchObject({
      omittedParticipantCount: 1,
      contextProjectionOmitted: true,
    });
    expect(stage?.contextFacts.participants[0]).toMatchObject({
      effectiveProviderGroup: 'group-1',
      effectiveModelGroup: 'group-1',
    });
    expect(stage?.degradedReasons ?? []).not.toContain('replication_context_unavailable');
  });

  it('counts declared strategy targets as participant and shared evidence context', async () => {
    const controller = await createAgentActorController({
      executor: {
        execute: async () => ({
          output: 'replicated',
          turnMetadata: {
            effectiveProvider: 'provider-a',
            effectiveModel: 'model-a',
          },
        }),
      },
    });
    const metadata = {
      qualityStrategy: {
        schemaVersion: 1,
        stageId: 'shared-target-stage',
        pattern: 'fan-out-and-synthesize',
        role: 'investigator',
        laneRelation: 'replication',
        targetEvidenceRefs: ['finding:shared'],
        ownerTurnRef: OWNER,
      },
    } as const;
    await controller.spawn('/root', {
      taskName: 'replica-a',
      objective: 'Inspect the shared target.',
      metadata,
    });
    await controller.spawn('/root', {
      taskName: 'replica-b',
      objective: 'Independently inspect the shared target.',
      metadata,
    });
    await settle();

    const stage = buildPatternTrace(controller.bind('/root'))?.stages[0];
    expect(stage?.contextFacts.sharedEvidenceRefCount).toBe(1);
    expect(stage?.contextFacts.participants.map((participant) => participant.evidenceRefCount))
      .toEqual([1, 1]);
  });

  it('retains refuted and unresolved facts before confirmed facts at the global cap', async () => {
    const targets = Array.from({ length: 26 }, (_, index) => `finding:target-${index}`);
    const controller = await createAgentActorController({
      executor: {
        execute: async (input) => {
          const laneTargets = input.actor.taskName === 'bounded-a'
            ? targets.slice(0, 13)
            : targets.slice(13);
          return {
            output: 'bounded dispositions',
            structured: {
              schemaVersion: 1,
              outcomes: laneTargets.map((target) => ({
                target: { evidenceRef: target },
                disposition: target === targets[24]
                  ? 'refuted'
                  : target === targets[25]
                    ? 'unresolved'
                    : 'confirmed',
                evidenceRefs: [],
              })),
              assertedCoverage: [],
            },
          };
        },
      },
    });
    await controller.spawn('/root', {
      taskName: 'bounded-a',
      objective: 'Classify the first bounded target lane.',
      metadata: qualityMetadata('challenger', targets.slice(0, 13), 'opposition'),
    });
    await controller.spawn('/root', {
      taskName: 'bounded-b',
      objective: 'Classify the second bounded target lane.',
      metadata: qualityMetadata('challenger', targets.slice(13), 'opposition'),
    });
    await settle();

    const stage = buildPatternTrace(controller.bind('/root'))?.stages[0];
    expect(stage?.dispositionFacts).toHaveLength(24);
    expect(stage?.dispositionFacts?.map((fact) => fact.disposition)).toContain('refuted');
    expect(stage?.dispositionFacts?.map((fact) => fact.disposition)).toContain('unresolved');
    expect(stage?.omittedDispositionCount).toBe(2);
  });

  it('marks missing replication facts and bounded ref truncation as degraded', async () => {
    const controller = await createAgentActorController({
      executor: {
        execute: async () => ({ output: 'replication lane complete' }),
      },
    });
    for (let lane = 0; lane < 3; lane += 1) {
      await controller.spawn('/root', {
        taskName: `replica-${lane}`,
        objective: 'Independently inspect the candidate.',
        metadata: qualityMetadata(
          'investigator',
          Array.from({ length: 20 }, (_, index) => `finding:${lane}-${index}`),
          'replication',
        ),
      });
    }
    await settle();

    const stage = buildPatternTrace(controller.bind('/root'))?.stages[0];
    expect(stage?.status).toBe('degraded');
    expect(stage?.degradedReasons).toContain('replication_context_unavailable');
    expect(stage?.targetEvidenceRefs).toHaveLength(50);
    expect(stage?.contextFacts.contextProjectionOmitted).toBe(true);
  });
});

function qualityMetadata(
  role: 'investigator' | 'filter' | 'challenger',
  targetEvidenceRefs: readonly string[],
  laneRelation: 'coverage' | 'replication' | 'opposition' = 'coverage',
): Readonly<Record<string, AgentMetadataValue>> {
  return {
    evidenceRefs: targetEvidenceRefs,
    qualityStrategy: {
      schemaVersion: 1,
      stageId: 'review-stage',
      pattern: 'fan-out-and-synthesize',
      role,
      laneRelation,
      targetEvidenceRefs,
      ownerTurnRef: OWNER,
    },
  };
}

function strategyRole(input: AgentExecutionInput): string | undefined {
  const strategy = input.turn.metadata?.qualityStrategy;
  if (typeof strategy !== 'object' || strategy === null || Array.isArray(strategy)) {
    return undefined;
  }
  return typeof strategy.role === 'string' ? strategy.role : undefined;
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
