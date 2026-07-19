/**
 * Tier 0 — Absolute Denylist — FEATURE_158 Step 4 (v0.7.39).
 *
 * The narrowest possible set of catastrophic patterns that must NEVER reach
 * the LLM classifier (which is fallible / can be prompt-injected). Per
 * ADR-025: every entry here must satisfy BOTH gates:
 *
 *   (a) "is there any legitimate context in which this should be allowed?"
 *       — answer must be **no**.
 *   (b) "could the LLM be convinced to allow it under prompt injection?"
 *       — answer must be **yes** (otherwise classifier is sufficient).
 *
 * The 5-item list is **frozen** by ADR-025; adding entries requires a new
 * ADR addendum answering (a)+(b) again. Removing entries requires evidence
 * of high-volume false-positive friction.
 *
 * Patterns:
 *
 *   1. rm_rf_root      — `rm -rf /`, `rm -rf ~`, `rm -rf $HOME` (and quoted
 *                        / -fr variants). Excludes `rm -rf /tmp/foo` (which
 *                        is a `dangerous_pattern` signal but reaches LLM).
 *   2. mkfs_or_format  — `mkfs.* /dev/sd*`, `fdisk /dev/sd*`, `format C:`.
 *                        Block formatting any disk device.
 *   3. dd_disk_write   — `dd of=/dev/sd*` (raw-disk write). Excludes
 *                        `dd of=test.bin` (file write — reaches LLM as
 *                        dangerous_pattern signal).
 *   4. fork_bomb       — `:(){ :|:& };:` — denial of service.
 *   5. user_kodax_write — write/edit to any path under `~/.kodax/`
 *                        (credentials zone — internal kodax config writes
 *                        use the TypeScript API, not bash/tools, so the
 *                        only path here is LLM-emitted shell which is
 *                        always wrong).
 *
 * Layer note: bash-level `~/.kodax/` writes (e.g. `echo x > ~/.kodax/y`)
 * require AST path-extraction which lives in `@kodax/repl`. The REPL-side
 * collector wired through `extraCollectors` (Step 7) escalates those to
 * Tier 0 by emitting a synthetic `user_kodax_write` denial via the same
 * `AbsoluteDenyResult` shape. This module handles the file-tool path
 * directly (the most common attack vector) and the four command-string
 * patterns that don't need path extraction.
 */

import { getAgentConfigHome, isPathInsideDirectory, resolveExecutionPath } from '@kodax-ai/agent';
import type { RunnerToolCall } from '@kodax-ai/agent';

export type TierZeroPatternId =
  | 'rm_rf_root'
  | 'mkfs_or_format'
  | 'dd_disk_write'
  | 'fork_bomb'
  | 'user_kodax_write';

export interface AbsoluteDenyMatch {
  readonly denied: true;
  readonly patternId: TierZeroPatternId;
  readonly reason: string;
}

export interface AbsoluteDenyMiss {
  readonly denied: false;
}

export type AbsoluteDenyResult = AbsoluteDenyMatch | AbsoluteDenyMiss;
export type AbsoluteDenyCheck = (
  call: RunnerToolCall,
  projectRoot: string,
  executionCwd: string,
) => AbsoluteDenyResult;

const MISS: AbsoluteDenyMiss = { denied: false };

// ============== Pattern 1: rm -rf / or ~ or $HOME ==============

/**
 * Matches `rm` with recursive+force flags. Captures common spellings:
 *   -rf / -fr / -r -f / --recursive --force / --force --recursive
 * Plus `r` / `f` bundled into longer flag clusters (e.g. `-rvf`, `-Rf`).
 *
 * Negative match for `-r` alone or `-f` alone — both flags required for
 * Tier 0 (a single flag isn't enough to wipe a directory tree).
 */
function hasRecursiveAndForceFlags(tokens: readonly string[]): boolean {
  let r = false;
  let f = false;
  for (const t of tokens) {
    if (!t.startsWith('-')) continue;
    if (t === '--recursive' || t === '-R') r = true;
    else if (t === '--force') f = true;
    else if (t.startsWith('-') && !t.startsWith('--')) {
      // bundled short flags like -rf / -fr / -Rfv
      if (/r/i.test(t.slice(1))) r = true;
      if (/f/.test(t.slice(1))) f = true;
    }
  }
  return r && f;
}

const ROOT_TARGET_TOKENS: ReadonlySet<string> = new Set([
  '/',
  '~',
  '~/',
  '$HOME',
  '${HOME}',
  '$HOME/',
  '${HOME}/',
]);

function unquote(token: string): string {
  if (token.length < 2) return token;
  const first = token[0];
  const last = token[token.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return token.slice(1, -1);
  }
  return token;
}

function checkRmRfRoot(command: string): AbsoluteDenyResult {
  const trimmed = command.trim();
  if (!/^\s*rm\b/.test(trimmed)) return MISS;
  // Strip leading `rm` and split on whitespace (good enough for Tier 0;
  // we're matching a narrow catastrophic pattern not parsing arbitrary
  // shell).
  const tokens = trimmed.split(/\s+/).slice(1);
  if (!hasRecursiveAndForceFlags(tokens)) return MISS;
  for (const raw of tokens) {
    if (raw.startsWith('-')) continue;
    const unq = unquote(raw);
    // Also catch glob-expanded forms like `/*`, `~/*`, `$HOME/*`
    const canonical = unq.replace(/\/\*+$/, '/').replace(/\/+$/, '/');
    if (ROOT_TARGET_TOKENS.has(unq) || ROOT_TARGET_TOKENS.has(canonical)) {
      return {
        denied: true,
        patternId: 'rm_rf_root',
        reason: `Recursive deletion of root path (\`${unq}\`) is permanently denied. If you intended a subdirectory, use a full path like \`rm -rf /tmp/scratch\`.`,
      };
    }
  }
  return MISS;
}

