/**
 * Bash AST Helpers — FEATURE_152 (v0.7.38) slice 1.
 *
 * Wraps `shell-quote.parse(...)` with a typed surface tailored for the
 * permission gate. Replaces the regex-soup in `permission.ts`
 * (`isBashReadCommand` / `isBashWriteCommand` / `collectBashWriteTargets`)
 * which was a documented source of false positives + Issue 129's class of
 * misjudgments (piped read commands tripping the write detector via raw
 * substring matching against `>` / `>>` / `tee` / `out-file`).
 *
 * Design choice — `shell-quote` only, NOT `tree-sitter`:
 *   - shell-quote is ~12KB pure JS, ships full POSIX-y shell tokenization
 *     (quoting, escapes, redirections, env var substitution, command
 *     substitution markers).
 *   - tree-sitter+wasm is ~500KB on disk + needs WASM loader plumbing —
 *     fights KodaX's `极致轻量化` philosophy in CLAUDE.md.
 *   - shell-quote covers ~98% of real-world bash that flows through the
 *     permission gate; the 2% it can't tokenize (e.g. heredocs spanning
 *     multiple lines) we explicitly mark as `unparseable` and let the
 *     caller fall back to "treat as write / require confirmation".
 *
 * Slice 1 (this file): module + tests, no integration. Slices 2-4 migrate
 * the consumers. See [docs/ADR.md ADR-023](../../../../docs/ADR.md#adr-023-bash-command-parsing--regex--ast-migration-feature_152-v0738)
 * for the full migration plan.
 */

import { parse as shellQuoteParse, type ParseEntry } from 'shell-quote';

// ============== Token model ==============

/**
 * One pipeline stage (e.g. for `grep foo file.txt | sort | head`, three
 * stages). Stages are separated by `|` operators in the raw token stream.
 *
 * Why expose stages instead of one flat token list:
 *   - `isBashReadCommand` already supports `|` chains; each stage must
 *     independently be a read command, so the consumer iterates stages
 *     not tokens.
 *   - `isBashWriteCommand` checks every stage's argv (`tee` / `Set-Content`
 *     can appear at the start of any pipeline stage, not only stage 0)
 *     AND every stage's redirections (`grep foo > out.txt` writes in
 *     stage 1; `grep foo | tee out.log` writes via stage 2's argv[0]).
 *     Per-stage exposure gives the consumer precise control.
 */
export interface BashPipelineStage {
  /** Argv-style positional tokens for this stage, with quoting stripped. */
  readonly argv: readonly string[];
  /** Redirections attached to this stage (`> file`, `2>NUL`, `>>foo.log`, ...). */
  readonly redirections: readonly BashRedirection[];
}

export interface BashRedirection {
  /** Operator as parsed from the source (e.g. `>`, `>>`, `2>`, `&>`, `<`). */
  readonly op: string;
  /** Optional file descriptor specifier (e.g. `2` for `2>NUL`, `&` for `&>foo`). */
  readonly fd: string | null;
  /** True when the operator is append (`>>`, `&>>`). */
  readonly append: boolean;
  /** True when reading from (`<`, `<<`). */
  readonly input: boolean;
  /**
   * Target path (already unquoted). For null-device redirects (`/dev/null`,
   * `NUL`) callers can check `isNullDevice(target)`.
   */
  readonly target: string;
}

/**
 * Top-level command tree. Multiple top-level entries appear when commands
 * are joined by `&&` / `||` / `;`; each entry is itself a pipeline of
 * stages.
 */
export interface BashCommandTree {
  readonly statements: readonly BashStatement[];
  /**
   * True when shell-quote couldn't fully tokenize the input (heredocs,
   * malformed quoting, etc.). Callers should treat unparseable commands
   * as "unsafe / require confirmation" rather than auto-allow.
   */
  readonly unparseable: boolean;
}

export interface BashStatement {
  /**
   * Logical separator from the PRECEDING statement. The first statement
   * always has `null` here. Subsequent ones get the operator that joined
   * them: `&&` / `||` / `;` / `|` (only `|` for command substitution
   * inside an arg, which we currently flatten into argv as a literal).
   */
  readonly precedingOp: '&&' | '||' | ';' | null;
  readonly stages: readonly BashPipelineStage[];
}

