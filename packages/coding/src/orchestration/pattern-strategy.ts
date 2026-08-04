import { access } from 'node:fs/promises';

import {
  type AgentMetadataValue,
} from '@kodax-ai/agent';

import type {
  KodaXToolExecutionContext,
} from '../types.js';
import { resolveExecutionPath } from '../runtime-paths.js';
import {
  COLLABORATION_PATTERN_CATALOG,
  type CollaborationPatternId,
} from './pattern-catalog.js';

export type ActorStrategyRole =
  | 'classifier'
  | 'investigator'
  | 'generator'
  | 'filter'
  | 'judge'
  | 'challenger';

export type ActorLaneRelation = 'coverage' | 'replication' | 'opposition';

export interface ActorTurnIdentity {
  readonly actorPath: string;
  readonly turnId: string;
}

export interface ActorStrategyMetadata {
  readonly schemaVersion: 1;
  readonly stageId: string;
  readonly pattern: CollaborationPatternId;
  readonly role: ActorStrategyRole;
  readonly laneRelation?: ActorLaneRelation;
  readonly targetEvidenceRefs?: readonly string[];
}

export interface StoredActorStrategyMetadata extends ActorStrategyMetadata {
  readonly ownerTurnRef: ActorTurnIdentity;
}

const PATTERNS = new Set(COLLABORATION_PATTERN_CATALOG.map((entry) => entry.id));
const ROLES = new Set<ActorStrategyRole>([
  'classifier',
  'investigator',
  'generator',
  'filter',
  'judge',
  'challenger',
]);
const RELATIONS = new Set<ActorLaneRelation>(['coverage', 'replication', 'opposition']);
const STAGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

/**
 * Identifies failures that belong only to optional collaboration telemetry.
 * Callers may safely discard the metadata and retry the underlying legal Actor
 * operation; capacity, capability, lifecycle, and permission failures are not
 * represented by this type and remain fail-closed.
 */
export class QualityStrategyMetadataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QualityStrategyMetadataError';
  }
}

export function isQualityStrategyMetadataError(
  error: unknown,
): error is QualityStrategyMetadataError {
  return error instanceof QualityStrategyMetadataError;
}

export async function buildStoredActorStrategy(
  value: unknown,
  ctx: KodaXToolExecutionContext,
): Promise<StoredActorStrategyMetadata | undefined> {
  if (value === undefined) return undefined;
  const ownerTurnRef = ctx.actorTurnRef;
  const callerPath = ctx.actorControl?.callerPath;
  if (ownerTurnRef === undefined || callerPath === undefined) {
    throw new QualityStrategyMetadataError(
      'quality_strategy requires a Runtime-attributed Actor Turn.',
    );
  }
  if (ownerTurnRef.actorPath !== callerPath) {
    throw new QualityStrategyMetadataError(
      'Runtime Actor Turn attribution does not match the collaboration principal.',
    );
  }
  const strategy = parseActorStrategy(value);
  for (const ref of strategy.targetEvidenceRefs ?? []) {
    await assertPatternEvidenceRefVisible(ref, ctx);
  }
  return { ...strategy, ownerTurnRef };
}

export async function assertPatternEvidenceRefVisible(
  ref: string,
  ctx: KodaXToolExecutionContext,
): Promise<void> {
  if (/[\r\n\u0000-\u001f\u007f]/.test(ref)) {
    throw new QualityStrategyMetadataError(
      'quality_strategy evidence refs must be single-line printable text.',
    );
  }
  if (ref.startsWith('agent:')) {
    throw new QualityStrategyMetadataError(
      'quality_strategy Actor targets require agent-turn:<path>#turn=<id>.',
    );
  }
  const target = parseActorTurnEvidenceRef(ref);
  if (target !== undefined) {
    const output = ctx.actorControl?.output(target.actorPath, target.turnId);
    if (output === undefined || output.state === 'accepted' || output.state === 'running') {
      throw new QualityStrategyMetadataError(
        `quality_strategy target ${ref} must already be terminal.`,
      );
    }
    return;
  }
  if (ref.startsWith('finding:')) {
    if (ref.slice('finding:'.length).trim().length === 0) {
      throw new QualityStrategyMetadataError(
        'quality_strategy finding refs require concrete text.',
      );
    }
    return;
  }
  if (ref.startsWith('file:') || ref.startsWith('diff:')) {
    const prefixLength = ref.startsWith('file:') ? 'file:'.length : 'diff:'.length;
    const candidate = ref.slice(prefixLength);
    if (candidate.length === 0 || candidate !== candidate.trim()) {
      throw new QualityStrategyMetadataError(
        'quality_strategy file and diff refs require an exact path.',
      );
    }
    const resolved = resolveExecutionPath(candidate, ctx);
    ctx.assertReadablePath?.(resolved);
    try {
      await access(resolved);
    } catch {
      throw new QualityStrategyMetadataError(
        `quality_strategy target ${ref} is not readable.`,
      );
    }
    return;
  }
  throw new QualityStrategyMetadataError(
    `quality_strategy target ${ref} must use file:, diff:, finding:, or agent-turn:.`,
  );
}