// ============== Pattern 2: mkfs / fdisk / format ==============

const MKFS_OR_FORMAT_RE = /(^|[\s|;&(])(mkfs(?:\.[a-z0-9]+)?|fdisk)\s+(['"]?)(\/dev\/(sd|nvme|hd|vd)[a-z0-9]*|\\\\\.\\PhysicalDrive[0-9]+)/i;
const FORMAT_DRIVE_RE = /(^|[\s|;&(])format(\s+\/[A-Za-z]:?)?(\s+[A-Za-z]:)/;

function checkMkfsOrFormat(command: string): AbsoluteDenyResult {
  if (MKFS_OR_FORMAT_RE.test(command)) {
    return {
      denied: true,
      patternId: 'mkfs_or_format',
      reason: 'Disk format / filesystem creation on a block device is permanently denied (data destruction risk).',
    };
  }
  if (FORMAT_DRIVE_RE.test(command)) {
    return {
      denied: true,
      patternId: 'mkfs_or_format',
      reason: 'Windows `format X:` command is permanently denied (data destruction risk).',
    };
  }
  return MISS;
}

// ============== Pattern 3: dd if=... of=/dev/sd* ==============

const DD_DISK_WRITE_RE = /(^|[\s|;&(])dd\s+[^\n]*\bof=(['"]?)(\/dev\/(sd|nvme|hd|vd)[a-z0-9]*|\\\\\.\\PhysicalDrive[0-9]+)/i;

function checkDdDiskWrite(command: string): AbsoluteDenyResult {
  if (DD_DISK_WRITE_RE.test(command)) {
    return {
      denied: true,
      patternId: 'dd_disk_write',
      reason: 'Raw disk write via `dd of=/dev/sd*` is permanently denied. Use a file target (`of=path.bin`) if you intended a file write.',
    };
  }
  return MISS;
}

// ============== Pattern 4: fork bomb ==============

// Classic fork bomb shape; whitespace-tolerant inside the braces but
// requires the structural `:(){...};:` skeleton to match.
const FORK_BOMB_RE = /:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:\s*&[^}]*\}\s*;\s*:/;

function checkForkBomb(command: string): AbsoluteDenyResult {
  if (FORK_BOMB_RE.test(command)) {
    return {
      denied: true,
      patternId: 'fork_bomb',
      reason: 'Fork bomb pattern detected; permanently denied (denial-of-service risk).',
    };
  }
  return MISS;
}

// ============== Pattern 5: write / edit to ~/.kodax/ ==============

function checkUserKodaxWrite(
  call: RunnerToolCall,
  executionCwd: string,
): AbsoluteDenyResult {
  if (call.name !== 'write' && call.name !== 'edit') return MISS;
  const targetPath = typeof call.input.path === 'string' ? call.input.path : '';
  if (!targetPath) return MISS;
  let userKodax: string;
  try {
    userKodax = getAgentConfigHome();
  } catch {
    return MISS;
  }
  const resolved = resolveExecutionPath(targetPath, executionCwd);
  if (isPathInsideDirectory(resolved, userKodax)) {
    return {
      denied: true,
      patternId: 'user_kodax_write',
      reason: `Write to credential-zone path \`${targetPath}\` (under ~/.kodax/) is permanently denied. KodaX config edits must go through the \`kodax config\` CLI or the SDK config API, never through the file-write tool.`,
    };
  }
  return MISS;
}

// ============== Public entrypoint ==============

/**
 * Check a tool call against the Tier 0 absolute denylist. Returns the
 * first matching pattern, or `{ denied: false }` if no pattern fires.
 *
 * Order is deterministic — patterns checked in the order defined above.
 * Multiple matches would be possible (e.g. `rm -rf / ; :(){...};:`) but
 * we return the first hit since the guardrail acts on `denied: true`
 * regardless and the reason string is one-shot.
 *
 * **Pure**: deterministic given (call, projectRoot, stable env).
 * **Fast**: ~5 regex tests + 1-2 string ops; safe to run on every
 * non-Tier-1 call without measurable overhead.
 */
export function checkAbsoluteDeny(
  call: RunnerToolCall,
  projectRoot: string,
  executionCwd = projectRoot,
): AbsoluteDenyResult {
  // File-tool path (write/edit to ~/.kodax/)
  const kodaxWrite = checkUserKodaxWrite(call, executionCwd);
  if (kodaxWrite.denied) return kodaxWrite;

  // Bash command-string patterns
  if (call.name !== 'bash') return MISS;
  const command = typeof call.input.command === 'string' ? call.input.command : '';
  if (!command) return MISS;

  const rmRoot = checkRmRfRoot(command);
  if (rmRoot.denied) return rmRoot;

  const mkfs = checkMkfsOrFormat(command);
  if (mkfs.denied) return mkfs;

  const dd = checkDdDiskWrite(command);
  if (dd.denied) return dd;

  const forkBomb = checkForkBomb(command);
  if (forkBomb.denied) return forkBomb;

  return MISS;
}
