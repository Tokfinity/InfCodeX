import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTempDirSync, removeTempDirSync } from '../test-utils/temp-dir.js';
import {
  getDirectShellBypassBlockReason,
  getPlanModeBlockReason,
  isAlwaysConfirmPath,
  isBashReadCommand,
  isBashWriteCommand,
  isCommandOnProtectedPath,
  isHelpCommand,
  isPlanModeAllowedPath,
  isToolCallAllowed,
} from './permission.js';
import type { BashPrefixExtractor, BashPrefixResult } from '@kodax-ai/coding';

const createdRoots: string[] = [];

function createProjectRoot(): string {
  const root = createTempDirSync('kodax-plan-mode-', process.cwd());
  createdRoots.push(root);
  return root;
}

afterEach(() => {
  while (createdRoots.length > 0) {
    const root = createdRoots.pop();
    removeTempDirSync(root);
  }
});

describe('plan mode writable path whitelist', () => {
  it('allows writes to the project plan mode document', () => {
    const projectRoot = createProjectRoot();

    expect(isPlanModeAllowedPath('.agent/plan_mode_doc.md', projectRoot)).toBe(true);
    expect(getPlanModeBlockReason('write', { path: '.agent/plan_mode_doc.md' }, projectRoot)).toBeNull();
    expect(
      getPlanModeBlockReason(
        'edit',
        { path: path.join(projectRoot, '.agent', 'plan_mode_doc.md') },
        projectRoot
      )
    ).toBeNull();
  });

  it('allows writes in the system temp directory', () => {
    const projectRoot = createProjectRoot();
    const tempFile = path.join(os.tmpdir(), `kodax-plan-${Date.now()}.txt`);

    expect(isPlanModeAllowedPath(tempFile, projectRoot)).toBe(true);
    expect(getPlanModeBlockReason('write', { path: tempFile }, projectRoot)).toBeNull();
  });

  it('blocks other workspace files and other .agent files', () => {
    const projectRoot = createProjectRoot();

    expect(getPlanModeBlockReason('write', { path: 'README.md' }, projectRoot)).toContain(
      'Plan mode only allows file modifications'
    );
    expect(getPlanModeBlockReason('edit', { path: '.agent/other.md' }, projectRoot)).toContain(
      'Plan mode only allows file modifications'
    );
  });

  it('allows bash writes only when every target stays in the whitelist', () => {
    const projectRoot = createProjectRoot();
    const tempFile = path.join(os.tmpdir(), `kodax-plan-${Date.now()}.txt`);

    expect(
      getPlanModeBlockReason('bash', { command: 'echo hi > .agent/plan_mode_doc.md' }, projectRoot)
    ).toBeNull();
    expect(
      getPlanModeBlockReason('bash', { command: `echo hi > "${tempFile}"` }, projectRoot)
    ).toBeNull();
  });

  it('blocks bash writes outside the whitelist or without a safe target', () => {
    const projectRoot = createProjectRoot();

    expect(
      getPlanModeBlockReason('bash', { command: 'echo hi > README.md' }, projectRoot)
    ).toContain('Blocked target: README.md');
    expect(
      getPlanModeBlockReason('bash', { command: 'mkdir scratch-output' }, projectRoot)
    ).toContain('Could not determine a safe target');
  });
});

describe('isAlwaysConfirmPath — system temp as safe scratchpad', () => {
  it('does NOT require confirmation for paths inside the system temp directory', () => {
    const projectRoot = createProjectRoot();
    const tempFile = path.join(os.tmpdir(), `kodax-test-${Date.now()}.txt`);
    expect(isAlwaysConfirmPath(tempFile, projectRoot)).toBe(false);
  });

  it('does NOT require confirmation for paths inside the project root', () => {
    const projectRoot = createProjectRoot();
    const projectFile = path.join(projectRoot, 'src', 'example.ts');
    expect(isAlwaysConfirmPath(projectFile, projectRoot)).toBe(false);
  });

  it('DOES require confirmation for paths outside both project and system temp', () => {
    const projectRoot = createProjectRoot();
    const homeFile = path.join(os.homedir(), 'Documents', 'other-project-file.ts');
    expect(isAlwaysConfirmPath(homeFile, projectRoot)).toBe(true);
  });

  it('DOES require confirmation for .kodax/ project config even inside project root', () => {
    const projectRoot = createProjectRoot();
    const kodaxFile = path.join(projectRoot, '.kodax', 'config.json');
    expect(isAlwaysConfirmPath(kodaxFile, projectRoot)).toBe(true);
  });

  it('DOES require confirmation for ~/.kodax user config', () => {
    const projectRoot = createProjectRoot();
    const userKodaxFile = path.join(os.homedir(), '.kodax', 'auth.json');
    expect(isAlwaysConfirmPath(userKodaxFile, projectRoot)).toBe(true);
  });

  it('bash commands writing to system temp are not flagged as protected', () => {
    const projectRoot = createProjectRoot();
    const tempFile = path.join(os.tmpdir(), `kodax-bash-${Date.now()}.txt`);
    // extractPathsFromCommand needs patterns it recognizes — use absolute path in arg
    expect(isCommandOnProtectedPath(`echo hi > "${tempFile}"`, projectRoot)).toBe(false);
  });

  it('bash commands writing outside project+temp are still flagged as protected', () => {
    const projectRoot = createProjectRoot();
    const outsideFile = path.join(os.homedir(), 'Documents', 'unrelated.txt');
    expect(isCommandOnProtectedPath(`echo hi > "${outsideFile}"`, projectRoot)).toBe(true);
  });
});

