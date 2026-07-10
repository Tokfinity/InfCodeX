import type { KodaXToolDefinition } from '@kodax-ai/llm';

export interface ToolSearchIndexEntry {
  readonly name: string;
  readonly text: string;
  readonly terms: ReadonlyMap<string, number>;
  readonly tokenCount: number;
}

export interface ToolSearchIndex {
  readonly entries: readonly ToolSearchIndexEntry[];
  readonly documentFrequency: ReadonlyMap<string, number>;
}

export interface ToolSearchQueryParts {
  readonly required: readonly string[];
  readonly loose: readonly string[];
}

export interface ToolSearchIndexOptions {
  readonly hints?: Readonly<Record<string, string>>;
}

export interface ToolSearchResult {
  readonly name: string;
  readonly score: number;
  readonly matchedTerms: readonly string[];
}

export function buildToolSearchIndex(
  definitions: readonly KodaXToolDefinition[],
  options: ToolSearchIndexOptions = {},
): ToolSearchIndex {
  const entries = definitions.map((definition) => buildEntry(definition, options.hints?.[definition.name]));
  const documentFrequency = new Map<string, number>();

  for (const entry of entries) {
    for (const term of entry.terms.keys()) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }

  return { entries, documentFrequency };
}

export function searchToolIndex(
  index: ToolSearchIndex,
  query: string | ToolSearchQueryParts,
  maxResults: number,
): readonly ToolSearchResult[] {
  const parsed = typeof query === 'string' ? parseToolSearchQuery(query) : normalizeQueryParts(query);
  const cappedMax = Math.max(0, Math.floor(maxResults));
  if (cappedMax === 0 || (parsed.required.length === 0 && parsed.loose.length === 0)) {
    return [];
  }

  const scored: ToolSearchResult[] = [];
  for (const entry of index.entries) {
    const requiredMatches = parsed.required.every((term) => entryMatchesTerm(entry, term));
    if (!requiredMatches) continue;

    const matchedLoose = parsed.loose.filter((term) => entryMatchesTerm(entry, term));
    if (parsed.loose.length > 0 && matchedLoose.length === 0) continue;

    const matchedTerms = [...parsed.required, ...matchedLoose];
    scored.push({
      name: entry.name,
      score: scoreEntry(index, entry, matchedTerms, parsed.loose),
      matchedTerms,
    });
  }

  scored.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return left.name.localeCompare(right.name);
  });
  return scored.slice(0, cappedMax);
}

export function parseToolSearchQuery(query: string): ToolSearchQueryParts {
  const required: string[] = [];
  const loose: string[] = [];

  for (const rawTerm of tokenize(query)) {
    if (rawTerm.startsWith('+') && rawTerm.length > 1) {
      required.push(normalizeTerm(rawTerm.slice(1)));
    } else {
      loose.push(normalizeTerm(rawTerm));
    }
  }

  return normalizeQueryParts({ required, loose });
}

function buildEntry(
  definition: KodaXToolDefinition,
  hint: string | undefined,
): ToolSearchIndexEntry {
  const schemaText = collectSchemaText(definition.input_schema);
  const nameText = splitToolName(definition.name).join(' ');
  const text = [
    definition.name,
    nameText,
    hint,
    definition.description,
    schemaText,
  ].filter((part): part is string => typeof part === 'string' && part.length > 0).join(' ');
  const terms = new Map<string, number>();

  for (const term of tokenize(text)) {
    const normalized = normalizeTerm(term);
    if (normalized.length === 0) continue;
    terms.set(normalized, (terms.get(normalized) ?? 0) + 1);
  }

  return {
    name: definition.name,
    text: text.toLowerCase(),
    terms,
    tokenCount: Array.from(terms.values()).reduce((total, count) => total + count, 0),
  };
}

function scoreEntry(
  index: ToolSearchIndex,
  entry: ToolSearchIndexEntry,
  matchedTerms: readonly string[],
  looseTerms: readonly string[],
): number {
  let score = 0;
  const averageLength = averageDocumentLength(index);
  for (const term of matchedTerms) {
    const tf = entry.terms.get(term) ?? (entry.text.includes(term) ? 1 : 0);
    const df = index.documentFrequency.get(term) ?? 1;
    const idf = Math.log(1 + (index.entries.length - df + 0.5) / (df + 0.5));
    const lengthNorm = entry.tokenCount > 0 && averageLength > 0
      ? 1.2 * (1 - 0.75 + 0.75 * (entry.tokenCount / averageLength))
      : 1.2;
    score += idf * ((tf * 2.2) / (tf + lengthNorm));
  }

  const normalizedName = normalizeTerm(entry.name);
  for (const term of [...matchedTerms, ...looseTerms]) {
    if (normalizedName === term) score += 5;
    else if (splitToolName(entry.name).includes(term)) score += 2;
    else if (normalizedName.includes(term)) score += 1;
  }

  return score;
}

function averageDocumentLength(index: ToolSearchIndex): number {
  if (index.entries.length === 0) return 0;
  return index.entries.reduce((total, entry) => total + entry.tokenCount, 0) / index.entries.length;
}

function entryMatchesTerm(entry: ToolSearchIndexEntry, term: string): boolean {
  return entry.terms.has(term) || entry.text.includes(term);
}

function normalizeQueryParts(query: ToolSearchQueryParts): ToolSearchQueryParts {
  return {
    required: uniqueNormalized(query.required),
    loose: uniqueNormalized(query.loose),
  };
}

function uniqueNormalized(terms: readonly string[]): readonly string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const term of terms) {
    const normalized = normalizeTerm(term);
    if (normalized.length === 0 || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function tokenize(value: string): string[] {
  return value.match(/\+?[\p{L}\p{N}_-]+/gu) ?? [];
}

function normalizeTerm(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\p{L}\p{N}]+/gu, '');
}

function splitToolName(name: string): readonly string[] {
  return name
    .split(/[_-]+/g)
    .map((part) => normalizeTerm(part))
    .filter((part) => part.length > 0);
}

function collectSchemaText(value: unknown): string {
  const parts: string[] = [];
  collectSchemaTextInto(value, parts, 0);
  return parts.join(' ');
}

function collectSchemaTextInto(value: unknown, parts: string[], depth: number): void {
  if (depth > 8 || value === null || value === undefined) return;
  if (typeof value === 'string') {
    parts.push(value);
    return;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    parts.push(String(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectSchemaTextInto(item, parts, depth + 1);
    }
    return;
  }
  if (typeof value !== 'object') return;

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    parts.push(key);
    collectSchemaTextInto(child, parts, depth + 1);
  }
}
