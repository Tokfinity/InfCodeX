import type {
  AgentActorClient,
  AgentExecutionKind,
  AgentForkTurns,
  AgentTurn,
} from '@kodax-ai/agent';

import {
  parsePatternDispositionEnvelope,
  type PatternDisposition,
  type PatternDispositionOutcome,
} from './pattern-result.js';
import {
  parseActorTurnEvidenceRef,
  readStoredActorStrategy,
  type ActorLaneRelation,
  type ActorStrategyRole,
  type ActorTurnIdentity,
  type StoredActorStrategyMetadata,
} from './pattern-strategy.js';
import type { CollaborationPatternId } from './pattern-catalog.js';

export interface PatternTraceParticipantContext {
  readonly turnRef: ActorTurnIdentity;
  readonly role: ActorStrategyRole;
  readonly forkTurns: AgentForkTurns;
  readonly effectiveProviderGroup?: string;
  readonly effectiveModelGroup?: string;
  readonly evidenceRefCount: number;
}

export interface PatternTraceDispositionFact {
  readonly targetEvidenceRef: string;
  readonly disposition: PatternDisposition;
  readonly evidenceRefs: readonly string[];
  readonly omittedEvidenceRefCount: number;
}

export interface PatternTraceStage {
  readonly schemaVersion: 1;
  readonly ownerTurnRef: ActorTurnIdentity;
  readonly stageId: string;
  readonly pattern: CollaborationPatternId;
  readonly declaredPurpose?: string;
  readonly laneRelation?: ActorLaneRelation;
  readonly participantTurnRefs: readonly ActorTurnIdentity[];
  readonly targetActorTurnRefs: readonly ActorTurnIdentity[];
  readonly targetEvidenceRefs: readonly string[];
  readonly contextFacts: {
    readonly participants: readonly PatternTraceParticipantContext[];
    readonly sharedEvidenceRefCount: number;
    readonly omittedParticipantCount: number;
    readonly commonParentActorPath?: string;
    readonly contextProjectionOmitted: boolean;
  };
  readonly status: 'started' | 'completed' | 'degraded' | 'failed' | 'stopped';
  readonly dispositionCounts?: {
    readonly confirmed: number;
    readonly refuted: number;
    readonly unresolved: number;
  };
  readonly dispositionFacts?: readonly PatternTraceDispositionFact[];
  readonly omittedDispositionCount?: number;
  readonly actorAssertedCoverage?: readonly string[];
  readonly stopReason?: string;
  readonly degradedReasons?: readonly string[];
}

export interface PatternTrace {
  readonly schemaVersion: 1;
  readonly stages: readonly PatternTraceStage[];
  readonly omittedStageCount: number;
}

interface StageFact {
  readonly turn: AgentTurn;
  readonly actorKind: AgentExecutionKind;
  readonly strategy: StoredActorStrategyMetadata;
}

const MAX_TRACE_STAGES = 24;
const MAX_TRACE_REFS = 50;
const MAX_TRACE_PARTICIPANTS = 12;
const MAX_TRACE_DISPOSITIONS = 24;
const MAX_DISPOSITION_EVIDENCE_REFS = 3;

export function buildPatternTrace(client: AgentActorClient): PatternTrace | undefined {
  const facts = client.list().actors.flatMap((actor) => (
    client.get(actor.path).turns.flatMap((turn) => {
      const strategy = readStoredActorStrategy(turn.metadata?.qualityStrategy);
      return strategy === undefined ? [] : [{ turn, actorKind: actor.kind, strategy }];
    })
  ));
  if (facts.length === 0) return undefined;
  const grouped = new Map<string, StageFact[]>();
  for (const fact of facts) {
    const key = stageKey(fact.strategy);
    grouped.set(key, [...(grouped.get(key) ?? []), fact]);
  }
  const stages = [...grouped.values()]
    .map((stageFacts) => buildStage(client, stageFacts))
    .sort(compareStages);
  const admitted = boundDispositionFacts(
    prioritizeStages(stages).slice(0, MAX_TRACE_STAGES),
  ).sort(compareStages);
  return {
    schemaVersion: 1,
    stages: admitted,
    omittedStageCount: Math.max(0, stages.length - admitted.length),
  };
}