// ============== Public API ==============

const NULL_DEVICE_TARGETS = new Set(['/dev/null', 'nul', 'NUL']);

/** Returns true when `target` resolves to a null device on POSIX or Windows. */
export function isNullDevice(target: string): boolean {
  return NULL_DEVICE_TARGETS.has(target) || NULL_DEVICE_TARGETS.has(target.toLowerCase());
}

/**
 * Parse a bash/PowerShell-style command into a structured tree. Returns
 * `unparseable: true` when shell-quote yields object tokens we don't
 * model (heredocs, glob-only ops). Caller policy: "unparseable → require
 * confirmation".
 *
 * Performance: shell-quote is a single-pass tokenizer; ~50μs per call on
 * a typical 80-char command. The permission gate calls this at most
 * once per tool invocation, so the cost is negligible vs. the existing
 * regex sweeps.
 *
 * @param command — raw bash/PowerShell command string. Empty / whitespace
 *                   returns `{ statements: [], unparseable: false }`.
 */
export function parseBashCommand(command: string): BashCommandTree {
  const trimmed = command.trim();
  if (!trimmed) {
    return { statements: [], unparseable: false };
  }

  // Pre-tokenization safety: shell-quote treats `` ` `` as an ordinary char
  // and packs it into string tokens (`echo \`rm -rf /\`` parses to argv
  // ['echo', '`rm', '-rf', '/`'] — a "safe" `echo` argv from the AST's
  // perspective even though backticks request command substitution at
  // shell-eval time). Flag the input as unparseable so callers fail-closed
  // (refuse auto-allow) on any backtick form.
  if (trimmed.includes('`')) {
    return { statements: [], unparseable: true };
  }

  let entries: ParseEntry[];
  try {
    entries = shellQuoteParse(trimmed);
  } catch {
    // shell-quote shouldn't throw on standard input but guard anyway.
    return { statements: [], unparseable: true };
  }

  // Build statements by walking entries and splitting on logical operators.
  const statements: BashStatement[] = [];
  let currentStages: BashPipelineStage[] = [];
  let currentArgv: string[] = [];
  let currentRedirs: BashRedirection[] = [];
  let precedingOp: '&&' | '||' | ';' | null = null;
  let unparseable = false;

  const flushStage = (): void => {
    if (currentArgv.length > 0 || currentRedirs.length > 0) {
      currentStages.push({
        argv: currentArgv,
        redirections: currentRedirs,
      });
      currentArgv = [];
      currentRedirs = [];
    }
  };

  const flushStatement = (nextOp: '&&' | '||' | ';' | null): void => {
    flushStage();
    if (currentStages.length > 0) {
      statements.push({ precedingOp, stages: currentStages });
      currentStages = [];
    }
    precedingOp = nextOp;
  };

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];

    if (typeof entry === 'string') {
      currentArgv.push(entry);
      continue;
    }

    // Object entry — operator, glob, comment, or substitution.
    if ('op' in entry) {
      const op = entry.op;
      if (op === '&&' || op === '||' || op === ';') {
        flushStatement(op);
        continue;
      }
      if (op === '|') {
        flushStage();
        continue;
      }
      // shell-quote tokenises `&>` as two ops: `{op:'&'}` then `{op:'>'}`.
      // Fuse them into a single combined-fd redirection. Mirrors the
      // `2>NUL` argv-fusion below.
      if (op === '&') {
        const next = entries[i + 1];
        if (
          next !== undefined &&
          typeof next !== 'string' &&
          'op' in next &&
          (next.op === '>' || next.op === '>>')
        ) {
          const target = entries[i + 2];
          if (typeof target !== 'string') {
            unparseable = true;
            i += 1;
            continue;
          }
          currentRedirs.push(parseRedirection(`&${next.op}`, target));
          i += 2;
          continue;
        }
        // Bare `&` (background job marker) — unsupported in our model.
        unparseable = true;
        continue;
      }
      if (isRedirectionOp(op)) {
        // shell-quote tokenises `2>NUL` as `'2'`, `{op:'>'}`, `'NUL'`. If the
        // last argv token is a bare numeric literal, treat it as the fd
        // prefix of this redirection rather than a positional arg.
        let fdPrefix: string | null = null;
        const lastArgv = currentArgv[currentArgv.length - 1];
        if (lastArgv !== undefined && /^[0-9]+$/.test(lastArgv)) {
          fdPrefix = lastArgv;
          currentArgv.pop();
        }
        const next = entries[i + 1];
        if (typeof next !== 'string') {
          unparseable = true;
          continue;
        }
        currentRedirs.push(parseRedirection(fdPrefix ? `${fdPrefix}${op}` : op, next));
        i += 1;
        continue;
      }
      if (op === 'glob') {
        // Glob token: `*.ts` etc. The pattern lives on `entry.pattern`.
        const pattern = (entry as { pattern?: string }).pattern;
        if (typeof pattern === 'string') {
          currentArgv.push(pattern);
        } else {
          unparseable = true;
        }
        continue;
      }
      // Unknown / unsupported operator (heredoc markers, etc.) — flag.
      unparseable = true;
      continue;
    }

    if ('comment' in entry) {
      // Inline comment — terminates the rest of the line, drop subsequent
      // entries for safety.
      break;
    }

    // shell-quote env-var substitutions (`$VAR`) come back as `{ pattern, op: 'glob' }`
    // OR as object literals `{ op: '$', value: ... }` depending on version. We
    // already handle 'glob' above; everything else flagged unparseable for
    // safety.
    unparseable = true;
  }

  flushStatement(null);

  return { statements, unparseable };
}

