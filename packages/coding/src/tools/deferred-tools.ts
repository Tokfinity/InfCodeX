/**
 * Deferred tool registry — FEATURE_189 Batch 3 B.2 progressive disclosure.
 *
 * Tools listed here have rich descriptions (claudecode-grade, ~500-1000 bytes)
 * whose teaching content the model only needs to consume when it plans to
 * call the tool. To save turn-1 context, the LLM-visible tool schema swaps
 * the full description for a one-line `searchHint` until the tool name
 * appears in the per-session unlock Set. Unlocking happens via the
 * `tool_search` tool: the LLM queries `tool_search` with a tool name (or
 * keywords), and the response includes the full schema + adds the tool to
 * the unlock Set for the next turn.
 *
 * Why centralized vs per-tool annotation: keeps deferred-tool policy in one
 * file rather than scattering `shouldDefer: true` across 15 LocalToolDefinition
 * entries; easier to audit which tools are deferred and to evolve the list.
 *
 * Mirrors claudecode's `isDeferredTool` (`c:/Works/claudecode/src/tools/index.ts`)
 * and `ToolSearch` bootstrap pattern (`c:/Works/claudecode/src/tools/ToolSearchTool/`).
 *
 * NOT in the deferred set:
 *   - Core tools always-loaded: bash, read, edit, write, multi_edit, grep, glob,
 *     todo_create, todo_update, todo_get, todo_list, ask_user_question,
 *     dispatch_child_task, exit_plan_mode, task_output, task_stop,
 *     send_message, insert_after_anchor,
 *     changed_diff, changed_diff_bundle, undo, worktree_*
 *   - `tool_search` itself (must always be available to unlock the rest)
 */

/**
 * Map of deferred tool name → one-line searchHint shown in place of the
 * full description until the tool is unlocked. Each hint must answer
 * "when would I want to look this up" in a compact form so the LLM can
 * decide whether to invoke `tool_search` for the full schema.
 */
export const DEFERRED_TOOL_HINTS: Readonly<Record<string, string>> = Object.freeze({
  // Web / discovery
  web_search:      'Discover web content when no specific URL is known — call `tool_search("web_search")` for full schema.',
  web_fetch:       'Fetch a specific remote URL (HTML→markdown, cached) — call `tool_search("web_fetch")` for full schema (includes GitHub-URL gh-CLI guidance).',
  code_search:     'Ranked text search across the repo with noise filtering — call `tool_search("code_search")` for selection heuristics vs grep / symbol_context.',
  semantic_lookup: 'Symbol-/module-/process-aware semantic queries against repo intelligence — call `tool_search("semantic_lookup")` for full schema and selection rules.',

  // MCP family
  mcp_search:        'Search active MCP capabilities by query / server / kind — call `tool_search("mcp_search")` for full schema.',
  mcp_describe:      'Describe a specific MCP capability by id (JSON schema + trust) — call `tool_search("mcp_describe")` for full schema.',
  mcp_call:          'Invoke an MCP tool capability — can MUTATE remote state. Call `tool_search("mcp_call")` for the full safety contract.',
  mcp_read_resource: 'Read an MCP resource (no mutation) — call `tool_search("mcp_read_resource")` for full schema.',
  mcp_get_prompt:    'Retrieve an MCP prompt template — call `tool_search("mcp_get_prompt")` for full schema.',

  // Repo intelligence
  repo_overview:   'Workspace structure snapshot — call ONCE at session start; `tool_search("repo_overview")` for full schema.',
  changed_scope:   'List files / areas changed in current git diff — canonical review entry. `tool_search("changed_scope")` for full schema.',
  module_context:  'Compact module capsule (deps, entries, symbols, tests) — call `tool_search("module_context")` for full schema and selection rules vs symbol_context.',
  symbol_context:  'Definition + callers/callees for one symbol — call `tool_search("symbol_context")` for full schema and selection rules.',
  process_context: 'Static execution/process trace from an entry — call `tool_search("process_context")` for full schema.',
  impact_estimate: 'Blast radius estimate BEFORE a rename or refactor — call `tool_search("impact_estimate")` for full schema (replaces guessing impact from grep).',

  // FEATURE_259 — workflow authoring is a resident identity/activation hint;
  // the full orchestration guide remains available through tool_search.
  run_workflow: 'Partitioned multi-agent work needing synthesis/verification: if plan is recorded, call instead of todo/dispatch. Runs manifest+source with structured output/resume; returns background task_id—idle-yield. `tool_search("run_workflow")` for contract.',

  // FEATURE_192 v0.7.44 — /goal Persistent Goal tools.
  // Hint-only on turn-1 to keep no-goal sessions context-clean; full
  // schema unlocks via `tool_search("goal")` once the model needs them.
  get_goal:    'Read the current /goal status (objective / tokens / budget / elapsed) — call `tool_search("get_goal")` for full schema. Available when a goal is set.',
  create_goal: 'Create a persistent /goal — only when explicitly requested by the user or system instructions. Call `tool_search("create_goal")` for full schema and discipline rules.',
  update_goal: 'Mark the current /goal complete or blocked — runtime-verified (sidecar + 3-turn rule). Call `tool_search("update_goal")` for full schema.',
});