describe('direct shell syntax guardrails', () => {
  it('allows safe read-only exploration commands', () => {
    expect(getDirectShellBypassBlockReason('git status --short')).toBeNull();
    expect(getDirectShellBypassBlockReason('cd src && pwd')).toBeNull();
  });

  it('blocks write or shell-chaining commands outside the safe whitelist', () => {
    expect(getDirectShellBypassBlockReason('npm install')).toContain('safe read-only commands');
    expect(getDirectShellBypassBlockReason('echo hi > out.txt')).toContain('safe read-only commands');
  });
});

// Issue 129: pure read-only commands containing 2>NUL / 2>/dev/null fd-redirects,
// pipes between safe-read stages, or Windows-native search tools were misclassified
// as "Modify files" and forced confirmation in auto mode.
describe('isBashWriteCommand — fd-redirect to null device is not a write (Issue 129)', () => {
  it('does not flag stderr-discard 2>NUL (Windows null device)', () => {
    expect(isBashWriteCommand('findstr foo bar 2>NUL')).toBe(false);
    expect(isBashWriteCommand('findstr foo bar 2>nul')).toBe(false);
  });

  it('does not flag stderr-discard 2>/dev/null (POSIX null device)', () => {
    expect(isBashWriteCommand('ls 2>/dev/null')).toBe(false);
    expect(isBashWriteCommand('grep foo file 2>>/dev/null')).toBe(false);
  });

  it('does not flag combined-stream discard &>/dev/null', () => {
    expect(isBashWriteCommand('grep foo bar &>/dev/null')).toBe(false);
  });

  it('still flags real file writes (regression guard)', () => {
    expect(isBashWriteCommand('echo hi > out.txt')).toBe(true);
    expect(isBashWriteCommand('echo hi >> out.txt')).toBe(true);
    expect(isBashWriteCommand('cat foo > /tmp/x')).toBe(true);
  });

  it('still flags real writes that also contain a null-device redirect', () => {
    // 2>NUL stripped, but the > out.txt write must still be detected.
    expect(isBashWriteCommand('cmd 2>NUL > out.txt')).toBe(true);
  });
});

describe('isBashReadCommand — Windows search tools and pipe chains (Issue 129)', () => {
  it('treats findstr as a safe read command', () => {
    expect(isBashReadCommand('findstr foo file.txt')).toBe(true);
  });

  it('treats fc and where as safe read commands', () => {
    expect(isBashReadCommand('fc a.txt b.txt')).toBe(true);
    expect(isBashReadCommand('where node')).toBe(true);
  });

  it('allows pipe chains where every stage is a safe-read command', () => {
    expect(isBashReadCommand('findstr foo a.txt | findstr bar')).toBe(true);
    expect(isBashReadCommand('grep foo file | grep bar | wc -l')).toBe(true);
  });

  it('allows null-device fd-redirects inside read chains', () => {
    expect(isBashReadCommand('findstr foo a.txt 2>NUL | findstr bar')).toBe(true);
    expect(isBashReadCommand('grep foo file 2>/dev/null')).toBe(true);
  });

  it('allows the original Issue 129 reproduction command', () => {
    expect(
      isBashReadCommand(
        'cd C:\\Works\\claudecode && findstr /S /I /N "todos" src\\bootstrap\\state.ts 2>NUL | findstr /V "node_modules"',
      ),
    ).toBe(true);
  });

  it('rejects pipe chains where any stage is a write command (regression guard)', () => {
    expect(isBashReadCommand('ls | rm -rf /')).toBe(false);
    expect(isBashReadCommand('cat file | tee out.txt')).toBe(false);
  });

  it('rejects redirects to real files even with a read-only base command', () => {
    expect(isBashReadCommand('grep foo file > out.txt')).toBe(false);
  });
});

