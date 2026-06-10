import fs from 'fs/promises';
import path from 'path';

import { getAgentConfigPath } from '../../runtime/agent-home.js';

export type McpCapabilityKind = 'tool' | 'resource' | 'prompt';
export type McpCapabilityRisk = 'read' | 'write' | 'network' | 'exec';

/** Per-tool task-augmentation support (2025-11-25 `execution.taskSupport`). */
export type McpToolTaskSupport = 'forbidden' | 'optional' | 'required';

/** Icon metadata (2025-11-25) attached to tools / resources / prompts. */
export interface McpIcon {
  src: string;
  mimeType?: string;
  sizes?: string[];
  theme?: 'light' | 'dark';
}

export interface McpCatalogItem {
  id: string;
  serverId: string;
  kind: McpCapabilityKind;
  name: string;
  title?: string;
  summary: string;
  tags?: string[];
  risk?: McpCapabilityRisk;
  annotations?: Record<string, unknown>;
  cachedAt: string;
}
export interface McpCapabilityDescriptor extends McpCatalogItem {
  inputSchema?: unknown;
  outputSchema?: unknown;
  promptArgsSchema?: unknown;
  uri?: string;
  mimeType?: string;
  /** Sanitized icon metadata (unsafe-scheme icons dropped). */
  icons?: McpIcon[];
  /** Tool only — `execution.taskSupport`. Absent is treated as 'forbidden'. */
  taskSupport?: McpToolTaskSupport;
}

export interface McpServerCatalogSnapshot {
  serverId: string;
  items: McpCatalogItem[];
  descriptors: McpCapabilityDescriptor[];
  updatedAt: string;
}

export interface McpCatalogSearchOptions {
  kind?: McpCapabilityKind;
  limit?: number;
}

function safeIdComponent(value: string): string {
  return encodeURIComponent(value);
}

export function defaultMcpCacheDir(): string {
  return getAgentConfigPath('mcp');
}

export function createMcpCapabilityId(
  serverId: string,
  kind: McpCapabilityKind,
  name: string,
): string {
  return `mcp:${safeIdComponent(serverId)}:${kind}:${safeIdComponent(name)}`;
}

export function parseMcpCapabilityId(id: string): {
  serverId: string;
  kind: McpCapabilityKind;
  name: string;
} {
  const match = id.match(/^mcp:([^:]+):(tool|resource|prompt):(.+)$/);
  if (!match?.[1] || !match[2] || !match[3]) {
    throw new Error(`Invalid MCP capability id: ${id}`);
  }

  return {
    serverId: decodeURIComponent(match[1]),
    kind: match[2] as McpCapabilityKind,
    name: decodeURIComponent(match[3]),
  };
}

export function summarizeMcpCatalogEntry(
  value: Record<string, unknown> | undefined,
  fallback: string,
): string {
  const description = typeof value?.description === 'string'
    ? value.description.trim()
    : '';
  const title = typeof value?.title === 'string'
    ? value.title.trim()
    : '';
  return description || title || fallback;
}

// Per 2025-11-25 icon security rules clients MUST reject unsafe schemes
// (javascript:, file:, ftp:, ws:, local app schemes). Allow only http(s) and
// data: URIs; relative URLs are unresolvable without a server origin and dropped.
const SAFE_ICON_SCHEMES = ['https:', 'http:', 'data:'];

function isSafeIconSrc(src: string): boolean {
  const lower = src.toLowerCase();
  return SAFE_ICON_SCHEMES.some((scheme) => lower.startsWith(scheme));
}

/**
 * Validate and normalize a raw `icons` array from a tool/resource/prompt entry,
 * dropping malformed entries and unsafe-scheme sources. Returns undefined when
 * nothing safe remains so callers can omit the field entirely.
 */
export function sanitizeMcpIcons(raw: unknown): McpIcon[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const icons: McpIcon[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const src = typeof record.src === 'string' ? record.src.trim() : '';
    if (!src || !isSafeIconSrc(src)) {
      continue;
    }
    const icon: McpIcon = { src };
    if (typeof record.mimeType === 'string' && record.mimeType.trim()) {
      icon.mimeType = record.mimeType.trim();
    }
    if (Array.isArray(record.sizes)) {
      const sizes = record.sizes.filter(
        (size): size is string => typeof size === 'string' && size.trim().length > 0,
      );
      if (sizes.length > 0) {
        icon.sizes = sizes;
      }
    }
    if (record.theme === 'light' || record.theme === 'dark') {
      icon.theme = record.theme;
    }
    icons.push(icon);
  }
  return icons.length > 0 ? icons : undefined;
}