/**
 * Predicate: is this tool name in the deferred set?
 */
export function isDeferredTool(name: string): boolean {
  return name in DEFERRED_TOOL_HINTS;
}

/**
 * Look up the search hint for a deferred tool, or `undefined` if the tool
 * is not deferred.
 */
export function getDeferredToolHint(name: string): string | undefined {
  return DEFERRED_TOOL_HINTS[name];
}

/**
 * Snapshot of all currently deferred tool names.
 *
 * NOTE: there is deliberately NO resident "deferred tools" system-prompt
 * section — the mechanism is self-taught via (a) each tool's `searchHint`
 * (which is shown in place of its description in the LLM-visible tool list and
 * names `tool_search` explicitly) and (b) `tool_search`'s own description.
 * The two-hop reachability eval (FEATURE_250) confirms this is sufficient
 * across the coding-plan panel, so this helper is a utility for callers that
 * want the list (e.g. tests / diagnostics), not a prompt-surface feed.
 */
export function listDeferredToolNames(): readonly string[] {
  return Object.freeze(Object.keys(DEFERRED_TOOL_HINTS));
}

/* ----------------------------------------------------------------
 * Per-context unlock state — keyed by KodaXToolExecutionContext via
 * WeakMap so the lifetime tracks the context object (auto-cleans on
 * GC). Per-context isolation also keeps unit tests independent.
 * ---------------------------------------------------------------- */

const UNLOCKED_PER_CONTEXT: WeakMap<object, Set<string>> = new WeakMap();

/**
 * Mark a deferred tool as unlocked for this context. Subsequent calls to
 * `getActiveToolDefinitions` that pass this context's unlock set will see
 * the full description instead of the search hint.
 *
 * Idempotent — adding an already-unlocked name is a no-op.
 */
export function unlockDeferredToolForContext(
  context: object,
  toolName: string,
): void {
  let set = UNLOCKED_PER_CONTEXT.get(context);
  if (!set) {
    set = new Set();
    UNLOCKED_PER_CONTEXT.set(context, set);
  }
  set.add(toolName);
}

/**
 * Snapshot of currently-unlocked deferred tool names for this context.
 * Returns an empty set if nothing has been unlocked yet. The returned
 * set is a defensive copy — callers must not mutate the internal set.
 */
export function getUnlockedDeferredTools(
  context: object,
): ReadonlySet<string> {
  const set = UNLOCKED_PER_CONTEXT.get(context);
  return set ? new Set(set) : new Set();
}

/**
 * Test-only: clear the unlock set for a context. Production code paths
 * rely on context-object lifetime + GC, not explicit clears.
 */
export function _resetUnlockedDeferredToolsForTest(context: object): void {
  UNLOCKED_PER_CONTEXT.delete(context);
}
