import type { KodaXToolExecutionContext } from '../types.js';
import { readOptionalString } from './internal.js';
import {
  finalizeRetrievalResult,
  readResponseTextLimited,
  stripHtmlToText,
} from './retrieval.js';

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;
const SEARCH_TIMEOUT_MS = 12_000;
const ATTEMPT_TIMEOUT_MS = 4_000;
const SEARCH_MAX_BYTES = 256 * 1024;
const SEARCH_ENDPOINT_ENV = 'KODAX_WEB_SEARCH_ENDPOINT';
const DUCKDUCKGO_SEARCH_ENDPOINT = 'https://html.duckduckgo.com/html/';
const BING_SEARCH_ENDPOINT = 'https://www.bing.com/search';

interface SearchItem {
  title: string;
  locator: string;
  snippet?: string;
}

type SearchEngine = 'duckduckgo' | 'bing' | 'custom';
type SearchTransport = 'html' | 'rss';
type SearchAttemptId = 'duckduckgo-html' | 'bing-rss' | 'bing-html' | 'custom-html';

interface SearchAttempt {
  id: SearchAttemptId;
  engine: SearchEngine;
  transport: SearchTransport;
  url: URL;
}

interface SearchAttemptResult {
  attempt: SearchAttempt;
  items: SearchItem[];
  status: number;
  bytesRead: number;
  truncated: boolean;
  finalUrl?: string;
}

interface SearchResult extends SearchAttemptResult {
  attempts: SearchAttemptId[];
  fallbacks: string[];
}

function clampLimit(input: unknown): number {
  const value = typeof input === 'number' && Number.isFinite(input)
    ? Math.floor(input)
    : DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, value));
}

function createFetchTimeoutSignal(timeoutMs: number): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    dispose: () => clearTimeout(timer),
  };
}

function buildSearchUrl(endpoint: string, query: string): URL {
  if (endpoint.includes('{query}')) {
    return new URL(endpoint.replace('{query}', encodeURIComponent(query)));
  }

  const url = new URL(endpoint);
  if (!url.searchParams.has('q')) {
    url.searchParams.set('q', query);
  } else {
    url.searchParams.set('q', query);
  }
  return url;
}

function buildDefaultAttempts(query: string): SearchAttempt[] {
  const duckduckgoUrl = buildSearchUrl(DUCKDUCKGO_SEARCH_ENDPOINT, query);
  const bingRssUrl = buildSearchUrl(BING_SEARCH_ENDPOINT, query);
  bingRssUrl.searchParams.set('format', 'rss');
  return [
    { id: 'duckduckgo-html', engine: 'duckduckgo', transport: 'html', url: duckduckgoUrl },
    { id: 'bing-rss', engine: 'bing', transport: 'rss', url: bingRssUrl },
    {
      id: 'bing-html',
      engine: 'bing',
      transport: 'html',
      url: buildSearchUrl(BING_SEARCH_ENDPOINT, query),
    },
  ];
}

