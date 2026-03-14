import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILTIN_COMMANDS, getCommandRegistry } from './commands.js';

describe('help command output', () => {
  beforeEach(() => {
    const registry = getCommandRegistry();
    registry.clear();
    getCommandRegistry();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    const registry = getCommandRegistry();
    registry.clear();
    getCommandRegistry();
  });

  it('shows dynamically registered commands in top-level help', async () => {
    const registry = getCommandRegistry();
    registry.register({
      name: 'deploy',
      aliases: ['dep'],
      description: 'Deploy the current project',
      source: 'extension',
      handler: async () => {},
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const helpCommand = BUILTIN_COMMANDS.find((cmd) => cmd.name === 'help');

    expect(helpCommand).toBeDefined();
    await helpCommand!.handler([], {} as never, {} as never, {} as never);

    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('Extensions:');
    expect(output).toContain('/deploy');
  });

  it('hides non-user-invocable commands from top-level help', async () => {
    const registry = getCommandRegistry();
    registry.register({
      name: 'internal-sync',
      description: 'Internal sync command',
      source: 'extension',
      userInvocable: false,
      handler: async () => {},
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const helpCommand = BUILTIN_COMMANDS.find((cmd) => cmd.name === 'help');

    expect(helpCommand).toBeDefined();
    await helpCommand!.handler([], {} as never, {} as never, {} as never);

    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).not.toContain('/internal-sync');
  });
});