// ============== Convenience accessors ==============

/**
 * All argv tokens across every stage of every statement, in order.
 *
 * **Do NOT use this for write-command detection.** `flattenArgv` cannot
 * distinguish `tee` appearing as a stage's command (a write) from `tee`
 * appearing as a positional argument (e.g. `man tee`). For "is this a
 * write command?" checks, iterate `tree.statements[i].stages[j]` and
 * inspect `stage.argv[0]` directly. `flattenArgv` is only safe for
 * "does ANY token mention a path" / argv-content searches that don't
 * care about token position.
 */
export function flattenArgv(tree: BashCommandTree): string[] {
  const out: string[] = [];
  for (const stmt of tree.statements) {
    for (const stage of stmt.stages) {
      out.push(...stage.argv);
    }
  }
  return out;
}

/**
 * All redirections across every stage, with the stage's argv[0] (the
 * command being redirected) attached for context. Useful for `tee` /
 * `out-file` style writes that aren't redirections themselves but write
 * via positional args.
 */
export function flattenRedirections(
  tree: BashCommandTree,
): Array<BashRedirection & { stageCommand: string | undefined }> {
  const out: Array<BashRedirection & { stageCommand: string | undefined }> = [];
  for (const stmt of tree.statements) {
    for (const stage of stmt.stages) {
      const stageCommand = stage.argv[0];
      for (const redir of stage.redirections) {
        out.push({ ...redir, stageCommand });
      }
    }
  }
  return out;
}

// ============== Internals ==============

const REDIRECTION_OPS = new Set([
  '>',
  '>>',
  '<',
  '<<',
  '<<<',
  '&>',
  '&>>',
]);

const FD_REDIRECTION_PATTERN = /^([0-9]+|&)(>>?|<<?)$/;

function isRedirectionOp(op: string): boolean {
  return REDIRECTION_OPS.has(op) || FD_REDIRECTION_PATTERN.test(op);
}

function parseRedirection(op: string, target: string): BashRedirection {
  let fd: string | null = null;
  let bareOp = op;
  const fdMatch = FD_REDIRECTION_PATTERN.exec(op);
  if (fdMatch) {
    fd = fdMatch[1];
    bareOp = fdMatch[2];
  }
  return {
    op,
    fd,
    append: bareOp === '>>' || op === '&>>',
    input: bareOp === '<' || bareOp === '<<' || op === '<<<',
    target,
  };
}
