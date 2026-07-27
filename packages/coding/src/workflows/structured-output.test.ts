import { describe, expect, it } from 'vitest';

import {
  assertSupportedOutputSchema,
  buildStructuredOutputInstruction,
  buildStructuredOutputRepairPrompt,
  evaluateStructuredOutput,
  extractJsonCandidate,
  validateAgainstSchema,
} from './structured-output.js';

const FINDING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['lens', 'findings'],
  properties: {
    lens: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'title'],
        properties: {
          severity: { enum: ['critical', 'high', 'medium', 'low', 'nit'] },
          title: { type: 'string' },
        },
      },
    },
  },
};

describe('validateAgainstSchema', () => {
  it('accepts a fully valid nested object', () => {
    const value = { lens: 'correctness', findings: [{ severity: 'high', title: 'x' }] };
    expect(validateAgainstSchema(value, FINDING_SCHEMA)).toEqual([]);
  });

  it('flags a missing required field', () => {
    const errors = validateAgainstSchema({ findings: [] }, FINDING_SCHEMA);
    expect(errors).toContain('lens: required field is missing');
  });

  it('flags an enum violation with a path', () => {
    const value = { lens: 'l', findings: [{ severity: 'blocker', title: 't' }] };
    const errors = validateAgainstSchema(value, FINDING_SCHEMA);
    expect(errors.some((e) => e.includes('findings[0].severity') && e.includes('enum'))).toBe(true);
  });

  it('flags a wrong scalar type', () => {
    const errors = validateAgainstSchema({ lens: 5, findings: [] }, FINDING_SCHEMA);
    expect(errors).toContain('lens: expected type string');
  });

  it('rejects an unexpected property when additionalProperties is false', () => {
    const value = { lens: 'l', findings: [], extra: 1 };
    const errors = validateAgainstSchema(value, FINDING_SCHEMA);
    expect(errors.some((e) => e.includes('extra') && e.includes('unexpected'))).toBe(true);
  });

  it('accepts integer for integer type but rejects a float', () => {
    const schema = { type: 'object', required: ['n'], properties: { n: { type: 'integer' } } };
    expect(validateAgainstSchema({ n: 3 }, schema)).toEqual([]);
    expect(validateAgainstSchema({ n: 3.5 }, schema)).toContain('n: expected type integer');
  });

  it('imposes no constraint for a non-object schema', () => {
    expect(validateAgainstSchema({ anything: true }, undefined)).toEqual([]);
  });

  it('enforces oneOf: exactly one variant must match', () => {
    const schema = {
      oneOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['actorPath', 'turnId'],
          properties: { actorPath: { type: 'string' }, turnId: { type: 'string' } },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['evidenceRef'],
          properties: { evidenceRef: { type: 'string' } },
        },
      ],
    };
    expect(
      validateAgainstSchema({ actorPath: '/root/reviewer', turnId: 'turn-1' }, schema),
    ).toEqual([]);
    expect(validateAgainstSchema({ evidenceRef: 'agent-turn:/root/reviewer#turn=turn-1' }, schema))
      .toEqual([]);
    // Both target forms present → matches zero variants (additionalProperties).
    const both = validateAgainstSchema(
      { actorPath: '/root/reviewer', turnId: 'turn-1', evidenceRef: 'x' },
      schema,
    );
    expect(both).toHaveLength(1);
    expect(both[0]).toContain('exactly one');
    expect(both[0]).toContain('matched 0');
    // Neither required set complete → also zero matches.
    const neither = validateAgainstSchema({ actorPath: '/root/reviewer' }, schema);
    expect(neither).toHaveLength(1);
    expect(neither[0]).toContain('matched 0');
  });

  it('enforces oneOf: matching more than one variant is an error', () => {
    const schema = { oneOf: [{ type: 'string' }, { type: 'string' }] };
    const errors = validateAgainstSchema('x', schema);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('matched 2');
  });
});
describe('extractJsonCandidate', () => {
  it('extracts a fenced json block surrounded by prose', () => {
    const text = 'Here is my analysis.\n\n```json\n{"lens":"x","findings":[]}\n```\n';
    expect(extractJsonCandidate(text)).toBe('{"lens":"x","findings":[]}');
  });

  it('prefers the LAST fenced block', () => {
    const text = '```json\n{"a":1}\n```\nthen\n```json\n{"b":2}\n```';
    expect(extractJsonCandidate(text)).toBe('{"b":2}');
  });

  it('falls back to a trailing balanced object with no fence', () => {
    const text = 'Result: {"lens":"x","findings":[{"severity":"low","title":"t"}]}';
    expect(extractJsonCandidate(text)).toBe('{"lens":"x","findings":[{"severity":"low","title":"t"}]}');
  });

  it('is string-aware (braces inside strings do not unbalance)', () => {
    const text = '{"title":"a } b","n":1}';
    expect(extractJsonCandidate(text)).toBe('{"title":"a } b","n":1}');
  });

  it('returns undefined when there is no JSON', () => {
    expect(extractJsonCandidate('no structured output here')).toBeUndefined();
    expect(extractJsonCandidate('')).toBeUndefined();
  });
});