// FEATURE_152 (v0.7.38): the AST migration replaced regex strip-then-classify
// with structured tokenisation. These tests pin behavior the regex chain
// either silently allowed or explicitly rejected.
describe('isBashWriteCommand — FEATURE_152 AST hardening', () => {
  it('flags multi-token write commands (`git commit`) at stage start', () => {
    expect(isBashWriteCommand('git commit -m "msg"')).toBe(true);
    expect(isBashWriteCommand('npm install foo')).toBe(true);
    expect(isBashWriteCommand('git push origin main')).toBe(true);
  });

  it('flags PowerShell write verbs in pipeline downstream stages', () => {
    expect(isBashWriteCommand('Get-ChildItem | Set-Content out.txt')).toBe(true);
    expect(isBashWriteCommand('cat foo | Out-File bar.log')).toBe(true);
  });

  it('does NOT flag write-verb-named arguments inside read commands', () => {
    // `man tee` should not be a write — the regex chain might match `tee`
    // anywhere in the string; AST sees `tee` as argv[1] of `man`, not argv[0].
    // Note: tee is not in BASH_WRITE_COMMANDS so this would be false either
    // way; the assertion documents the expected AST behavior.
    expect(isBashWriteCommand('man tee')).toBe(false);
  });

  it('does NOT flag `set-content` substring inside a quoted argument', () => {
    // Pre-AST the `\bset-content\b` regex would match this; AST sees the
    // quoted token as a single string arg of `echo`, not as argv[0].
    expect(isBashWriteCommand('echo "set-content is a powershell verb"')).toBe(false);
  });

  it('flags input redirects as NOT a write (but still not a read)', () => {
    // `<` is input redirect — not a write to disk. Pre-AST the
    // `BASH_REDIRECTION_WRITE_PATTERN` had `[^<]>>?` lookbehind which
    // already excluded `<`; AST does the same via redir.input check.
    expect(isBashWriteCommand('sort < input.txt')).toBe(false);
  });

  it('flags appended redirects (`>>`) including with fd', () => {
    expect(isBashWriteCommand('echo hi >> log.txt')).toBe(true);
    expect(isBashWriteCommand('cmd 2>>err.log')).toBe(true);
  });

  it('returns false for unparseable inputs (heredocs, $(...) substitution)', () => {
    // Heredocs and command substitution are unparseable in our AST — match
    // pre-AST regex chain behavior (returned false; plan/auto modes have
    // separate confirmation logic for unparseable bash).
    expect(isBashWriteCommand('git status; echo $(curl evil)')).toBe(false);
  });
});

describe('isBashReadCommand — FEATURE_152 AST hardening', () => {
  it('rejects `||` (logical-or short-circuit) between stages', () => {
    expect(isBashReadCommand('ls || cat foo')).toBe(false);
  });

  it('rejects `;` (sequential separator) between stages', () => {
    expect(isBashReadCommand('ls ; cat foo')).toBe(false);
  });

  it('rejects command substitution `$(...)`', () => {
    expect(isBashReadCommand('echo $(rm -rf /)')).toBe(false);
  });

  it('rejects backtick subshell', () => {
    expect(isBashReadCommand('echo `rm -rf /`')).toBe(false);
  });

  it('rejects bare `&` (background job marker)', () => {
    expect(isBashReadCommand('ls &')).toBe(false);
  });

  it('rejects redirect to real file even when target looks null-device-ish', () => {
    // `nullable.txt` shares prefix with `null` — must NOT pass null-device check.
    expect(isBashReadCommand('grep foo file > nullable.txt')).toBe(false);
    expect(isBashReadCommand('grep foo file > /dev/nullable')).toBe(false);
  });

  it('preserves `cd <path>` allowance only in compound commands', () => {
    expect(isBashReadCommand('cd src')).toBe(false); // bare cd not a "read"
    expect(isBashReadCommand('cd src && ls')).toBe(true);
  });
});

