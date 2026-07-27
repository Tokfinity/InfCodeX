import type { AgentMetadataValue } from '@kodax-ai/agent';

import type { ActorTurnIdentity } from './pattern-strategy.js';

export type PatternDisposition = 'confirmed' | 'refuted' | 'unresolved';

export interface PatternDispositionOutcome {
  readonly target: ActorTurnIdentity | { readonly evidenceRef: string };
  readonly disposition: PatternDisposition;
  readonly evidenceRefs: readonly string[];
}

export interface PatternDispositionEnvelope {
  readonly schemaVersion: 1;
  readonly outcomes: readonly PatternDispositionOutcome[];
  readonly assertedCoverage: readonly string[];
}

export const PATTERN_DISPOSITION_ENVELOPE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'outcomes', 'assertedCoverage'],
  properties: {
    schemaVersion: { type: 'number', enum: [1] },
    outcomes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['target', 'disposition', 'evidenceRefs'],
        properties: {
          target: {
            oneOf: [
              {
                type: 'object',
                additionalProperties: false,
                required: ['actorPath', 'turnId'],
                properties: {
                  actorPath: { type: 'string' },
                  turnId: { type: 'string' },
                },
              },
              {
                type: 'object',
                additionalProperties: false,
                required: ['evidenceRef'],
                properties: {
                  evidenceRef: { type: 'string' },
                },
              },
            ],
          },
          disposition: {
            type: 'string',
            enum: ['confirmed', 'refuted', 'unresolved'],
          },
          evidenceRefs: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    assertedCoverage: { type: 'array', items: { type: 'string' } },
  },
} as const;

export function parsePatternDispositionEnvelope(
  value: unknown,
): PatternDispositionEnvelope | undefined {
  if (
    !isRecord(value)
    || !hasOnlyKeys(value, ['schemaVersion', 'outcomes', 'assertedCoverage'])
    || value.schemaVersion !== 1
  ) {
    return undefined;
  }
  if (!Array.isArray(value.outcomes) || value.outcomes.length > 50) return undefined;
  if (!Array.isArray(value.assertedCoverage) || value.assertedCoverage.length > 50) {
    return undefined;
  }
  const assertedCoverage = stringArray(value.assertedCoverage);
  if (assertedCoverage === undefined) return undefined;
  const outcomes: PatternDispositionOutcome[] = [];
  for (const entry of value.outcomes) {
    const outcome = parseOutcome(entry);
    if (outcome === undefined) return undefined;
    outcomes.push(outcome);
  }
  return {
    schemaVersion: 1,
    outcomes,
    assertedCoverage: [...new Set(assertedCoverage)],
  };
}

export function toAgentMetadataValue(value: unknown): AgentMetadataValue | undefined {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    const converted: AgentMetadataValue[] = [];
    for (const entry of value) {
      const item = toAgentMetadataValue(entry);
      if (item === undefined) return undefined;
      converted.push(item);
    }
    return converted;
  }
  if (!isRecord(value)) return undefined;
  const converted: Record<string, AgentMetadataValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    const item = toAgentMetadataValue(entry);
    if (item === undefined) return undefined;
    converted[key] = item;
  }
  return converted;
}

function parseOutcome(value: unknown): PatternDispositionOutcome | undefined {
  if (
    !isRecord(value)
    || !hasOnlyKeys(value, ['target', 'disposition', 'evidenceRefs'])
    || !isRecord(value.target)
    || !hasOnlyKeys(value.target, ['actorPath', 'turnId', 'evidenceRef'])
  ) {
    return undefined;
  }
  if (
    value.disposition !== 'confirmed'
    && value.disposition !== 'refuted'
    && value.disposition !== 'unresolved'
  ) {
    return undefined;
  }
  if (!Array.isArray(value.evidenceRefs) || value.evidenceRefs.length > 20) return undefined;
  const evidenceRefs = stringArray(value.evidenceRefs);
  if (evidenceRefs === undefined) return undefined;
  const actorPath = boundedString(value.target.actorPath);
  const turnId = boundedString(value.target.turnId);
  const evidenceRef = boundedString(value.target.evidenceRef);
  const hasActorTarget = actorPath !== undefined && turnId !== undefined;
  const hasEvidenceTarget = evidenceRef !== undefined;
  if (hasActorTarget === hasEvidenceTarget) return undefined;
  if (
    !hasActorTarget
    && (value.target.actorPath !== undefined || value.target.turnId !== undefined)
  ) {
    return undefined;
  }
  return {
    target: hasActorTarget
      ? { actorPath, turnId }
      : { evidenceRef: evidenceRef as string },
    disposition: value.disposition,
    evidenceRefs: [...new Set(evidenceRefs)],
  };
}

function stringArray(value: readonly unknown[]): string[] | undefined {
  const output: string[] = [];
  for (const entry of value) {
    const text = boundedString(entry);
    if (text === undefined) return undefined;
    output.push(text);
  }
  return output;
}

function boundedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 512 ? normalized : undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}
