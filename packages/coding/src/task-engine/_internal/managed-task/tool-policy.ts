/**
 * Managed-task tool policy — path- and shell-pattern guards + per-role
 * policy assembler.
 *
 * Ported 1:1 from the legacy `task-engine.ts` helpers + the deleted
 * `_internal/prompts/tool-policy.ts` + `role-prompt-types.ts` modules
 * (removed in FEATURE_084 Shard 6d-b), then restored in v0.7.26 to close
 * the prompt-surface parity gap — without `buildManagedWorkerToolPolicy`
 * the "## Tool Policy" section vanished from every managed worker's
 * system prompt.
 *
 * Runtime guards (always ported):
 *   - `DOCS_ONLY_WRITE_PATH_PATTERNS` / `SHELL_WRITE_PATTERNS` constants.
 *   - `matchesWritePathPattern` / `matchesShellPattern` / `collectToolInputPaths`.
 *   - `enforceWritePathBoundary` / `enforceShellWriteBoundary`.
 *
 * Policy assembly:
 *   - `INSPECTION_SHELL_PATTERNS` / `VERIFICATION_SHELL_PATTERNS`.
 *   - `extractRuntimeCommandCandidate` / `buildRuntimeVerificationShellPatterns`.
 *   - `buildManagedWorkerToolPolicy` — per-role switch (post-F193:
 *     returns `undefined` for every role; V2 Worker discipline is
 *     prompt-enforced via `worker-role-prompt.ts`).
 *
 * FEATURE_184 Phase C.3 removed `H1_EVALUATOR_ALLOWED_TOOLS` (Evaluator
 * retired). FEATURE_193 (v0.7.43) removed `PLANNER_ALLOWED_TOOLS` and
 * `H1_READONLY_GENERATOR_ALLOWED_TOOLS` (V1 Planner / readonly Generator
 * retired).
 */

import { isDocsLikePath, escapeRegexLiteral } from '../text-utils.js';
import type {
  KodaXTaskRole,
  KodaXTaskRoutingDecision,
  KodaXTaskToolPolicy,
  KodaXTaskVerificationContract,
} from '../../../types.js';

// FEATURE_193 / ADR-043: ScoutScopeHint + ScoutMutationIntent +
// inferScoutMutationIntent (the Scout mutation-intent classifier) were removed —
// the Scout role is retired and its only production call site was deleted in
// FEATURE_193, leaving a test-only dead cluster. The live tool-policy guards
// below (write-path / shell-write boundaries, buildManagedWorkerToolPolicy) are
// unaffected.

export const WRITE_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'write',
  'edit',
  'multi_edit',
  'apply_patch',
  'delete',
  'remove',
  'rename',
  'move',
  'create',
  'create_file',
  'create_resource',
  // v0.7.22-parity defense-in-depth — scene/script tool names from the
  // Godot-editor MCP integration. None of these are currently registered
  // in the KodaX core bundle, but they appeared in legacy
  // WRITE_ONLY_TOOLS and are kept here so that if an MCP server or
  // third-party extension registers a tool under any of these names,
  // Planner / Evaluator's `blockedTools: [...WRITE_ONLY_TOOLS]` already
  // covers it. Restoring the list closes the v22→v26 gap identified in
  // the deep-diff audit.
  'scene_create',
  'scene_node_add',
  'scene_node_delete',
  'scene_node_set',
  'scene_save',
  'script_create',
  'script_modify',
  'project_setting_set',
  'signal_connect',
]);

export const DOCS_ONLY_WRITE_PATH_PATTERNS: readonly string[] = [
  '\\.(?:md|mdx|txt|rst|adoc)$',
  '(?:^|/)(?:docs?|documentation|design|requirements?|specs?|plans?|notes?|reports?)(?:/|$)',
  '(?:^|/)(?:README|CHANGELOG|FEATURE_LIST|KNOWN_ISSUES|PRD|ADR|HLD|DD)(?:\\.[^/]+)?$',
];

export const SHELL_WRITE_PATTERNS: readonly string[] = [
  '\\b(?:Set-Content|Add-Content|Out-File|Tee-Object|Copy-Item|Move-Item|Rename-Item|Remove-Item|New-Item|Clear-Content)\\b',
  '\\b(?:rm|mv|cp|del|erase|touch|mkdir|rmdir|rename|ren)\\b',
  '\\b(?:sed\\s+-i|perl\\s+-pi|python\\s+-c|node\\s+-e)\\b',
  '(?:^|\\s)(?:>|>>)(?!(?:\\s*&1|\\s*2>&1))',
];

/**
 * Read-only inspection shell allow-list. Shared by Scout / Planner /
 * Evaluator so they can run status/diff/log/list commands but nothing
 * mutating. 1:1 port from legacy `_internal/prompts/tool-policy.ts`.
 */