function buildStage(client: AgentActorClient, facts: readonly StageFact[]): PatternTraceStage {
  const ordered = [...facts].sort((left, right) => (
    left.turn.createdAt.localeCompare(right.turn.createdAt)
    || left.turn.actorPath.localeCompare(right.turn.actorPath)
    || left.turn.turnId.localeCompare(right.turn.turnId)
  ));
  const first = ordered[0]!;
  const degradedReasons = new Set<string>();
  const patterns = new Set(ordered.map((fact) => fact.strategy.pattern));
  const relations = new Set(ordered.map((fact) => fact.strategy.laneRelation ?? ''));
  if (patterns.size > 1) degradedReasons.add('stage_pattern_conflict');
  if (relations.size > 1) degradedReasons.add('stage_relation_conflict');

  const targetEvidenceRefs = unique(ordered.flatMap(
    (fact) => fact.strategy.targetEvidenceRefs ?? [],
  ));
  const targetActorTurnRefs: ActorTurnIdentity[] = [];
  for (const ref of targetEvidenceRefs) {
    try {
      const target = parseActorTurnEvidenceRef(ref);
      if (target !== undefined) targetActorTurnRefs.push(target);
    } catch {
      degradedReasons.add('invalid_actor_turn_reference');
    }
  }

  const dispositionCounts = { confirmed: 0, refuted: 0, unresolved: 0 };
  const dispositionFacts: PatternTraceDispositionFact[] = [];
  const actorAssertedCoverage: string[] = [];
  let dispositionCount = 0;
  for (const fact of ordered) {
    for (const reason of metadataStringArray(
      fact.turn,
      'qualityStrategyDegradedReasons',
    )) {
      degradedReasons.add(reason);
    }
    const requiresStructured = fact.strategy.role === 'filter'
      || fact.strategy.role === 'judge'
      || fact.strategy.role === 'challenger';
    const envelope = parsePatternDispositionEnvelope(fact.turn.structured);
    if (requiresStructured && envelope === undefined) {
      degradedReasons.add(
        fact.actorKind === 'external'
          ? 'external_structured_result_unavailable'
          : 'structured_result_unavailable',
      );
      continue;
    }
    if (envelope === undefined) continue;
    for (const outcome of envelope.outcomes) {
      const targetRef = validatedOutcomeTargetRef(
        client,
        outcome,
        targetEvidenceRefs,
        degradedReasons,
      );
      if (targetRef === undefined) continue;
      dispositionCounts[outcome.disposition] += 1;
      dispositionCount += 1;
      if ('actorPath' in outcome.target) targetActorTurnRefs.push(outcome.target);
      dispositionFacts.push({
        targetEvidenceRef: targetRef,
        disposition: outcome.disposition,
        evidenceRefs: outcome.evidenceRefs.slice(0, MAX_DISPOSITION_EVIDENCE_REFS),
        omittedEvidenceRefCount: Math.max(
          0,
          outcome.evidenceRefs.length - MAX_DISPOSITION_EVIDENCE_REFS,
        ),
      });
    }
    actorAssertedCoverage.push(...envelope.assertedCoverage);
  }

  const uniqueTargetActorTurnRefs = uniqueTurnRefs(targetActorTurnRefs);
  const uniqueActorAssertedCoverage = unique(actorAssertedCoverage);
  const baseContextFacts = buildContextFacts(ordered);
  const contextProjectionOmitted =
    ordered.length > MAX_TRACE_PARTICIPANTS
    ||
    uniqueTargetActorTurnRefs.length > MAX_TRACE_REFS
    || targetEvidenceRefs.length > MAX_TRACE_REFS
    || uniqueActorAssertedCoverage.length > MAX_TRACE_REFS;
  const contextFacts = {
    ...baseContextFacts,
    contextProjectionOmitted,
  };
  if (
    first.strategy.laneRelation === 'replication'
    && contextFacts.participants.some(
      (participant) =>
        participant.effectiveProviderGroup === undefined
        || participant.effectiveModelGroup === undefined,
    )
  ) {
    degradedReasons.add('replication_context_unavailable');
  }

  const allTerminal = ordered.every(({ turn }) => isTerminal(turn));
  const allUnsuccessful = allTerminal && ordered.every(({ turn }) => turn.state !== 'completed');
  const hasInterrupted = ordered.some(({ turn }) => turn.state === 'interrupted');
  const hasFailed = ordered.some(({ turn }) => turn.state === 'failed');
  if (allTerminal && !allUnsuccessful) {
    if (hasFailed) degradedReasons.add('participant_failed');
    if (hasInterrupted) degradedReasons.add('participant_interrupted');
  }
  const status = !allTerminal
    ? 'started'
    : allUnsuccessful
      ? hasInterrupted ? 'stopped' : 'failed'
      : degradedReasons.size > 0
        ? 'degraded'
        : 'completed';
  const participantTurnRefs = ordered
    .slice(0, MAX_TRACE_PARTICIPANTS)
    .map(({ turn }) => turnRef(turn));
  return {
    schemaVersion: 1,
    ownerTurnRef: first.strategy.ownerTurnRef,
    stageId: first.strategy.stageId,
    pattern: first.strategy.pattern,
    ...declaredPurpose(client, first.strategy.ownerTurnRef),
    ...(first.strategy.laneRelation === undefined
      ? {}
      : { laneRelation: first.strategy.laneRelation }),
    participantTurnRefs,
    targetActorTurnRefs: uniqueTargetActorTurnRefs.slice(0, MAX_TRACE_REFS),
    targetEvidenceRefs: targetEvidenceRefs.slice(0, MAX_TRACE_REFS),
    contextFacts,
    status,
    ...(dispositionCount === 0 ? {} : { dispositionCounts }),
    ...(dispositionFacts.length === 0 ? {} : { dispositionFacts }),
    ...(uniqueActorAssertedCoverage.length === 0
      ? {}
      : { actorAssertedCoverage: uniqueActorAssertedCoverage.slice(0, MAX_TRACE_REFS) }),
    ...(status === 'stopped' ? { stopReason: 'participant_interrupted' } : {}),
    ...(degradedReasons.size === 0
      ? {}
      : { degradedReasons: [...degradedReasons].sort() }),
  };
}

