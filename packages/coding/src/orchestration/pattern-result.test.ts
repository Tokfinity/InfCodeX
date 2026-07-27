import { describe, expect, it } from 'vitest';

import {
  assertSupportedOutputSchema,
  evaluateStructuredOutput,
} from '../workflows/structured-output.js';
import {
  parsePatternDispositionEnvelope,
  PATTERN_DISPOSITION_ENVELOPE_SCHEMA,
} from './pattern-result.js';

describe('pattern disposition target contract', () => {
  it('exposes the same exclusive actor-or-evidence target accepted by the parser', () => {
    const targetSchema =
      PATTERN_DISPOSITION_ENVELOPE_SCHEMA.properties.outcomes.items.properties.target;

    expect(targetSchema).toEqual({
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
    });

    expect(parsePatternDispositionEnvelope({
      schemaVersion: 1,
      outcomes: [{
        target: { actorPath: '/root/reviewer', turnId: 'turn-1' },
        disposition: 'confirmed',
        evidenceRefs: ['agent-turn:/root/reviewer#turn=turn-1'],
      }],
      assertedCoverage: [],
    })).toBeDefined();
    expect(parsePatternDispositionEnvelope({
      schemaVersion: 1,
      outcomes: [{
        target: {
          actorPath: '/root/reviewer',
          turnId: 'turn-1',
          evidenceRef: 'agent-turn:/root/reviewer#turn=turn-1',
        },
        disposition: 'confirmed',
        evidenceRefs: [],
      }],
      assertedCoverage: [],
    })).toBeUndefined();
  });

  it('first-pass structured-output validation rejects a mixed target via the schema oneOf', () => {
    const mixed = evaluateStructuredOutput(
      [
        '```json',
        JSON.stringify({
          schemaVersion: 1,
          outcomes: [{
            target: {
              actorPath: '/root/reviewer',
              turnId: 'turn-1',
              evidenceRef: 'agent-turn:/root/reviewer#turn=turn-1',
            },
            disposition: 'confirmed',
            evidenceRefs: [],
          }],
          assertedCoverage: [],
        }),
        '```',
      ].join('\n'),
      PATTERN_DISPOSITION_ENVELOPE_SCHEMA,
    );

    expect(mixed.ok).toBe(false);
    expect(mixed.errors.some((error) => error.includes('exactly one'))).toBe(true);
  });

  it('remains declarable as a workflow outputSchema after the oneOf tightening', () => {
    expect(() =>
      assertSupportedOutputSchema(PATTERN_DISPOSITION_ENVELOPE_SCHEMA),
    ).not.toThrow();
  });
});
