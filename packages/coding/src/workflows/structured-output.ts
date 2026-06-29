/**
 * FEATURE_246 Part B — structured child output (validate-and-repair).
 *
 * A workflow child can declare an `outputSchema` (a JSON Schema). The child is
 * instructed to end its response with a fenced ```json block; after it
 * completes we extract that block, parse it, and validate it against a focused
 * JSON-Schema subset. On a hard failure (no JSON / parse error / missing
 * required field) the caller runs one bounded repair turn.
 *
 * This lives entirely in the workflow layer and never touches the provider
 * tool-call parser (ADR-044 §4 — the validate-and-repair path was chosen over a
 * forced `structured_output` tool precisely to avoid that coupling). The
 * validator covers the JSON-Schema keywords real workflow schemas use: `type`,
 * `enum`, `required`, `properties`, `items`, `additionalProperties:false`.
 */

export interface StructuredOutputEvaluation {
  readonly ok: boolean;
  /** Parsed value when JSON was found and parsed (even if schema-invalid). */
  readonly value?: unknown;
  /** Human-readable problems ([] when ok). */
  readonly errors: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return isRecord(value);
    case 'array':
      return Array.isArray(value);
    case 'null':
      return value === null;
    default:
      // Unknown type keyword — do not constrain.
      return true;
  }
}

function enumMatches(candidates: readonly unknown[], value: unknown): boolean {
  return candidates.some((candidate) => {
    if (candidate === value) return true;
    if (typeof candidate !== 'object' || typeof value !== 'object') return false;
    return safeStringify(candidate) === safeStringify(value);
  });
}

function joinPath(path: string, key: string): string {
  return path ? `${path}.${key}` : key;
}

/**
 * Validate `value` against the JSON-Schema subset. Returns a list of
 * human-readable problems; an empty list means valid. Best-effort and
 * non-throwing — an unrecognized schema shape simply imposes no constraint.
 */
export function validateAgainstSchema(value: unknown, schema: unknown, path = ''): readonly string[] {
  if (!isRecord(schema)) return [];
  const errors: string[] = [];
  const loc = path || '(root)';

  const type = schema.type;
  if (typeof type === 'string' && !matchesType(value, type)) {
    return [`${loc}: expected type ${type}`];
  }
  if (
    Array.isArray(type) &&
    !type.some((candidate) => typeof candidate === 'string' && matchesType(value, candidate))
  ) {
    return [`${loc}: expected one of types ${type.join('|')}`];
  }

  if (Array.isArray(schema.enum) && !enumMatches(schema.enum, value)) {
    errors.push(`${loc}: value is not one of the allowed enum values`);
  }

  if (isRecord(value)) {
    const properties = isRecord(schema.properties) ? schema.properties : undefined;
    if (Array.isArray(schema.required)) {
      for (const required of schema.required) {
        if (typeof required === 'string' && !(required in value)) {
          errors.push(`${joinPath(path, required)}: required field is missing`);
        }
      }
    }
    if (properties) {
      for (const [key, child] of Object.entries(value)) {
        if (key in properties) {
          errors.push(...validateAgainstSchema(child, properties[key], joinPath(path, key)));
        }
      }
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(value)) {
          if (!(key in properties)) {
            errors.push(`${joinPath(path, key)}: unexpected property (additionalProperties is false)`);
          }
        }
      }
    }
  }

  if (Array.isArray(value) && isRecord(schema.items)) {
    value.forEach((element, index) => {
      errors.push(...validateAgainstSchema(element, schema.items, `${loc}[${index}]`));
    });
  }

  return errors;
}

/**
 * JSON-Schema keywords whose presence changes whether/how validation happens
 * but which the subset validator does NOT implement. Silently ignoring them
 * would mean a schema "validates" while real constraints go unchecked — and the
 * model, seeing idiomatic JSON Schema accepted, has no signal it was a no-op.
 * So we reject them at declaration time with a clear error instead.
 *
 * Annotation-only keywords (`description`, `title`, `default`, `examples`,
 * `$comment`, `$schema`, `format`) do not change validation and are allowed.
 */
const UNSUPPORTED_SCHEMA_KEYWORDS: readonly string[] = [
  '$ref',
  '$defs',
  'definitions',
  'oneOf',
  'allOf',
  'anyOf',
  'not',
  'if',
  'then',
  'else',
  'const',
  'patternProperties',
  'propertyNames',
  'dependencies',
  'dependentSchemas',
  'dependentRequired',
  'contains',
  'unevaluatedProperties',
  'unevaluatedItems',
];

