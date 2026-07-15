import type { CapabilityResult } from '../extensions/types.js';
import type { KodaXToolExecutionContext } from '../types.js';
import type {
  KodaXRetrievalArtifact,
  KodaXRetrievalItem,
  KodaXRetrievalResult,
  KodaXRetrievalToolName,
} from './types.js';

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function readText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function readFirstString(
  record: Record<string, unknown>,
  keys: readonly string[],
): { key: string; value: string } | undefined {
  for (const key of keys) {
    const value = readString(record[key]);
    if (value) {
      return { key, value };
    }
  }
  return undefined;
}

function omitRecordKeys(
  record: Record<string, unknown>,
  keys: ReadonlySet<string>,
): Record<string, unknown> | undefined {
  const entries = Object.entries(record).filter(([key]) => !keys.has(key));
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function stringifyScalar(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return undefined;
}

function formatMetadataValue(value: unknown): string | undefined {
  const scalar = stringifyScalar(value);
  if (scalar !== undefined) {
    return scalar;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function collectMetadataLines(metadata?: Record<string, unknown>): string[] {
  if (!metadata) {
    return [];
  }

  return Object.entries(metadata)
    .map(([key, value]) => {
      const formatted = formatMetadataValue(value);
      return formatted ? `- ${key}: ${formatted}` : undefined;
    })
    .filter((line): line is string => line !== undefined);
}

export function stripHtmlToText(html: string): string {
  const withoutScripts = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ');
  const withLineBreaks = withoutScripts
    .replace(/<(?:br|\/p|\/div|\/li|\/tr|\/h\d)>/gi, '\n')
    .replace(/<\/(?:p|div|li|tr|section|article|header|footer|main|aside)>/gi, '\n');
  return withLineBreaks
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, '\'')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

export function extractHtmlTitle(html: string): string | undefined {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match?.[1]) {
    return undefined;
  }
  return stripHtmlToText(match[1]);
}

export async function readResponseTextLimited(
  response: Response,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean; bytesRead: number }> {
  if (!response.body) {
    return {
      text: await response.text(),
      truncated: false,
      bytesRead: 0,
    };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  let truncated = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value || value.length === 0) {
        continue;
      }

      const remaining = maxBytes - bytesRead;
      if (remaining <= 0) {
        truncated = true;
        await reader.cancel();
        break;
      }

      if (value.length > remaining) {
        chunks.push(value.slice(0, remaining));
        bytesRead += remaining;
        truncated = true;
        await reader.cancel();
        break;
      }

      chunks.push(value);
      bytesRead += value.length;
    }
  } finally {
    reader.releaseLock();
  }

  const buffer = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  return {
    text: buffer.toString('utf-8'),
    truncated,
    bytesRead,
  };
}

export function convertProviderSearchResults(
  results: unknown[],
  limit: number,
): KodaXRetrievalItem[] {
  const items: KodaXRetrievalItem[] = [];

  for (const entry of results.slice(0, Math.max(1, limit))) {
    const record = asRecord(entry);
    if (!record) {
      const text = formatMetadataValue(entry);
      if (text) {
        items.push({ title: text });
      }
      continue;
    }

    const titleField = readFirstString(record, ['title', 'name', 'label', 'id']);
    const locatorField = readFirstString(record, ['url', 'path', 'uri', 'locator']);
    const snippetField = readFirstString(record, ['snippet', 'summary', 'description', 'preview']);
    const scoreValue = record.score;
    const score = typeof scoreValue === 'number' && Number.isFinite(scoreValue)
      ? scoreValue
      : undefined;
    const projectedKeys = new Set<string>();
    if (titleField) projectedKeys.add(titleField.key);
    if (locatorField) projectedKeys.add(locatorField.key);
    if (snippetField) projectedKeys.add(snippetField.key);
    if (score !== undefined) projectedKeys.add('score');
    items.push({
      title: titleField?.value ?? 'provider result',
      locator: locatorField?.value,
      snippet: snippetField?.value,
      score,
      metadata: omitRecordKeys(record, projectedKeys),
    });
  }

  return items;
}

export function convertCapabilityReadResult(
  tool: KodaXRetrievalToolName,
  providerId: string,
  capabilityId: string,
  result: CapabilityResult,
  summary: string,
): KodaXRetrievalResult {
  const structured = asRecord(result.structuredContent);
  const artifactValue = readString(structured?.url)
    ?? readString(structured?.path)
    ?? readString(structured?.uri)
    ?? capabilityId;
  const artifacts: KodaXRetrievalArtifact[] = artifactValue
    ? [{
      kind: readString(structured?.path) ? 'path' : 'provider',
      label: capabilityId,
      value: artifactValue,
    }]
    : [];

  return {
    tool,
    scope: tool === 'web_fetch' ? 'remote' : 'workspace',
    trust: 'provider',
    freshness: 'unknown',
    provider: providerId,
    summary,
    content: readText(result.content),
    items: structured
      ? convertProviderSearchResults([structured], 1)
      : [],
    artifacts,
    metadata: {
      capabilityId,
      capabilityKind: result.kind,
      ...(result.metadata ?? {}),
    },
  };
}

export function renderRetrievalResult(result: KodaXRetrievalResult): string {
  const lines: string[] = [
    `Retrieval result for ${result.tool}`,
    `Scope: ${result.scope} | Trust: ${result.trust} | Freshness: ${result.freshness}`,
  ];

  if (result.query) {
    lines.push(`Query: ${result.query}`);
  }
  if (result.provider) {
    lines.push(`Provider: ${result.provider}`);
  }
  lines.push(`Summary: ${result.summary}`);

  if (result.content?.trim()) {
    lines.push('', 'Content:', result.content);
  }

  if (result.items.length > 0) {
    lines.push('', 'Results:');
    result.items.forEach((item, index) => {
      lines.push(`${index + 1}. ${item.title}`);
      if (item.locator) {
        lines.push(`   Locator: ${item.locator}`);
      }
      if (item.snippet) {
        lines.push(`   Snippet: ${item.snippet}`);
      }
      if (item.score !== undefined) {
        lines.push(`   Score: ${item.score.toFixed(2)}`);
      }
      const metadataLines = collectMetadataLines(item.metadata);
      metadataLines.forEach((line) => {
        lines.push(`   ${line}`);
      });
    });
  }

  const artifacts = result.artifacts?.filter((artifact) => !result.items.some((item) => (
    item.title === artifact.label && item.locator === artifact.value
  )));
  if (artifacts && artifacts.length > 0) {
    lines.push('', 'Artifacts:');
    artifacts.forEach((artifact) => {
      lines.push(`- ${artifact.kind}: ${artifact.label} -> ${artifact.value}`);
    });
  }

  const metadataLines = collectMetadataLines(result.metadata);
  if (metadataLines.length > 0) {
    lines.push('', 'Metadata:', ...metadataLines);
  }

  return lines.join('\n');
}

export async function finalizeRetrievalResult(
  result: KodaXRetrievalResult,
  _ctx: KodaXToolExecutionContext,
): Promise<string> {
  return renderRetrievalResult(result);
}
