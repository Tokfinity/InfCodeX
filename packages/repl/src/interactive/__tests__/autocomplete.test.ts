import { describe, expect, it } from 'vitest';
import { CommandCompleter, FileCompleter } from '../autocomplete.js';

describe('CommandCompleter boundaries', () => {
  const completer = new CommandCompleter();

  it('triggers at line start and after whitespace', () => {
    expect(completer.canComplete('/help', 5)).toBe(true);
    expect(completer.canComplete('hello /help', 11)).toBe(true);
    expect(completer.canComplete('hello\n/help', 11)).toBe(true);
    expect(completer.canComplete('hello\t/help', 11)).toBe(true);
  });

  it('does not trigger inside non-whitespace-delimited text', () => {
    expect(completer.canComplete('https://example.com', 19)).toBe(false);
    expect(completer.canComplete('foo/help', 8)).toBe(false);
  });
});

describe('FileCompleter boundaries', () => {
  const completer = new FileCompleter();

  it('triggers at line start and after whitespace', () => {
    expect(completer.canComplete('@src', 4)).toBe(true);
    expect(completer.canComplete('hello @src', 10)).toBe(true);
    expect(completer.canComplete('hello\n@src', 10)).toBe(true);
    expect(completer.canComplete('hello\t@src', 10)).toBe(true);
  });

  it('does not trigger inside email-like text', () => {
    expect(completer.canComplete('name@example.com', 16)).toBe(false);
    expect(completer.canComplete('foo@src', 7)).toBe(false);
  });
});