function collectUnsupportedKeywords(schema: unknown, path: string, found: Map<string, string>): void {
  if (!isRecord(schema)) return;
  for (const keyword of UNSUPPORTED_SCHEMA_KEYWORDS) {
    if (keyword in schema && !found.has(keyword)) {
      found.set(keyword, path || '(root)');
    }
  }
  // Recurse only into the subschema positions the subset validator honors, so
  // the error points at where an author can actually fix it.
  if (isRecord(schema.properties)) {
    for (const [key, child] of Object.entries(schema.properties)) {
      collectUnsupportedKeywords(child, joinPath(path, key), found);
    }
  }
  if (isRecord(schema.items)) {
    collectUnsupportedKeywords(schema.items, `${path || '(root)'}[]`, found);
  }
  if (isRecord(schema.additionalProperties)) {
    collectUnsupportedKeywords(schema.additionalProperties, `${path || '(root)'}.*`, found);
  }
}

/**
 * Throw if `schema` uses a JSON-Schema keyword the subset validator can't honor.
 * Called when a workflow child declares `outputSchema`, so the author/model gets
 * immediate feedback rather than a silently-unvalidated result. No-op for the
 * supported subset (`type`/`enum`/`required`/`properties`/`items`/
 * `additionalProperties`) and for non-object schemas.
 */
export function assertSupportedOutputSchema(schema: unknown): void {
  if (!isRecord(schema)) return;
  const found = new Map<string, string>();
  collectUnsupportedKeywords(schema, '', found);
  if (found.size === 0) return;
  const detail = [...found.entries()]
    .map(([keyword, at]) => `\`${keyword}\` (at ${at})`)
    .join(', ');
  throw new Error(
    `outputSchema uses unsupported JSON-Schema keyword(s): ${detail}. ` +
      'The workflow validator supports only type, enum, required, properties, ' +
      'items, and additionalProperties (nested object arrays included). ' +
      'Inline the referenced shapes and use that subset.',
  );
}

function firstStructureStart(text: string): number {
  const brace = text.indexOf('{');
  const bracket = text.indexOf('[');
  if (brace < 0) return bracket;
  if (bracket < 0) return brace;
  return Math.min(brace, bracket);
}

/** Return the first balanced `{...}` / `[...]` substring (string-aware), or undefined. */
function balancedStructure(text: string): string | undefined {
  const start = firstStructureStart(text);
  if (start < 0) return undefined;
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

/**
 * Extract the JSON candidate from a child's final text. Prefers the LAST fenced
 * ```json block; falls back to the first balanced object/array in the text.
 */
export function extractJsonCandidate(text: string): string | undefined {
  if (typeof text !== 'string' || text.trim().length === 0) return undefined;
  const fence = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  let lastFenced: string | undefined;
  while ((match = fence.exec(text)) !== null) {
    const inner = match[1]?.trim();
    if (inner) lastFenced = inner;
  }
  if (lastFenced) {
    return balancedStructure(lastFenced) ?? lastFenced;
  }
  return balancedStructure(text);
}

/** Parse + validate a child's final text against the schema. Never throws. */
export function evaluateStructuredOutput(finalText: string, schema: unknown): StructuredOutputEvaluation {
  const candidate = extractJsonCandidate(finalText);
  if (candidate === undefined) {
    return { ok: false, errors: ['no JSON value was found in the output'] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (error) {
    return { ok: false, errors: [`output was not valid JSON: ${errorMessage(error)}`] };
  }
  const errors = validateAgainstSchema(parsed, schema);
  return { ok: errors.length === 0, value: parsed, errors };
}

/** Instruction appended to a child's briefing when `outputSchema` is set. */
export function buildStructuredOutputInstruction(schema: unknown): string {
  return [
    '## Required Output Format',
    'After your analysis, end your response with a single fenced ```json code block containing ONLY a JSON value that matches the JSON Schema below. Put nothing after the closing fence.',
    'Schema:',
    '```json',
    safeStringify(schema),
    '```',
  ].join('\n');
}

/** Prompt for the one bounded repair turn when the output failed to validate. */
export function buildStructuredOutputRepairPrompt(
  errors: readonly string[],
  schema: unknown,
): string {
  return [
    'Your previous response did not produce a valid result object for the workflow.',
    'Problems:',
    ...errors.map((error) => `- ${error}`),
    'Re-emit ONLY a single fenced ```json code block containing a JSON value that matches this schema. No prose, nothing after the closing fence.',
    'Schema:',
    '```json',
    safeStringify(schema),
    '```',
  ].join('\n');
}
