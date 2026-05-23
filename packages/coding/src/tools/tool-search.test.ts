/**
 * Unit tests for FEATURE_189 Batch 3 B.2 — tool_search + deferred tool swap.
 *
 * Behavioral guarantees pinned here:
 *   - `tool_search` `select:NAME` returns the full schema as a `<function>` block
 *   - `tool_search` keyword search ranks by hint-content match
 *   - Selecting a deferred tool name adds it to the per-context unlock Set
 *   - `getActiveToolDefinitions` returns the searchHint for deferred tools
 *     when the unlock set does not contain them
 *   - `getActiveToolDefinitions` returns the full description when the
 *     unlock set contains the tool name
 *   - `getActiveToolDefinitions` leaves non-deferred tools alone
 */

import { describe, it, expect, beforeEach } from 'vitest';

import type { KodaXToolExecutionContext } from '../types.js';
import { getActiveToolDefinitions } from '../agent-runtime/tool-resolution.js';
import {
  DEFERRED_TOOL_HINTS,
  isDeferredTool,
  unlockDeferredToolForContext,
  getUnlockedDeferredTools,
  _resetUnlockedDeferredToolsForTest,
} from './deferred-tools.js';
import { toolSearchHandler, TOOL_SEARCH_DEFINITION } from './tool-search.js';

function makeContext(): KodaXToolExecutionContext {
  return { backups: new Map(), executionCwd: process.cwd() };
}

describe('FEATURE_189 B.2 — deferred-tools registry', () => {
  it('exports a non-empty hint map', () => {
    expect(Object.keys(DEFERRED_TOOL_HINTS).length).toBeGreaterThanOrEqual(15);
  });

  it('classifies all 15 expanded tools as deferred', () => {
    const expected = [
      'web_search', 'web_fetch', 'code_search', 'semantic_lookup',
      'mcp_search', 'mcp_describe', 'mcp_call', 'mcp_read_resource', 'mcp_get_prompt',
      'repo_overview', 'changed_scope',
      'module_context', 'symbol_context', 'process_context', 'impact_estimate',
    ];
    for (const name of expected) {
      expect(isDeferredTool(name)).toBe(true);
    }
  });

  it('does NOT classify core tools as deferred', () => {
    for (const name of ['read', 'write', 'edit', 'bash', 'grep', 'glob', 'todo_create', 'todo_update', 'dispatch_child_task', 'tool_search']) {
      expect(isDeferredTool(name)).toBe(false);
    }
  });

  it('hint length stays compact (≤ ~250 chars per hint)', () => {
    for (const [name, hint] of Object.entries(DEFERRED_TOOL_HINTS)) {
      expect(hint.length, `${name} hint too long: ${hint.length}`).toBeLessThanOrEqual(250);
    }
  });
});

describe('FEATURE_189 B.2 — unlockDeferredToolForContext', () => {
  let ctx: KodaXToolExecutionContext;
  beforeEach(() => {
    ctx = makeContext();
    _resetUnlockedDeferredToolsForTest(ctx);
  });

  it('starts empty for a fresh context', () => {
    expect(getUnlockedDeferredTools(ctx).size).toBe(0);
  });

  it('records an unlocked tool', () => {
    unlockDeferredToolForContext(ctx, 'web_fetch');
    const unlocked = getUnlockedDeferredTools(ctx);
    expect(unlocked.has('web_fetch')).toBe(true);
  });

  it('is idempotent on repeat unlock', () => {
    unlockDeferredToolForContext(ctx, 'web_fetch');
    unlockDeferredToolForContext(ctx, 'web_fetch');
    expect(getUnlockedDeferredTools(ctx).size).toBe(1);
  });

  it('isolates per context (different ctx → different state)', () => {
    const ctxA = makeContext();
    const ctxB = makeContext();
    unlockDeferredToolForContext(ctxA, 'web_fetch');
    expect(getUnlockedDeferredTools(ctxA).has('web_fetch')).toBe(true);
    expect(getUnlockedDeferredTools(ctxB).has('web_fetch')).toBe(false);
  });
});

