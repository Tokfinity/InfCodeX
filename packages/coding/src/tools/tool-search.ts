/**
 * tool_search — FEATURE_189 Batch 3 B.2 progressive disclosure bootstrap.
 *
 * Returns the full description + JSON Schema for one or more deferred tools.
 * Mirrors claudecode's `ToolSearchTool` (`c:/Works/claudecode/src/tools/ToolSearchTool/`).
 *
 * Query forms:
 *   - `"select:Name1,Name2"`  — fetch exact tools by name
 *   - `"keyword"`             — keyword search in deferred tool hints
 *   - `"+keyword tool"`       — require all keywords (filter mode)
 *
 * Side effect: each tool name resolved is added to the per-context unlock
 * Set via {@link unlockDeferredToolForContext}. The next call to
 * `getActiveToolDefinitions` for this context emits the full description
 * for the unlocked tools instead of the search hint.
 *
 * Return format:
 *   A text block with one `<function>{...}</function>` line per resolved
 *   tool. Each line is the same JSON shape that
 *   `getActiveToolDefinitions` emits, so the LLM sees the schema in the
 *   exact form it would arrive in a real tool list.
 */

import type { KodaXToolDefinition } from '@kodax-ai/llm';
import type { LocalToolDefinition, ToolHandlerSync } from './types.js';
import { getToolDefinition } from './index.js';
import {
  DEFERRED_TOOL_HINTS,
  isDeferredTool,
  unlockDeferredToolForContext,
} from './deferred-tools.js';

interface ToolSearchInput {
  query?: string;
  max_results?: number;
}

const DEFAULT_MAX_RESULTS = 5;
const MAX_RESULTS_CAP = 15;

/**
 * Parse the query string into either a select list (exact names) or a
 * keyword set (with optional `+` required terms).
 */
function parseQuery(rawQuery: string): { mode: 'select' | 'keyword'; names: string[]; required: string[]; loose: string[] } {
  const trimmed = rawQuery.trim();
  if (trimmed.startsWith('select:')) {
    const list = trimmed.slice('select:'.length);
    const names = list.split(/[,\s]+/).map((s) => s.trim()).filter((s) => s.length > 0);
    return { mode: 'select', names, required: [], loose: [] };
  }
  const tokens = trimmed.split(/\s+/).filter((s) => s.length > 0);
  const required: string[] = [];
  const loose: string[] = [];
  for (const t of tokens) {
    if (t.startsWith('+') && t.length > 1) required.push(t.slice(1).toLowerCase());
    else loose.push(t.toLowerCase());
  }
  return { mode: 'keyword', names: [], required, loose };
}

function scoreToolForKeywords(
  toolName: string,
  hint: string,
  required: readonly string[],
  loose: readonly string[],
): number | null {
  const haystack = `${toolName.toLowerCase()} ${hint.toLowerCase()}`;
  for (const r of required) {
    if (!haystack.includes(r)) return null;
  }
  let score = 0;
  for (const l of loose) {
    if (haystack.includes(l)) score++;
  }
  return score;
}

function resolveSelectNames(names: readonly string[]): string[] {
  const resolved: string[] = [];
  const seen = new Set<string>();
  for (const n of names) {
    if (seen.has(n)) continue;
    seen.add(n);
    if (isDeferredTool(n)) resolved.push(n);
    // For non-deferred tools requested by name, still resolve and emit —
    // useful when the LLM is uncertain whether a tool is deferred.
    else if (getToolDefinition(n)) resolved.push(n);
  }
  return resolved;
}

function searchKeywords(required: readonly string[], loose: readonly string[], maxResults: number): string[] {
  const scored: Array<{ name: string; score: number }> = [];
  for (const [name, hint] of Object.entries(DEFERRED_TOOL_HINTS)) {
    const s = scoreToolForKeywords(name, hint, required, loose);
    if (s === null) continue;
    if (s === 0 && loose.length > 0) continue;
    scored.push({ name, score: s });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxResults).map((e) => e.name);
}

function formatToolAsFunctionBlock(def: KodaXToolDefinition): string {
  const schema = {
    description: def.description,
    name: def.name,
    parameters: def.input_schema,
  };
  return `<function>${JSON.stringify(schema)}</function>`;
}

function buildResult(resolved: readonly string[], context: object): string {
  if (resolved.length === 0) {
    return 'No tools matched the query. Available deferred tools: '
      + Object.keys(DEFERRED_TOOL_HINTS).join(', ')
      + '. Use query form `select:NAME` to fetch a specific schema.';
  }
  const lines: string[] = [];
  for (const name of resolved) {
    const def = getToolDefinition(name);
    if (!def) {
      lines.push(`<!-- ${name}: not registered (skipped) -->`);
      continue;
    }
    unlockDeferredToolForContext(context, name);
    lines.push(formatToolAsFunctionBlock(def));
  }
  return lines.join('\n');
}

export const toolSearchHandler: ToolHandlerSync = async (input, context) => {
  const i = input as ToolSearchInput;
  const query = typeof i.query === 'string' ? i.query : '';
  if (query.length === 0) {
    return 'tool_search: `query` is required. Forms: `select:NAME[,NAME...]` for exact lookup, or keyword search (`+required loose terms`).';
  }
  const requestedMax = typeof i.max_results === 'number' && i.max_results > 0
    ? Math.min(Math.floor(i.max_results), MAX_RESULTS_CAP)
    : DEFAULT_MAX_RESULTS;
  const parsed = parseQuery(query);
  const resolved = parsed.mode === 'select'
    ? resolveSelectNames(parsed.names).slice(0, MAX_RESULTS_CAP)
    : searchKeywords(parsed.required, parsed.loose, requestedMax);
  return buildResult(resolved, context);
};

/**
 * Tool definition exported so registry.ts can register it. Always-loaded;
 * the description below is itself short by design (do not need to defer
 * the meta-tool used to unlock deferred tools).
 */
export const TOOL_SEARCH_DEFINITION: LocalToolDefinition = {
  name: 'tool_search',
  description:
    'Fetch full schema definitions for deferred tools so they can be called effectively. Deferred tools (mcp_*, web_*, repo-intel — module_context / symbol_context / impact_estimate / process_context / changed_scope / repo_overview / semantic_lookup / code_search) appear in your tool list with a one-line `searchHint` instead of the full description. Use `tool_search` when the hint suggests a deferred tool fits the task and you need the full schema (parameter shape, when-to-prefer-X, behavioral contracts) before invoking. Query forms: `select:ToolName` (exact, recommended) or keyword search like `"+module exploration"` (require keyword) / `"refactor impact"` (loose match, ranked). After `tool_search` resolves a tool, the next API call sees its full description automatically.',
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'Either `select:ToolName[,ToolName...]` for exact lookup, or keyword search (`+keyword required loose terms`).',
      },
      max_results: {
        type: 'number',
        description: 'Maximum number of results to return (default 5, capped at 15). Ignored in `select:` mode.',
      },
    },
    required: ['query'],
  },
  handler: toolSearchHandler,
  sideEffect: 'readonly',
  // Plan mode permits tool_search: it is a pure read against the registry
  // catalog and the on-context unlock set. Schema retrieval is the kind
  // of investigative action plan-mode is for.
  planModeAllowed: true,
  toClassifierInput: () => '',
};
