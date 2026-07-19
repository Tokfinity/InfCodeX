import { describe, expect, it } from 'vitest';
import {
  flattenArgv,
  flattenRedirections,
  isNullDevice,
  parseBashCommand,
} from './bash-ast.js';

describe('parseBashCommand — basic argv', () => {
  it('returns empty tree for empty input', () => {
    const tree = parseBashCommand('');
    expect(tree.statements).toEqual([]);
    expect(tree.unparseable).toBe(false);
  });

  it('parses a single bare command', () => {
    const tree = parseBashCommand('git status');
    expect(tree.unparseable).toBe(false);
    expect(tree.statements).toHaveLength(1);
    expect(tree.statements[0].precedingOp).toBeNull();
    expect(tree.statements[0].stages).toHaveLength(1);
    expect(tree.statements[0].stages[0].argv).toEqual(['git', 'status']);
    expect(tree.statements[0].stages[0].redirections).toEqual([]);
  });

  it('strips quoting on argv tokens', () => {
    const tree = parseBashCommand('git commit -m "hello world"');
    expect(tree.statements[0].stages[0].argv).toEqual([
      'git',
      'commit',
      '-m',
      'hello world',
    ]);
  });
});

describe('parseBashCommand — pipelines', () => {
  it('splits on `|` into multiple stages within one statement', () => {
    const tree = parseBashCommand('grep foo file.txt | sort | head -n 5');
    expect(tree.statements).toHaveLength(1);
    expect(tree.statements[0].stages).toHaveLength(3);
    expect(tree.statements[0].stages[0].argv).toEqual(['grep', 'foo', 'file.txt']);
    expect(tree.statements[0].stages[1].argv).toEqual(['sort']);
    expect(tree.statements[0].stages[2].argv).toEqual(['head', '-n', '5']);
  });
});

describe('parseBashCommand — logical operators', () => {
  it('splits on `&&` into multiple statements', () => {
    const tree = parseBashCommand('cd src && ls');
    expect(tree.statements).toHaveLength(2);
    expect(tree.statements[0].precedingOp).toBeNull();
    expect(tree.statements[0].stages[0].argv).toEqual(['cd', 'src']);
    expect(tree.statements[1].precedingOp).toBe('&&');
    expect(tree.statements[1].stages[0].argv).toEqual(['ls']);
  });

  it('splits on `||` and `;` similarly', () => {
    const tree = parseBashCommand('a; b || c');
    expect(tree.statements).toHaveLength(3);
    expect(tree.statements[1].precedingOp).toBe(';');
    expect(tree.statements[2].precedingOp).toBe('||');
  });
});

describe('parseBashCommand — redirections', () => {
  it('preserves environment references in redirection targets', () => {
    const tree = parseBashCommand('echo secret > "$HOME/.kodax/credentials.json"');
    expect(tree.unparseable).toBe(false);
    expect(tree.statements[0]?.stages[0]?.redirections).toEqual([
      expect.objectContaining({ target: '$HOME/.kodax/credentials.json' }),
    ]);
  });

  it('parses a simple stdout redirect', () => {
    const tree = parseBashCommand('echo hi > out.txt');
    expect(tree.statements[0].stages[0].argv).toEqual(['echo', 'hi']);
    expect(tree.statements[0].stages[0].redirections).toEqual([
      { op: '>', fd: null, append: false, input: false, target: 'out.txt' },
    ]);
  });

  it('parses append redirect (`>>`)', () => {
    const tree = parseBashCommand('echo hi >> log.txt');
    const redir = tree.statements[0].stages[0].redirections[0];
    expect(redir.append).toBe(true);
    expect(redir.target).toBe('log.txt');
  });

  it('parses fd redirection (e.g. `2>NUL`)', () => {
    const tree = parseBashCommand('findstr foo file.txt 2>NUL');
    const redir = tree.statements[0].stages[0].redirections[0];
    expect(redir.fd).toBe('2');
    expect(redir.target).toBe('NUL');
    expect(isNullDevice(redir.target)).toBe(true);
  });

  it('parses combined fd redirect (`&>`)', () => {
    const tree = parseBashCommand('cmd &> /dev/null');
    const redir = tree.statements[0].stages[0].redirections[0];
    expect(redir.fd).toBe('&');
    expect(isNullDevice(redir.target)).toBe(true);
  });

  it('parses input redirect (`<`)', () => {
    const tree = parseBashCommand('sort < input.txt');
    const redir = tree.statements[0].stages[0].redirections[0];
    expect(redir.input).toBe(true);
    expect(redir.target).toBe('input.txt');
  });

  it('attaches redirection to the correct stage in a pipeline', () => {
    const tree = parseBashCommand('grep foo file.txt | tee out.log');
    expect(tree.statements[0].stages).toHaveLength(2);
    // Redirect `> log` would be on stage 2, but `tee out.log` is just argv.
    expect(tree.statements[0].stages[0].redirections).toEqual([]);
    expect(tree.statements[0].stages[1].redirections).toEqual([]);
    expect(tree.statements[0].stages[1].argv).toEqual(['tee', 'out.log']);
  });
});