describe('evaluateStructuredOutput', () => {
  it('ok=true and value set for valid fenced output', () => {
    const text = '```json\n{"lens":"c","findings":[{"severity":"high","title":"t"}]}\n```';
    const result = evaluateStructuredOutput(text, FINDING_SCHEMA);
    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ lens: 'c', findings: [{ severity: 'high', title: 't' }] });
    expect(result.errors).toEqual([]);
  });

  it('ok=false but value still parsed when schema-invalid', () => {
    const text = '```json\n{"findings":[]}\n```';
    const result = evaluateStructuredOutput(text, FINDING_SCHEMA);
    expect(result.ok).toBe(false);
    expect(result.value).toEqual({ findings: [] });
    expect(result.errors).toContain('lens: required field is missing');
  });

  it('ok=false with no value when JSON is absent', () => {
    const result = evaluateStructuredOutput('I could not produce JSON.', FINDING_SCHEMA);
    expect(result.ok).toBe(false);
    expect(result.value).toBeUndefined();
  });

  it('ok=false with no value when JSON is malformed', () => {
    const result = evaluateStructuredOutput('```json\n{"lens": "x",,}\n```', FINDING_SCHEMA);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('not valid JSON');
  });
});

describe('prompt builders', () => {
  it('instruction names the fenced json contract and embeds the schema', () => {
    const instruction = buildStructuredOutputInstruction(FINDING_SCHEMA);
    expect(instruction).toContain('Required Output Format');
    expect(instruction).toContain('```json');
    expect(instruction).toContain('"severity"');
  });

  it('repair prompt lists the errors and the schema', () => {
    const prompt = buildStructuredOutputRepairPrompt(['lens: required field is missing'], FINDING_SCHEMA);
    expect(prompt).toContain('lens: required field is missing');
    expect(prompt).toContain('Re-emit ONLY');
    expect(prompt).toContain('"findings"');
  });
});

describe('assertSupportedOutputSchema', () => {
  it('accepts the supported subset (incl. nested object arrays)', () => {
    expect(() => assertSupportedOutputSchema(FINDING_SCHEMA)).not.toThrow();
  });

  it('accepts annotation-only keywords (description/title/default/format)', () => {
    expect(() =>
      assertSupportedOutputSchema({
        type: 'object',
        title: 'Finding',
        description: 'a finding',
        properties: { name: { type: 'string', description: 'x', default: '', format: 'email' } },
      }),
    ).not.toThrow();
  });

  it('rejects $ref / $defs and names the keyword + location', () => {
    let message = '';
    try {
      assertSupportedOutputSchema({
        $defs: { Sev: { enum: ['high', 'low'] } },
        type: 'object',
        properties: { severity: { $ref: '#/$defs/Sev' } },
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('unsupported');
    expect(message).toContain('$defs');
    expect(message).toContain('$ref');
    // path uses the validator's joinPath convention (root property = bare key)
    expect(message).toContain('at severity');
  });

  it('rejects unsupported composition keywords nested under items', () => {
    expect(() =>
      assertSupportedOutputSchema({
        type: 'array',
        items: { allOf: [{ type: 'string' }, { minLength: 1 }] },
      }),
    ).toThrow(/allOf/);
  });

  it('accepts oneOf at declaration and rejects unsupported keywords inside its variants', () => {
    expect(() =>
      assertSupportedOutputSchema({
        type: 'object',
        properties: {
          target: {
            oneOf: [
              { type: 'object', required: ['a'], properties: { a: { type: 'string' } } },
              { type: 'object', required: ['b'], properties: { b: { type: 'string' } } },
            ],
          },
        },
      }),
    ).not.toThrow();
    expect(() =>
      assertSupportedOutputSchema({
        type: 'object',
        properties: {
          target: {
            oneOf: [
              { type: 'object', properties: { a: { type: 'string', pattern: '^a' } } },
              { type: 'object', properties: { b: { type: 'string' } } },
            ],
          },
        },
      }),
    ).toThrow(/pattern/);
  });
  it('is a no-op for a non-object schema', () => {
    expect(() => assertSupportedOutputSchema(undefined)).not.toThrow();
    expect(() => assertSupportedOutputSchema('nope')).not.toThrow();
  });

  it('rejects value-constraint keywords the validator would silently ignore', () => {
    // These would otherwise "validate" while the constraint goes unchecked
    // (e.g. `{ age: -5 }` passing a `minimum: 0` schema).
    expect(() =>
      assertSupportedOutputSchema({ type: 'object', properties: { age: { type: 'number', minimum: 0 } } }),
    ).toThrow(/minimum/);
    expect(() =>
      assertSupportedOutputSchema({ type: 'object', properties: { name: { type: 'string', pattern: '^a' } } }),
    ).toThrow(/pattern/);
    expect(() =>
      assertSupportedOutputSchema({ type: 'array', items: { type: 'string' }, minItems: 1 }),
    ).toThrow(/minItems/);
  });

  it('rejects additionalProperties in schema-object form (only false is honored)', () => {
    expect(() =>
      assertSupportedOutputSchema({ type: 'object', additionalProperties: { type: 'string' } }),
    ).toThrow(/additionalProperties/);
    // `false` and omitted stay supported.
    expect(() =>
      assertSupportedOutputSchema({ type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false }),
    ).not.toThrow();
  });
});