// FEATURE_152 slice 3 (v0.7.38): collectBashWriteTargets / extractPathsFromCommand
// switched from regex-soup to AST. The AST version replaces four overlapping
// regex sweeps with structural traversal, eliminating substring-vs-token
// false positives while preserving plan-mode coverage.
//
// Imports needed at the top of the file are already in place — these tests
// exercise the public API used by plan-mode and isCommandOnProtectedPath.
describe('collectBashWriteTargets — FEATURE_152 AST hardening', () => {
  it('extracts `>` redirect targets across statements + stages', async () => {
    const { collectBashWriteTargets } = await import('./permission.js');
    const targets = collectBashWriteTargets('echo hi > out.txt && cat foo > out2.txt');
    expect(targets).toContain('out.txt');
    expect(targets).toContain('out2.txt');
  });

  it('extracts tee target from pipeline stage 2', async () => {
    const { collectBashWriteTargets } = await import('./permission.js');
    const targets = collectBashWriteTargets('cat foo | tee /tmp/out');
    expect(targets).toContain('/tmp/out');
  });

  it('does NOT match `tee` as a substring inside another argv token', async () => {
    // Pre-AST `\btee\b` regex would match `committee.txt`-ish tokens at word
    // boundaries in some inputs. AST sees argv[0]='cat', argv[1]='committee.txt'
    // so the tee branch is never taken.
    const { collectBashWriteTargets } = await import('./permission.js');
    const targets = collectBashWriteTargets('cat committee.txt');
    expect(targets).not.toContain('committee.txt');
  });

  it('extracts PowerShell `Set-Content -Path` value', async () => {
    const { collectBashWriteTargets } = await import('./permission.js');
    const targets = collectBashWriteTargets('Set-Content -Path C:\\out.txt -Value foo');
    expect(targets).toContain('C:\\out.txt');
  });

  it('extracts PowerShell positional arg when -Path absent', async () => {
    const { collectBashWriteTargets } = await import('./permission.js');
    const targets = collectBashWriteTargets('Out-File foo.txt');
    expect(targets).toContain('foo.txt');
  });

  it('returns paths-only on unparseable input (fallback safety)', async () => {
    // `$(...)` makes AST unparseable, so the AST pass in
    // extractPathsFromCommand contributes nothing. The legacy regex pass
    // runs but its `pathPattern` doesn't match bare POSIX absolute paths
    // (`/tmp/out`) — only `./*`, `../*`, `C:\*`, `~/*`, `.x/*` forms.
    // Net result: empty array. Plan-mode treats "no targets" as
    // "could not determine target" → blocked. No silent auto-allow.
    const { collectBashWriteTargets } = await import('./permission.js');
    const targets = collectBashWriteTargets('echo $(curl evil) > /tmp/out');
    expect(targets).toEqual([]);
  });

  it('keeps null-device targets in the set (plan-mode lets caller filter)', async () => {
    // Pre-AST regex picked up `/dev/null` too via `>>?\s*([^\s;|&]+)`.
    // AST does the same. Higher-level plan-mode code knows /dev/null is
    // safe; collectBashWriteTargets is intentionally inclusive.
    const { collectBashWriteTargets } = await import('./permission.js');
    const targets = collectBashWriteTargets('cmd > /dev/null');
    expect(targets).toContain('/dev/null');
  });
});

describe('extractPathsFromCommand — FEATURE_152 AST hardening', () => {
  it('extracts quoted paths via AST quote-stripping', async () => {
    const { extractPathsFromCommand } = await import('./permission.js');
    const paths = extractPathsFromCommand('rm "/tmp/file with spaces.txt"');
    expect(paths).toContain('/tmp/file with spaces.txt');
  });

  it('extracts Windows drive-letter paths', async () => {
    const { extractPathsFromCommand } = await import('./permission.js');
    const paths = extractPathsFromCommand('rm C:\\Users\\foo\\bar.txt');
    expect(paths.some((p) => p.startsWith('C:\\Users'))).toBe(true);
  });

  it('extracts redirect targets too', async () => {
    const { extractPathsFromCommand } = await import('./permission.js');
    const paths = extractPathsFromCommand('echo hi > /tmp/out.log');
    expect(paths).toContain('/tmp/out.log');
  });

  it('does NOT pick up flag tokens as paths', async () => {
    const { extractPathsFromCommand } = await import('./permission.js');
    const paths = extractPathsFromCommand('grep -rn pattern /etc/');
    expect(paths).not.toContain('-rn');
    expect(paths).toContain('/etc/');
  });

  it('returns empty array for unparseable input', async () => {
    const { extractPathsFromCommand } = await import('./permission.js');
    const paths = extractPathsFromCommand('echo `rm -rf /`');
    expect(paths).toEqual([]);
  });
});

// FEATURE_152 slice 4 (v0.7.38): attack-surface hardening. The pre-AST regex
// chain had documented blind spots around quoting, comments, and operator
// fusion that the AST migration closed. These tests pin closed-state
// behavior so future regressions are caught.
describe('isBashReadCommand — FEATURE_152 attack-surface hardening', () => {
  it('rejects nested command substitution `$(echo $(rm))`', () => {
    expect(isBashReadCommand('echo $(echo $(rm -rf /))')).toBe(false);
  });

  it('rejects backticks inside quoted strings', () => {
    // Backticks inside double-quoted strings still expand in bash. AST
    // pre-tokenisation guard catches this regardless of quoting.
    expect(isBashReadCommand('echo "test `whoami`"')).toBe(false);
  });

  it('rejects append-redirect to real files', () => {
    expect(isBashReadCommand('grep foo file >> log.txt')).toBe(false);
  });

  it('rejects fd-redirect to real files', () => {
    expect(isBashReadCommand('grep foo file 2>err.log')).toBe(false);
  });

  it('treats `&>` real file redirect as not-read', () => {
    expect(isBashReadCommand('cmd &> output.log')).toBe(false);
  });

  it('rejects herestring `<<<`', () => {
    // Herestring is an input redirect form; rejected as input.
    expect(isBashReadCommand('cat <<< "string"')).toBe(false);
  });

  it('preserves Issue 129 reproduction command exactly', () => {
    expect(
      isBashReadCommand(
        'cd C:\\Works\\claudecode && findstr /S /I /N "todos" src\\bootstrap\\state.ts 2>NUL | findstr /V "node_modules"',
      ),
    ).toBe(true);
  });
});