describe('FEATURE_189 B.2 — tool_search handler', () => {
  let ctx: KodaXToolExecutionContext;
  beforeEach(() => {
    ctx = makeContext();
    _resetUnlockedDeferredToolsForTest(ctx);
  });

  it('returns a function block for `select:web_fetch`', async () => {
    const out = await toolSearchHandler({ query: 'select:web_fetch' }, ctx);
    expect(out).toContain('<function>');
    expect(out).toContain('"name":"web_fetch"');
    // Full description should include the load-bearing teaching:
    expect(out).toContain('prefer `bash` with the `gh` CLI');
  });

  it('unlocks the requested tool for the context as a side effect', async () => {
    await toolSearchHandler({ query: 'select:module_context' }, ctx);
    expect(getUnlockedDeferredTools(ctx).has('module_context')).toBe(true);
  });

  it('supports multi-name select with comma separation', async () => {
    const out = await toolSearchHandler({ query: 'select:web_fetch,web_search' }, ctx);
    const blocks = (out.match(/<function>/g) ?? []).length;
    expect(blocks).toBe(2);
    expect(getUnlockedDeferredTools(ctx).has('web_fetch')).toBe(true);
    expect(getUnlockedDeferredTools(ctx).has('web_search')).toBe(true);
  });

  it('keyword search finds matching deferred tools', async () => {
    const out = await toolSearchHandler({ query: 'module exploration', max_results: 3 }, ctx);
    expect(out).toContain('<function>');
    // module_context hint mentions "module" — should be in the top results
    expect(out).toMatch(/"name":"module_context"/);
  });

  it('`+keyword` enforces required term', async () => {
    const out = await toolSearchHandler({ query: '+refactor impact', max_results: 5 }, ctx);
    // impact_estimate hint mentions "refactor" and "impact"
    expect(out).toContain('"name":"impact_estimate"');
  });

  it('returns helpful message when query is empty', async () => {
    const out = await toolSearchHandler({ query: '' }, ctx);
    expect(out).toContain('`query` is required');
  });

  it('returns helpful message when nothing matches', async () => {
    const out = await toolSearchHandler({ query: 'zzz_nonexistent_xyz', max_results: 5 }, ctx);
    expect(out).toContain('No tools matched');
    expect(out).toContain('Available deferred tools');
  });

  it('TOOL_SEARCH_DEFINITION has the expected shape', () => {
    expect(TOOL_SEARCH_DEFINITION.name).toBe('tool_search');
    expect(TOOL_SEARCH_DEFINITION.sideEffect).toBe('readonly');
    expect(TOOL_SEARCH_DEFINITION.planModeAllowed).toBe(true);
  });
});

describe('FEATURE_189 B.2 — getActiveToolDefinitions deferred description swap', () => {
  const ACTIVE = [
    'read', 'write', 'edit', 'bash', 'grep', 'glob',
    'web_fetch', 'web_search', 'module_context', 'symbol_context',
    'tool_search',
  ];

  it('emits searchHint instead of full description for deferred tools by default', () => {
    const defs = getActiveToolDefinitions(ACTIVE);
    const webFetch = defs.find((d) => d.name === 'web_fetch');
    expect(webFetch).toBeDefined();
    expect(webFetch!.description).toBe(DEFERRED_TOOL_HINTS.web_fetch);
    // Make sure we are NOT emitting the full "prefer gh CLI" content here:
    expect(webFetch!.description).not.toContain('prefer `bash` with the `gh` CLI');
  });

  it('emits full description when the tool is in the unlock set', () => {
    const unlocked = new Set(['web_fetch']);
    const defs = getActiveToolDefinitions(
      ACTIVE,
      undefined,
      false,
      false,
      undefined,
      unlocked,
    );
    const webFetch = defs.find((d) => d.name === 'web_fetch');
    expect(webFetch).toBeDefined();
    expect(webFetch!.description).toContain('prefer `bash` with the `gh` CLI');
  });

  it('leaves non-deferred tools unchanged regardless of unlock set', () => {
    const unlocked = new Set(['read']); // read isn't deferred
    const defs = getActiveToolDefinitions(
      ACTIVE,
      undefined,
      false,
      false,
      undefined,
      unlocked,
    );
    const read = defs.find((d) => d.name === 'read');
    expect(read).toBeDefined();
    // read's real description should be substantial, not a tiny hint
    expect(read!.description.length).toBeGreaterThan(200);
  });

  it('emits hints simultaneously for multiple un-unlocked deferred tools', () => {
    const defs = getActiveToolDefinitions(ACTIVE);
    const moduleCtx = defs.find((d) => d.name === 'module_context');
    const symbolCtx = defs.find((d) => d.name === 'symbol_context');
    expect(moduleCtx!.description).toBe(DEFERRED_TOOL_HINTS.module_context);
    expect(symbolCtx!.description).toBe(DEFERRED_TOOL_HINTS.symbol_context);
  });

  it('partial unlock — only the unlocked tool gets full description', () => {
    const unlocked = new Set(['module_context']);
    const defs = getActiveToolDefinitions(
      ACTIVE,
      undefined,
      false,
      false,
      undefined,
      unlocked,
    );
    const moduleCtx = defs.find((d) => d.name === 'module_context');
    const symbolCtx = defs.find((d) => d.name === 'symbol_context');
    expect(moduleCtx!.description.length).toBeGreaterThan(300); // full
    expect(symbolCtx!.description).toBe(DEFERRED_TOOL_HINTS.symbol_context); // hint
  });

  it('tool_search itself is not deferred (always full description)', () => {
    const defs = getActiveToolDefinitions(ACTIVE);
    const ts = defs.find((d) => d.name === 'tool_search');
    expect(ts).toBeDefined();
    expect(ts!.description.length).toBeGreaterThan(200);
    expect(ts!.description).toContain('Fetch full schema');
  });
});