function validatedOutcomeTargetRef(
  client: AgentActorClient,
  outcome: PatternDispositionOutcome,
  declaredTargets: readonly string[],
  degradedReasons: Set<string>,
): string | undefined {
  if (!outcome.evidenceRefs.every(isCanonicalEvidenceRef)) {
    degradedReasons.add('invalid_disposition_evidence');
    return undefined;
  }
  if ('evidenceRef' in outcome.target) {
    if (!declaredTargets.includes(outcome.target.evidenceRef)) {
      degradedReasons.add('undeclared_disposition_target');
      return undefined;
    }
    return outcome.target.evidenceRef;
  }
  try {
    const declaredRef =
      `agent-turn:${outcome.target.actorPath}#turn=${outcome.target.turnId}`;
    if (!declaredTargets.includes(declaredRef)) {
      degradedReasons.add('undeclared_disposition_target');
      return undefined;
    }
    const output = client.output(outcome.target.actorPath, outcome.target.turnId);
    if (output.state === 'accepted' || output.state === 'running') {
      degradedReasons.add('nonterminal_actor_target');
      return undefined;
    }
    return declaredRef;
  } catch {
    degradedReasons.add('unavailable_actor_target');
    return undefined;
  }
}

function declaredPurpose(
  client: AgentActorClient,
  owner: ActorTurnIdentity,
): { readonly declaredPurpose?: string } {
  if (!client.list().actors.some((actor) => actor.path === owner.actorPath)) return {};
  const turn = client.get(owner.actorPath).turns.find(
    (candidate) => candidate.turnId === owner.turnId,
  );
  const purpose = turn === undefined ? undefined : boundedPurpose(turn.objective);
  return purpose === undefined ? {} : { declaredPurpose: purpose };
}

function buildContextFacts(facts: readonly StageFact[]): PatternTraceStage['contextFacts'] {
  const providers = groupLabels(facts.map(({ turn }) => metadataString(turn, 'effectiveProvider')));
  const models = groupLabels(facts.map(({ turn }) => metadataString(turn, 'effectiveModel')));
  const evidence = facts.map(({ turn, strategy }) => unique([
    ...metadataStringArray(turn, 'evidenceRefs'),
    ...(strategy.targetEvidenceRefs ?? []),
  ]));
  const shared = evidence.length === 0
    ? []
    : evidence.slice(1).reduce(
        (current, refs) => current.filter((ref) => refs.includes(ref)),
        evidence[0] ?? [],
      );
  const projected = facts.slice(0, MAX_TRACE_PARTICIPANTS);
  const commonParentActorPath = commonParentPath(facts.map(({ turn }) => turn.actorPath));
  return {
    participants: projected.map(({ turn, strategy }, index) => ({
      turnRef: turnRef(turn),
      role: strategy.role,
      forkTurns: turn.forkTurns,
      ...(providers[index] === undefined ? {} : { effectiveProviderGroup: providers[index] }),
      ...(models[index] === undefined ? {} : { effectiveModelGroup: models[index] }),
      evidenceRefCount: evidence[index]?.length ?? 0,
    })),
    sharedEvidenceRefCount: unique(shared).length,
    omittedParticipantCount: Math.max(0, facts.length - projected.length),
    ...(commonParentActorPath === undefined ? {} : { commonParentActorPath }),
    contextProjectionOmitted: facts.length > projected.length,
  };
}