describe('isBashWriteCommand — FEATURE_152 attack-surface hardening', () => {
  it('flags rm even buried inside a compound', () => {
    // `cmd && rm foo` — rm is argv[0] of stage 2 of statement 2.
    expect(isBashWriteCommand('echo hi && rm foo.txt')).toBe(true);
  });

  it('flags pipeline-downstream rm', () => {
    // `cat foo | rm bar` — rm is argv[0] of stage 2 even though pipeline
    // semantically doesn't reach rm. AST treats every stage uniformly,
    // which is conservative + correct.
    expect(isBashWriteCommand('cat foo | rm bar')).toBe(true);
  });

  it('does NOT flag rm-as-argument (`man rm`)', () => {
    // Pre-AST regex `(^|[|&;><])rm(\s|$)` would NOT match here either
    // (rm is preceded by a space, not a separator). AST sees argv[0]=man.
    // Pin the behavior either way.
    expect(isBashWriteCommand('man rm')).toBe(false);
  });

  it('does NOT flag write verb inside double-quoted argument', () => {
    expect(isBashWriteCommand('echo "I will rm everything"')).toBe(false);
  });

  it('does NOT flag write verb inside single-quoted argument', () => {
    expect(isBashWriteCommand("echo 'rm bar'")).toBe(false);
  });

  it('flags Remove-Item appearing as stage 2 of a pipeline', () => {
    // PowerShell pipeline form. Remove-Item is in POWERSHELL_WRITE_TOKENS.
    expect(isBashWriteCommand('Get-ChildItem | Remove-Item')).toBe(true);
  });

  it('flags Out-File even when invoked with -FilePath instead of -Path', () => {
    // -FilePath is an Out-File-specific alias. Our collectPowerShellWriteTargets
    // recognises -Path / -LiteralPath / -Destination explicitly; -FilePath
    // is treated as a flag and the first positional becomes the target.
    // The write-detection itself only needs argv[0] match → still flags.
    expect(isBashWriteCommand('Get-Content foo | Out-File -FilePath bar.txt')).toBe(true);
  });

  it('does NOT flag path-qualified custom executables (`~/myrm foo`) — known gap, delegated to LLM classifier', () => {
    // Documents an acknowledged limitation: BASH_WRITE_COMMANDS is keyed on
    // bare verb names (`rm`, `git commit`, etc.). A path-qualified executable
    // (`~/myrm`, `./scripts/delete-everything.sh`, `/usr/local/bin/myrm`) is
    // not recognised as a write at this layer.
    //
    // Why this is acceptable: KodaX is a single-user CLI (trust boundary
    // user↔agent), the agent generates command text programmatically, and
    // the FEATURE_092 auto-mode LLM classifier is the upstream gate that
    // sees the full command string with semantic context. This rule-layer
    // function is "known write patterns", not "anything that could write".
    //
    // If this becomes a real issue (3+ user reports of path-qualified write
    // tools sneaking past), revisit by adding `path.basename(argv[0])` to
    // the BASH_WRITE_COMMANDS lookup. Don't add ad-hoc patches before then.
    expect(isBashWriteCommand('~/myrm foo')).toBe(false);
    expect(isBashWriteCommand('./scripts/delete-everything.sh')).toBe(false);
    expect(isBashWriteCommand('/usr/local/bin/myrm bar')).toBe(false);
  });
});