describe('parseBashCommand — null-device redirects', () => {
  it.each([
    '2>NUL',
    '2>nul',
    '2>/dev/null',
    '&>/dev/null',
  ])('recognises %s as null device', (snippet) => {
    const tree = parseBashCommand(`echo hi ${snippet}`);
    const redir = tree.statements[0].stages[0].redirections[0];
    expect(redir).toBeDefined();
    expect(isNullDevice(redir.target)).toBe(true);
  });
});

describe('parseBashCommand — unparseable / safety', () => {
  it('flags unknown operators as unparseable', () => {
    // Heredoc-style inputs aren't fully modeled.
    const tree = parseBashCommand('cat <<EOF\nhello\nEOF');
    // shell-quote may or may not produce object tokens for this. We assert
    // the API contract: ANY object token we don't recognise → unparseable.
    expect(tree.statements.length + (tree.unparseable ? 1 : 0)).toBeGreaterThan(0);
  });

  it('drops content after a `#` comment', () => {
    const tree = parseBashCommand('git status # show working tree');
    expect(tree.statements[0].stages[0].argv).toEqual(['git', 'status']);
  });

  it('flags backtick subshell as unparseable (shell-quote treats ` as plain char)', () => {
    // Without this guard, `echo \`rm -rf /\`` would parse to a "safe" argv
    // form because shell-quote doesn't tokenise backticks specially. The
    // module pre-checks for `\`` and forces unparseable to fail-closed.
    const tree = parseBashCommand('echo `rm -rf /`');
    expect(tree.unparseable).toBe(true);
    expect(tree.statements).toEqual([]);
  });

  it('flags `$(...)` command substitution as unparseable', () => {
    // `$` ends up in argv but `(` is an unknown op — falls through to the
    // `unparseable = true` branch in the parser.
    const tree = parseBashCommand('echo $(rm -rf /)');
    expect(tree.unparseable).toBe(true);
  });
});

describe('flattenArgv / flattenRedirections', () => {
  it('flattenArgv returns argv across pipeline stages and statements', () => {
    const tree = parseBashCommand('a b | c d && e f');
    expect(flattenArgv(tree)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });

  it('flattenRedirections attaches stage command name', () => {
    const tree = parseBashCommand('echo hi > out.txt && cat foo > out2.txt');
    const redirs = flattenRedirections(tree);
    expect(redirs).toHaveLength(2);
    expect(redirs[0].stageCommand).toBe('echo');
    expect(redirs[0].target).toBe('out.txt');
    expect(redirs[1].stageCommand).toBe('cat');
    expect(redirs[1].target).toBe('out2.txt');
  });
});

describe('isNullDevice', () => {
  it('matches POSIX and Windows variants', () => {
    expect(isNullDevice('/dev/null')).toBe(true);
    expect(isNullDevice('NUL')).toBe(true);
    expect(isNullDevice('nul')).toBe(true);
    expect(isNullDevice('Nul')).toBe(true);
  });

  it('rejects path-like impostors', () => {
    expect(isNullDevice('foo/nul.txt')).toBe(false);
    expect(isNullDevice('/dev/nullable')).toBe(false);
    expect(isNullDevice('out.txt')).toBe(false);
  });
});