export function toActorStrategyMetadataValue(
  strategy: StoredActorStrategyMetadata,
): AgentMetadataValue {
  return {
    schemaVersion: strategy.schemaVersion,
    stageId: strategy.stageId,
    pattern: strategy.pattern,
    role: strategy.role,
    ...(strategy.laneRelation === undefined ? {} : { laneRelation: strategy.laneRelation }),
    ...(strategy.targetEvidenceRefs === undefined
      ? {}
      : { targetEvidenceRefs: strategy.targetEvidenceRefs }),
    ownerTurnRef: {
      actorPath: strategy.ownerTurnRef.actorPath,
      turnId: strategy.ownerTurnRef.turnId,
    },
  };
}

export function parseActorTurnEvidenceRef(value: string): ActorTurnIdentity | undefined {
  if (!value.startsWith('agent-turn:')) return undefined;
  const payload = value.slice('agent-turn:'.length);
  const separator = payload.lastIndexOf('#turn=');
  if (separator <= 0) {
    throw new QualityStrategyMetadataError(
      'agent-turn evidence refs must use agent-turn:<path>#turn=<id>.',
    );
  }
  const actorPath = payload.slice(0, separator).trim();
  const turnId = payload.slice(separator + '#turn='.length).trim();
  if (!actorPath.startsWith('/root/') || turnId.length === 0) {
    throw new QualityStrategyMetadataError(
      'agent-turn evidence refs require a canonical child path and exact turn id.',
    );
  }
  return { actorPath, turnId };
}

export function readStoredActorStrategy(
  value: AgentMetadataValue | undefined,
): StoredActorStrategyMetadata | undefined {
  if (!isRecord(value)) return undefined;
  try {
    const strategy = parseActorStrategy(value);
    const owner = value.ownerTurnRef;
    if (!isRecord(owner)) return undefined;
    const actorPath = nonEmptyString(owner.actorPath);
    const turnId = nonEmptyString(owner.turnId);
    if (actorPath === undefined || turnId === undefined) return undefined;
    return { ...strategy, ownerTurnRef: { actorPath, turnId } };
  } catch {
    return undefined;
  }
}

function parseActorStrategy(value: unknown): ActorStrategyMetadata {
  if (!isRecord(value)) {
    throw new QualityStrategyMetadataError('quality_strategy must be an object.');
  }
  if (value.schemaVersion !== 1) {
    throw new QualityStrategyMetadataError('quality_strategy.schemaVersion must be 1.');
  }
  const stageId = nonEmptyString(value.stageId);
  if (stageId === undefined || !STAGE_ID_PATTERN.test(stageId)) {
    throw new QualityStrategyMetadataError(
      'quality_strategy.stageId must be a stable 1-120 character id.',
    );
  }
  const pattern = value.pattern;
  if (typeof pattern !== 'string' || !PATTERNS.has(pattern as CollaborationPatternId)) {
    throw new QualityStrategyMetadataError(
      'quality_strategy.pattern is not a known collaboration pattern.',
    );
  }
  const role = value.role;
  if (typeof role !== 'string' || !ROLES.has(role as ActorStrategyRole)) {
    throw new QualityStrategyMetadataError('quality_strategy.role is not supported.');
  }
  const laneRelation = value.laneRelation;
  if (
    laneRelation !== undefined
    && (typeof laneRelation !== 'string' || !RELATIONS.has(laneRelation as ActorLaneRelation))
  ) {
    throw new QualityStrategyMetadataError(
      'quality_strategy.laneRelation is not supported.',
    );
  }
  const targetEvidenceRefs = optionalStringArray(value.targetEvidenceRefs);
  if (pattern === 'adversarial-verification' && targetEvidenceRefs.length === 0) {
    throw new QualityStrategyMetadataError(
      'adversarial-verification requires at least one concrete targetEvidenceRef.',
    );
  }
  return {
    schemaVersion: 1,
    stageId,
    pattern: pattern as CollaborationPatternId,
    role: role as ActorStrategyRole,
    ...(laneRelation === undefined ? {} : { laneRelation: laneRelation as ActorLaneRelation }),
    ...(targetEvidenceRefs.length === 0 ? {} : { targetEvidenceRefs }),
  };
}

function optionalStringArray(value: unknown): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) {
    throw new QualityStrategyMetadataError(
      'quality_strategy.targetEvidenceRefs must contain at most 20 strings.',
    );
  }
  const normalized = value.map((entry) => {
    const text = nonEmptyString(entry);
    if (text === undefined || text.length > 512) {
      throw new QualityStrategyMetadataError(
        'quality_strategy.targetEvidenceRefs entries must be 1-512 characters.',
      );
    }
    return text;
  });
  return [...new Set(normalized)];
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized.length === 0 ? undefined : normalized;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