function resolveSearchHref(rawHref: string, searchUrl: URL): string | undefined {
  try {
    const url = new URL(rawHref.replace(/&amp;/gi, '&'), searchUrl);
    const redirected = url.searchParams.get('uddg');
    if (redirected) {
      const target = new URL(redirected);
      return target.protocol === 'http:' || target.protocol === 'https:'
        ? target.toString()
        : undefined;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

interface HtmlAnchor {
  index: number;
  className: string;
  href?: string;
  content: string;
}

function readAnchorAttribute(attributes: string, name: 'class' | 'href'): string | undefined {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const match = attributes.match(pattern);
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function extractHtmlAnchors(html: string): HtmlAnchor[] {
  const anchors: HtmlAnchor[] = [];
  const pattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(pattern)) {
    anchors.push({
      index: match.index,
      className: readAnchorAttribute(match[1] ?? '', 'class') ?? '',
      href: readAnchorAttribute(match[1] ?? '', 'href'),
      content: match[2] ?? '',
    });
  }
  return anchors;
}

function hasHtmlClass(anchor: HtmlAnchor, className: string): boolean {
  return anchor.className.split(/\s+/).includes(className);
}

function cleanSearchText(value: string): string {
  return stripHtmlToText(value).replace(/\s+([,.!?;:])/g, '$1').trim();
}

export function parseDuckDuckGoResults(
  html: string,
  searchUrl: URL,
  limit: number,
): SearchItem[] {
  const anchors = extractHtmlAnchors(html);
  const titles = anchors.filter((anchor) => hasHtmlClass(anchor, 'result__a'));
  const results: SearchItem[] = [];
  const seen = new Set<string>();
  for (const [index, anchor] of titles.entries()) {
    const title = cleanSearchText(anchor.content);
    const locator = anchor.href ? resolveSearchHref(anchor.href, searchUrl) : undefined;
    if (!title || !locator || seen.has(locator)) continue;
    seen.add(locator);
    const nextTitleIndex = titles[index + 1]?.index ?? Number.POSITIVE_INFINITY;
    const snippetAnchor = anchors.find((candidate) => (
      candidate.index > anchor.index
      && candidate.index < nextTitleIndex
      && hasHtmlClass(candidate, 'result__snippet')
    ));
    const snippet = snippetAnchor
      ? cleanSearchText(snippetAnchor.content)
      : undefined;
    results.push({ title, locator, ...(snippet ? { snippet } : {}) });
    if (results.length >= limit) break;
  }
  return results;
}

function unwrapCdata(value: string): string {
  const match = value.trim().match(/^<!\[CDATA\[([\s\S]*)\]\]>$/i);
  return match?.[1] ?? value;
}

function readXmlElement(block: string, name: 'title' | 'link' | 'description'): string | undefined {
  const pattern = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i');
  const value = block.match(pattern)?.[1];
  return value === undefined ? undefined : cleanSearchText(unwrapCdata(value));
}

function normalizeHttpLocator(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function parseBingRssResults(xml: string, limit: number): SearchItem[] {
  const results: SearchItem[] = [];
  const seen = new Set<string>();
  for (const match of xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)) {
    const block = match[1] ?? '';
    const title = readXmlElement(block, 'title');
    const locator = normalizeHttpLocator(readXmlElement(block, 'link') ?? '');
    if (!title || !locator || seen.has(locator)) {
      continue;
    }
    seen.add(locator);
    const snippet = readXmlElement(block, 'description');
    results.push({ title, locator, ...(snippet ? { snippet } : {}) });
    if (results.length >= limit) {
      break;
    }
  }
  return results;
}

function parseSearchResults(html: string, searchUrl: URL, limit: number): SearchItem[] {
  const results: SearchItem[] = [];
  const seen = new Set<string>();
  const anchorPattern = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;

  for (const match of html.matchAll(anchorPattern)) {
    const href = match[1]?.trim();
    const title = stripHtmlToText(match[2] ?? '').trim();
    if (!href || !title) {
      continue;
    }
    const locator = resolveSearchHref(href, searchUrl);
    if (!locator || seen.has(locator)) {
      continue;
    }
    seen.add(locator);
    results.push({
      title,
      locator,
    });
    if (results.length >= limit) {
      break;
    }
  }

  return results;
}

// Bing renders each organic result title as `<h2><a href="...">title</a></h2>`,
// so the generic anchor scan (which depends on DuckDuckGo's `uddg=` redirect
// markers) would otherwise return Bing's own navigation chrome instead.
export function parseBingResults(html: string, limit: number): SearchItem[] {
  const results: SearchItem[] = [];
  const seen = new Set<string>();
  const headingPattern = /<h2\b[^>]*>\s*<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;

  // Bing stacks paid ads (`b_ad`) above the organic block (`b_algo`). Scanning
  // from the first organic block skips that ad stack so results stay relevant.
  const organicStart = html.indexOf('b_algo');
  const scope = organicStart >= 0 ? html.slice(organicStart) : html;

  const headings = [...scope.matchAll(headingPattern)];
  for (const [index, match] of headings.entries()) {
    const href = (match[1] ?? '').trim().replace(/&amp;/g, '&');
    const title = cleanSearchText(match[2] ?? '');
    const locator = normalizeHttpLocator(href);
    if (!title || !locator) {
      continue;
    }
    // Drop Bing's ad/click-tracking redirects; keep only direct destinations.
    if (/\/(aclk|aclick)\b/i.test(locator) || /\/ck\/a\b/i.test(locator)) {
      continue;
    }
    if (seen.has(locator)) {
      continue;
    }
    seen.add(locator);
    const blockStart = match.index ?? 0;
    const blockEnd = headings[index + 1]?.index ?? scope.length;
    const snippetMatch = scope.slice(blockStart, blockEnd).match(/<p\b[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = snippetMatch?.[1] ? cleanSearchText(snippetMatch[1]) : undefined;
    results.push({
      title,
      locator,
      ...(snippet ? { snippet } : {}),
    });
    if (results.length >= limit) {
      break;
    }
  }

  return results;
}

function isChallengePage(body: string): boolean {
  return /\b(?:id|class)\s*=\s*["'][^"']*(?:challenge-form|captcha|recaptcha|robot[-_ ]?challenge)[^"']*["']/i.test(body)
    || /<title\b[^>]*>[^<]*(?:captcha|verify you are human|robot challenge)[^<]*<\/title>/i.test(body);
}

function isNoResultsPage(attempt: SearchAttempt, body: string): boolean {
  if (attempt.id === 'duckduckgo-html') {
    return /class=["'][^"']*\bno-results\b/i.test(body);
  }
  return /class=["'][^"']*\bb_no\b/i.test(body) || /no results found/i.test(body);
}

function parseAttemptItems(attempt: SearchAttempt, body: string, limit: number): SearchItem[] {
  if (attempt.id === 'duckduckgo-html') {
    const items = parseDuckDuckGoResults(body, attempt.url, limit);
    if (items.length > 0 || isNoResultsPage(attempt, body)) return items;
    if (isChallengePage(body)) throw new Error('challenge');
    throw new Error('unrecognized-response');
  }
  if (attempt.id === 'bing-rss') {
    if (!/<rss\b[\s\S]*<channel\b[\s\S]*<\/channel>[\s\S]*<\/rss>/i.test(body)) {
      if (isChallengePage(body)) throw new Error('challenge');
      throw new Error('unrecognized-response');
    }
    const items = parseBingRssResults(body, limit);
    if (items.length === 0 && /<item\b/i.test(body)) throw new Error('unrecognized-response');
    return items;
  }
  if (attempt.id === 'bing-html') {
    const items = parseBingResults(body, limit);
    if (items.length > 0 || isNoResultsPage(attempt, body)) return items;
    if (isChallengePage(body)) throw new Error('challenge');
    throw new Error('unrecognized-response');
  }
  const items = parseSearchResults(body, attempt.url, limit);
  if (items.length === 0 && isChallengePage(body)) throw new Error('challenge');
  return items;
}

async function executeSearchAttempt(
  attempt: SearchAttempt,
  limit: number,
  timeoutMs: number,
): Promise<SearchAttemptResult> {
  if (timeoutMs <= 0) throw new Error('timeout-budget-exhausted');
  const timeout = createFetchTimeoutSignal(timeoutMs);
  try {
    const response = await fetch(attempt.url, {
      signal: timeout.signal,
      headers: {
        'user-agent': 'KodaX/0.7 retrieval',
        accept: attempt.transport === 'rss'
          ? 'application/rss+xml,application/xml;q=0.9,text/xml;q=0.8'
          : 'text/html,text/plain;q=0.8,*/*;q=0.5',
      },
    });
    if (!response.ok) throw new Error(`http-${response.status}`);
    const { text, truncated, bytesRead } = await readResponseTextLimited(response, SEARCH_MAX_BYTES);
    return {
      attempt,
      items: parseAttemptItems(attempt, text, limit),
      status: response.status,
      bytesRead,
      truncated,
      ...(response.url ? { finalUrl: response.url } : {}),
    };
  } finally {
    timeout.dispose();
  }
}

function searchFailureReason(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError') return 'timeout';
  if (error instanceof Error) {
    if (/^(?:challenge|http-\d+|timeout-budget-exhausted|unrecognized-response)$/.test(error.message)) {
      return error.message;
    }
    return `network-${error.message.slice(0, 120)}`;
  }
  return `network-${String(error).slice(0, 120)}`;
}

async function searchDefaults(query: string, limit: number): Promise<SearchResult> {
  const deadline = Date.now() + SEARCH_TIMEOUT_MS;
  const attempts: SearchAttemptId[] = [];
  const fallbacks: string[] = [];
  for (const attempt of buildDefaultAttempts(query)) {
    attempts.push(attempt.id);
    try {
      const timeoutMs = Math.min(ATTEMPT_TIMEOUT_MS, deadline - Date.now());
      const result = await executeSearchAttempt(attempt, limit, timeoutMs);
      return { ...result, attempts: [...attempts], fallbacks };
    } catch (error) {
      fallbacks.push(`${attempt.id}:${searchFailureReason(error)}`);
    }
  }
  throw new Error(`all default search attempts failed (${fallbacks.join('; ')})`);
}

async function searchConfiguredEndpoint(
  endpoint: string,
  query: string,
  limit: number,
): Promise<SearchResult> {
  const attempt: SearchAttempt = {
    id: 'custom-html',
    engine: 'custom',
    transport: 'html',
    url: buildSearchUrl(endpoint, query),
  };
  const result = await executeSearchAttempt(attempt, limit, SEARCH_TIMEOUT_MS);
  return { ...result, attempts: [attempt.id], fallbacks: [] };
}

async function renderSearchResult(
  query: string,
  limit: number,
  search: SearchResult,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  const items = search.items.slice(0, limit);
  const limitStatus = search.items.length > limit
    ? `[RESULT_LIMIT_REACHED: limit=${limit}; additional parsed matches were omitted.] `
    : '';
  const sourceStatus = search.truncated
    ? `[SOURCE_INCOMPLETE: response exceeded the ${SEARCH_MAX_BYTES / 1024} KiB network acquisition safety limit.] `
    : '';
  const finalUrl = search.finalUrl ? new URL(search.finalUrl) : search.attempt.url;

  return finalizeRetrievalResult({
    tool: 'web_search', query, scope: 'remote', trust: 'open-world', freshness: 'unknown',
    summary: `${sourceStatus}${limitStatus}${items.length > 0
      ? `Found ${items.length} web search result(s) for "${query}".`
      : `No web search results for "${query}".`}`,
    items,
    artifacts: items.map((item) => ({ kind: 'url', label: item.title, value: item.locator })),
    metadata: {
      endpoint: finalUrl.origin,
      engine: search.attempt.engine,
      transport: search.attempt.transport,
      status: search.status,
      bytesRead: search.bytesRead,
      truncated: search.truncated,
      attempts: search.attempts,
      ...(search.fallbacks.length > 0 ? { fallbacks: search.fallbacks } : {}),
    },
  }, ctx);
}

export async function toolWebSearch(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  try {
    const query = readOptionalString(input, 'query');
    if (!query) {
      throw new Error('query is required.');
    }
    const limit = clampLimit(input.limit);

    const configuredEndpoint = process.env[SEARCH_ENDPOINT_ENV];
    const search = configuredEndpoint
      ? await searchConfiguredEndpoint(configuredEndpoint, query, limit + 1)
      : await searchDefaults(query, limit + 1);
    return renderSearchResult(query, limit, search, ctx);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `[Tool Error] web_search: ${message}`;
  }
}