export const INSPECTION_SHELL_PATTERNS: readonly string[] = [
  '^(?:git\\s+(?:status|diff|show|log|branch|rev-parse|ls-files))\\b',
  '^(?:Get-ChildItem|Get-Content|Select-String|type|dir|ls|cat)\\b',
  '^(?:findstr|where|pwd|cd)\\b',
  '^(?:node|npm|pnpm|yarn|bun)\\s+(?:run\\s+)?(?:lint|typecheck|check|list|why)\\b',
];

/**
 * Evaluator / verification-capable role allow-list — inspection +
 * test-runner / build / lint / e2e drivers. 1:1 port from legacy.
 */
export const VERIFICATION_SHELL_PATTERNS: readonly string[] = [
  ...INSPECTION_SHELL_PATTERNS,
  '^(?:agent-browser)\\b',
  '^(?:npx\\s+)?playwright\\b',
  '^(?:npx\\s+)?vitest\\b',
  '^(?:npx\\s+)?jest\\b',
  '^(?:npx\\s+)?cypress\\b',
  '^(?:npm|pnpm|yarn|bun)\\s+(?:run\\s+)?(?:test|test:[^\\s]+|e2e|e2e:[^\\s]+|verify|verify:[^\\s]+|build|build:[^\\s]+|lint|lint:[^\\s]+|typecheck|typecheck:[^\\s]+)\\b',
  '^(?:pytest|go\\s+test|cargo\\s+test|dotnet\\s+test|mvn\\s+test|gradle\\s+test)\\b',
];

// FEATURE_193 (v0.7.43): `PLANNER_ALLOWED_TOOLS` +
// `H1_READONLY_GENERATOR_ALLOWED_TOOLS` removed. The V1 Planner /
// readonly Generator allow-lists were referenced only by
// `buildManagedWorkerToolPolicy`'s `case 'planner'` / `case 'generator'`
// switch arms (deleted in F193 commits 1–5) and the
// `'role allow-lists expose repo-intelligence deep-capsule tools'`
// describe block in `tool-policy.test.ts` (deleted in this commit).

/**
 * Extract a plausible shell command candidate from a free-form
 * verification hint (e.g. `"startup: npm run dev"`). Returns the
 * suffix only when it begins with a recognized runtime driver —
 * prevents arbitrary user prose from polluting the shell allow-list.
 * 1:1 port from legacy.
 */
export function extractRuntimeCommandCandidate(
  value: string | undefined,
): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const suffixMatch = trimmed.match(/^[^:]+:\s*(.+)$/);
  const candidate = suffixMatch?.[1]?.trim() || trimmed;
  return /^(?:npm|pnpm|yarn|bun|npx|node|python|pytest|go\s+test|cargo\s+test|dotnet\s+test|mvn\s+test|gradle\s+test|curl|Invoke-WebRequest|Invoke-RestMethod|agent-browser|sqlite3|psql|mysql)\b/i.test(candidate)
    ? candidate
    : undefined;
}

/**
 * Extend the verification shell allow-list with the exact startup /
 * API / DB commands declared by the task's verification contract,
 * plus a generic curl/Invoke-* pattern when a live HTTP target is
 * implied. 1:1 port from legacy.
 */
export function buildRuntimeVerificationShellPatterns(
  verification: KodaXTaskVerificationContract | undefined,
): string[] {
  const runtime = verification?.runtime;
  if (!runtime) return [];
  const exactCommands = [
    runtime.startupCommand,
    ...(runtime.apiChecks ?? []),
    ...(runtime.dbChecks ?? []),
  ]
    .map(extractRuntimeCommandCandidate)
    .filter((value): value is string => Boolean(value));
  const patterns = exactCommands.map(
    (command) => `^${escapeRegexLiteral(command)}(?:\\s+.*)?$`,
  );
  if (runtime.baseUrl || (runtime.apiChecks?.length ?? 0) > 0) {
    patterns.push('^(?:curl|Invoke-WebRequest|Invoke-RestMethod)\\b');
  }
  return Array.from(new Set(patterns));
}

/**
 * Per-role `KodaXTaskToolPolicy` for a managed worker, or `undefined`
 * for the unrestricted-surface case.
 *
 * FEATURE_193 (v0.7.43): V1 scout / planner / generator switch cases
 * were retired with the V1 chain. The V2 Worker runs with an unrestricted
 * tool surface — discipline is enforced by `worker-role-prompt.ts` (plan-
 * first, mutation discipline, dispatch RULE A/B/C, scope commitment),
 * not by the tool-policy layer. The previous `verification` /
 * `harnessProfile` / `scoutMutationIntent` / `repoIntelligenceMode`
 * parameters + `finalizeToolPolicy` repo-intelligence-off filter became
 * unreachable when every switch arm returned `undefined`; they were
 * removed here. The function is kept (rather than inlined to `undefined`
 * at the call site) so a future role-specific tool policy can reattach
 * without touching the runner-driven dispatch closure.
 */
