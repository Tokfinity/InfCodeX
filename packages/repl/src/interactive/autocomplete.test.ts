import { describe, expect, it } from 'vitest';
import { CommandCompleter, FileCompleter } from './autocomplete.js';
import { getCommandRegistry } from './commands.js';

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

  it('includes newly registered builtin commands', async () => {
    const completions = await completer.getCompletions('/n', 2);
    expect(completions.some((item) => item.display === '/new')).toBe(true);
  });

  it('refreshes command completions after runtime registration', async () => {
    const registry = getCommandRegistry();
    registry.unregister('deploy');

    registry.register({
      name: 'deploy',
      aliases: ['dep'],
      description: 'Deploy the current project',
      source: 'extension',
      handler: async () => {},
    });

    try {
      const completions = await completer.getCompletions('/dep', 4);
      expect(completions.some((item) => item.display === '/deploy')).toBe(true);
      expect(completions.some((item) => item.display === '/dep')).toBe(true);
    } finally {
      registry.unregister('deploy');
    }
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