// FEATURE_154: universal `--help` fast-path (parity with Claude Code
// `commands.ts:isHelpCommand`). Pre-FEATURE_154 KodaX only allowed `--help`
// for ~12 hard-coded language tools; this generalises to any command name
// to bypass the LLM classifier on unconditionally safe help queries.
describe('isHelpCommand — universal --help fast-path (FEATURE_154)', () => {
  it('accepts simple `cmd --help` for arbitrary commands', () => {
    expect(isHelpCommand('python --help')).toBe(true);
    expect(isHelpCommand('node --help')).toBe(true);
    expect(isHelpCommand('docker --help')).toBe(true);
    expect(isHelpCommand('kubectl --help')).toBe(true);
    expect(isHelpCommand('terraform --help')).toBe(true);
  });

  it('accepts `cmd subcmd ... --help` patterns with multiple alphanumeric tokens', () => {
    expect(isHelpCommand('git log --help')).toBe(true);
    expect(isHelpCommand('npm run --help')).toBe(true);
    expect(isHelpCommand('docker container ls --help')).toBe(true);
    expect(isHelpCommand('kubectl get pods --help')).toBe(true);
  });

  it('handles surrounding and inter-token whitespace', () => {
    expect(isHelpCommand('  python --help  ')).toBe(true);
    expect(isHelpCommand('python  --help')).toBe(true);
    expect(isHelpCommand('\tpython\t--help\n')).toBe(true);
  });

  it('rejects commands containing quotes (potential injection bypass)', () => {
    expect(isHelpCommand("python -c 'evil()' --help")).toBe(false);
    expect(isHelpCommand('node -e "evil" --help')).toBe(false);
    expect(isHelpCommand('echo "hi" --help')).toBe(false);
  });

  it('rejects flags other than --help', () => {
    expect(isHelpCommand('python --help --version')).toBe(false);
    expect(isHelpCommand('python -c script --help')).toBe(false);
    expect(isHelpCommand('node --no-warnings --help')).toBe(false);
    expect(isHelpCommand('git -C /repo log --help')).toBe(false);
  });

  it('rejects non-alphanumeric non-flag tokens (paths, dotted, env vars, shell ops)', () => {
    expect(isHelpCommand('./bin/foo --help')).toBe(false);
    expect(isHelpCommand('/usr/bin/python --help')).toBe(false);
    expect(isHelpCommand('python script.js --help')).toBe(false);
    expect(isHelpCommand('foo $VAR --help')).toBe(false);
    expect(isHelpCommand('foo bar* --help')).toBe(false);
    expect(isHelpCommand('python --help && rm')).toBe(false);
  });

  it('rejects commands not ending with --help', () => {
    expect(isHelpCommand('python -h')).toBe(false);
    expect(isHelpCommand('python --version')).toBe(false);
    expect(isHelpCommand('python --help && ls')).toBe(false);
    expect(isHelpCommand('python --help | grep usage')).toBe(false);
    expect(isHelpCommand('--help python')).toBe(false);
  });

  it('rejects empty / whitespace-only input', () => {
    expect(isHelpCommand('')).toBe(false);
    expect(isHelpCommand('   ')).toBe(false);
    expect(isHelpCommand('--help')).toBe(true); // bare `--help` allowed (matches CC)
  });

  it('integrates into isBashReadCommand for arbitrary command names', () => {
    // Pre-FEATURE_154, only the 12 hard-coded language tools (node/npm/python/etc.)
    // could pass `--help` through the safe-read whitelist. Now any command can.
    expect(isBashReadCommand('docker --help')).toBe(true);
    expect(isBashReadCommand('kubectl --help')).toBe(true);
    expect(isBashReadCommand('terraform --help')).toBe(true);
    expect(isBashReadCommand('git status --help')).toBe(true);
  });

  it('preserves language-tools --help (no regression)', () => {
    expect(isBashReadCommand('python --help')).toBe(true);
    expect(isBashReadCommand('node --help')).toBe(true);
    expect(isBashReadCommand('npm --help')).toBe(true);
  });

  it('preserves language-tools script-execution blocking (no regression)', () => {
    // The languageTools branch in isSingleBashReadCommand still blocks scripts
    // for these tools. FEATURE_154 only bypasses the parser for *--help* form.
    expect(isBashReadCommand('node script.js')).toBe(false);
    expect(isBashReadCommand('npm install foo')).toBe(false);
    expect(isBashReadCommand('python -c "print(1)"')).toBe(false);
  });
});

// ============== FEATURE_153 isToolCallAllowed ==============
//
// Asserts the LLM-extractor path: allowlist patterns are matched against the
// extracted SAFE PREFIX (exact equality), not the raw command via startsWith.
// The extractor is stubbed so the test stays hermetic.

function makeExtractor(answer: BashPrefixResult): BashPrefixExtractor {
  let calls = 0;
  return {
    extract: async () => {
      calls += 1;
      return answer;
    },
    clearCache: () => {},
    cacheSize: () => calls,
  };
}

