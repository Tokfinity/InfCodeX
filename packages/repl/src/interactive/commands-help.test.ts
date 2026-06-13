import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILTIN_COMMANDS, executeCommand, getCommandRegistry, type CommandCallbacks } from './commands.js';
import { createInteractiveContext } from './context.js';

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
    expect(output).not.toContain('/project');
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

  it('routes /<command> help through detailed help without executing the command', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const context = await createInteractiveContext({});
    const callbacks = {
      saveSession: vi.fn(async () => {}),
      exit: vi.fn(),
    } as unknown as CommandCallbacks;

    const result = await executeCommand(
      { command: 'exit', args: ['help'] },
      context,
      callbacks,
      {} as never,
    );

    const output = logSpy.mock.calls.flat().join('\n');
    expect(result).toBe(true);
    expect(callbacks.exit).not.toHaveBeenCalled();
    expect(output).toContain('/exit - Exit Interactive Mode');
  });

  it('shows basic help for /<command> help when detailed help is absent', async () => {
    const registry = getCommandRegistry();
    const handler = vi.fn(async () => true);
    registry.register({
      name: 'deploy',
      description: 'Deploy the current project',
      usage: '/deploy [environment]',
      source: 'prompt',
      handler,
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await executeCommand(
      { command: 'deploy', args: ['help'] },
      await createInteractiveContext({}),
      {} as unknown as CommandCallbacks,
      {} as never,
    );

    const output = logSpy.mock.calls.flat().join('\n');
    expect(result).toBe(true);
    expect(handler).not.toHaveBeenCalled();
    expect(output).toContain('/deploy');
    expect(output).toContain('Deploy the current project');
    expect(output).toContain('Usage: /deploy [environment]');
  });

  it('documents workspace-aware session semantics for save/load/sessions/delete', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const saveCommand = BUILTIN_COMMANDS.find((cmd) => cmd.name === 'save');
    const loadCommand = BUILTIN_COMMANDS.find((cmd) => cmd.name === 'load');
    const sessionsCommand = BUILTIN_COMMANDS.find((cmd) => cmd.name === 'sessions');
    const deleteCommand = BUILTIN_COMMANDS.find((cmd) => cmd.name === 'delete');

    saveCommand?.detailedHelp?.();
    loadCommand?.detailedHelp?.();
    sessionsCommand?.detailedHelp?.();
    deleteCommand?.detailedHelp?.();

    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('Saving updates session storage only');
    expect(output).toContain('sibling workspaces in the same canonical repo');
    expect(output).toContain('workspace truth');
    expect(output).toContain('Current workspaces and checkouts remain untouched');
  });

  it('keeps workspace unchanged when saving, exiting, or deleting sessions', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const context = await createInteractiveContext({
      gitRoot: 'C:/repo/worktrees/runtime-docs',
      runtimeInfo: {
        canonicalRepoRoot: 'C:/repo',
        workspaceRoot: 'C:/repo/worktrees/runtime-docs',
        executionCwd: 'C:/repo/worktrees/runtime-docs/packages/repl',
        branch: 'feature/runtime-docs',
        workspaceKind: 'managed',
      },
    });
    const callbacks = {
      saveSession: vi.fn(async () => {}),
      exit: vi.fn(),
      deleteSession: vi.fn(async () => {}),
    } as unknown as CommandCallbacks;

    await BUILTIN_COMMANDS.find((cmd) => cmd.name === 'save')!.handler([], context, callbacks, {} as never);
    await BUILTIN_COMMANDS.find((cmd) => cmd.name === 'delete')!.handler(['session-1'], context, callbacks, {} as never);
    await BUILTIN_COMMANDS.find((cmd) => cmd.name === 'exit')!.handler([], context, callbacks, {} as never);

    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('Workspace unchanged');
    expect(output).toContain('feature/runtime-docs');
  });

  it('FEATURE_218: /help <manual-topic> falls through to the self-knowledge manual', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const helpCommand = BUILTIN_COMMANDS.find((cmd) => cmd.name === 'help');

    await helpCommand!.handler(['providers'], {} as never, {} as never, {} as never);

    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('Providers & models');
    expect(output).not.toContain('Unknown command');
  });

  it('FEATURE_218: /help <unknown> shows the manual index, not an error', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const helpCommand = BUILTIN_COMMANDS.find((cmd) => cmd.name === 'help');

    await helpCommand!.handler(['totally-unknown-xyz'], {} as never, {} as never, {} as never);

    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('KodaX Manual — Index');
    expect(output).not.toContain('Unknown command');
  });

  it('sets AMAW through /agent-mode and documents explicit /workflow support in AMA', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const context = await createInteractiveContext({});
    const setAgentMode = vi.fn();
    const callbacks = {
      saveSession: vi.fn(async () => {}),
      exit: vi.fn(),
      setAgentMode,
    } as unknown as CommandCallbacks;
    const currentConfig = {
      provider: 'openai',
      thinking: false,
      reasoningMode: 'off',
      agentMode: 'ama',
      permissionMode: 'accept-edits',
    } as const;

    const result = await executeCommand(
      { command: 'agent-mode', args: ['amaw'] },
      context,
      callbacks,
      currentConfig,
    );

    const agentModeCommand = BUILTIN_COMMANDS.find((cmd) => cmd.name === 'agent-mode');
    agentModeCommand?.detailedHelp?.();
    const output = logSpy.mock.calls.flat().join('\n');

    expect(result).toBe(true);
    expect(setAgentMode).toHaveBeenCalledWith('amaw');
    expect(output).toContain('/agent-mode amaw');
    expect(output).toContain('/workflow');
  });
});
