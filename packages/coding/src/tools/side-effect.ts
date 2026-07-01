/**
 * v0.7.42 — Declarative tool side-effect class.
 *
 * FEATURE_247: extracted into this leaf module (from `tools/types.ts`) so the
 * main `coding/src/types.ts` can import `ToolSideEffect` for the tool-visibility
 * policy WITHOUT forming a type-level import cycle with `tools/types.ts` (which
 * imports `KodaXToolExecutionContext` back from `types.ts`). This file imports
 * nothing from the coding type graph.
 *
 * Required field on every {@link import('./types.js').LocalToolDefinition}. Used by:
 *   - Plan mode: tools with `sideEffect !== 'readonly'` are blocked unless
 *     they explicitly opt in via `planModeAllowed: true` (e.g.
 *     `exit_plan_mode`, `task_stop`).
 *   - SDK embedders (KodaX Space etc.): iterate `getAllRegisteredTools()`
 *     and build their own blocklist by category — replaces the previous
 *     practice of hardcoding a `Set<string>` of tool names, which silently
 *     drifted whenever KodaX added a new tool.
 *   - Internal permission system: `FILE_MODIFICATION_TOOLS` and
 *     `MODIFICATION_TOOLS` exports in `@kodax-ai/repl` are now computed
 *     from this metadata at module load time, so adding a new
 *     `'mutates-fs'` tool here automatically reaches every callsite
 *     that consumes those sets.
 *
 * Categories (mutually exclusive; pick the dominant effect):
 *   - `'readonly'`        — produces no observable side effect, just reads
 *                            local state (FS, registry, computed views).
 *   - `'mutates-fs'`      — writes to the local filesystem (write, edit,
 *                            multi-edit, undo, worktree-*, construction
 *                            artifacts). Bash is NOT in this bucket; it has
 *                            its own.
 *   - `'mutates-shell'`   — invokes an arbitrary shell command (bash).
 *   - `'reads-network'`   — FEATURE_247: performs a network request whose
 *                            LLM-facing semantics are read-only, i.e. no remote
 *                            mutation (web_search, mcp_read_resource,
 *                            mcp_get_prompt). Distinct from `'mutates-network'`
 *                            so a permission broker can allow web research while
 *                            still blocking mutating network calls. Plan-mode
 *                            eligibility is still driven by `planModeAllowed`,
 *                            unchanged.
 *   - `'mutates-network'` — performs a network request that may mutate remote
 *                            state (web_fetch with a mutating method, mcp_call).
 *   - `'mutates-state'`   — changes internal session/agent state without
 *                            FS or shell side effects (todo_update,
 *                            send_message, dispatch_child_task,
 *                            exit_plan_mode, emit_managed_protocol).
 *
 * Pick the dominant effect when a tool touches multiple. e.g. `dispatch_
 * child_task` may transitively run any tool, but its own direct effect is
 * spawning a child agent (`mutates-state`).
 */
export type ToolSideEffect =
  | 'readonly'
  | 'reads-network'
  | 'mutates-fs'
  | 'mutates-shell'
  | 'mutates-network'
  | 'mutates-state';