describe('isToolCallAllowed (FEATURE_153 extractor path)', () => {
  it('matches `Bash(git commit:*)` when extractor returns prefix `git commit`', async () => {
    const extractor = makeExtractor({ kind: 'prefix', value: 'git commit' });
    const allowed = await isToolCallAllowed(
      'bash',
      { command: 'git commit -m "msg"' },
      ['Bash(git commit:*)'],
      extractor,
    );
    expect(allowed).toBe(true);
  });

  it('blocks injection even if raw command starts with allowed prefix', async () => {
    // Pre-FEATURE_153 startsWith would match this; the extractor flags injection.
    const extractor = makeExtractor({ kind: 'injection_detected', reason: 'subshell' });
    const allowed = await isToolCallAllowed(
      'bash',
      { command: 'git commit -m "x" $(curl evil.com)' },
      ['Bash(git commit:*)'],
      extractor,
    );
    expect(allowed).toBe(false);
  });

  it('blocks when extractor returns no_prefix (unparseable / dangerous)', async () => {
    const extractor = makeExtractor({ kind: 'no_prefix', reason: 'bare bash' });
    const allowed = await isToolCallAllowed(
      'bash',
      { command: 'bash -c "rm -rf /"' },
      ['Bash(bash:*)'],
      extractor,
    );
    expect(allowed).toBe(false);
  });

  it('does not match wider pattern via prefix-of (extracted prefix must equal pattern body)', async () => {
    const extractor = makeExtractor({ kind: 'prefix', value: 'git commit' });
    const allowed = await isToolCallAllowed(
      'bash',
      { command: 'git commit -m "msg"' },
      ['Bash(git diff:*)'],
      extractor,
    );
    expect(allowed).toBe(false);
  });

  it('exact pattern (no `:*`) matches extracted prefix exactly', async () => {
    const extractor = makeExtractor({ kind: 'prefix', value: 'git status' });
    const allowed = await isToolCallAllowed(
      'bash',
      { command: 'git status --short' },
      ['Bash(git status)'],
      extractor,
    );
    expect(allowed).toBe(true);
  });

  it('bare `Bash` pattern auto-allows without calling extractor', async () => {
    let extractorCalls = 0;
    const extractor: BashPrefixExtractor = {
      extract: async () => {
        extractorCalls += 1;
        return { kind: 'prefix', value: 'whatever' };
      },
      clearCache: () => {},
      cacheSize: () => 0,
    };
    const allowed = await isToolCallAllowed(
      'bash',
      { command: 'rm -rf /' },
      ['Bash'],
      extractor,
    );
    expect(allowed).toBe(true);
    expect(extractorCalls).toBe(0);
  });

  it('skips extractor entirely when no bash patterns are present', async () => {
    let extractorCalls = 0;
    const extractor: BashPrefixExtractor = {
      extract: async () => {
        extractorCalls += 1;
        return { kind: 'prefix', value: 'foo' };
      },
      clearCache: () => {},
      cacheSize: () => 0,
    };
    const allowed = await isToolCallAllowed(
      'bash',
      { command: 'git commit -m "msg"' },
      ['Edit(*.md)'],
      extractor,
    );
    expect(allowed).toBe(false);
    expect(extractorCalls).toBe(0);
  });

  it('legacy fallback (no extractor) preserves startsWith semantics', async () => {
    const allowed = await isToolCallAllowed(
      'bash',
      { command: 'git commit -m "msg"' },
      ['Bash(git commit:*)'],
    );
    expect(allowed).toBe(true);
  });

  it('rejects "*" pattern even when extracted prefix is non-empty (defence-in-depth)', async () => {
    const extractor = makeExtractor({ kind: 'prefix', value: 'ls' });
    const allowed = await isToolCallAllowed(
      'bash',
      { command: 'ls -la' },
      ['Bash(*)'],
      extractor,
    );
    expect(allowed).toBe(false);
  });

  it('fails closed on extractor throw (timeout / network / abort) — falls through to confirmation', async () => {
    // The extractor module throws on transient failures so its LRU cache
    // can evict the failed slot. isToolCallAllowed must catch and return
    // false so the caller falls through to the user confirmation prompt
    // instead of letting the rejection bubble into the tool-exec loop.
    const throwingExtractor: BashPrefixExtractor = {
      extract: async () => {
        throw new Error('extractCommandPrefix timeout (8000ms)');
      },
      clearCache: () => {},
      cacheSize: () => 0,
    };
    const allowed = await isToolCallAllowed(
      'bash',
      { command: 'git commit -m "msg"' },
      ['Bash(git commit:*)'],
      throwingExtractor,
    );
    expect(allowed).toBe(false);
  });
});

// ============== FEATURE_158 — Issue 131 structural fix ==============
//
// Issue 131: Windows cmd.exe flag tokens like `/R`, `/B`, `/Y`, `/A:H`
// were misclassified by looksLikePath as POSIX absolute paths,
// causing path.resolve('/R') → 'C:\R' (an outside-project, non-temp
// path) which triggered isAlwaysConfirmPath → "Protected path" confirm.
//
// Fix: process.platform === 'win32' branch in looksLikePath rejects
// tokens shaped `/[A-Za-z][A-Za-z0-9]*(:[A-Za-z0-9]+)?` with no further
// `/` or `\` separators. POSIX behavior unchanged.
//
// Also: expanded BASH_SAFE_READ_COMMANDS with `git tag` / `git stash list`
// / `git describe` / `git config --get` so the original repro
// (`git tag --sort=-creatordate | findstr /R "v[0-9]"`) takes the
// bash-read fast-path instead of any later guardrail step.