export function buildManagedWorkerToolPolicy(
  role: KodaXTaskRole,
): KodaXTaskToolPolicy | undefined {
  switch (role) {
    case 'worker':
      return undefined;
    default:
      return undefined;
  }
}

const WRITE_PATH_PATTERN_CACHE = new Map<string, RegExp>();
const SHELL_PATTERN_CACHE = new Map<string, RegExp>();

function getWritePathRegex(pattern: string): RegExp {
  let cached = WRITE_PATH_PATTERN_CACHE.get(pattern);
  if (!cached) {
    cached = new RegExp(pattern, 'i');
    WRITE_PATH_PATTERN_CACHE.set(pattern, cached);
  }
  return cached;
}

function getShellRegex(pattern: string): RegExp {
  let cached = SHELL_PATTERN_CACHE.get(pattern);
  if (!cached) {
    cached = new RegExp(pattern);
    SHELL_PATTERN_CACHE.set(pattern, cached);
  }
  return cached;
}

export function matchesWritePathPattern(
  targetPath: string,
  allowedPatterns: readonly string[] | undefined,
): boolean {
  if (!allowedPatterns || allowedPatterns.length === 0) {
    return true;
  }
  const normalized = targetPath.replace(/\\/g, '/');
  return allowedPatterns.some((pattern) => getWritePathRegex(pattern).test(normalized));
}

export function matchesShellPattern(
  command: string,
  patterns: readonly string[] | undefined,
): boolean {
  if (!patterns || patterns.length === 0) {
    return false;
  }
  return patterns.some((pattern) => getShellRegex(pattern).test(command));
}

const TOOL_INPUT_PATH_KEYS: ReadonlySet<string> = new Set([
  'file_path',
  'path',
  'target_path',
  'destination',
  'dest',
  'output_path',
  'output',
  'dir',
  'directory',
  'filename',
  'file',
  'paths',
  'files',
]);

export function collectToolInputPaths(
  value: unknown,
  currentKey?: string,
  seen: WeakSet<object> = new WeakSet(),
): string[] {
  if (typeof value === 'string') {
    return currentKey && TOOL_INPUT_PATH_KEYS.has(currentKey) ? [value] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectToolInputPaths(item, currentKey, seen));
  }
  if (!value || typeof value !== 'object') {
    return [];
  }
  const obj = value as Record<string, unknown>;
  if (seen.has(obj)) {
    return [];
  }
  seen.add(obj);

  const paths: string[] = [];
  for (const [childKey, childValue] of Object.entries(obj)) {
    paths.push(...collectToolInputPaths(childValue, childKey, seen));
  }
  return paths;
}

/**
 * Guard a write/edit tool call against an allowed-path pattern list.
 * Returns a human-readable error message when the call should be blocked,
 * or `undefined` when it's allowed.
 *
 * Matches legacy `createToolPolicyHook` behaviour (task-engine.ts:~1891):
 * if the input contains no recognisable path keys we *reject* the call —
 * the caller cannot verify the target against the boundary.
 */
export function enforceWritePathBoundary(
  toolName: string,
  input: unknown,
  allowedWritePathPatterns: readonly string[] | undefined,
  roleTitle = 'Generator',
): string | undefined {
  const normalizedTool = toolName.toLowerCase();
  if (!WRITE_ONLY_TOOLS.has(normalizedTool)) {
    return undefined;
  }
  if (!allowedWritePathPatterns || allowedWritePathPatterns.length === 0) {
    return undefined;
  }
  const targetPaths = Array.from(new Set(collectToolInputPaths(input)));
  if (targetPaths.length === 0) {
    return `[Managed Task ${roleTitle}] Tool "${toolName}" is blocked because the target path could not be verified against the docs-only boundary.`;
  }
  const disallowedPath = targetPaths.find(
    (targetPath) => !matchesWritePathPattern(targetPath, allowedWritePathPatterns),
  );
  if (disallowedPath) {
    return `[Managed Task ${roleTitle}] Tool "${toolName}" is blocked because "${disallowedPath}" is outside the allowed docs-only write boundary.`;
  }
  return undefined;
}

/**
 * Guard a bash tool call against the shell-write pattern list.
 * Returns a human-readable error message when the command is destructive
 * and the role is restricted; `undefined` when it's allowed.
 */
export function enforceShellWriteBoundary(
  command: string,
  roleTitle = 'Generator',
): string | undefined {
  if (matchesShellPattern(command.trim(), SHELL_WRITE_PATTERNS)) {
    return `[Managed Task ${roleTitle}] Shell command blocked because this role is restricted to docs-only mutations and the command would modify the filesystem outside the docs boundary.`;
  }
  return undefined;
}