export function deriveMcpCapabilityRisk(
  kind: McpCapabilityKind,
  name: string,
  annotations?: Record<string, unknown>,
): McpCapabilityRisk | undefined {
  if (kind === 'resource' || kind === 'prompt') {
    return 'read';
  }

  const lowerName = name.toLowerCase();
  if (annotations?.destructive === true || annotations?.destructiveHint === true) {
    return 'write';
  }
  if (annotations?.openWorld === true || annotations?.openWorldHint === true) {
    return 'network';
  }
  if (annotations?.exec === true || annotations?.execHint === true || lowerName.includes('exec')) {
    return 'exec';
  }
  if (
    lowerName.includes('delete')
    || lowerName.includes('remove')
    || lowerName.includes('write')
    || lowerName.includes('update')
    || lowerName.includes('create')
  ) {
    return 'write';
  }

  return 'read';
}

export function buildCatalogSearchText(item: McpCatalogItem): string {
  return [
    item.id,
    item.serverId,
    item.kind,
    item.name,
    item.title,
    item.summary,
    ...(item.tags ?? []),
  ]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join('\n')
    .toLowerCase();
}

export function searchMcpCatalog(
  items: readonly McpCatalogItem[],
  query: string,
  options: McpCatalogSearchOptions = {},
): McpCatalogItem[] {
  const normalizedQuery = query.trim().toLowerCase();
  const limit = Math.max(1, Math.floor(options.limit ?? 10));

  return items
    .filter((item) => !options.kind || item.kind === options.kind)
    .map((item) => ({
      item,
      haystack: buildCatalogSearchText(item),
    }))
    .filter(({ haystack }) => normalizedQuery.length === 0 || haystack.includes(normalizedQuery))
    .slice(0, limit)
    .map(({ item }) => item);
}

export function getMcpCachePaths(cacheDir: string, serverId: string): {
  catalogDir: string;
  indexPath: string;
  itemsPath: string;
} {
  const catalogDir = path.join(cacheDir, 'catalog');
  return {
    catalogDir,
    indexPath: path.join(catalogDir, `${serverId}.index.json`),
    itemsPath: path.join(catalogDir, `${serverId}.items.json`),
  };
}

export async function writeMcpServerCatalog(
  cacheDir: string,
  snapshot: McpServerCatalogSnapshot,
): Promise<void> {
  const { catalogDir, indexPath, itemsPath } = getMcpCachePaths(cacheDir, snapshot.serverId);
  await fs.mkdir(catalogDir, { recursive: true });
  await fs.writeFile(
    indexPath,
    JSON.stringify({
      serverId: snapshot.serverId,
      updatedAt: snapshot.updatedAt,
      items: snapshot.items,
    }, null, 2),
    'utf8',
  );
  await fs.writeFile(
    itemsPath,
    JSON.stringify({
      serverId: snapshot.serverId,
      updatedAt: snapshot.updatedAt,
      descriptors: snapshot.descriptors,
    }, null, 2),
    'utf8',
  );
}

export async function readMcpServerCatalog(
  cacheDir: string,
  serverId: string,
): Promise<McpServerCatalogSnapshot | undefined> {
  const { indexPath, itemsPath } = getMcpCachePaths(cacheDir, serverId);
  try {
    const [indexRaw, itemsRaw] = await Promise.all([
      fs.readFile(indexPath, 'utf8'),
      fs.readFile(itemsPath, 'utf8'),
    ]);
    const indexJson = JSON.parse(indexRaw) as {
      serverId?: string;
      updatedAt?: string;
      items?: McpCatalogItem[];
    };
    const itemsJson = JSON.parse(itemsRaw) as {
      serverId?: string;
      updatedAt?: string;
      descriptors?: McpCapabilityDescriptor[];
    };

    return {
      serverId,
      updatedAt: itemsJson.updatedAt ?? indexJson.updatedAt ?? new Date(0).toISOString(),
      items: indexJson.items ?? [],
      descriptors: itemsJson.descriptors ?? [],
    };
  } catch {
    return undefined;
  }
}