describe('FEATURE_158 — Issue 131 Windows-flag false-positive regression', () => {
  it.runIf(process.platform === 'win32')(
    'does NOT extract `/R` as a path on Windows (findstr flag)',
    async () => {
      const { extractPathsFromCommand } = await import('./permission.js');
      const paths = extractPathsFromCommand('findstr /R "v[0-9]" file.txt');
      expect(paths).not.toContain('/R');
    },
  );

  it.runIf(process.platform === 'win32').each([
    ['dir /B', '/B'],
    ['xcopy src dst /Y', '/Y'],
    ['where /R . node.exe', '/R'],
    ['fc /B a.bin b.bin', '/B'],
    ['robocopy src dst /MIR', '/MIR'],
    ['findstr /A:H pattern file', '/A:H'],
    ['findstr /I /S "needle" *.ts', '/I'],
  ])('does NOT extract flag-shape token from %s', async (cmd, flag) => {
    const { extractPathsFromCommand } = await import('./permission.js');
    const paths = extractPathsFromCommand(cmd);
    expect(paths).not.toContain(flag);
  });

  it.runIf(process.platform === 'win32')(
    'still extracts real POSIX-style paths even on Windows (e.g. `/etc/hosts`)',
    async () => {
      const { extractPathsFromCommand } = await import('./permission.js');
      // Real path with further separators after leading `/` — not a flag shape.
      const paths = extractPathsFromCommand('grep -r pattern /etc/hosts');
      expect(paths).toContain('/etc/hosts');
    },
  );

  it.runIf(process.platform !== 'win32')(
    'POSIX behavior unchanged: `/R` still treated as path on Linux/macOS',
    async () => {
      const { extractPathsFromCommand } = await import('./permission.js');
      // On POSIX, `/R` is a valid (if unusual) absolute path token.
      // Behavior must remain identical to pre-FEATURE_158.
      const paths = extractPathsFromCommand('findstr /R "v[0-9]" file.txt');
      expect(paths).toContain('/R');
    },
  );

  it.runIf(process.platform === 'win32')(
    'isCommandOnProtectedPath returns false for the original Issue 131 repro (when cwd === projectRoot)',
    async () => {
      // The original Issue 131 reproduction runs from the user's project
      // root, so the relative token `v[0-9]` (extracted from quoted
      // `"v[0-9]"` by legacyRegexPathScan) resolves INSIDE the project
      // root via path.resolve. With the looksLikePath /R fix, the only
      // remaining candidate is the quoted regex pattern — which is in
      // project and therefore not protected.
      const root = process.cwd();
      const cmd = 'git tag --sort=-creatordate | findstr /R "v[0-9]"';
      expect(isCommandOnProtectedPath(cmd, root)).toBe(false);
    },
  );

  it.runIf(process.platform === 'win32')(
    'isCommandOnProtectedPath: `/R` alone (the headline bug) no longer triggers',
    async () => {
      // Strip the quoted regex pattern that legacyRegexPathScan over-eagerly
      // captures; this verifies the actual looksLikePath fix in isolation.
      const root = process.cwd();
      const cmd = 'findstr /R needle file.txt';
      expect(isCommandOnProtectedPath(cmd, root)).toBe(false);
    },
  );
});

describe('FEATURE_158 — BASH_SAFE_READ_COMMANDS expansion', () => {
  it.each([
    ['git tag', true],
    ['git tag --sort=-creatordate', true],
    ['git stash list', true],
    ['git stash list --pretty=format:%gd', true],
    ['git describe', true],
    ['git describe --tags HEAD', true],
    ['git config --get user.email', true],
    ['git config --get-all user.email', false], // --get-all is NOT in whitelist (only --get)
    ['git stash pop', false], // write
    ['git stash push', false], // write
    ['git config user.email "x@y"', false], // bare git config is write-capable
    ['git tag -a v1.0 -m msg', true], // starts with `git tag` so it's a prefix match — known limitation
  ])('isBashReadCommand("%s") = %s', (cmd, expected) => {
    // Note: BASH_SAFE_READ_COMMANDS uses prefix-startsWith matching, so
    // `git tag -a v1.0` matches `git tag` whitelist entry. This is
    // accepted: `git tag` writes a new tag but it's still a low-risk
    // local operation that auto-mode would historically allow. Tier 2
    // LLM classifier (FEATURE_092) can still review if needed.
    expect(isBashReadCommand(cmd)).toBe(expected);
  });

  it('git tag piped to findstr (Issue 131 user-reported command) takes bash-read fast-path', () => {
    // This is the exact command from the user-reported regression.
    // Result: fast-path bypass — no guardrail step ever runs.
    expect(isBashReadCommand('git tag --sort=-creatordate | findstr /R "v[0-9]"')).toBe(true);
  });
});