function boundDispositionFacts(stages: readonly PatternTraceStage[]): PatternTraceStage[] {
  const candidates = stages.flatMap((stage, stageIndex) => (
    (stage.dispositionFacts ?? []).map((fact, factIndex) => ({
      fact,
      key: `${stageIndex}:${factIndex}`,
      stageIndex,
      factIndex,
    }))
  ));
  const admittedKeys = new Set(
    [...candidates]
      .sort((left, right) => (
        dispositionPriority(left.fact.disposition)
        - dispositionPriority(right.fact.disposition)
        || left.stageIndex - right.stageIndex
        || left.factIndex - right.factIndex
      ))
      .slice(0, MAX_TRACE_DISPOSITIONS)
      .map(({ key }) => key),
  );
  return stages.map((stage, stageIndex) => {
    const facts = stage.dispositionFacts ?? [];
    const admitted = facts.filter((_fact, factIndex) => (
      admittedKeys.has(`${stageIndex}:${factIndex}`)
    ));
    const omittedDispositionCount = facts.length - admitted.length;
    return {
      ...stage,
      ...(facts.length === 0 ? {} : { dispositionFacts: admitted }),
      ...(omittedDispositionCount === 0 ? {} : { omittedDispositionCount }),
    };
  });
}

function dispositionPriority(disposition: PatternDisposition): number {
  return disposition === 'refuted' ? 0 : disposition === 'unresolved' ? 1 : 2;
}

function groupLabels(values: readonly (string | undefined)[]): Array<string | undefined> {
  const uniqueValues = unique(values.filter((value): value is string => value !== undefined)).sort();
  return values.map((value) => {
    if (value === undefined) return undefined;
    return `group-${uniqueValues.indexOf(value) + 1}`;
  });
}

function metadataString(turn: AgentTurn, key: string): string | undefined {
  const value = turn.metadata?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function metadataStringArray(turn: AgentTurn, key: string): readonly string[] {
  const value = turn.metadata?.[key];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function isCanonicalEvidenceRef(value: string): boolean {
  return value.length <= 512
    && !/[\r\n\u0000-\u001f\u007f]/.test(value)
    && (
      value.startsWith('file:')
      || value.startsWith('diff:')
      || value.startsWith('finding:')
      || value.startsWith('agent-turn:')
    );
}

function commonParentPath(paths: readonly string[]): string | undefined {
  const parents = unique(paths.map((value) => {
    const separator = value.lastIndexOf('/');
    return separator <= 0 ? '/' : value.slice(0, separator);
  }));
  return parents.length === 1 ? parents[0] : undefined;
}

function prioritizeStages(stages: readonly PatternTraceStage[]): PatternTraceStage[] {
  return [...stages].sort((left, right) => (
    Number(hasRiskDisposition(right)) - Number(hasRiskDisposition(left))
    || compareStages(right, left)
  ));
}

function hasRiskDisposition(stage: PatternTraceStage): boolean {
  return (stage.dispositionCounts?.refuted ?? 0) > 0
    || (stage.dispositionCounts?.unresolved ?? 0) > 0;
}

function compareStages(left: PatternTraceStage, right: PatternTraceStage): number {
  return left.ownerTurnRef.actorPath.localeCompare(right.ownerTurnRef.actorPath)
    || left.ownerTurnRef.turnId.localeCompare(right.ownerTurnRef.turnId)
    || left.stageId.localeCompare(right.stageId);
}

function stageKey(strategy: StoredActorStrategyMetadata): string {
  return `${strategy.ownerTurnRef.actorPath}\0${strategy.ownerTurnRef.turnId}\0${strategy.stageId}`;
}

function turnRef(turn: AgentTurn): ActorTurnIdentity {
  return { actorPath: turn.actorPath, turnId: turn.turnId };
}

function isTerminal(turn: AgentTurn): boolean {
  return turn.state === 'completed' || turn.state === 'failed' || turn.state === 'interrupted';
}

function boundedPurpose(value: string): string | undefined {
  const normalized = value.replace(/\s+/g, ' ').trim().slice(0, 240);
  return normalized.length === 0 ? undefined : normalized;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function uniqueTurnRefs(values: readonly ActorTurnIdentity[]): ActorTurnIdentity[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = `${value.actorPath}\0${value.turnId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
