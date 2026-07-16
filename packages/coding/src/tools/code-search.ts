import fs from 'node:fs/promises';
import { glob as globAsync } from 'glob';
import type { KodaXToolExecutionContext } from '../types.js';
import { resolveExecutionPathOrCwd } from '../runtime-paths.js';
import { readOptionalString } from './internal.js';
import {
  convertProviderSearchResults,
  finalizeRetrievalResult,
} from './retrieval.js';
import type { KodaXRetrievalItem } from './types.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MAX_SCAN_FILES_PER_CALL = 512;
const SEARCHABLE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.json', '.md', '.yml', '.yaml',
  '.py', '.java', '.go', '.rs', '.c', '.cc', '.cpp', '.cxx', '.h', '.hpp',
]);

function isSearchableFile(filePath: string): boolean {
  const extension = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  return SEARCHABLE_EXTENSIONS.has(extension);
}

async function collectCandidateFiles(searchRoot: string): Promise<string[]> {
  const stat = await fs.stat(searchRoot);
  if (stat.isFile()) {
    return [searchRoot];
  }

  const files = await globAsync('**/*', {
    cwd: searchRoot,
    nodir: true,
    absolute: true,
    ignore: [
      '**/node_modules/**',
      '**/.git/**',
      '**/.agent/**',
      '**/dist/**',
      '**/coverage/**',
    ],
  });

  return files.filter(isSearchableFile).sort((left, right) => left.localeCompare(right));
}

function readScanOffset(value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error('scan_offset must be a non-negative finite number.');
  }
  return Math.floor(value);
}

function clampLimit(input: unknown): number {
  const value = typeof input === 'number' && Number.isFinite(input)
    ? Math.floor(input)
    : DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, value));
}

function buildSnippet(line: string, query: string, caseSensitive: boolean): string {
  const haystack = caseSensitive ? line : line.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  const matchIndex = haystack.indexOf(needle);
  if (matchIndex < 0) {
    return line.trim();
  }
  const start = Math.max(0, matchIndex - 48);
  const end = Math.min(line.length, matchIndex + query.length + 72);
  const snippet = line.slice(start, end).trim();
  return start > 0 ? `...${snippet}` : snippet;
}

export async function toolCodeSearch(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  try {
    const query = readOptionalString(input, 'query');
    if (!query) {
      throw new Error('query is required.');
    }
    const providerId = readOptionalString(input, 'provider_id');
    const limit = clampLimit(input.limit);
    if (providerId) {
      if (!ctx.extensionRuntime) {
        throw new Error('provider-backed code_search requires an active extension runtime.');
      }
      const probedResults = await ctx.extensionRuntime.searchCapabilities(providerId, query, {
        limit: limit + 1,
      });
      const hasMore = probedResults.length > limit;
      const providerResults = probedResults.slice(0, limit);
      const limitStatus = hasMore
        ? `[RESULT_LIMIT_REACHED: limit=${limit}; additional provider matches were omitted.] `
        : '';
      return finalizeRetrievalResult({
        tool: 'code_search',
        query,
        scope: 'workspace',
        trust: 'provider',
        freshness: 'unknown',
        provider: providerId,
        summary: `${limitStatus}${providerResults.length > 0
          ? `Provider ${providerId} returned ${providerResults.length} code search result(s).`
          : `Provider ${providerId} returned no code search results for "${query}".`}`,
        items: convertProviderSearchResults(providerResults, limit),
        metadata: {
          searchRoot: 'provider-search',
        },
      }, ctx);
    }

    const searchRoot = resolveExecutionPathOrCwd(readOptionalString(input, 'path'), ctx);
    const caseSensitive = input.case_sensitive === true;
    const queryNeedle = caseSensitive ? query : query.toLowerCase();
    const files = await collectCandidateFiles(searchRoot);
    const scanOffset = readScanOffset(input.scan_offset);
    const scanCandidates = files.slice(scanOffset, scanOffset + MAX_SCAN_FILES_PER_CALL);
    const probedItems: KodaXRetrievalItem[] = [];
    const probeLimit = limit + 1;
    let unreadableFiles = 0;
    let scannedFiles = 0;

    for (const filePath of scanCandidates) {
      if (probedItems.length >= probeLimit) {
        break;
      }
      scannedFiles += 1;

      const pathHaystack = caseSensitive ? filePath : filePath.toLowerCase();
      if (pathHaystack.includes(queryNeedle)) {
        probedItems.push({
          title: filePath,
          locator: filePath,
          snippet: 'Filename/path match',
          score: 1,
          metadata: { matchType: 'path' },
        });
        if (probedItems.length >= probeLimit) {
          break;
        }
      }

      let content: string;
      try {
        content = await fs.readFile(filePath, 'utf-8');
      } catch {
        unreadableFiles += 1;
        continue;
      }

      const lines = content.split('\n');
      for (let index = 0; index < lines.length && probedItems.length < probeLimit; index++) {
        const rawLine = lines[index] ?? '';
        const haystack = caseSensitive ? rawLine : rawLine.toLowerCase();
        if (!haystack.includes(queryNeedle)) {
          continue;
        }
        probedItems.push({
          title: `${filePath}:${index + 1}`,
          locator: `${filePath}:${index + 1}`,
          snippet: buildSnippet(rawLine, query, caseSensitive),
          score: 0.8,
          metadata: { matchType: 'content', line: index + 1 },
        });
      }
    }

    const hasMore = probedItems.length > limit;
    const items = probedItems.slice(0, limit);
    const nextScanOffset = scanOffset + scannedFiles;
    const sourceIncomplete = nextScanOffset < files.length;
    const limitStatus = hasMore
      ? `[RESULT_LIMIT_REACHED: limit=${limit}; additional matches were omitted. Narrow the query or path.] `
      : '';

    return finalizeRetrievalResult({
      tool: 'code_search',
      query,
      scope: 'workspace',
      trust: 'workspace',
      freshness: 'snapshot',
      summary: `${unreadableFiles > 0
        ? `[SOURCE_INCOMPLETE: ${unreadableFiles} candidate file(s) could not be read.] `
        : ''}${sourceIncomplete
        ? `[SOURCE_INCOMPLETE: scanned ${scannedFiles} of ${files.length} candidate file(s) from scan_offset=${scanOffset}; continue with scan_offset=${nextScanOffset} or narrow path.] `
        : ''}${limitStatus}${items.length > 0
        ? `Found ${items.length} code search matches under ${searchRoot}.`
        : `No code search matches for "${query}" under ${searchRoot}.`}`,
      items,
      artifacts: items.map((item) => ({
        kind: 'path',
        label: item.title,
        value: item.locator ?? item.title,
      })),
      metadata: {
        searchRoot,
        scannedFiles,
        candidateFiles: files.length,
        scanOffset,
        unreadableFiles,
      },
    }, ctx);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `[Tool Error] code_search: ${message}`;
  }
}
